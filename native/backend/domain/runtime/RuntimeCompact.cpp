#include "RuntimeCoordinator.h"

#include "AgentEvents.h"

#include <QJsonArray>

/**
 * Manual context compaction (`sessions:runtime-compact` → pi `compact`).
 *
 * Port of `AgentManager.compact` / `finishManualCompaction`. The channel's contract is
 * *not* "forward pi's reply": the oracle resolves with the agent's current
 * `AgentRuntimeState` on every non-throwing path —
 *   - a duplicate request while a compaction is in flight returns the current state
 *     instead of failing (the renderer must not show a second toast),
 *   - a pi process that exits mid-compaction is reattached under the *same* agentId and
 *     reports success with a localized "session compacted" row.
 * Only a real failure (pi error / transport error with a live process / failed reattach)
 * throws, which is what the renderer maps to the friendly compaction toast.
 */
namespace runtime {
namespace {

constexpr int kStateTimeoutMs = 30'000;
constexpr int kLongCommandTimeoutMs = 120'000;

QJsonObject compactPayload(const QString &prompt)
{
    QJsonObject payload;
    const QString trimmed = prompt.trimmed();
    if (!trimmed.isEmpty()) payload.insert(QStringLiteral("customInstructions"), trimmed);
    return payload;
}

} // namespace

void Coordinator::fetchRuntimeState(const QString &agentId, std::function<void(QJsonObject)> done)
{
    AgentSession *session = agent(agentId);
    if (!session) {
        done(QJsonObject{});
        return;
    }
    // Same two polls as `emitRuntimeState`, but resolved to the caller instead of the
    // `agents:runtime-state` channel. Oracle `getRuntimeState` swallows a failed
    // `get_state`/`get_session_stats`, so a process that died between the compact and the
    // read still yields the locally known half instead of an error.
    session->request(QStringLiteral("get_state"), {}, kStateTimeoutMs,
                     [this, agentId, done](bool ok, const QJsonObject &response, const QString &) {
                         AgentSession *current = agent(agentId);
                         if (!current) {
                             done(QJsonObject{});
                             return;
                         }
                         const QJsonObject state =
                             ok ? response.value(QStringLiteral("data")).toObject() : QJsonObject{};
                         current->request(
                             QStringLiteral("get_session_stats"), {}, kStateTimeoutMs,
                             [this, agentId, state, done](bool statsOk,
                                                          const QJsonObject &statsResponse,
                                                          const QString &) {
                                 AgentSession *latest = agent(agentId);
                                 if (!latest) {
                                     done(QJsonObject{});
                                     return;
                                 }
                                 const QJsonObject stats = statsOk
                                     ? statsResponse.value(QStringLiteral("data")).toObject()
                                     : QJsonObject{};
                                 // Same builder as `agents:runtime-state`, including the local
                                 // manual-compaction gate (oracle `isCompacting`) and the
                                 // session-file cache-hit / last-reply perf fields, so the
                                 // duplicate-request answer reports the in-flight compaction.
                                 done(buildRuntimeState(state, stats, *latest));
                             });
                     });
}

void Coordinator::finishManualCompaction(AgentSession &session)
{
    // Oracle `finishManualCompaction`: clear the gates on BOTH outcomes, otherwise the
    // session stays "busy" forever (a manual compact has no reliable `agent_settled`) and
    // every later auto-compaction is silently denied its history reload.
    const bool piCompactionStillRunning = session.manualCompactionEvent();
    const bool followUpStarted = session.manualCompactionFollowUp();
    session.setManualCompaction(false);
    if (!piCompactionStillRunning) session.setManualCompactionEvent(false);
    if (!followUpStarted) session.setManualCompactionFollowUp(false);
    const bool stillWorking = piCompactionStillRunning || followUpStarted || session.turnActive()
        || session.tab().isStreaming || session.tab().isExecutingTool;
    const QString status = session.tab().status;
    if (!stillWorking && status != QLatin1String("error") && status != QLatin1String("closed")
        && status != QLatin1String("starting")) {
        session.tab().status = QStringLiteral("idle");
    }
    emitState();
    // The renderer's busy/compacting badge reads `agents:runtime-state`, so the gate
    // release has to be visible there too (oracle `emitRuntimeState`).
    emitRuntimeState(session.tab().id);
}

void Coordinator::compact(const QJsonObject &target, const QString &prompt,
                          std::function<void(QJsonObject)> done)
{
    runTarget(target, [this, prompt](AgentSession &session, const Target &binding,
                                     CommandDone finish) {
        const QString agentId = binding.agentId;
        // Oracle: `if (compactingAgents.has || rpcCompactingAgents.has) return
        // getRuntimeState(agentId)`. Resolving (instead of failing) is observable: the
        // renderer maps a failure to a toast, so a refused duplicate used to produce a
        // spurious "compaction failed" for a compaction that is still running fine.
        // `manualCompactionEvent` is pi's own `compaction_start` (manual *or* auto), so this
        // also refuses to write a second `compact` RPC into pi mid-auto-compaction.
        if (session.manualCompaction() || session.manualCompactionEvent()) {
            fetchRuntimeState(agentId, [finish](const QJsonObject &state) {
                finish(true, state, QString());
            });
            return;
        }

        // Settle = clear the gates, then answer with the post-compaction state (success)
        // or the pi/transport error (failure). Used by every exit of this command so the
        // flags can never leak, exactly like the oracle's `finally`.
        const auto settle = [this, agentId, finish](bool ok, const QString &failure) {
            if (AgentSession *current = agent(agentId)) finishManualCompaction(*current);
            if (!ok) {
                finish(false, QJsonValue(), failure);
                return;
            }
            fetchRuntimeState(agentId, [finish](const QJsonObject &state) {
                finish(true, state, QString());
            });
        };

        session.consumeManualCompactionReloadClaim();
        session.setManualCompaction(true);
        // Oracle: a terminal runtime keeps its status; an idle/error-free one goes running
        // optimistically so the sidebar shows the compaction instead of staying idle.
        if (session.tab().status != QLatin1String("error")
            && session.tab().status != QLatin1String("closed")) {
            session.setStatus(QStringLiteral("running"));
        }
        emitRuntimeState(agentId);

        session.request(
            QStringLiteral("compact"), compactPayload(prompt), kLongCommandTimeoutMs,
            [this, binding, settle](bool ok, const QJsonObject &response, const QString &error) {
                const QString agentId = binding.agentId;
                AgentSession *current = agent(agentId);
                if (!current) {
                    settle(false, QStringLiteral("Session runtime stopped during compaction"));
                    return;
                }
                if (!ok || !response.value(QStringLiteral("success")).toBool(false)) {
                    const QString failure = error.isEmpty()
                        ? response.value(QStringLiteral("error")).toString(
                              QStringLiteral("compact failed"))
                        : error;
                    if (current->running()) {
                        // A live process answered (or timed out): this is a genuine
                        // failure, so the renderer's nothing-to-do / too-small mapping
                        // has to see the message.
                        settle(false, failure);
                        return;
                    }
                    // Oracle: pi exiting on compaction makes the RPC fail even though the
                    // compaction itself finished. Reattach the same agentId and report
                    // success. Deferring is required: the transport fails pending RPCs
                    // *before* the exit handler runs, so unbind/`closed` state is not final
                    // yet and the reattach must observe it.
                    if (!m_deps.post) {
                        settle(false, failure);
                        return;
                    }
                    m_deps.post([this, binding, settle]() {
                        const QString agentId = binding.agentId;
                        AgentSession *latest = agent(agentId);
                        if (!latest) {
                            settle(false, QStringLiteral("Session runtime stopped during compaction"));
                            return;
                        }
                        reattachProcess(agentId, binding,
                                        [this, agentId, settle](bool reattached,
                                                                const QString &reattachError) {
                                            AgentSession *attached = agent(agentId);
                                            if (!reattached || !attached) {
                                                settle(false, reattachError);
                                                return;
                                            }
                                            // Process-exit compaction may never emit
                                            // `compaction_end`; a successful reconnect means
                                            // pi can take messages again.
                                            attached->tab().status = QStringLiteral("idle");
                                            attached->transcript().appendLocalized(
                                                QStringLiteral("system"),
                                                QStringLiteral("diagnostic.compactDone"),
                                                QStringLiteral("会话压缩完成"), QJsonObject{});
                                            agentruntime::flushMessages(*attached, hooksFor(*attached));
                                            emitState();
                                            settle(true, QString());
                                        });
                    });
                    return;
                }

                // Success with a live process: the manual RPC owns the history refresh
                // (oracle `claimManualCompactionReload`), so a `compaction_end` arriving
                // mid-reload cannot overwrite the fresh projection with a short snapshot.
                current->claimManualCompactionReload();
                loadProjection(*current, [this, agentId, settle]() {
                    AgentSession *latest = agent(agentId);
                    if (latest) latest->consumeManualCompactionReloadClaim();
                    settle(true, QString());
                });
            });
    }, std::move(done));
}

} // namespace runtime
