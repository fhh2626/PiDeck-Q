#include "AppLogStore.h"

#include <QDateTime>
#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QJsonDocument>
#include <QRegularExpression>
#include <QUuid>

#include <algorithm>

namespace applog {
namespace {

/** Local midnight of a calendar day, matching the writer's local-date file name. */
qint64 dayStartMs(int year, int month, int day)
{
    return QDateTime(QDate(year, month, day), QTime(0, 0)).toMSecsSinceEpoch();
}

QString formatDate(const QDateTime &value)
{
    return value.toString(QStringLiteral("yyyy-MM-dd"));
}

QJsonObject parseLine(const QString &line)
{
    const QJsonDocument document = QJsonDocument::fromJson(line.toUtf8());
    if (!document.isObject()) return {};
    const QJsonObject entry = document.object();
    // A damaged or foreign line is skipped instead of failing the whole query.
    if (!entry.value(QStringLiteral("id")).isString()) return {};
    if (!entry.value(QStringLiteral("time")).isDouble()) return {};
    return entry;
}

} // namespace

bool isLogFileName(const QString &name)
{
    static const QRegularExpression pattern(QStringLiteral("^app-(\\d{4})-(\\d{2})-(\\d{2})\\.log$"));
    return pattern.match(name).hasMatch();
}

Query parseQuery(const QJsonObject &object)
{
    Query query;
    if (object.value(QStringLiteral("search")).isString()) {
        query.search = object.value(QStringLiteral("search")).toString();
    }
    if (object.value(QStringLiteral("level")).isString()) {
        query.level = object.value(QStringLiteral("level")).toString();
    }
    if (object.value(QStringLiteral("from")).isDouble()) {
        query.hasFrom = true;
        query.from = qint64(object.value(QStringLiteral("from")).toDouble());
    }
    if (object.value(QStringLiteral("to")).isDouble()) {
        query.hasTo = true;
        query.to = qint64(object.value(QStringLiteral("to")).toDouble());
    }
    if (object.value(QStringLiteral("pageSize")).isDouble()) {
        query.hasPage = true;
        query.page = object.value(QStringLiteral("page")).toInt(0);
        query.pageSize = object.value(QStringLiteral("pageSize")).toInt(0);
    }
    if (object.value(QStringLiteral("limit")).isDouble()) {
        query.limit = object.value(QStringLiteral("limit")).toInt(500);
    }
    return query;
}

Store::Store(QString directory) : m_directory(std::move(directory)) {}

void Store::ensureDirectory() const
{
    QDir().mkpath(m_directory);
}

QStringList Store::logFiles() const
{
    QStringList names;
    const QStringList entries = QDir(m_directory).entryList(QDir::Files, QDir::NoSort);
    for (const QString &name : entries) {
        if (isLogFileName(name)) names.append(name);
    }
    names.sort();
    // Only the newest 14 files are ever queried; older ones are already deleted.
    if (names.size() > kMaxLogFiles) names = names.mid(names.size() - kMaxLogFiles);
    return names;
}

QStringList Store::linesOf(const QString &path) const
{
    const QFileInfo info(path);
    const QString fingerprint = QStringLiteral("%1:%2")
                                    .arg(info.lastModified().toMSecsSinceEpoch())
                                    .arg(info.size());
    const auto cached = m_cache.constFind(path);
    if (cached != m_cache.constEnd() && cached.value().first == fingerprint) {
        return cached.value().second;
    }
    QStringList lines;
    QFile file(path);
    if (file.open(QIODevice::ReadOnly)) {
        const QString raw = QString::fromUtf8(file.readAll());
        lines = raw.split(QRegularExpression(QStringLiteral("\\r?\\n")), Qt::SkipEmptyParts);
        if (lines.size() > kMaxFileLines) lines = lines.mid(lines.size() - kMaxFileLines);
    }
    if (m_cache.size() > 32) m_cache.clear();
    m_cache.insert(path, {fingerprint, lines});
    return lines;
}

void Store::clearCache()
{
    m_cache.clear();
}

QJsonObject Store::write(const QString &level, const QString &scope, const QString &message,
                         const QJsonValue &detail)
{
    ensureDirectory();
    cleanupOldFiles();
    QJsonObject entry{
        {QStringLiteral("id"), QUuid::createUuid().toString(QUuid::WithoutBraces)},
        {QStringLiteral("time"), double(QDateTime::currentMSecsSinceEpoch())},
        {QStringLiteral("level"), level},
        {QStringLiteral("scope"), scope},
        {QStringLiteral("message"), message},
    };
    if (!detail.isUndefined()) entry.insert(QStringLiteral("detail"), detail);
    const QString path =
        QDir(m_directory).filePath(QStringLiteral("app-%1.log").arg(formatDate(QDateTime::currentDateTime())));
    QFile file(path);
    if (file.open(QIODevice::Append)) {
        file.write(QJsonDocument(entry).toJson(QJsonDocument::Compact));
        file.write("\n");
    }
    return entry;
}

void Store::cleanupOldFiles() const
{
    QStringList names;
    for (const QString &name : QDir(m_directory).entryList(QDir::Files, QDir::NoSort)) {
        if (isLogFileName(name)) names.append(name);
    }
    names.sort();
    const int expired = names.size() - kMaxLogFiles;
    for (int index = 0; index < expired; ++index) {
        QFile::remove(QDir(m_directory).filePath(names.at(index)));
    }
}

QJsonArray Store::list(const Query &query)
{
    return listPage(query).value(QStringLiteral("entries")).toArray();
}

QJsonObject Store::listPage(const Query &query)
{
    ensureDirectory();
    QStringList names = logFiles();
    // Narrow the read set by day before touching any file content.
    if (query.hasFrom || query.hasTo) {
        static const QRegularExpression pattern(
            QStringLiteral("^app-(\\d{4})-(\\d{2})-(\\d{2})\\.log$"));
        QStringList filtered;
        for (const QString &name : names) {
            const QRegularExpressionMatch match = pattern.match(name);
            if (!match.hasMatch()) continue;
            const qint64 fileDay = dayStartMs(match.captured(1).toInt(), match.captured(2).toInt(),
                                              match.captured(3).toInt());
            if (query.hasFrom && fileDay < query.from) continue;
            if (query.hasTo) {
                const QDateTime end = QDateTime::fromMSecsSinceEpoch(query.to);
                const qint64 endOfDay =
                    dayStartMs(end.date().year(), end.date().month(), end.date().day())
                    + 86'400'000 - 1;
                if (fileDay > endOfDay) continue;
            }
            filtered.append(name);
        }
        names = filtered;
    }

    QStringList lines;
    for (const QString &name : names) lines.append(linesOf(QDir(m_directory).filePath(name)));

    const QString search = query.search.trimmed().toLower();
    QVector<QJsonObject> matched;
    for (const QString &line : lines) {
        const QJsonObject entry = parseLine(line);
        if (entry.isEmpty()) continue;
        const qint64 time = qint64(entry.value(QStringLiteral("time")).toDouble());
        if (query.hasFrom && time < query.from) continue;
        if (query.hasTo && time > query.to) continue;
        if (!query.level.isEmpty() && query.level != QLatin1String("all")
            && entry.value(QStringLiteral("level")).toString() != query.level) {
            continue;
        }
        if (!search.isEmpty()) {
            // The oracle searches level + scope + message + JSON.stringify(detail ?? "").
            const QJsonValue detail = entry.value(QStringLiteral("detail"));
            const QString detailJson = detail.isUndefined()
                ? QStringLiteral("\"\"")
                : QString::fromUtf8(QJsonDocument(QJsonArray{detail}).toJson(QJsonDocument::Compact));
            const QString haystack = entry.value(QStringLiteral("level")).toString() + QLatin1Char(' ')
                + entry.value(QStringLiteral("scope")).toString() + QLatin1Char(' ')
                + entry.value(QStringLiteral("message")).toString() + QLatin1Char(' ') + detailJson;
            if (!haystack.toLower().contains(search)) continue;
        }
        matched.append(entry);
    }
    // Newest first: paging walks backwards into history.
    std::reverse(matched.begin(), matched.end());

    const int total = matched.size();
    const int page = qMax(0, query.page);
    // queryLogLines: an explicit pageSize switches to paging, otherwise the legacy
    // `limit` window is returned. The page object always reports the clamped pageSize
    // (`Math.max(1, Math.min(query.pageSize ?? 50, 200))` in the oracle, so an explicit
    // 0 reports 1, not the default).
    const int pagingSize = query.hasPage ? qBound(1, query.pageSize, 200) : 0;
    QJsonArray entries;
    if (pagingSize == 0) {
        const int limit = qBound(1, query.limit, 2000);
        for (int index = 0; index < total && index < limit; ++index) entries.append(matched.at(index));
    } else {
        const int start = page * pagingSize;
        for (int index = start; index < total && index < start + pagingSize; ++index) {
            entries.append(matched.at(index));
        }
    }
    const int reportedPageSize =
        query.hasPage ? pagingSize : qBound(1, kDefaultPageSize, 200);
    return QJsonObject{
        {QStringLiteral("entries"), entries},
        {QStringLiteral("total"), total},
        {QStringLiteral("page"), page},
        {QStringLiteral("pageSize"), reportedPageSize},
        {QStringLiteral("hasMore"), (page + 1) * reportedPageSize < total},
    };
}

void Store::clear()
{
    ensureDirectory();
    int removed = 0;
    for (const QString &name : QDir(m_directory).entryList(QDir::Files, QDir::NoSort)) {
        if (!isLogFileName(name)) continue;
        if (QFile::remove(QDir(m_directory).filePath(name))) ++removed;
    }
    // The cache holds lines of files that no longer exist; keeping them would make the
    // next query return the deleted history.
    clearCache();
    write(QStringLiteral("info"), QStringLiteral("logs"), QStringLiteral("Logs cleared"),
          QJsonObject{{QStringLiteral("files"), removed}});
}

qint64 Store::size() const
{
    qint64 total = 0;
    for (const QString &name : QDir(m_directory).entryList(QDir::Files, QDir::NoSort)) {
        if (!isLogFileName(name)) continue;
        total += QFileInfo(QDir(m_directory).filePath(name)).size();
    }
    return total;
}

} // namespace applog
