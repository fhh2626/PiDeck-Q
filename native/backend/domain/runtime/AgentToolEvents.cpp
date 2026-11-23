#include "AgentToolEvents.h"

#include "ToolCallBatch.h"

#include <QDateTime>
#include <QJsonObject>

/**
 * Tool frames: transcript row, subagent projection and the aggregate executing edge.
 *
 * Order and payload follow `AgentManager.handlePiEvent`'s three tool branches
 * (`src/main/pi/AgentManager.ts`):
 *  - start/end publish the tool edge from the *raw* event, before the async full
 *    `get_state`/`get_session_stats` poll can land, so a fast tool still shows
 *    `true → false`;
 *  - `tool_execution_update` only touches one transcript row and coalesces its flush
 *    (per-update full state polls were an RPC storm on long outputs);
 *  - tool rows share the message flush window so a burst of completions does not
 *    repeat image-heavy snapshots; runtime edges are still immediate.
 */
namespace agentruntime {
namespace {

qint64 nowMs()
{
    return QDateTime::currentMSecsSinceEpoch();
}

/** Absorb one tool frame into the subagent projection and publish only on change. */
void observeSubagentTool(AgentSession &session, const QJsonObject &event, const EventHooks &hooks)
{
    const QJsonValue direct = event.value(QStringLiteral("result")).toObject()
                                  .value(QStringLiteral("details"));
    const QJsonValue partial = event.value(QStringLiteral("partialResult")).toObject()
                                   .value(QStringLiteral("details"));
    const QJsonObject details = direct.isObject() ? direct.toObject() : partial.toObject();
    if (details.isEmpty()) return;
    const QString toolName = event.value(QStringLiteral("toolName")).toString();
    const QString toolCallId = event.value(QStringLiteral("toolCallId")).toString();
    if (!session.subagentRuns().observeToolResult(toolName, details, toolCallId, nowMs())) return;
    emitSubagentStatus(session, hooks);
}

/**
 * Batch key for one frame.
 *
 * pi always sends `toolCallId`; a build that omits it must still pair start and end, so
 * the fallback keys on the tool *name* (the oracle mints a per-start
 * `${toolName}-${Date.now()}` id, which the matching id-less end can never close, leaving
 * the executing flag stuck until the runtime settles).
 */
QString toolCallKey(const QJsonObject &event)
{
    const QString id = event.value(QStringLiteral("toolCallId")).toString();
    if (!id.isEmpty()) return id;
    const QString name = event.value(QStringLiteral("toolName")).toString();
    return name.isEmpty() ? QStringLiteral("tool") : name;
}

/**
 * Publish one aggregate tool-batch transition (oracle `applyActiveToolCallState` +
 * `emitToolRuntimeTransition`): the sequence bumps on every edge so a late full poll can
 * never overwrite a newer edge, and the name is only carried while a call is open.
 */
void applyToolBatch(AgentSession &session, const toolbatch::State &state, const EventHooks &hooks)
{
    session.activeToolCalls() = state.calls;
    session.tab().isExecutingTool = state.isExecutingTool;
    session.tab().executingToolName = state.isExecutingTool
        ? (state.executingToolName.isEmpty() ? QStringLiteral("tool") : state.executingToolName)
        : QString();
    session.tab().toolStateSequence += 1;
    if (!hooks.send) return;
    QJsonObject payload{
        {QStringLiteral("isExecutingTool"), session.tab().isExecutingTool},
        {QStringLiteral("toolStateSequence"), session.tab().toolStateSequence},
    };
    if (!session.tab().executingToolName.isEmpty()) {
        payload.insert(QStringLiteral("executingToolName"), session.tab().executingToolName);
    }
    hooks.send(QStringLiteral("agents:runtime-state"),
               QJsonObject{{QStringLiteral("agentId"), session.tab().id},
                           {QStringLiteral("state"), payload}});
}

} // namespace

void handleToolEvent(AgentSession &session, const QJsonObject &event, const EventHooks &hooks)
{
    const QString type = event.value(QStringLiteral("type")).toString();
    if (session.streamSealed()) return;
    const bool start = type == QLatin1String("tool_execution_start");
    const bool end = type == QLatin1String("tool_execution_end");
    const bool failed = event.value(QStringLiteral("isError")).toBool(false);
    const QString status = end ? (failed ? QStringLiteral("error") : QStringLiteral("done"))
                              : QStringLiteral("running");
    session.transcript().upsertTool(event, status);
    // Subagent / bg_wait frames keep the sidebar child rows alive while the tool call is
    // open; the extension's status slot takes over after handoff.
    observeSubagentTool(session, event, hooks);
    if (end && failed
        && session.subagentRuns().clearToolCall(toolCallKey(event), nowMs())) {
        emitSubagentStatus(session, hooks);
    }
    if (!start && !end) {
        // Progress only changes one transcript row: the oracle coalesces the message
        // emit and never polls runtime state per update.
        session.liveChannels().scheduleMessages();
        return;
    }
    // A parallel batch keeps the executing flag up until its *last* call ends.
    const QString key = toolCallKey(event);
    applyToolBatch(session,
                   start ? toolbatch::started(session.activeToolCalls(), key,
                                              event.value(QStringLiteral("toolName"))
                                                  .toString(QStringLiteral("tool")))
                         : toolbatch::ended(session.activeToolCalls(), key),
                   hooks);
    session.tab().status = QStringLiteral("running");
    if (hooks.emitState) hooks.emitState();
    // A batch of parallel completions may arrive in one stdout read. Publishing a
    // full image-bearing transcript for each can overflow the renderer's SSE backlog.
    session.liveChannels().scheduleMessages(end);
    if (hooks.emitRuntimeState) hooks.emitRuntimeState();
}

} // namespace agentruntime
