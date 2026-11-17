#pragma once

#include "SessionDelete.h"
#include "SessionFs.h"
#include "SessionSummary.h"

#include "../MainCopy.h"

#include <QHash>
#include <QJsonArray>
#include <QJsonObject>
#include <QMutex>
#include <QString>
#include <QStringList>
#include <QVector>

#include <atomic>
#include <memory>

namespace summarycache {
class Cache;
}

/**
 * Session file scanner and file-level operations.
 *
 * Port of src/main/sessions/SessionScanner.ts. Responsibilities:
 *  - enumerate `*.jsonl` under every scan root and summarize each file;
 *  - decide project membership (cwd match, parent-cwd content match, custom
 *    `sessionDir` containment, or encoded-cwd token);
 *  - rename by appending a pi-native `session_info` record (never a private header
 *    line, which makes pi refuse to load the session);
 *  - archive/unarchive with an index and companion-directory rollback;
 *  - delete through the recycle bin (native) or a soft-delete bucket (WSL).
 *
 * Scans are summarised through `summarycache::Cache` (mtime + size invalidation) and, in
 * WSL mode, batched through `wslscan` so a few-hundred-session history is not a few
 * hundred `wsl.exe` starts.
 *
 * Environment (native ↔ WSL) is an immutable snapshot: a scan captures the snapshot it
 * started with, and `configureEnvironment` publishes a new one plus a cancellation token.
 * A scan that outlived its environment therefore cannot read the new distro's paths with
 * the old filesystem adapter; it aborts and the caller sees the environment change.
 */
class SessionScanner {
public:
    struct Config {
        QString hostHome;
        QString downloadsDir;
        /** Default scan root (`~/.pi/agent/sessions`). */
        QString sessionsDir;
        /** userData root for the persistent summary cache (empty = memory only). */
        QString userDataDir;
        SessionFs fs;
        /** Whole-scan budget for WSL scans (oracle `scanTimeoutMs`). */
        int wslScanTimeoutMs = 18'000;
        /** Per-command body budget for the WSL batch reader. */
        int wslBodyTimeoutMs = 10'000;
    };

    SessionScanner(Config config, maincopy::Translator translate);
    ~SessionScanner();

    /** Switch the active environment; aborts an in-flight scan and reloads the cache. */
    void configureEnvironment(SessionFs::Config fsConfig, const QString &sessionsDir);
    /** Current environment's filesystem adapter (a copy: callers may keep it). */
    SessionFs fs() const;
    QStringList activeScanRoots() const;

    /**
     * List summaries for one project.
     * `projectPath` is the host path; `runtimeProjectPath` is what pi runs with.
     */
    QVector<SessionSummary> list(const QString &projectPath, const QString &runtimeProjectPath);

    /** Raw JSONL text (used by reference messages, process events, delete ownership). */
    QString readSessionRawText(const QString &filePath) const;

    /** `[{role, content, timestamp}]` for reference/quote features. */
    QJsonArray readReferenceMessages(const QString &filePath) const;

    /** Append a pi-native `session_info` record and replace the file atomically. */
    void rename(const QString &filePath, const QString &newName) const;

    /**
     * Repair a corrupted header (legacy private `sessionName` line, or a path glued
     * onto the session header). Returns true when the file was rewritten.
     */
    bool repairCorruptSessionHeader(const QString &filePath) const;

    /** Copy the file and append a `… copy` session_info record. */
    SessionSummary copy(const QString &filePath) const;

    /** Local HTML export (fallback used when no pi process is available). */
    QJsonObject exportHtml(const QString &filePath) const;

    /** Archive/unarchive/list, implemented in SessionArchive.cpp. */
    QString archive(const QString &filePath);
    QString unarchive(const QString &archivedPath);
    QVector<SessionSummary> listArchived();

    /**
     * Enumerate everything a delete must move (residue + companion dir + file).
     * Native deletions then go through the host recycle bin; WSL uses softDeleteWsl.
     */
    sessiondelete::Plan planDelete(const QString &filePath) const;

    struct DeletionStorage {
        SessionFs fs;
        QString root;
    };
    /** Value-only environment captured before asynchronous runtime identity checks. */
    struct DeletionSnapshot {
        SessionFs fs;
        QString sessionsDir;
    };
    DeletionSnapshot deletionSnapshot() const;
    /** Authorize and capture one storage environment for the entire deletion. */
    DeletionStorage deletionStorage(const QString &filePath, const QString &projectPath,
                                    const QString &runtimeProjectPath) const;
    DeletionStorage deletionStorage(const QString &filePath, const QString &projectPath,
                                    const QString &runtimeProjectPath, const DeletionSnapshot &snapshot) const;

    /**
     * WSL soft delete: move the residue, companion directory and file into the
     * environment's `.pideck-trash/<stamp>/` bucket. Returns the bucket path, empty
     * when there was nothing to move (idempotent delete of an already-removed session).
     */
    QString softDeleteWsl(const QString &filePath);

    /** Absolute path of the archive index for the active environment. */
    QString archiveIndexPath() const;

    /** Most specific scan root containing `filePath`. */
    QString findRootForFile(const QString &filePath) const;

    /** `<file>.jsonl` → `<file>`; empty when the path is not a session file. */
    QString siblingDirectory(const QString &filePath) const;

    /** Write the summary cache now (called during shutdown, before the executor stops). */
    void flushSummaryCache();

private:
    /** Immutable scan environment; replacing it is the only way to change distro/paths. */
    struct Environment {
        SessionFs fs;
        QString sessionsDir;
        /** Roots resolved by the last scan (empty until the first one). */
        QStringList roots;
        quint64 generation = 0;
    };

    /** Parent-cwd membership decided for one file version (oracle `projectMembership`). */
    struct Membership {
        qint64 mtimeMs = 0;
        qint64 size = 0;
        bool matches = false;
    };

    std::shared_ptr<const Environment> environment() const;
    /**
     * Reload the summary cache on the serial domain executor.
     *
     * `configureEnvironment` runs on the Qt owner thread (the WSL switch publishes there),
     * so the potentially large cache read is handed off instead of stalling the event loop.
     */
    void scheduleSummaryCacheReload();
    /** Publish the roots the scan resolved, unless the environment changed meanwhile. */
    void publishRoots(quint64 generation, const QStringList &roots);
    /** Throw when a WSL/local switch happened while this scan was running. */
    void assertEnvironment(quint64 generation) const;
    /** Drop the cancellation token once this scan is done (idempotent). */
    void releaseScanToken(const std::shared_ptr<std::atomic<bool>> &token);

    bool isSameProject(const SessionSummary &summary, const QString &projectPath, qint64 mtimeMs,
                       qint64 size, const QString *raw) const;
    bool isParentSessionForProject(const QString &sessionProject, const QString &projectPath,
                                   const QString &filePath, qint64 mtimeMs, qint64 size,
                                   const QString *raw) const;
    bool isUnderProjectSessionDir(const QString &filePath, const QString &projectPath) const;
    /** Prefetch only cache misses or an undecided parent-cwd membership. */
    bool needsScanBody(const QString &path, qint64 mtimeMs, qint64 size, const QString &projectPath) const;

    QString nextCopyPath(const QString &filePath) const;
    QJsonObject readArchiveIndex() const;
    void writeArchiveIndex(const QJsonObject &entries) const;
    QString appendSessionInfoLine(const QString &raw, const QString &name,
                                  const QJsonObject &extra = QJsonObject{}) const;

    Config m_config;
    maincopy::Translator m_translate;
    mutable QMutex m_stateMutex;
    std::shared_ptr<const Environment> m_environment;
    /** Cancellation token of the scan currently running (null when idle). */
    std::shared_ptr<std::atomic<bool>> m_scanCancel;
    std::unique_ptr<summarycache::Cache> m_summaryCache;
    /** An unscanned environment differs from a completed scan with an empty file set. */
    bool m_hasCacheFileSetKey = false;
    QString m_cacheFileSetKey;
    mutable QHash<QString, Membership> m_membership;
};
