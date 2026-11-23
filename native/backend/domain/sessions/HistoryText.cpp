#include "HistoryText.h"

#include "MessageContent.h"

#include <QJsonArray>
#include <QJsonDocument>
#include <QSet>

namespace historytext {
namespace {

QString compactJson(const QJsonValue &value)
{
    if (value.isString()) {
        const QByteArray bytes = QJsonDocument(QJsonArray{value}).toJson(QJsonDocument::Compact);
        return QString::fromUtf8(bytes.mid(1).chopped(1));
    }
    if (value.isObject()) return QString::fromUtf8(QJsonDocument(value.toObject()).toJson(QJsonDocument::Compact));
    if (value.isArray()) return QString::fromUtf8(QJsonDocument(value.toArray()).toJson(QJsonDocument::Compact));
    return QString::fromUtf8(QJsonDocument(QJsonArray{value}).toJson(QJsonDocument::Compact)).mid(1).chopped(1);
}

/**
 * `JSON.stringify(value, null, 2)`: two-space indent, no trailing newline.
 * Qt only exposes Compact/Indented (4 spaces), and the oracle's args/details text is
 * compared byte-for-byte by the full-output viewer and export paths.
 */
QString prettyJson(const QJsonValue &value, int depth = 0)
{
    const QString pad(2 * depth, QLatin1Char(' '));
    const QString innerPad(2 * (depth + 1), QLatin1Char(' '));
    if (value.isObject()) {
        const QJsonObject object = value.toObject();
        if (object.isEmpty()) return QStringLiteral("{}");
        QStringList lines;
        for (auto iterator = object.constBegin(); iterator != object.constEnd(); ++iterator) {
            lines.append(innerPad + compactJson(QJsonValue(iterator.key())) + QStringLiteral(": ")
                         + prettyJson(iterator.value(), depth + 1));
        }
        return QStringLiteral("{\n") + lines.join(QStringLiteral(",\n")) + QLatin1Char('\n') + pad
            + QLatin1Char('}');
    }
    if (value.isArray()) {
        const QJsonArray array = value.toArray();
        if (array.isEmpty()) return QStringLiteral("[]");
        QStringList lines;
        for (const QJsonValue &item : array) lines.append(innerPad + prettyJson(item, depth + 1));
        return QStringLiteral("[\n") + lines.join(QStringLiteral(",\n")) + QLatin1Char('\n') + pad
            + QLatin1Char(']');
    }
    return compactJson(value);
}

QString stringify(const QJsonValue &value)
{
    if (value.isUndefined() || value.isNull()) return QString();
    if (value.isString()) return value.toString();
    return prettyJson(value);
}

QString argsTextOf(const QJsonValue &rawArgs)
{
    if (rawArgs.isString()) return rawArgs.toString();
    if (rawArgs.isObject() || rawArgs.isArray()) return stringify(rawArgs);
    if (rawArgs.isUndefined() || rawArgs.isNull()) return QString();
    return stringify(rawArgs);
}

} // namespace

QString syntheticHistoryEntryId(const QString &messageId)
{
    const QString marker = QStringLiteral("-history-");
    const int index = messageId.lastIndexOf(marker);
    if (index < 0) return QString();
    return messageId.mid(index + marker.size());
}

QString extractEntryResultText(const QJsonValue &message)
{
    if (!message.isObject()) return QString();
    const QJsonValue content = message.toObject().value(QStringLiteral("content"));
    if (content.isString()) return content.toString();
    if (!content.isArray()) return QString();
    QStringList parts;
    for (const QJsonValue &item : content.toArray()) {
        if (!item.isObject()) continue;
        const QJsonValue text = item.toObject().value(QStringLiteral("text"));
        if (text.isString() && !text.toString().isEmpty()) parts.append(text.toString());
    }
    return parts.join(QLatin1Char('\n'));
}

FullText readMessageFullText(const JsonlIndex &index, const QString &messageId, const QString &entryId)
{
    FullText result;
    const IndexEntry *entry = nullptr;
    if (!entryId.isEmpty()) {
        const auto found = index.firstEntries.constFind(entryId);
        if (found != index.firstEntries.constEnd()) entry = &*found;
    } else {
        const auto found = index.firstMessages.constFind(messageId);
        if (found != index.firstMessages.constEnd()) entry = &*found;
    }
    if (!entry) {
        result.error = QStringLiteral("Message %1 not found in session file").arg(messageId);
        return result;
    }
    QVector<QJsonValue> raw;
    try {
        raw = jsonlindex::readMessages(index, QVector<IndexEntry>{*entry});
    } catch (const std::exception &error) {
        result.error = QString::fromUtf8(error.what());
        return result;
    }
    if (raw.isEmpty()) {
        result.error = QStringLiteral("Message %1 not found in session file").arg(messageId);
        return result;
    }
    result.text = extractEntryResultText(raw.first());
    if (result.text.isEmpty()) {
        result.error = QStringLiteral("Message %1 has no extractable text content").arg(messageId);
        return result;
    }
    result.ok = true;
    return result;
}

QHash<QString, ToolExportPayload> readToolExportPayloads(const JsonlIndex &index,
                                                         const QStringList &messageIds)
{
    QHash<QString, ToolExportPayload> result;
    QStringList cleanIds;
    QSet<QString> seen;
    for (const QString &id : messageIds) {
        const QString trimmed = id.trimmed();
        if (trimmed.isEmpty() || seen.contains(trimmed)) continue;
        seen.insert(trimmed);
        cleanIds.append(trimmed);
    }
    if (cleanIds.isEmpty()) return result;

    // Resolve requested renderer ids to active-branch entries.
    QHash<QString, int> targetPositions;
    for (const QString &requested : cleanIds) {
        const QString syntheticId = syntheticHistoryEntryId(requested);
        for (int position = 0; position < index.activeMessageEntries.size(); ++position) {
            const IndexEntry &entry = index.activeMessageEntries.at(position);
            if (entry.messageId == requested || entry.id == requested
                || (!syntheticId.isEmpty() && entry.id == syntheticId)) {
                targetPositions.insert(requested, position);
                break;
            }
        }
    }
    if (targetPositions.isEmpty()) return result;

    QVector<IndexEntry> toRead;
    for (const IndexEntry &entry : index.activeMessageEntries) {
        if (entry.role == QLatin1String("assistant") || entry.role == QLatin1String("toolResult")) {
            toRead.append(entry);
        }
    }
    if (toRead.isEmpty()) return result;
    QVector<QJsonValue> rawList;
    try {
        rawList = jsonlindex::readMessages(index, toRead);
    } catch (const std::exception &) {
        return result;
    }
    QHash<QString, int> positionByEntryId;
    for (int position = 0; position < toRead.size(); ++position) {
        positionByEntryId.insert(toRead.at(position).id, position);
    }

    // callId -> serialized arguments, gathered from every assistant toolCall block.
    QHash<QString, QString> argsByCallId;
    for (int position = 0; position < toRead.size(); ++position) {
        if (toRead.at(position).role != QLatin1String("assistant")) continue;
        const QJsonValue content = rawList.at(position).toObject().value(QStringLiteral("content"));
        if (!content.isArray()) continue;
        for (const QJsonValue &blockValue : content.toArray()) {
            if (!blockValue.isObject()) continue;
            const QJsonObject block = blockValue.toObject();
            if (block.value(QStringLiteral("type")).toString() != QLatin1String("toolCall")) continue;
            const QJsonValue id = block.value(QStringLiteral("id"));
            if (id.isUndefined() || id.isNull()) continue;
            argsByCallId.insert(id.isString() ? id.toString() : QString::number(id.toDouble()),
                                argsTextOf(block.value(QStringLiteral("arguments"))));
        }
    }

    for (auto iterator = targetPositions.constBegin(); iterator != targetPositions.constEnd(); ++iterator) {
        const QString &requested = iterator.key();
        const IndexEntry &entry = index.activeMessageEntries.at(iterator.value());
        const int position = positionByEntryId.value(entry.id, -1);
        if (position < 0) {
            result.insert(requested, ToolExportPayload{});
            continue;
        }
        const QJsonObject message = rawList.at(position).toObject();
        ToolExportPayload payload;
        const QString role = message.value(QStringLiteral("role")).toString();
        if (role == QLatin1String("toolResult")) {
            const QString text = extractEntryResultText(message);
            if (!text.isEmpty()) {
                payload.hasResultText = true;
                payload.resultText = text;
            } else if (message.contains(QStringLiteral("content"))) {
                const QString serialized = stringify(message.value(QStringLiteral("content")));
                payload.hasResultText = !serialized.isEmpty();
                payload.resultText = serialized;
            }
            if (message.contains(QStringLiteral("details"))) {
                const QString details = stringify(message.value(QStringLiteral("details")));
                payload.hasDetailsText = !details.isEmpty();
                payload.detailsText = details;
            }
            const QJsonValue toolCallId = message.value(QStringLiteral("toolCallId"));
            if (!toolCallId.isUndefined() && !toolCallId.isNull()) {
                const QString key = toolCallId.isString() ? toolCallId.toString()
                                                          : QString::number(toolCallId.toDouble());
                const auto found = argsByCallId.constFind(key);
                if (found != argsByCallId.constEnd()) {
                    payload.hasArgsText = true;
                    payload.argsText = *found;
                }
            }
        } else if (role == QLatin1String("assistant")) {
            const QJsonValue content = message.value(QStringLiteral("content"));
            if (content.isArray()) {
                for (const QJsonValue &blockValue : content.toArray()) {
                    if (!blockValue.isObject()) continue;
                    const QJsonObject block = blockValue.toObject();
                    if (block.value(QStringLiteral("type")).toString() != QLatin1String("toolCall")) continue;
                    payload.hasArgsText = true;
                    payload.argsText = argsTextOf(block.value(QStringLiteral("arguments")));
                    const QJsonValue callId = block.value(QStringLiteral("id"));
                    if (callId.isUndefined() || callId.isNull()) break;
                    const QString key = callId.isString() ? callId.toString()
                                                          : QString::number(callId.toDouble());
                    for (int candidate = 0; candidate < toRead.size(); ++candidate) {
                        if (toRead.at(candidate).role != QLatin1String("toolResult")) continue;
                        const QJsonObject response = rawList.at(candidate).toObject();
                        const QJsonValue responseId = response.value(QStringLiteral("toolCallId"));
                        const QString responseKey = responseId.isString()
                            ? responseId.toString()
                            : QString::number(responseId.toDouble());
                        if (responseKey != key) continue;
                        const QString text = extractEntryResultText(response);
                        if (!text.isEmpty()) {
                            payload.hasResultText = true;
                            payload.resultText = text;
                        } else if (response.contains(QStringLiteral("content"))) {
                            const QString serialized = stringify(response.value(QStringLiteral("content")));
                            payload.hasResultText = !serialized.isEmpty();
                            payload.resultText = serialized;
                        }
                        if (response.contains(QStringLiteral("details"))) {
                            const QString details = stringify(response.value(QStringLiteral("details")));
                            payload.hasDetailsText = !details.isEmpty();
                            payload.detailsText = details;
                        }
                        break;
                    }
                    break;
                }
            }
        }
        result.insert(requested, payload);
    }
    return result;
}

ResendTarget readMessageByMessageId(const JsonlIndex &index, const QString &messageId)
{
    ResendTarget target;
    if (messageId.isEmpty()) return target;
    const QString syntheticId = syntheticHistoryEntryId(messageId);
    const IndexEntry *entry = nullptr;
    for (const IndexEntry &candidate : index.activeMessageEntries) {
        if (candidate.messageId == messageId || candidate.id == messageId
            || (!syntheticId.isEmpty() && candidate.id == syntheticId)) {
            entry = &candidate;
            break;
        }
    }
    if (!entry) return target;
    QVector<QJsonValue> raw;
    try {
        raw = jsonlindex::readMessages(index, QVector<IndexEntry>{*entry});
    } catch (const std::exception &) {
        return target;
    }
    if (raw.isEmpty()) return target;
    const QJsonValue content = raw.first().toObject().value(QStringLiteral("content"));
    const messagecontent::ResendContent extracted = messagecontent::extractResendContent(content);
    target.found = true;
    target.entryId = entry->id;
    target.role = entry->role;
    target.text = extracted.text;
    target.images = extracted.images;
    return target;
}

} // namespace historytext
