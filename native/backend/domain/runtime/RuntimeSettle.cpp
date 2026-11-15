#include "RuntimeCoordinator.h"

#include "AgentEvents.h"

#include <QJsonObject>
#include <QTimer>

/**
 * Idle confirmation for runtimes that never send `agent_settled`.
 *
 * Port of `AgentManager.markIdleIfPiReportsNoWork` and its two arming points
 * (`agent_end` → `AGENT_SETTLED_TIMEOUT_MS`/`RUST_AGENT_SETTLED_TIMEOUT_MS`, `compaction_end`
 * → 300 ms). `pi_agent_rust` (and Pi-Bolt, which shares its lifecycle serializer) emit
 * `agent_end` carrying a `sessionId` and never emit `agent_settled`; without this fallback
 * the tab stays `running` forever — the renderer then hides edit/delete/resend, keeps the
 * sidebar spinner and never finishes a LAN stream.
 *
 * The fallback is deliberately conservative: it only runs when the *local* view says the
 * turn ended (no pending ask, no compaction in flight, no open tool call, no live
 * assistant row) **and** pi's own `get_state` agrees (not streaming, not compacting, no
 * queued message). Every gate is re-checked after the round trip and fenced on the
 * transport epoch, the run generation and the abort gate, so a stale timer can never
 * settle a replacement run or a run the user just restarted.
 */
namespace runtime {
namespace {

constexpr int kStateTimeoutMs = 10'000;
/** Oracle `AGENT_SETTLED_TIMEOUT_MS`: TypeScript pi settles on its own in practice. */
constexpr int kTypeScriptSettledTimeoutMs = 5'000;
/** Oracle `RUST_AGENT_SETTLED_TIMEOUT_MS`: pi_agent_rust never emits agent_settled. */
constexpr int kRustSettledTimeoutMs = 250;
/** Oracle `compaction_end` → `markIdleIfPiReportsNoWork` delay. */
constexpr int kCompactionIdleCheckMs = 300;

} // namespace

void Coordinator::noteRuntimeKind(const QString &agentId, const QJsonObject &event)
{
    // Oracle `rustRuntimeAgents`: the Rust lifecycle serializer stamps `agent_start` with
    // the pi session id, TypeScript pi does not (its `agent_end` payload is normalized
    // differently, which is why the *start* event is the witness). The flag lives as long
    // as the runtime, so a reattach keeps it.
    if (event.value(QStringLiteral("type")).toString() != QLatin1String("agent_start")) return;
    if (event.value(QStringLiteral("sessionId")).isString()) m_rustRuntimeAgents.insert(agentId);
}

void Coordinator::scheduleSettledWatchdog(const QString &agentId,
                                          agentruntime::SettleWatchdog reason)
{
    AgentSession *session = agent(agentId);
    if (!session) return;
    QObject *context = session->timerContext();
    if (!context) return;
    // Captured at arm time, exactly like the oracle's `settledProcess`/`settledGeneration`:
    // a runtime replaced (or a run started) later must not be settled by this timer.
    const quint64 epoch = session->clientEpoch();
    const int generation = session->runGeneration();
    const bool rustFamily = m_rustRuntimeAgents.contains(agentId);
    const int delayMs = reason == agentruntime::SettleWatchdog::CompactionEnd
        ? kCompactionIdleCheckMs
        : (rustFamily ? kRustSettledTimeoutMs : kTypeScriptSettledTimeoutMs);
    QTimer::singleShot(delayMs, context, [this, agentId, epoch, generation]() {
        markIdleIfPiReportsNoWork(agentId, epoch, generation);
    });
}

void Coordinator::markIdleIfPiReportsNoWork(const QString &agentId, quint64 clientEpoch,
                                            int generation)
{
    AgentSession *session = agent(agentId);
    if (!session) return;
    if (!locallySettled(*session, clientEpoch, generation)) return;
    // `get_state` is the authority: the local flags only describe what the renderer saw.
    // A failed poll settles nothing (the runtime may be mid-restart), matching the oracle.
    session->request(QStringLiteral("get_state"), {}, kStateTimeoutMs,
                     [this, agentId, clientEpoch, generation](bool ok,
                                                              const QJsonObject &response,
                                                              const QString &) {
                         if (!ok) return;
                         const QJsonObject state = response.value(QStringLiteral("data")).toObject();
                         if (state.value(QStringLiteral("isStreaming")).toBool(false)) return;
                         if (state.value(QStringLiteral("isCompacting")).toBool(false)) return;
                         if (state.value(QStringLiteral("pendingMessageCount")).toInt(0) > 0) return;
                         AgentSession *current = agent(agentId);
                         if (!current) return;
                         // Re-fence after the round trip: a prompt sent while the poll was in
                         // flight makes the answer stale (oracle re-checks both).
                         if (!locallySettled(*current, clientEpoch, generation)) return;
                         settleWithoutSettled(*current);
                     });
}

bool Coordinator::locallySettled(const AgentSession &session, quint64 clientEpoch,
                                 int generation) const
{
    if (session.clientEpoch() != clientEpoch) return false;
    if (session.runGeneration() != generation) return false;
    // A run that started before the aborted run's settled is still gated: it is not the run
    // this timer was armed for.
    if (session.pendingOpenAfterSettled()) return false;
    const QString status = session.tab().status;
    // `error` is allowed through: the Rust runtime also skips `agent_settled` on the final
    // failure path, and its caches still have to settle (the status itself is preserved).
    if (status != QLatin1String("running") && status != QLatin1String("error")) return false;
    // Work gates the oracle checks before polling at all.
    if (!session.pendingUi().isEmpty()) return false;
    if (session.manualCompaction() || session.manualCompactionEvent()) return false;
    if (!session.transcript().activeAssistantId().isEmpty()) return false;
    if (session.tab().isExecutingTool || !session.activeToolCalls().isEmpty()) return false;
    return true;
}

void Coordinator::settleWithoutSettled(AgentSession &session)
{
    const QString agentId = session.tab().id;
    session.setRecentlyAborted(false);
    // Same finalization as the `agent_settled` branch: an `error` status is preserved
    // (sidebar failure marker, no completion toast), everything else becomes `idle`. The
    // cache flush and the live-channel close matter for both — a leftover streaming
    // flag/live bubble keeps the renderer from offering edit/delete/resend.
    if (session.tab().status != QLatin1String("error")
        && session.tab().status != QLatin1String("closed")) {
        session.tab().status = QStringLiteral("idle");
    }
    session.setTurnActive(false);
    session.tab().isStreaming = false;
    session.tab().isExecutingTool = false;
    session.tab().executingToolName.clear();
    session.activeToolCalls().clear();
    session.liveChannels().settle();
    session.transcript().trimToTurns(50);
    // Unconditional flush, like `settleRuntimeCaches` (`finalizeThinkingIntoMessage` →
    // `flushMessageEmit`): the fallback also covers a turn whose `message_end` never made it
    // out of the pipe, and a trimmed cache must reach the renderer with its `windowStart`.
    agentruntime::flushMessages(session, hooksFor(session));
    emitState();
    emitRuntimeState(agentId);
    // Oracle `emitLocalEvent(agentId, {type:"agent_settled"})`: the browser stream needs a
    // terminal event or the phone waits forever. This is a *local* event only — the desktop
    // completion toast stays owned by a real `agent_settled`, exactly like the oracle (which
    // does not call `notifySessionEnd` from the fallback).
    publishLocalSettled(agentId, session);
}

void Coordinator::publishLocalSettled(const QString &agentId, AgentSession &session)
{
    if (m_piObservers.isEmpty()) return;
    const QJsonObject event{{QStringLiteral("type"), QStringLiteral("agent_settled")}};
    const int generation = session.runGeneration();
    for (const auto &observer : m_piObservers) {
        if (observer) observer(agentId, event, generation);
    }
}

} // namespace runtime
