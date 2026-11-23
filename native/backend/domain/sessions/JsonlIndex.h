#pragma once

#include <QByteArray>
#include <QHash>
#include <QJsonValue>
#include <QSet>
#include <QString>
#include <QVector>

/**
 * Streaming JSONL index for one session file.
 *
 * Port of src/main/pi/SessionDisplayIndexStore.ts + sessionJsonlRows.ts. The index
 * keeps row offsets, byte lengths and a digest per row instead of message bodies, so
 * a page read touches only the rows it needs.
 *
 * The active branch is traced from the **last** entry along `parentId`, exactly like
 * pi's leaf. Reading the file in physical order instead would mix abandoned branches
 * (fork/rewind) into the timeline — the prototype did that and showed wrong history.
 */
struct IndexEntry {
    QString id;
    QString parentId;
    QString type;
    qint64 offset = 0;
    qint64 byteLength = 0;
    QByteArray rowDigest;
    bool hasMessage = false;
    bool hasTruthyMessage = false;
    QString role;
    /**
     * A visible task message (goal or resume guidance) starts a user turn even though
     * its projected role is `system`.
     * `role` is already overridden to `user` for those entries, but the flag keeps the
     * turn-start rule identical to the oracle (`findTurnPageStart` and
     * `mapCachedMessageToEntryCandidates` read it) instead of relying on that rewrite.
     */
    bool turnBoundary = false;
    QString messageId;
    QString toolCallId;
    QString summary;
    QString firstKeptEntryId;
    QString timestamp;
    bool hasTokensBefore = false;
    qint64 tokensBefore = 0;
};

struct IndexCompaction {
    QString id;
    QString summary;
    QString timestamp;
    QString firstKeptEntryId;
    bool hasTokensBefore = false;
    qint64 tokensBefore = 0;
};

struct JsonlIndex {
    QString hostPath;
    qint64 size = 0;
    qint64 mtimeMs = 0;
    bool hasCompaction = false;
    bool endsWithNewline = false;
    int rowCount = 0;
    QHash<QString, IndexEntry> entries;
    QVector<IndexEntry> activeBranch;
    QVector<IndexEntry> activeMessageEntries;
    QSet<QString> activeToolResultIds;
    /** Physical-first lookup for full-text requests (abandoned branches included). */
    QHash<QString, IndexEntry> firstEntries;
    QHash<QString, IndexEntry> firstMessages;
    QVector<IndexCompaction> compactions;

    /** `mtime:size`, the cursor version the renderer compares. */
    QString version() const;
};

namespace jsonlindex {

/** Raised when the file changed between indexing and body read. */
extern const char *const kHistoryChangedCode;

/** Build the index for one file. Throws ChannelError on IO/parse failure. */
JsonlIndex build(const QString &hostPath);

/**
 * Read the raw `message` payload of exactly these entries.
 * Verifies the row digest and id so an in-place edit cannot serve a stale body.
 */
QVector<QJsonValue> readMessages(const JsonlIndex &index, const QVector<IndexEntry> &entries);

/** Read one full entry with the same digest and identity checks as readMessages. */
QJsonValue readEntry(const JsonlIndex &index, const IndexEntry &entry);

/** LRU + single-flight index cache (32 entries, mirroring the oracle). */
class Store {
public:
    explicit Store(int limit = 32);
    JsonlIndex get(const QString &hostPath);
    void clear();

private:
    int m_limit;
    QVector<QString> m_order;
    QHash<QString, JsonlIndex> m_cache;
    void touch(const QString &hostPath, const JsonlIndex &index);
};

} // namespace jsonlindex
