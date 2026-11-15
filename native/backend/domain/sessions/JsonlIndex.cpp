#include "JsonlIndex.h"

#include "PiTaskMessage.h"

#include "../ChannelRegistry.h"

#include <QCryptographicHash>
#include <QFile>
#include <QFileInfo>
#include <QJsonDocument>
#include <QJsonObject>

#include <algorithm>

QString JsonlIndex::version() const
{
    return QStringLiteral("%1:%2").arg(qint64(mtimeMs)).arg(qint64(size));
}

namespace jsonlindex {

const char *const kHistoryChangedCode = "SESSION_HISTORY_CHANGED";

namespace {

struct Row {
    QByteArray text;
    qint64 offset = 0;
    qint64 byteLength = 0;
    bool terminated = true;
};

QByteArray digestOf(const QByteArray &text)
{
    return QCryptographicHash::hash(text, QCryptographicHash::Sha256).toHex();
}

/** Parse one row into an index entry; returns false for rows without an id. */
bool addRow(JsonlIndex *index, const Row &row, QString *rowId)
{
    rowId->clear();
    ++index->rowCount;
    index->endsWithNewline = row.terminated;

    QJsonParseError parseError{};
    const QJsonDocument document = QJsonDocument::fromJson(row.text, &parseError);
    if (parseError.error != QJsonParseError::NoError || !document.isObject()) return false;
    const QJsonObject value = document.object();

    const QJsonObject projected = pitask::displayEntry(value);
    const QJsonValue messageValue = projected.value(QStringLiteral("message"));
    const QJsonObject message = messageValue.isObject() ? messageValue.toObject() : QJsonObject{};

    IndexEntry entry;
    entry.id = value.value(QStringLiteral("id")).toString();
    entry.parentId = value.value(QStringLiteral("parentId")).toString();
    entry.type = projected.value(QStringLiteral("type")).toString();
    entry.offset = row.offset;
    entry.byteLength = row.byteLength;
    entry.rowDigest = digestOf(row.text);
    entry.hasMessage = !messageValue.isUndefined() && !messageValue.isNull();
    entry.hasTruthyMessage = messageValue.isObject() ? !message.isEmpty() : messageValue.toBool(false);
    // A visible task message is a turn boundary, but its raw custom role stays in the
    // body. Since e978ad8a the oracle recognises the resume guidance as well as the
    // goal; `turnBoundary` is the field paging/targeting read on both sides.
    pitask::TaskMessage task;
    if (pitask::readTodoTaskMessage(messageValue, &task)) {
        entry.role = QStringLiteral("user");
        entry.turnBoundary = true;
    } else {
        entry.role = message.value(QStringLiteral("role")).toString();
    }
    entry.messageId = message.value(QStringLiteral("id")).toString();
    // Only toolResult carries a cross-page tool identity; it is a short string and
    // never requires reading the result body.
    if (message.value(QStringLiteral("role")).toString() == QLatin1String("toolResult")) {
        entry.toolCallId = message.value(QStringLiteral("toolCallId")).toString();
    }
    entry.summary = value.value(QStringLiteral("summary")).toString();
    entry.firstKeptEntryId = value.value(QStringLiteral("firstKeptEntryId")).toString();
    entry.timestamp = value.value(QStringLiteral("timestamp")).toString();
    if (value.value(QStringLiteral("tokensBefore")).isDouble()) {
        entry.hasTokensBefore = true;
        entry.tokensBefore = qint64(value.value(QStringLiteral("tokensBefore")).toDouble());
    }

    // Full-text lookup is physical-first: the first occurrence wins, unlike the
    // active branch where the last duplicate id is the live one.
    if (!entry.id.isEmpty() && !index->firstEntries.contains(entry.id)) {
        index->firstEntries.insert(entry.id, entry);
    }
    if (!entry.messageId.isEmpty() && !index->firstMessages.contains(entry.messageId)) {
        index->firstMessages.insert(entry.messageId, entry);
    }
    if (value.value(QStringLiteral("type")).toString() == QLatin1String("compaction")) {
        IndexCompaction compaction;
        compaction.id = entry.id;
        compaction.summary = entry.summary;
        compaction.timestamp = entry.timestamp;
        compaction.firstKeptEntryId = entry.firstKeptEntryId;
        compaction.hasTokensBefore = entry.hasTokensBefore;
        compaction.tokensBefore = entry.tokensBefore;
        index->compactions.append(compaction);
    }
    if (entry.id.isEmpty()) return false;
    index->entries.insert(entry.id, entry);
    *rowId = entry.id;
    return true;
}

void finish(JsonlIndex *index, const QString &leafId)
{
    QVector<IndexEntry> branch;
    QSet<QString> seen;
    QString currentId = leafId;
    while (!currentId.isEmpty() && !seen.contains(currentId)) {
        seen.insert(currentId);
        const auto found = index->entries.constFind(currentId);
        if (found == index->entries.constEnd()) break;
        branch.append(*found);
        currentId = found->parentId;
    }
    std::reverse(branch.begin(), branch.end());
    index->activeBranch = branch;
    // Result ids come from the active branch only: a toolResult on an abandoned
    // branch must not launder an orphan call on the current branch into "has result".
    for (const IndexEntry &entry : branch) {
        if (entry.type == QLatin1String("message") && entry.role == QLatin1String("toolResult")
            && !entry.toolCallId.isEmpty()) {
            index->activeToolResultIds.insert(entry.toolCallId);
        }
    }
    index->hasCompaction = false;
    for (const IndexEntry &entry : branch) {
        if (entry.type == QLatin1String("compaction")) {
            index->hasCompaction = true;
            break;
        }
    }
    for (const IndexEntry &entry : branch) {
        if (entry.type == QLatin1String("message") && entry.hasMessage) {
            index->activeMessageEntries.append(entry);
        }
    }
}

} // namespace

JsonlIndex build(const QString &hostPath)
{
    QFile file(hostPath);
    if (!file.open(QIODevice::ReadOnly)) {
        throw ChannelError(QStringLiteral("Unable to read session file: %1").arg(hostPath));
    }
    const QFileInfo info(file);
    JsonlIndex index;
    index.hostPath = hostPath;
    index.size = info.size();
    index.mtimeMs = qint64(info.lastModified().toMSecsSinceEpoch());

    // Stream in 64 KiB chunks and join fragments once per row: never re-copy a growing
    // buffer (the prototype's `remove(0, n)` was quadratic on large sessions).
    QByteArray carry;
    qint64 position = 0;
    qint64 rowOffset = 0;
    QString leafId;
    while (true) {
        const QByteArray chunk = file.read(64 * 1024);
        if (chunk.isEmpty()) break;
        qint64 from = 0;
        while (from < chunk.size()) {
            const int boundary = chunk.indexOf('\n', int(from));
            if (boundary < 0) {
                carry.append(chunk.mid(int(from)));
                break;
            }
            QByteArray row = carry;
            row.append(chunk.mid(int(from), boundary - int(from)));
            carry.clear();
            Row parsed{row, rowOffset, qint64(row.size()), true};
            QString rowId;
            if (addRow(&index, parsed, &rowId)) leafId = rowId;
            rowOffset += qint64(row.size()) + 1;
            from = boundary + 1;
        }
        position += chunk.size();
    }
    if (!carry.isEmpty()) {
        Row parsed{carry, rowOffset, qint64(carry.size()), false};
        QString rowId;
        if (addRow(&index, parsed, &rowId)) leafId = rowId;
    }
    Q_UNUSED(position);
    finish(&index, leafId);
    return index;
}

QVector<QJsonValue> readMessages(const JsonlIndex &index, const QVector<IndexEntry> &entries)
{
    QVector<QJsonValue> result;
    if (entries.isEmpty()) return result;
    QFile file(index.hostPath);
    if (!file.open(QIODevice::ReadOnly)) {
        throw ChannelError(QStringLiteral("Unable to read session file: %1").arg(index.hostPath));
    }
    // Coalesce adjacent rows into one read, capped so a huge page never allocates
    // unbounded memory.
    int from = 0;
    while (from < entries.size()) {
        int to = from + 1;
        qint64 end = entries.at(from).offset + entries.at(from).byteLength;
        while (to < entries.size() && entries.at(to).offset == end + 1
               && entries.at(to).offset + entries.at(to).byteLength - entries.at(from).offset
                   <= 1024 * 1024) {
            end = entries.at(to).offset + entries.at(to).byteLength;
            ++to;
        }
        const qint64 base = entries.at(from).offset;
        if (!file.seek(base)) throw ChannelError(QStringLiteral("Unable to seek session file"));
        const QByteArray buffer = file.read(end - base);
        if (buffer.size() != end - base) {
            throw ChannelError(QLatin1String(kHistoryChangedCode));
        }
        for (int position = from; position < to; ++position) {
            const IndexEntry &entry = entries.at(position);
            const qint64 offset = entry.offset - base;
            const QByteArray text = buffer.mid(int(offset), int(entry.byteLength));
            // The digest check is what makes an in-place edit safe: serving a body that
            // no longer matches the indexed row would silently show stale content.
            if (digestOf(text) != entry.rowDigest) throw ChannelError(QLatin1String(kHistoryChangedCode));
            QJsonParseError parseError{};
            const QJsonDocument document = QJsonDocument::fromJson(text, &parseError);
            if (parseError.error != QJsonParseError::NoError || !document.isObject()) {
                throw ChannelError(QLatin1String(kHistoryChangedCode));
            }
            const QJsonObject row = document.object();
            if (!entry.id.isEmpty() && row.value(QStringLiteral("id")).toString() != entry.id) {
                throw ChannelError(QLatin1String(kHistoryChangedCode));
            }
            result.append(pitask::displayEntry(row).value(QStringLiteral("message")));
        }
        from = to;
    }
    return result;
}

Store::Store(int limit) : m_limit(limit) {}

void Store::touch(const QString &hostPath, const JsonlIndex &index)
{
    m_order.removeAll(hostPath);
    m_order.append(hostPath);
    m_cache.insert(hostPath, index);
    while (m_order.size() > m_limit) {
        const QString oldest = m_order.takeFirst();
        m_cache.remove(oldest);
    }
}

JsonlIndex Store::get(const QString &hostPath)
{
    const QFileInfo info(hostPath);
    const qint64 mtimeMs = qint64(info.lastModified().toMSecsSinceEpoch());
    const qint64 size = info.size();
    const auto cached = m_cache.constFind(hostPath);
    if (cached != m_cache.constEnd() && cached->mtimeMs == mtimeMs && cached->size == size) {
        const JsonlIndex index = *cached;
        touch(hostPath, index);
        return index;
    }
    JsonlIndex index = build(hostPath);
    touch(hostPath, index);
    return index;
}

void Store::clear()
{
    m_order.clear();
    m_cache.clear();
}

} // namespace jsonlindex
