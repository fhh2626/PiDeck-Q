#include "RpcLogStore.h"

#include "../market/Gzip.h"

#include <QDateTime>
#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QJsonDocument>
#include <QRegularExpression>
#include <QSaveFile>

#include <algorithm>

namespace rpclog {
namespace {

QString formatDate(const QDateTime &value)
{
    return value.toString(QStringLiteral("yyyy-MM-dd"));
}

/** `[^\w-.~]` → `_`: an agent id must never escape the log directory. */
QString sanitizeAgentId(const QString &id)
{
    QString safe = id;
    for (int index = 0; index < safe.size(); ++index) {
        const QChar character = safe.at(index);
        if (character.isLetterOrNumber() || character == QLatin1Char('_')
            || character == QLatin1Char('-') || character == QLatin1Char('.')
            || character == QLatin1Char('~')) {
            continue;
        }
        safe[index] = QLatin1Char('_');
    }
    return safe;
}

bool isLogEntry(const QJsonObject &entry)
{
    // Disk JSON is untrusted, including rows written by older builds.
    return entry.value(QStringLiteral("id")).isString()
        && entry.value(QStringLiteral("agentId")).isString()
        && entry.value(QStringLiteral("direction")).isString()
        && entry.value(QStringLiteral("summary")).isString()
        && entry.value(QStringLiteral("time")).isDouble();
}

/** Replace an oversized live payload with a summary (the file keeps the full data). */
QJsonObject truncateForLive(const QJsonObject &entry)
{
    if (!entry.contains(QStringLiteral("data"))) return entry;
    const QJsonValue data = entry.value(QStringLiteral("data"));
    // C++ cannot hold a scalar document, so non-container payloads are serialized inside
    // a one-element array and unwrapped again. The oracle measures
    // `JSON.stringify(entry.data)` (UTF-16 code units, no wrapper), so comparing bytes of
    // a `{"data": ...}` object would change both the threshold and the preview.
    QByteArray jsonBytes;
    if (data.isObject()) jsonBytes = QJsonDocument(data.toObject()).toJson(QJsonDocument::Compact);
    else if (data.isArray()) jsonBytes = QJsonDocument(data.toArray()).toJson(QJsonDocument::Compact);
    else {
        const QByteArray wrapped = QJsonDocument(QJsonArray{data}).toJson(QJsonDocument::Compact);
        jsonBytes = wrapped.mid(1, wrapped.size() - 2);
    }
    const QString json = QString::fromUtf8(jsonBytes);
    if (json.size() <= kMaxLiveDataBytes) return entry;
    QJsonObject copy = entry;
    copy.insert(QStringLiteral("data"),
                QJsonObject{{QStringLiteral("truncated"), true},
                            {QStringLiteral("size"), json.size()},
                            {QStringLiteral("preview"), json.left(200)}});
    return copy;
}

/** Only a bash command is truncated on disk; every other payload is written verbatim. */
QJsonObject truncateForDisk(const QJsonObject &entry)
{
    if (entry.value(QStringLiteral("direction")).toString() != QLatin1String("send")) return entry;
    const QJsonObject data = entry.value(QStringLiteral("data")).toObject();
    if (data.value(QStringLiteral("type")).toString() != QLatin1String("bash")) return entry;
    QJsonObject copy = entry;
    copy.insert(QStringLiteral("data"),
                QJsonObject{{QStringLiteral("type"), QStringLiteral("bash")},
                            {QStringLiteral("command"),
                             data.value(QStringLiteral("command")).toString().left(200)}});
    return copy;
}

QByteArray readFileBytes(const QString &path, bool gzipped)
{
    QFile file(path);
    if (!file.open(QIODevice::ReadOnly)) return {};
    const QByteArray raw = file.readAll();
    if (!gzipped) return raw;
    QByteArray inflated;
    // A damaged archive must not hide valid rows in the other files.
    if (!gzip::gunzip(raw, &inflated)) return {};
    return inflated;
}

} // namespace

Store::Store(QString directory) : m_directory(std::move(directory)) {}

void Store::ensureDirectory() const
{
    QDir().mkpath(m_directory);
}

QStringList Store::filesFor(const QString &agentId) const
{
    static const QRegularExpression pattern(
        QStringLiteral("^rpc-[\\w.~\\-]+-\\d{4}-\\d{2}-\\d{2}\\.jsonl(\\.gz)?$"));
    QStringList files;
    for (const QString &name : QDir(m_directory).entryList(QDir::Files, QDir::NoSort)) {
        if (!pattern.match(name).hasMatch()) continue;
        if (!agentId.isEmpty() && !name.startsWith(QStringLiteral("rpc-") + sanitizeAgentId(agentId)
                                                   + QLatin1Char('-'))) {
            continue;
        }
        files.append(name);
    }
    return files;
}

QString Store::filePathFor(const QJsonObject &entry) const
{
    const QString agent = sanitizeAgentId(entry.value(QStringLiteral("agentId")).toString());
    const QDateTime time = QDateTime::fromMSecsSinceEpoch(
        qint64(entry.value(QStringLiteral("time")).toDouble()));
    return QDir(m_directory).filePath(
        QStringLiteral("rpc-%1-%2.jsonl").arg(agent, formatDate(time)));
}

void Store::push(const QJsonObject &entry)
{
    if (!isLogEntry(entry)) return;
    const QString agentId = entry.value(QStringLiteral("agentId")).toString();
    if (!m_loggingEnabled.contains(agentId)) return;

    // Ring buffer: keep the newest kMaxLive entries, with the payload summarized.
    while (m_live.size() >= kMaxLive) m_live.removeFirst();
    m_live.append(truncateForLive(entry));
    writeEntry(entry);
}

QJsonArray Store::live(const QString &agentId) const
{
    if (agentId.isEmpty()) return m_live;
    QJsonArray filtered;
    for (const QJsonValue &value : m_live) {
        if (value.toObject().value(QStringLiteral("agentId")).toString() == agentId) {
            filtered.append(value);
        }
    }
    return filtered;
}

void Store::writeEntry(const QJsonObject &entry)
{
    ensureDirectory();
    // The oracle derives the day from the *entry* timestamp, not from the wall clock:
    // saving entries the viewer collected yesterday must not gzip today's file or skip
    // yesterday's rotation.
    const QDateTime time = QDateTime::fromMSecsSinceEpoch(
        qint64(entry.value(QStringLiteral("time")).toDouble()));
    const QString dateString = formatDate(time);
    rotateIfNeeded(dateString);
    m_lastWriteDate = dateString;

    QFile file(filePathFor(entry));
    if (!file.open(QIODevice::Append)) return;
    file.write(QJsonDocument(truncateForDisk(entry)).toJson(QJsonDocument::Compact));
    file.write("\n");
    file.close();
    // Retention is checked on a sample of writes; doing it every time would stat the
    // whole directory for every pi frame.
    static int writes = 0;
    if (++writes % 100 == 0) cleanOldFiles();
}

void Store::rotateIfNeeded(const QString &dateString)
{
    if (m_lastWriteDate.isEmpty() || m_lastWriteDate == dateString) return;
    const QString suffix = QStringLiteral("-%1.jsonl").arg(m_lastWriteDate);
    for (const QString &name : filesFor(QString())) {
        if (!name.endsWith(suffix)) continue;
        const QString path = QDir(m_directory).filePath(name);
        QByteArray raw;
        {
            QFile file(path);
            if (!file.open(QIODevice::ReadOnly)) continue;
            raw = file.readAll();
        }
        QByteArray compressed;
        if (!gzip::gzipCompress(raw, &compressed)) continue;
        QSaveFile output(path + QStringLiteral(".gz"));
        if (!output.open(QIODevice::WriteOnly)) continue;
        if (output.write(compressed) != compressed.size() || !output.commit()) continue;
        QFile::remove(path);
    }
}

void Store::cleanOldFiles()
{
    const qint64 cutoff = QDateTime::currentMSecsSinceEpoch() - qint64(kRetentionDays) * 86'400'000;
    static const QRegularExpression datePattern(
        QStringLiteral("-(\\d{4}-\\d{2}-\\d{2})\\.jsonl"));
    for (const QString &name : filesFor(QString())) {
        const QRegularExpressionMatch match = datePattern.match(name);
        if (!match.hasMatch()) continue;
        const QDateTime day(QDate::fromString(match.captured(1), Qt::ISODate), QTime(0, 0));
        if (day.isValid() && day.toMSecsSinceEpoch() < cutoff) {
            QFile::remove(QDir(m_directory).filePath(name));
        }
    }
}

QJsonArray Store::history(const HistoryOptions &options)
{
    ensureDirectory();
    const int limit = qBound(1, options.limit, 10'000);
    const int days = qBound(1, options.days, kRetentionDays);
    const QDateTime cutoff(QDate::currentDate().addDays(-(days - 1)), QTime(0, 0));
    const QString cutoffDate = formatDate(cutoff);
    const qint64 cutoffMs = cutoff.toMSecsSinceEpoch();

    static const QRegularExpression datePattern(
        QStringLiteral("-(\\d{4}-\\d{2}-\\d{2})\\.jsonl"));
    QStringList files;
    for (const QString &name : filesFor(options.agentId)) {
        const QRegularExpressionMatch match = datePattern.match(name);
        if (!match.hasMatch()) continue;
        if (match.captured(1) < cutoffDate) continue;
        files.append(name);
    }
    // Newest day first, so the newest entries are found before the scan budget is spent.
    std::sort(files.begin(), files.end(), [](const QString &left, const QString &right) {
        return left > right;
    });

    struct Row {
        QJsonObject entry;
        qint64 time = 0;
        qint64 bytes = 0;
    };
    QVector<Row> rows;
    qint64 scanned = 0;
    qint64 resultBytes = 0;
    for (const QString &name : files) {
        const QString path = QDir(m_directory).filePath(name);
        const QByteArray raw = readFileBytes(path, name.endsWith(QLatin1String(".gz")));
        scanned += raw.size();
        if (scanned > kMaxScanBytes) {
            throw std::runtime_error(
                "RPC log history exceeds the bounded query budget; narrow the date range.");
        }
        const QList<QByteArray> lines = raw.split('\n');
        for (const QByteArray &line : lines) {
            if (line.isEmpty()) continue;
            if (line.size() > kMaxLineBytes) {
                throw std::runtime_error(
                    "RPC log history exceeds the bounded query budget; narrow the date range.");
            }
            const QJsonDocument document = QJsonDocument::fromJson(line);
            if (!document.isObject()) continue;
            const QJsonObject entry = document.object();
            if (!isLogEntry(entry)) continue;
            const qint64 time = qint64(entry.value(QStringLiteral("time")).toDouble());
            if (time < cutoffMs) continue;
            if (!options.agentId.isEmpty()
                && entry.value(QStringLiteral("agentId")).toString() != options.agentId) {
                continue;
            }
            // Binary insertion keeps the newest N across agents and files, even when a
            // viewer appended older saved entries out of chronological order.
            int low = 0;
            int high = rows.size();
            while (low < high) {
                const int middle = (low + high) / 2;
                if (rows.at(middle).time > time) low = middle + 1;
                else high = middle;
            }
            if (low >= limit) continue;
            rows.insert(low, Row{entry, time, line.size()});
            resultBytes += line.size();
            while (rows.size() > limit || resultBytes > kMaxResultBytes) {
                resultBytes -= rows.last().bytes;
                rows.removeLast();
            }
        }
    }
    QJsonArray result;
    for (const Row &row : rows) result.append(row.entry);
    return result;
}

qint64 Store::size(const QString &agentId) const
{
    qint64 total = 0;
    for (const QString &name : filesFor(agentId)) {
        total += QFileInfo(QDir(m_directory).filePath(name)).size();
    }
    return total;
}

void Store::clear(const QString &agentId)
{
    ensureDirectory();
    for (const QString &name : filesFor(agentId)) {
        QFile::remove(QDir(m_directory).filePath(name));
    }
    if (agentId.isEmpty()) {
        m_live = QJsonArray();
        return;
    }
    QJsonArray kept;
    for (const QJsonValue &value : m_live) {
        if (value.toObject().value(QStringLiteral("agentId")).toString() != agentId) {
            kept.append(value);
        }
    }
    m_live = kept;
}

QStringList Store::appendEntries(const QJsonArray &entries)
{
    ensureDirectory();
    // Group by destination file so the de-duplication read happens once per file.
    QHash<QString, QJsonArray> byFile;
    QStringList order;
    for (const QJsonValue &value : entries) {
        const QJsonObject entry = value.toObject();
        if (!isLogEntry(entry)) continue;
        const QString path = filePathFor(entry);
        if (!byFile.contains(path)) order.append(path);
        QJsonArray group = byFile.value(path);
        group.append(entry);
        byFile.insert(path, group);
    }
    QStringList written;
    for (const QString &path : order) {
        QSet<QString> existing;
        {
            QFile file(path);
            if (file.open(QIODevice::ReadOnly)) {
                const QList<QByteArray> lines = file.readAll().split('\n');
                for (const QByteArray &line : lines) {
                    if (line.isEmpty()) continue;
                    const QJsonDocument document = QJsonDocument::fromJson(line);
                    if (!document.isObject()) continue;
                    existing.insert(document.object().value(QStringLiteral("id")).toString());
                }
            }
        }
        bool wrote = false;
        for (const QJsonValue &value : byFile.value(path)) {
            const QJsonObject entry = value.toObject();
            if (existing.contains(entry.value(QStringLiteral("id")).toString())) continue;
            writeEntry(entry);
            wrote = true;
        }
        if (wrote) written.append(path);
    }
    return written;
}

void Store::setLoggingEnabled(const QString &agentId, bool enabled)
{
    if (enabled) m_loggingEnabled.insert(agentId);
    else m_loggingEnabled.remove(agentId);
}

bool Store::loggingEnabled(const QString &agentId) const
{
    return m_loggingEnabled.contains(agentId);
}

} // namespace rpclog
