#pragma once

#include "CatalogTypes.h"
#include "SessionSummary.h"

#include <QHash>
#include <QJsonArray>
#include <QJsonObject>
#include <QRecursiveMutex>
#include <QString>
#include <QVector>

#include <functional>
#include <optional>

/**
 * The durable session catalog: the single owner of stable session identity.
 *
 * Port of src/main/sessions/SessionCatalog.ts. The prototype used `filePath` as the
 * record id, which meant identity changed whenever a file moved and made drafts
 * impossible to represent. Here every record gets a `randomUUID()` that survives
 * restarts, and the file mapping lives in `originKey`.
 *
 * Persistence contract (all of it observable, all of it required):
 *  - `session-catalog.json` is `{version:1, sessions:[...]}`;
 *  - a version other than 1 (or a missing one) is **refused**, never downgraded to
 *    the `.bak`, because writing back would destroy newer data;
 *  - writes go through temp file + fsync + rename, and the previous file becomes
 *    `.bak` before the swap;
 *  - stale `draft` entries are purged on load (a draft has no pi session to resume);
 *  - anonymous entries live in `transientEntries` and never reach disk;
 *  - `createDraft` performs no filesystem write outside the catalog.
 *
 * Thread ownership (CAT-1): every public read *and* mutation is internally
 * synchronized. The backend reaches this store from two threads — the Qt owner thread
 * (runtime activation, project channels, the LAN web state) and the serial domain
 * executor (`sessions:catalog-*` bodies, background scans) — and neither is allowed to
 * observe a half-applied record vector. Copy → durable write → assign stays ONE
 * transaction under the lock, so a concurrent merge can never drop a draft that was
 * created between its copy and its assign.
 *
 * Rules that keep the lock safe:
 *  - the mutex is recursive because the transactions nest (`update` → `mutate`,
 *    `remove` → `removeTransient`, `getRecord` → `get`);
 *  - no channel handler may hold it while performing an RPC or waiting on another
 *    thread: nothing inside the store does either, so a caller can never deadlock the
 *    event loop through this lock;
 *  - `identityContext()` returns a copy (not a reference) so a reader cannot observe a
 *    half-published WSL distro/user pair, which is what splits one session file into two
 *    origin identities on the next scan.
 */
class SessionCatalogStore {
public:
    struct Context {
        QString wslDistro;
        QString wslUser;
    };

    /** The filesystem namespace captured from the process that owns a session file. */
    struct RuntimeIdentity {
        QString environment;
        QString wslDistro;
        QString wslUser;
    };

    /** Normalizes a pi-reported relative sessionFile against the project cwd. */
    using FilePathResolver = std::function<QString(const QString &projectId, const QString &filePath,
                                                   const QString &environment)>;
    using ProjectPathResolver = std::function<QString(const QString &projectId, const QString &environment)>;

    SessionCatalogStore(QString filePath, Context context, FilePathResolver resolveFilePath = {},
                        ProjectPathResolver resolveProjectPath = {});

    void setIdentityContext(const Context &context);
    /** One coherent WSL identity (copy: a reference could be read mid-publication). */
    Context identityContext() const;

    /** Load from disk. Throws when the version is unsupported or both copies are corrupt. */
    void load();

    QVector<CatalogEntry> listEntries() const;
    bool get(const QString &id, CatalogEntry *out) const;
    /** SessionRecord projection; `found` reports whether the id exists. */
    QJsonObject getRecord(const QString &id, bool *found) const;
    QJsonArray listRecords(const QString &projectId = QString()) const;
    QJsonArray listProjectRecords(const QString &projectId) const;
    bool findByFilePath(const QString &filePath, const QString &environment, CatalogEntry *out) const;

    QJsonObject createAnonymous(const QString &projectId, const QString &title, const QString &environment,
                                bool hasModel, const QString &modelProvider, const QString &modelId,
                                bool hasThinkingLevel, const QString &thinkingLevel);
    bool removeTransient(const QString &id);
    bool isTransient(const QString &id) const;

    CatalogEntry ensureRuntimeTarget(const QString &projectId, const QString &title, const QString &source,
                                     const QString &environment, const QString &filePath,
                                     const QString &wslDistro, const QString &wslUser,
                                     const QString &importedSourceId, const QString &piSessionId);
    QJsonObject createDraft(const QString &projectId, const QString &title, const QString &environment,
                            const QString &source, bool hasModel, const QString &modelProvider,
                            const QString &modelId, bool hasThinkingLevel, const QString &thinkingLevel);
    QJsonObject update(const QString &id, const QJsonObject &patch);
    /** Attach the path and its actual launch namespace in one catalog transaction. */
    CatalogEntry attachRuntime(const QString &sessionId, const QString &filePath, const QString &piSessionId,
                               std::optional<RuntimeIdentity> identity = std::nullopt);
    /** Pin a captured filesystem identity across asynchronous deletion and settlement. */
    bool pinDeletion(const CatalogEntry &expected);
    void releaseDeletion(const QString &id);
    bool removePinned(const CatalogEntry &expected);
    static bool sameDeletionTarget(const CatalogEntry &left, const CatalogEntry &right);
    bool remove(const QString &id);
    bool removeByFilePath(const QString &filePath, const QString &environment);

    /** Capture before reading files; a completed removal invalidates in-flight summaries. */
    quint64 scanGeneration() const;

    /**
     * Fold scanner output into the catalog and return the project's records.
     * Creates records for new files, refreshes changed metadata and preserves the
     * stable id plus user preferences (title/model/thinking) for known files.
     */
    QJsonArray mergeScanned(const QString &projectId, const QVector<SessionSummary> &summaries,
                            const Context &context, std::optional<quint64> generation = std::nullopt);

    /** Absolute path of the catalog file (used by tests and logging). */
    const QString &filePath() const { return m_filePath; }

private:
    using Mutation = std::function<bool(QVector<CatalogEntry> &entries)>;

    void assertLoaded() const;
    void mutate(const Mutation &mutation);
    CatalogEntry requireEntry(const QVector<CatalogEntry> &entries, const QString &id) const;
    QString originKeyForEntry(const CatalogEntry &entry) const;
    QJsonObject recordFromEntry(const CatalogEntry &entry, const SessionSummary *summary) const;
    QString resolveProjectPath(const CatalogEntry &entry) const;

    QString backupFilePath() const;
    QVector<CatalogEntry> readEntries(const QString &path) const;
    void writeSnapshot(const QVector<CatalogEntry> &entries);
    void assertPinnedTargets(const QVector<CatalogEntry> &entries) const;

    QString m_filePath;
    /** Guards every field below plus the durable write (see the class comment). */
    mutable QRecursiveMutex m_mutex;
    Context m_context;
    FilePathResolver m_resolveFilePath;
    ProjectPathResolver m_resolveProjectPath;
    QVector<CatalogEntry> m_entries;
    QVector<CatalogEntry> m_transientEntries;
    QHash<QString, CatalogEntry> m_deletingEntries;
    quint64 m_deletionGeneration = 0;
    bool m_loaded = false;
    bool m_skipNextBackup = false;
};
