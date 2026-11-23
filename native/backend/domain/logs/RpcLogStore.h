#pragma once

#include <QJsonArray>
#include <QJsonObject>
#include <QString>
#include <QStringList>

#include <QSet>

/**
 * RPC traffic log (`rpc-logs:*`).
 *
 * Port of src/main/logging/RpcLogger.ts + readRpcLogHistory.ts. Files are
 * `<userData>/logs/rpc/rpc-<agentId>-YYYY-MM-DD.jsonl` (rotated to `.jsonl.gz` when the
 * day changes, deleted after 30 days) and contain the raw pi frames, so they are only
 * written while the user has recording enabled for that agent.
 *
 * Invariants:
 *  - the in-memory ring keeps the newest 1000 entries with each `data` payload replaced
 *    by a summary above 4 KiB, so a large prompt cannot grow the backend's memory;
 *  - a history read is bounded (scan budget, per-line budget, result budget) and fails
 *    explicitly instead of silently returning a partial date range;
 *  - `save` de-duplicates by entry id so the live view and the automatic file converge.
 */
namespace rpclog {

constexpr int kMaxLive = 1000;
constexpr int kMaxLiveDataBytes = 4'096;
constexpr int kRetentionDays = 30;
constexpr qint64 kMaxScanBytes = 128 * 1024 * 1024;
constexpr qint64 kMaxLineBytes = 4 * 1024 * 1024;
constexpr qint64 kMaxResultBytes = 8 * 1024 * 1024;

struct HistoryOptions {
    QString agentId;
    int days = 7;
    int limit = 5000;
};

class Store {
public:
    explicit Store(QString directory);

    const QString &directory() const { return m_directory; }
    void ensureDirectory() const;

    /** Record one frame. Only called when recording is enabled for the agent. */
    void push(const QJsonObject &entry);

    /** Ring buffer copy, optionally filtered by agent. */
    QJsonArray live(const QString &agentId) const;

    /** Bounded, newest-first history across the requested day range. */
    QJsonArray history(const HistoryOptions &options);

    qint64 size(const QString &agentId) const;
    void clear(const QString &agentId);

    /** Merge saved entries into their daily files, de-duplicated by id. */
    QStringList appendEntries(const QJsonArray &entries);

    void setLoggingEnabled(const QString &agentId, bool enabled);
    bool loggingEnabled(const QString &agentId) const;

private:
    QStringList filesFor(const QString &agentId) const;
    QString filePathFor(const QJsonObject &entry) const;
    void writeEntry(const QJsonObject &entry);
    void rotateIfNeeded(const QString &dateString);
    void cleanOldFiles();

    QString m_directory;
    QJsonArray m_live;
    QString m_lastWriteDate;
    QSet<QString> m_loggingEnabled;
};

} // namespace rpclog
