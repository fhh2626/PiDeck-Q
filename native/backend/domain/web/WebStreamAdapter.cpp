#include "WebStreamAdapter.h"

#include "WebStreamJson.h"

#include <QDateTime>
#include <QJsonDocument>

namespace webstream {
namespace {

qint64 nowMs()
{
    return QDateTime::currentMSecsSinceEpoch();
}

QJsonObject frame(const QString &type)
{
    return QJsonObject{{QStringLiteral("type"), type}};
}

QJsonObject frame(const QString &type, const QString &id)
{
    return QJsonObject{{QStringLiteral("type"), type}, {QStringLiteral("id"), id}};
}

QJsonObject deltaFrame(const QString &type, const QString &id, const QString &delta)
{
    return QJsonObject{{QStringLiteral("type"), type},
                       {QStringLiteral("id"), id},
                       {QStringLiteral("delta"), delta}};
}

/** `value ?? fallback` for the fields the oracle reads as strings. */
QString textOr(const QJsonObject &source, const QString &key, const QString &fallback = QString())
{
    return jsString(coalesce(source.value(key), fallback));
}

} // namespace

QString serializeFrame(const QJsonObject &frame)
{
    const QByteArray json = QJsonDocument(frame).toJson(QJsonDocument::Compact);
    return QStringLiteral("data: ") + QString::fromUtf8(json) + QStringLiteral("\n\n");
}

const char *const kSseDone = "data: [DONE]\n\n";

QVector<QJsonObject> Adapter::push(const QJsonObject &event)
{
    QVector<QJsonObject> frames;
    const QString type = event.value(QStringLiteral("type")).toString();

    // The first assistant message opens one UI message; a later step (tool loop) must
    // not restart the bubble, or the phone shows one card per LLM step.
    if (type == QLatin1String("message_start")) {
        const QJsonObject message = event.value(QStringLiteral("message")).toObject();
        if (message.value(QStringLiteral("role")).toString() != QLatin1String("assistant")
            || m_finished) {
            return frames;
        }
        if (m_currentMessageId.isEmpty()) {
            m_currentMessageId =
                textOr(message, QStringLiteral("id"), QStringLiteral("msg_%1").arg(nowMs()));
            frames.append(QJsonObject{{QStringLiteral("type"), QStringLiteral("start")},
                                      {QStringLiteral("messageId"), m_currentMessageId}});
        } else if (m_activeToolCalls.isEmpty()) {
            // A tool that is still executing must stay in the current step: ai@7 only
            // finds an existing part by toolCallId inside the active step.
            frames.append(frame(QStringLiteral("start-step")));
        }
        return frames;
    }

    if (type == QLatin1String("message_update")
        && event.value(QStringLiteral("assistantMessageEvent")).isObject()) {
        return handleAssistantEvent(event.value(QStringLiteral("assistantMessageEvent")).toObject());
    }

    // A snapshot may be the first observed evidence of a tool on a cold stream (Web was
    // enabled mid-execution), so the declared calls are announced from the snapshot.
    if (type == QLatin1String("message_end")) {
        const QJsonObject message = event.value(QStringLiteral("message")).toObject();
        if (message.value(QStringLiteral("role")).toString() == QLatin1String("assistant")) {
            for (const ToolInput &call :
                 readAssistantToolCalls(message.value(QStringLiteral("content")))) {
                frames.append(startTool(call));
            }
        }
        return frames;
    }

    // Progress can arrive after the LAN page was opened mid-execution, without a start.
    if (type == QLatin1String("tool_execution_update")) return startTool(event);
    if (type == QLatin1String("tool_execution_start")) return startTool(event);
    if (type == QLatin1String("tool_execution_end")) return endTool(event);

    // `agent_end` only ends one LLM step (tools and the next message_start follow); an
    // error is a real failure and finishes the run. Normal completion waits for settled.
    if (type == QLatin1String("agent_end")) {
        if (event.contains(QStringLiteral("error"))) return finishMessage(event);
        return frames;
    }

    if (type == QLatin1String("agent_settled")) return finishMessage(event);

    return frames;
}

QVector<QJsonObject> Adapter::replayActiveTools(const QVector<ToolInput> &snapshot)
{
    // The live translator wins over possibly older polling snapshots.
    for (const ToolInput &call : snapshot) {
        if (!m_startedToolCallSet.contains(call.toolCallId)) startTool(call);
    }
    if (m_currentMessageId.isEmpty() && !m_activeOrder.isEmpty()) {
        // A cold translator seeded mid-tool treats the next assistant as a new step,
        // not as a restart of the UI message that already carries the recovered tools.
        m_currentMessageId = QStringLiteral("tool_") + m_activeOrder.first();
    }
    QVector<QJsonObject> frames;
    for (const QString &toolCallId : m_activeOrder) {
        const ActiveTool &active = m_activeToolCalls[toolCallId];
        frames.append(QJsonObject{{QStringLiteral("type"), QStringLiteral("tool-input-start")},
                                  {QStringLiteral("toolCallId"), toolCallId},
                                  {QStringLiteral("toolName"), active.input.toolName},
                                  {QStringLiteral("dynamic"), true}});
        frames.append(QJsonObject{{QStringLiteral("type"), QStringLiteral("tool-input-available")},
                                  {QStringLiteral("toolCallId"), toolCallId},
                                  {QStringLiteral("toolName"), active.input.toolName},
                                  {QStringLiteral("dynamic"), true},
                                  {QStringLiteral("input"), active.input.args},
                                  {QStringLiteral("toolMetadata"), QJsonObject{}}});
    }
    return frames;
}

QVector<QJsonObject> Adapter::finish()
{
    return finishMessage(QJsonObject{});
}

QVector<QJsonObject> Adapter::handleAssistantEvent(const QJsonObject &event)
{
    QVector<QJsonObject> frames;
    const QString eventType = event.value(QStringLiteral("type")).toString();

    if (eventType == QLatin1String("text_start") || eventType == QLatin1String("text_delta")
        || eventType == QLatin1String("text_end")) {
        const QString delta =
            textOr(event, QStringLiteral("delta"),
                   jsString(coalesce(event.value(QStringLiteral("text")), QString())));
        const QString finalContent = eventType == QLatin1String("text_end")
            ? textOr(event, QStringLiteral("content"))
            : QString();
        if (m_textBlockId.isEmpty()) {
            m_textBlockId = blockId(QStringLiteral("text"));
            m_hasTextDelta = false;
            frames.append(frame(QStringLiteral("text-start"), m_textBlockId));
        }
        if (eventType == QLatin1String("text_delta") && !delta.isEmpty()) {
            m_hasTextDelta = true;
            frames.append(deltaFrame(QStringLiteral("text-delta"), m_textBlockId, delta));
        }
        if (eventType == QLatin1String("text_end") && !m_textBlockId.isEmpty()) {
            // `text_end.content` is authoritative, but only backfill when this block
            // never streamed a delta; otherwise the text would appear twice.
            if (!m_hasTextDelta && !finalContent.isEmpty()) {
                frames.append(deltaFrame(QStringLiteral("text-delta"), m_textBlockId, finalContent));
            }
            frames.append(frame(QStringLiteral("text-end"), m_textBlockId));
            m_textBlockId.clear();
            m_hasTextDelta = false;
        }
        return frames;
    }

    if (eventType == QLatin1String("thinking_delta") || eventType == QLatin1String("thinking_end")) {
        const QString delta =
            textOr(event, QStringLiteral("delta"),
                   jsString(coalesce(event.value(QStringLiteral("thinking")), QString())));
        const QString finalContent = eventType == QLatin1String("thinking_end")
            ? textOr(event, QStringLiteral("content"))
            : QString();
        if (m_reasoningBlockId.isEmpty()) {
            m_reasoningBlockId = blockId(QStringLiteral("reasoning"));
            m_hasReasoningDelta = false;
            frames.append(frame(QStringLiteral("reasoning-start"), m_reasoningBlockId));
        }
        if (eventType == QLatin1String("thinking_delta") && !delta.isEmpty()) {
            m_hasReasoningDelta = true;
            frames.append(deltaFrame(QStringLiteral("reasoning-delta"), m_reasoningBlockId, delta));
        }
        if (eventType == QLatin1String("thinking_end")) {
            // Only backfill from `content` when nothing streamed, or the reasoning text
            // is appended twice.
            if (!m_hasReasoningDelta && !finalContent.isEmpty()) {
                frames.append(
                    deltaFrame(QStringLiteral("reasoning-delta"), m_reasoningBlockId, finalContent));
            }
            frames.append(frame(QStringLiteral("reasoning-end"), m_reasoningBlockId));
            m_reasoningBlockId.clear();
            m_hasReasoningDelta = false;
        }
        return frames;
    }

    // `toolcall_end` completes argument generation, not execution: a subagent can run
    // for minutes afterwards, so only `tool_execution_end` may settle the card.
    if (eventType == QLatin1String("toolcall_start") || eventType == QLatin1String("toolcall_end")) {
        const QJsonValue toolCall = event.value(QStringLiteral("toolCall"));
        if (!toolCall.isObject()) return frames;
        QJsonObject block = toolCall.toObject();
        block.insert(QStringLiteral("type"), QStringLiteral("toolCall"));
        for (const ToolInput &call : readAssistantToolCalls(QJsonArray{QJsonValue(block)})) {
            frames.append(startTool(call));
        }
        return frames;
    }

    // `done` ends this assistant text/thinking block, not the run: a tool turn still has
    // `tool_execution_*` and another `message_start` ahead of it.
    if (eventType == QLatin1String("done")) {
        const QJsonValue message = event.value(QStringLiteral("message"));
        frames = closeOpenBlocks();
        if (message.isObject()) {
            for (const ToolInput &call :
                 readAssistantToolCalls(message.toObject().value(QStringLiteral("content")))) {
                frames.append(startTool(call));
            }
        }
        return frames;
    }

    return frames;
}

QVector<QJsonObject> Adapter::startTool(const QJsonObject &event)
{
    const QString toolName = event.value(QStringLiteral("toolName")).isString()
        ? event.value(QStringLiteral("toolName")).toString()
        : QStringLiteral("tool");
    const QString toolCallId = resolveToolCallId(event.value(QStringLiteral("toolCallId")), toolName);
    if (toolCallId.isEmpty()) return {};
    const QJsonValue args = event.value(QStringLiteral("args"));
    const QJsonValue input = args.isUndefined() || args.isNull() ? retainedToolInput(toolCallId) : args;
    return ensureToolStarted(toolCallId, toolName, input);
}

QVector<QJsonObject> Adapter::startTool(const ToolInput &call)
{
    QJsonObject event{
        {QStringLiteral("toolName"), call.toolName},
        {QStringLiteral("toolCallId"), call.toolCallId},
        {QStringLiteral("args"), call.args},
    };
    return startTool(event);
}

QVector<QJsonObject> Adapter::endTool(const QJsonObject &event)
{
    const QString toolName = event.value(QStringLiteral("toolName")).isString()
        ? event.value(QStringLiteral("toolName")).toString()
        : QStringLiteral("tool");
    const QString toolCallId = resolveToolCallId(event.value(QStringLiteral("toolCallId")), toolName);
    if (toolCallId.isEmpty()) return {};
    const QJsonValue args = event.value(QStringLiteral("args"));
    const QJsonValue input = args.isUndefined() || args.isNull() ? retainedToolInput(toolCallId) : args;
    return finishTool(toolCallId, toolName, input,
                      event.value(QStringLiteral("isError")).toBool(false));
}

QJsonValue Adapter::retainedToolInput(const QString &toolCallId) const
{
    const auto iterator = m_activeToolCalls.constFind(toolCallId);
    // Prefer the structured live value: a bounded replay snapshot would truncate the
    // parameters the user already saw in full.
    if (iterator != m_activeToolCalls.constEnd()) return iterator->liveInput;
    return QJsonObject{};
}

QString Adapter::resolveToolCallId(const QJsonValue &rawId, const QString &toolName)
{
    if (rawId.isString() && !rawId.toString().trimmed().isEmpty()) return rawId.toString();
    // A start/end pair without an id shares the most recent card; synthesizing a new id
    // for the end would leave the card spinning forever.
    if (!m_lastStartedToolCallId.isEmpty()) return m_lastStartedToolCallId;
    if (toolName.isEmpty()) return QString();
    return QStringLiteral("tool_%1_%2").arg(toolName).arg(nowMs());
}

QVector<QJsonObject> Adapter::ensureToolStarted(const QString &toolCallId, const QString &toolName,
                                                const QJsonValue &input)
{
    m_lastStartedToolCallId = toolCallId;
    if (m_finishedToolCallIds.contains(toolCallId)) return {};

    const auto existing = m_activeToolCalls.find(toolCallId);
    if (existing != m_activeToolCalls.end()) {
        // Already announced in this step: only an in-place update is allowed. A second
        // `tool-input-start` would push a duplicated card in the console.
        if (jsonEqual(existing->liveInput, input)) return {};
        const QJsonValue args = snapshotToolInput(input);
        if (jsonEqual(existing->input.args, args) && jsonEqual(existing->liveInput, input)) {
            return {};
        }
        existing->input = ToolInput{toolCallId, toolName, args};
        existing->liveInput = input;
        return {QJsonObject{{QStringLiteral("type"), QStringLiteral("tool-input-available")},
                            {QStringLiteral("toolCallId"), toolCallId},
                            {QStringLiteral("toolName"), toolName},
                            {QStringLiteral("dynamic"), true},
                            {QStringLiteral("input"), input},
                            {QStringLiteral("toolMetadata"), QJsonObject{}}}};
    }

    rememberTool(toolCallId, toolName, snapshotToolInput(input), input);
    // `toolMetadata: {}` clears a "result missing" marker left by an optimistic history
    // projection: the SDK only overwrites when toolMetadata is defined.
    return {QJsonObject{{QStringLiteral("type"), QStringLiteral("tool-input-start")},
                        {QStringLiteral("toolCallId"), toolCallId},
                        {QStringLiteral("toolName"), toolName},
                        {QStringLiteral("dynamic"), true}},
            QJsonObject{{QStringLiteral("type"), QStringLiteral("tool-input-available")},
                        {QStringLiteral("toolCallId"), toolCallId},
                        {QStringLiteral("toolName"), toolName},
                        {QStringLiteral("dynamic"), true},
                        {QStringLiteral("input"), input},
                        {QStringLiteral("toolMetadata"), QJsonObject{}}}};
}

QVector<QJsonObject> Adapter::finishTool(const QString &toolCallId, const QString &toolName,
                                         const QJsonValue &input, bool isError)
{
    QVector<QJsonObject> frames = ensureToolStarted(toolCallId, toolName, input);
    if (m_finishedToolCallIds.contains(toolCallId)) return frames;
    m_finishedToolCallIds.insert(toolCallId);
    forgetTool(toolCallId);
    // The output value is intentionally empty: pi's execution events do not carry a
    // renderable result here, and inventing one would misreport what happened.
    frames.append(isError
                      ? QJsonObject{{QStringLiteral("type"), QStringLiteral("tool-output-error")},
                                    {QStringLiteral("toolCallId"), toolCallId},
                                    {QStringLiteral("errorText"), QStringLiteral("Tool failed")},
                                    {QStringLiteral("toolMetadata"), QJsonObject{}}}
                      : QJsonObject{{QStringLiteral("type"), QStringLiteral("tool-output-available")},
                                    {QStringLiteral("toolCallId"), toolCallId},
                                    {QStringLiteral("output"), QJsonObject{}},
                                    {QStringLiteral("toolMetadata"), QJsonObject{}}});
    return frames;
}

QVector<QJsonObject> Adapter::closeOpenBlocks()
{
    QVector<QJsonObject> frames;
    if (!m_textBlockId.isEmpty()) {
        frames.append(frame(QStringLiteral("text-end"), m_textBlockId));
        m_textBlockId.clear();
        m_hasTextDelta = false;
    }
    if (!m_reasoningBlockId.isEmpty()) {
        frames.append(frame(QStringLiteral("reasoning-end"), m_reasoningBlockId));
        m_reasoningBlockId.clear();
        m_hasReasoningDelta = false;
    }
    return frames;
}

QVector<QJsonObject> Adapter::finishMessage(const QJsonObject &event)
{
    if (m_finished) return {};
    m_finished = true;
    QVector<QJsonObject> frames = closeOpenBlocks();

    // Close dangling tool cards, but never fabricate an output: with no observed
    // execution the only honest state is `input-available` + "result not recorded"
    // (the same contract the desktop projection uses).
    for (const QString &toolCallId : m_startedToolCallIds) {
        if (m_finishedToolCallIds.contains(toolCallId)) continue;
        m_finishedToolCallIds.insert(toolCallId);
        const auto active = m_activeToolCalls.constFind(toolCallId);
        frames.append(
            QJsonObject{{QStringLiteral("type"), QStringLiteral("tool-input-available")},
                        {QStringLiteral("toolCallId"), toolCallId},
                        {QStringLiteral("toolName"),
                         active != m_activeToolCalls.constEnd() ? active->input.toolName
                                                               : QStringLiteral("tool")},
                        {QStringLiteral("dynamic"), true},
                        // Backfill with the live input so an already shown large argument
                        // is not downgraded to its bounded replay snapshot.
                        {QStringLiteral("input"),
                         active != m_activeToolCalls.constEnd() ? active->liveInput
                                                               : QJsonValue(QJsonObject{})},
                        {QStringLiteral("toolMetadata"), missingResultMetadata()}});
    }
    m_activeToolCalls.clear();
    m_activeOrder.clear();

    if (event.contains(QStringLiteral("error"))) {
        const QJsonValue error = event.value(QStringLiteral("error"));
        frames.append(QJsonObject{
            {QStringLiteral("type"), QStringLiteral("error")},
            {QStringLiteral("errorText"), error.isString() ? error.toString()
                                                           : QStringLiteral("Agent 运行失败")}});
    }
    frames.append(frame(QStringLiteral("finish")));
    return frames;
}

QString Adapter::blockId(const QString &prefix)
{
    // Unique per block; tests compare the id across start/delta/end, never its value.
    return QStringLiteral("%1_%2_%3")
        .arg(prefix)
        .arg(nowMs())
        .arg(++m_blockCounter, 0, 36);
}

void Adapter::rememberTool(const QString &toolCallId, const QString &toolName,
                           const QJsonValue &args, const QJsonValue &liveInput)
{
    if (!m_activeToolCalls.contains(toolCallId)) m_activeOrder.append(toolCallId);
    m_activeToolCalls.insert(toolCallId, ActiveTool{ToolInput{toolCallId, toolName, args}, liveInput});
    if (!m_startedToolCallSet.contains(toolCallId)) {
        m_startedToolCallSet.insert(toolCallId);
        m_startedToolCallIds.append(toolCallId);
    }
}

void Adapter::forgetTool(const QString &toolCallId)
{
    m_activeToolCalls.remove(toolCallId);
    m_activeOrder.removeAll(toolCallId);
}

} // namespace webstream
