#include "UsageLogReader.h"

#include <QFile>
#include <QFileInfo>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QJsonValue>
#include <QSet>

#include <cmath>

namespace usage {
namespace {

/**
 * 合法字段数：10（旧版）或 11（新版，多一个 costKnown）。
 * 费用字段仅为兼容上游行格式而存在，PiDeck 不读取也不聚合费用。
 */
bool acceptedFieldCount(int count)
{
    return count == 10 || count == 11;
}

bool finiteNumber(const QJsonValue &value, double *out = nullptr)
{
    if (!value.isDouble()) return false;
    const double number = value.toDouble();
    if (!std::isfinite(number)) return false;
    if (out) *out = number;
    return true;
}

bool statFile(const QString &logPath, QFileInfo *info)
{
    const QFileInfo candidate(logPath);
    if (!candidate.exists() || !candidate.isFile()) return false;
    *info = candidate;
    return true;
}

/** 行尾 \r 剥离（CRLF 兼容）。 */
QString stripCarriageReturn(QString line)
{
    if (line.endsWith(QLatin1Char('\r'))) line.chop(1);
    return line;
}

} // namespace

bool parseLine(const QString &line, Record *record)
{
    if (line.trimmed().isEmpty()) return false;

    QJsonParseError error{};
    const QJsonDocument document = QJsonDocument::fromJson(line.toUtf8(), &error);
    if (error.error != QJsonParseError::NoError) return false;
    if (!document.isArray()) return false;
    const QJsonArray row = document.array();
    if (!acceptedFieldCount(row.size())) return false;

    Record parsed;
    if (!finiteNumber(row.at(0), &parsed.ts) || parsed.ts <= 0) return false;
    if (!row.at(1).isString()) return false;
    parsed.sid = row.at(1).toString();
    if (parsed.sid.isEmpty()) return false;
    if (!row.at(2).isString()) return false;
    parsed.cwd = row.at(2).toString();
    if (!row.at(3).isString()) return false;
    parsed.model = row.at(3).toString();
    if (parsed.model.isEmpty()) return false;
    // 数值字段非法一律当坏行：静默清零会让脏数据污染统计。
    if (!finiteNumber(row.at(4), &parsed.input)) return false;
    if (!finiteNumber(row.at(5), &parsed.output)) return false;
    if (!finiteNumber(row.at(6), &parsed.cacheRead)) return false;
    if (!finiteNumber(row.at(7), &parsed.cacheWrite)) return false;
    if (!finiteNumber(row.at(8), &parsed.totalTokens)) return false;

    *record = parsed;
    return true;
}

ReadResult readIncremental(const QString &logPath, const FileState *previous, qint64 maxBytes)
{
    ReadResult result;
    QFileInfo info;
    if (!statFile(logPath, &info)) return result;

    const qint64 size = info.size();
    const double mtimeMs = static_cast<double>(info.lastModified().toMSecsSinceEpoch());
    // Qt does not expose the NTFS file index, so identity is detected through the
    // size/mtime pair below. A replaced file with identical size and mtime is the
    // only case the Node oracle catches and this port does not; it is documented in
    // the migration plan rather than silently assumed away.
    const quint64 ino = 0;
    const bool hasIno = false;

    result.fullRescan = !previous || size < previous->size
        // 同尺寸原地重写（mtime 变化）也重扫：append-only 假设之外的防御。
        || (size == previous->size && !qFuzzyCompare(mtimeMs + 1.0, previous->mtimeMs + 1.0));

    if (previous && !result.fullRescan && size == previous->size
        && qFuzzyCompare(mtimeMs + 1.0, previous->mtimeMs + 1.0)) {
        // 无变化：直接复用旧游标，零 IO。
        result.fileState = *previous;
        result.hasFileState = true;
        return result;
    }

    // 超限截读：正常增量只涉及新增段，超限只可能出现在全量重扫。
    result.truncated = size > maxBytes;
    const qint64 startOffset = result.fullRescan ? 0 : previous->size;
    const qint64 endOffset = result.truncated ? maxBytes - 1 : size - 1;

    QFile file(logPath);
    if (!file.open(QIODevice::ReadOnly)) return result;
    if (startOffset > 0) file.seek(startOffset);

    QSet<QString> seenKeys;
    QByteArray pending;
    constexpr qint64 kChunk = 64 * 1024;
    qint64 remaining = endOffset >= startOffset ? endOffset - startOffset + 1 : 0;

    const auto consume = [&](const QByteArray &rawLine) {
        const QString line = stripCarriageReturn(QString::fromUtf8(rawLine));
        if (line.trimmed().isEmpty()) return;
        Record record;
        if (!parseLine(line, &record)) {
            result.skippedLines += 1;
            return;
        }
        // 本次读取范围内去重：防御非 append 改写造成的段内重复。
        const QString key = QString::number(record.ts) + QLatin1Char('|') + record.sid
            + QLatin1Char('|') + record.model;
        if (seenKeys.contains(key)) return;
        seenKeys.insert(key);
        result.newRecords.append(record);
    };

    while (remaining > 0) {
        const QByteArray chunk = file.read(qMin(kChunk, remaining));
        if (chunk.isEmpty()) break;
        remaining -= chunk.size();
        pending.append(chunk);
        int newline = pending.indexOf('\n');
        while (newline != -1) {
            consume(pending.left(newline));
            pending.remove(0, newline + 1);
            newline = pending.indexOf('\n');
        }
    }
    // 末尾没有换行的残行也要解析（append 中途读取的常见形态）。
    if (!pending.isEmpty()) consume(pending);

    result.hasFileState = true;
    result.fileState.size = size;
    result.fileState.mtimeMs = mtimeMs;
    result.fileState.ino = ino;
    result.fileState.hasIno = hasIno;
    result.fileState.count = result.fullRescan
        ? result.newRecords.size()
        : (previous ? previous->count : 0) + result.newRecords.size();
    return result;
}

} // namespace usage
