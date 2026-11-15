#include "WebStreamTools.h"

#include "WebStreamJson.h"

#include <QJsonDocument>

namespace webstream {
namespace {

/** `JSON.stringify(value)` for one scalar/array/object (compact, no wrapper). */
QByteArray serialize(const QJsonValue &value)
{
    if (value.isObject()) return QJsonDocument(value.toObject()).toJson(QJsonDocument::Compact);
    if (value.isArray()) return QJsonDocument(value.toArray()).toJson(QJsonDocument::Compact);
    const QByteArray wrapped =
        QJsonDocument(QJsonArray{value}).toJson(QJsonDocument::Compact);
    return wrapped.mid(1, wrapped.size() - 2);
}

/** `JSON.parse(text)`; an unparseable scalar keeps the original text (readable input). */
QJsonValue parseValue(const QByteArray &text)
{
    const QJsonDocument document = QJsonDocument::fromJson(text);
    if (document.isArray()) return document.array();
    if (document.isObject()) return document.object();
    const QJsonDocument wrapped = QJsonDocument::fromJson('[' + text + ']');
    if (wrapped.isArray() && !wrapped.array().isEmpty()) return wrapped.array().at(0);
    return QJsonValue();
}

/** Truncate to the replay budget with the oracle's ellipsis suffix. */
QString bounded(const QString &text)
{
    if (text.size() <= kMaxReplayInputChars) return text;
    return text.left(kMaxReplayInputChars) + QStringLiteral("…");
}

} // namespace

QJsonValue snapshotToolInput(const QJsonValue &input)
{
    if (input.isString()) {
        // Already-truncated JSON snapshots stay strings; quoting them again would make
        // the next replay escape its own quotes.
        return bounded(input.toString());
    }
    const QJsonValue effective = input.isUndefined() || input.isNull() ? QJsonValue(QJsonObject{})
                                                                      : input;
    const QByteArray text = serialize(effective);
    if (text.isEmpty()) return QJsonObject{};
    const QString rendered = QString::fromUtf8(text);
    if (rendered.size() > kMaxReplayInputChars) return bounded(rendered);
    return parseValue(text);
}

QVector<ToolInput> readAssistantToolCalls(const QJsonValue &content)
{
    QVector<ToolInput> calls;
    if (!content.isArray()) return calls;
    for (const QJsonValue &value : content.toArray()) {
        if (!value.isObject()) continue;
        const QJsonObject block = value.toObject();
        if (block.value(QStringLiteral("type")).toString() != QLatin1String("toolCall")) continue;
        const QJsonValue id = block.value(QStringLiteral("id"));
        const QJsonValue name = block.value(QStringLiteral("name"));
        if (!id.isString() || id.toString().trimmed().isEmpty()) continue;
        if (!name.isString() || name.toString().trimmed().isEmpty()) continue;
        ToolInput call;
        call.toolCallId = id.toString();
        call.toolName = name.toString();
        const QJsonValue arguments = block.value(QStringLiteral("arguments"));
        const QJsonValue input = block.value(QStringLiteral("input"));
        call.args = coalesce(coalesce(arguments, input), QJsonValue(QJsonObject{}));
        calls.append(call);
    }
    return calls;
}

QJsonObject missingResultMetadata()
{
    // Mirrors `toolResultMissingMetadata()` in src/shared/toolOutcome.ts.
    return QJsonObject{{QStringLiteral("resultMissing"), true}};
}

QVector<ToolInput> readCurrentToolInputs(const QString &sessionId, const QJsonArray &runtimes,
                                         const QJsonObject &snapshot)
{
    QJsonObject runtime;
    for (const QJsonValue &value : runtimes) {
        const QJsonObject row = value.toObject();
        if (row.value(QStringLiteral("sessionId")).toString() != sessionId) continue;
        if (row.value(QStringLiteral("status")).toString() != QLatin1String("running")) continue;
        runtime = row;
        break;
    }
    if (runtime.isEmpty() || snapshot.isEmpty()) return {};
    const QJsonObject target = snapshot.value(QStringLiteral("target")).toObject();
    if (target.value(QStringLiteral("sessionId")).toString() != sessionId) return {};
    if (target.value(QStringLiteral("agentId")).toString()
        != runtime.value(QStringLiteral("agentId")).toString()) {
        return {};
    }
    if (target.value(QStringLiteral("runtimeGeneration")).toInt()
        != runtime.value(QStringLiteral("runtimeGeneration")).toInt()) {
        return {};
    }
    return readRunningTools(snapshot.value(QStringLiteral("value")).toArray());
}

QVector<ToolInput> readRunningTools(const QJsonArray &messages)
{
    QVector<ToolInput> calls;
    for (const QJsonValue &value : messages) {
        if (!value.isObject()) continue;
        const QJsonObject message = value.toObject();
        if (message.value(QStringLiteral("role")).toString() != QLatin1String("tool")) continue;
        const QJsonObject meta = message.value(QStringLiteral("meta")).toObject();
        if (meta.value(QStringLiteral("status")).toString() != QLatin1String("running")) continue;
        const QString toolCallId = meta.value(QStringLiteral("toolCallId")).toString();
        const QString toolName = meta.value(QStringLiteral("toolName")).toString();
        if (toolCallId.trimmed().isEmpty() || toolName.trimmed().isEmpty()) continue;
        QJsonValue input = meta.value(QStringLiteral("args"));
        if (input.isUndefined() || input.isNull()) input = QJsonObject{};
        if (input.isString()) {
            // Older/truncated rows keep the JSON text; parse it when it is valid.
            const QJsonValue parsed = parseValue(input.toString().toUtf8());
            if (!parsed.isUndefined()) input = parsed;
        }
        ToolInput call;
        call.toolCallId = toolCallId;
        call.toolName = toolName;
        call.args = snapshotToolInput(input);
        calls.append(call);
    }
    return calls;
}

} // namespace webstream
