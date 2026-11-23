#pragma once

#include <QJsonArray>
#include <QJsonObject>
#include <QString>
#include <QStringList>

#include <QHash>

/**
 * Main-process application log (`logs:*`, `renderer-log`).
 *
 * Port of src/main/logging/AppLogger.ts + logQuery.ts + logLineCache.ts. Entries are
 * JSON lines in `<userData>/logs/app-YYYY-MM-DD.log`, one file per local day, at most
 * 14 files. The file name is the day key used by the date filter, so a query for a
 * narrow range never reads the whole history.
 *
 * Invariants:
 *  - a query filters *before* paging, so an old date range is still reachable (the old
 *    implementation truncated to the newest 5000 lines and lost history);
 *  - a single file is read at most `kMaxFileLines` lines, so a malformed huge file
 *    cannot stall the query;
 *  - the per-file line cache is keyed by an mtime+size fingerprint, so only the file
 *    that is still being appended to is re-read.
 */
namespace applog {

constexpr int kMaxLogFiles = 14;
constexpr int kMaxFileLines = 200'000;
constexpr int kDefaultPageSize = 50;

/** `^app-(\d{4})-(\d{2})-(\d{2})\.log$` */
bool isLogFileName(const QString &name);

struct Query {
    QString search;
    QString level;
    bool hasFrom = false;
    qint64 from = 0;
    bool hasTo = false;
    qint64 to = 0;
    bool hasPage = false;
    int page = 0;
    int pageSize = 0;
    int limit = 500;
};

/** Parse the renderer's query object; every field is optional and untrusted. */
Query parseQuery(const QJsonObject &object);

class Store {
public:
    explicit Store(QString directory);

    const QString &directory() const { return m_directory; }
    void ensureDirectory() const;

    /** Append one entry; returns the persisted record. */
    QJsonObject write(const QString &level, const QString &scope, const QString &message,
                      const QJsonValue &detail);

    QJsonArray list(const Query &query);
    QJsonObject listPage(const Query &query);
    void clear();
    qint64 size() const;

    /** Drop the line cache (after a clear or in tests). */
    void clearCache();

private:
    QStringList logFiles() const;
    QStringList linesOf(const QString &path) const;
    void cleanupOldFiles() const;

    QString m_directory;
    mutable QHash<QString, QPair<QString, QStringList>> m_cache;
};

} // namespace applog
