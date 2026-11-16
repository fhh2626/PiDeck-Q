#include "AgentEvents.h"

#include "AgentRunEndEvents.h"
#include "AgentToolEvents.h"

#include "../sessions/PiTaskMessage.h"
#include "../sessions/Projector.h"

#include <QDateTime>
#include <QJsonArray>

#include <optional>

namespace agentruntime {
namespace {

qint64 nowMs()
{
    return QDateTime::currentMSecsSinceEpoch();
}

/** Text blocks of a pi content array (thinking/tool_use excluded), matching `extractText`. */
QString contentText(const QJsonObject &message)
{
    QString text;
    for (const QJsonValue &value : message.value(QStringLiteral("content")).toArray()) {
        if (!value.isObject()) continue;
        const QJsonObject block = value.toObject();
        if (block.value(QStringLiteral("type")).toString() != QLatin1String("text")) continue;
        text += block.value(QStringLiteral("text")).toString();
    }
    return text;
}

/** `agent_end` error extraction lives in AgentRunEndEvents.cpp with its only caller. */

/**
 * Edge-triggered local streaming flag (port of `AgentManager.setStreamingAgent`).
 *
 * The oracle publishes a *lightweight* `agents:runtime-state` patch only when the flag
 * actually flips; per-delta assignment with an unconditional frame would put one patch
 * per token on the wire (the delivery budget trims exactly that), while a silent local
 * assignment leaves the renderer's stop button/spinner on the value from the last full
 * poll. Both directions matter, and the position matters too:
 *  - `true` is published *before* the first timeline frame of the reply, so the live
 *    bubble and the stop button appear together instead of the row existing with no
 *    running state;
 *  - `false` is published at the terminal frame, after the final message flush and
 *    before the live text channel's `done` frame (`message_end` and the
 *    `message_update` done/error path both follow that order).
 *
 * Payload shape is `AgentRuntimeState` (not the tab): the renderer merges it into its
 * runtime-state atom, so the omitted fields keep their previous values.
 */
void setStreamingState(AgentSession &session, bool streaming, const EventHooks &hooks)
{
    if (session.tab().isStreaming == streaming) return;
    session.tab().isStreaming = streaming;
    if (!hooks.send) return;
    QJsonObject state{
        {QStringLiteral("isStreaming"), streaming},
        {QStringLiteral("isExecutingTool"), session.tab().isExecutingTool},
    };
    if (session.tab().isExecutingTool && !session.tab().executingToolName.isEmpty()) {
        state.insert(QStringLiteral("executingToolName"), session.tab().executingToolName);
    }
    state.insert(QStringLiteral("toolStateSequence"), session.tab().toolStateSequence);
    hooks.send(QStringLiteral("agents:runtime-state"),
               QJsonObject{{QStringLiteral("agentId"), session.tab().id},
                           {QStringLiteral("state"), state}});
}

} // namespace

void emitSubagentStatus(AgentSession &session, const EventHooks &hooks)
{
    if (!hooks.send) return;
    // The renderer sanitizer requires `sessionFile` plus `running|error`; the projection
    // guarantees both, so an emitted frame always draws or clears a real sidebar row.
    hooks.send(QStringLiteral("agents:subagent-status"), QJsonObject{
        {QStringLiteral("agentId"), session.tab().id},
        {QStringLiteral("runs"), session.subagentRuns().snapshot(nowMs())},
    });
}

/** Absorb one tool frame into the subagent projection and publish only on change. */
// (moved to AgentToolEvents.cpp together with the tool lifecycle it serves)

void flushMessages(AgentSession &session, const EventHooks &hooks)
{
    if (!hooks.send) return;
    // An immediate flush supersedes a pending coalesced window: emitting both would send
    // the same transcript twice and the earlier frame could arrive after a newer one.
    session.liveChannels().flushMessagesNow();
}

/** Last-reply metrics edge (`AgentManager.settleMessagePerf`'s lightweight patch). */
void emitPerfPatch(AgentSession &session, const agentmetrics::ReplyPerf &perf,
                   const EventHooks &hooks)
{
    if (!hooks.send || !perf.valid) return;
    QJsonObject state{ {QStringLiteral("totalMs"), perf.totalMs},
                       {QStringLiteral("perfAt"), perf.at} };
    if (perf.hasTtft) state.insert(QStringLiteral("ttftMs"), perf.ttftMs);
    if (perf.hasTps) state.insert(QStringLiteral("tps"), perf.tps);
    hooks.send(QStringLiteral("agents:runtime-state"),
               QJsonObject{{"agentId", session.tab().id}, {"state", state}});
}

void handlePiEvent(AgentSession &session, const QJsonObject &event, const EventHooks &hooks)
{
    const QString type = event.value(QStringLiteral("type")).toString();
    if (type.isEmpty()) return;
    const QString agentId = session.tab().id;
    Transcript &transcript = session.transcript();

    if (type == QLatin1String("session_info_changed")) {
        QString name = event.value(QStringLiteral("name")).toString().simplified();
        if (!name.isEmpty() && name != session.tab().title) {
            session.tab().title = name;
            if (hooks.emitState) hooks.emitState();
        }
        return;
    }

    if (type == QLatin1String("agent_start")) {
        session.setRecentlyAborted(false);
        // A run that starts while a manual compact is still in flight is pi continuing
        // with a queued follow-up: the compact's completion must not push it to idle
        // (oracle `manualCompactionFollowUpAgents`).
        if (session.manualCompaction()) session.setManualCompactionFollowUp(true);
        session.openStream();
        session.setTurnActive(true);
        transcript.clearActiveAssistant();
        transcript.clearToolIds();
        // A new run cannot inherit the previous batch: a tool that never reported its end
        // (killed process, aborted turn) would otherwise keep `isExecutingTool` true and
        // gate the settle watchdog and the manual-compaction completion.
        session.activeToolCalls().clear();
        session.tab().isStreaming = false;
        session.tab().isExecutingTool = false;
        session.tab().executingToolName.clear();
        session.setStatus(QStringLiteral("running"));
        if (hooks.runStarted) hooks.runStarted();
        if (hooks.emitState) hooks.emitState();
        return;
    }

    if (type == QLatin1String("message_start")) {
        const QJsonObject message = event.value(QStringLiteral("message")).toObject();
        if (message.value(QStringLiteral("role")).toString() != QLatin1String("assistant")) return;
        if (session.streamSealed()) return;
        session.perf().messageStarted(nowMs());
        transcript.beginThinking(transcript.activeAssistantId());
        transcript.upsertAssistant(message, QString(), true);
        // Oracle order: flag patch, then the message flush (`beginAssistantMessage` →
        // `setStreamingAgent(true)` → `flushMessageEmit`).
        setStreamingState(session, true, hooks);
        flushMessages(session, hooks);
        return;
    }

    if (type == QLatin1String("message_update")) {
        if (session.streamSealed()) return;
        const QJsonObject update = event.value(QStringLiteral("assistantMessageEvent")).toObject();
        if (update.isEmpty()) return;
        const QString updateType = update.value(QStringLiteral("type")).toString();
        const QJsonObject partial = event.value(QStringLiteral("message")).toObject();
        if (updateType == QLatin1String("thinking_start")) {
            session.perf().messageStarted(nowMs());
            transcript.beginThinking(transcript.activeAssistantId());
            setStreamingState(session, true, hooks);
            return;
        }
        if (updateType == QLatin1String("thinking_delta")) {
            session.perf().messageStarted(nowMs());
            transcript.beginThinking(transcript.activeAssistantId());
            const QString next = transcript.streamingThinking()
                + update.value(QStringLiteral("delta")).toString();
            transcript.appendThinking(next);
            session.perf().firstDelta(nowMs());
            // 50 ms coalescer: one growing full-text frame per token is what evicted the
            // replay window on long replies (oracle `thinkingEmitter`).
            session.liveChannels().pushThinking(runtime::stripAnsi(next));
            // Oracle publishes the flag after pushing the thinking frame.
            setStreamingState(session, true, hooks);
            return;
        }
        if (updateType == QLatin1String("thinking_end")) {
            // Phase terminal, not message terminal: the live bubble stays until
            // message_end (`done=true`), exactly like `markThinkingSegmentEnded`. The
            // `endedAt` stamp lives in the channel so the phase end is published exactly
            // once even when a `text_delta` closed the segment first.
            session.liveChannels().thinkingEnded();
            return;
        }
        if (updateType == QLatin1String("text_start")) {
            session.perf().messageStarted(nowMs());
            setStreamingState(session, true, hooks);
            return;
        }
        if (updateType == QLatin1String("text_delta")) {
            const QString delta = update.value(QStringLiteral("delta")).toString();
            // Oracle `handleAssistantMessageEvent`: a partial snapshot wins, otherwise the
            // delta is appended to the independent live buffer. The transcript row is NOT
            // upserted per delta: the row is written once at message_end, and a per-delta
            // upsert (content array present -> fallback ignored) would reset it every time.
            const QString snapshot = contentText(partial);
            const QString text = snapshot.isEmpty()
                ? session.liveChannels().appendText(delta)
                : session.liveChannels().replaceText(snapshot);
            session.perf().messageStarted(nowMs());
            session.perf().firstDelta(nowMs());
            session.perf().firstText(nowMs());
            // Thinking -> body: pi does not always send `thinking_end` once text starts
            // (several providers switch straight from thinking to text deltas), so the
            // open segment is closed here exactly like `markThinkingSegmentEnded`. The
            // oracle pushes the text frame first and only then stamps/flushes the thinking
            // phase, so the live body must not wait behind the reasoning frame.
            setStreamingState(session, true, hooks);
            session.liveChannels().pushText(runtime::stripAnsi(text));
            if (transcript.hasThinkingSegment()) session.liveChannels().thinkingEnded();
            return;
        }
        if (updateType == QLatin1String("text_end")) {
            if (!partial.isEmpty()) transcript.upsertAssistant(partial, QString(), true);
            return;
        }
        if (updateType == QLatin1String("done") || updateType == QLatin1String("error")) {
            // Final state of this reply (`message_end|done|error` in the oracle): settle
            // the perf metrics, persist thinking + body, then close both live channels.
            agentmetrics::ReplyPerf perf;
            const bool settled = session.perf().settle(partial, nowMs(), &perf);
            if (!transcript.activeAssistantId().isEmpty()) {
                transcript.finalizeThinking(partial);
                transcript.upsertAssistant(partial, QString(), true);
                flushMessages(session, hooks);
                session.liveChannels().finishThinking();
            }
            // Oracle order (`message_end|done|error`): `setStreamingAgent(false)` comes
            // *before* the live text channel's terminal frame (`textEmitter.flush` →
            // `emitTextStreamNow(text, true)`). Reversing it made the renderer see the
            // reply finish (text stream done) while `isStreaming` was still true, i.e. the
            // stop button outlived the answer by one frame. The history flush and the
            // thinking close stay ahead of the patch.
            setStreamingState(session, false, hooks);
            session.liveChannels().finishText();
            if (settled) emitPerfPatch(session, perf, hooks);
            return;
        }
        return;
    }

    if (type == QLatin1String("message_end")) {
        const QJsonObject message = event.value(QStringLiteral("message")).toObject();
        const QString role = message.value(QStringLiteral("role")).toString();
        if (role == QLatin1String("assistant")) {
            if (session.streamSealed()) return;
            if (!transcript.activeAssistantId().isEmpty()) {
                transcript.finalizeThinking(message);
                transcript.upsertAssistant(message, QString(), true);
                flushMessages(session, hooks);
                // Thinking first (History row + done frame), then perf settle, then the
                // body channel: the order the oracle's message_end branch encodes.
                session.liveChannels().finishThinking();
            }
            setStreamingState(session, false, hooks);
            agentmetrics::ReplyPerf perf;
            const bool settled = session.perf().settle(message, nowMs(), &perf);
            session.liveChannels().finishText();
            transcript.clearActiveAssistant();
            if (settled) emitPerfPatch(session, perf, hooks);
            return;
        }
        if (role == QLatin1String("custom") && !session.streamSealed()) {
            // Atomic extension task messages reuse the history projection so a reconnect
            // cannot duplicate the card.
            projector::Deps deps;
            deps.translate = session.translate();
            const QVector<QJsonValue> single{message};
            const QJsonArray converted = projector::convert(agentId, single, {}, {}, deps);
            // The sender stamps every task message with its own identity, so live and
            // projected cards dedupe on that identity instead of on text that may repeat.
            double sentAt = 0;
            const bool hasSentAt = pitask::toEpochMs(message.value(QStringLiteral("timestamp")), &sentAt);
            for (const QJsonValue &value : converted) {
                const QJsonObject row = value.toObject();
                const QJsonObject meta = row.value(QStringLiteral("meta")).toObject();
                if (meta.value(QStringLiteral("type")).toString() != QLatin1String("todoTask")) continue;
                const QString text = row.value(QStringLiteral("text")).toString();
                const bool hasCardKey = meta.contains(QStringLiteral("todoTaskMessageId"));
                bool duplicate = false;
                for (const QJsonValue &existing : transcript.messages()) {
                    const QJsonObject existingRow = existing.toObject();
                    const QJsonObject existingMeta = existingRow.value(QStringLiteral("meta")).toObject();
                    if (existingMeta.value(QStringLiteral("type")).toString() != QLatin1String("todoTask")) continue;
                    // Absent ids compare equal, matching the oracle's `undefined !== undefined` check.
                    if (existingMeta.value(QStringLiteral("todoTaskId")).toString()
                        != meta.value(QStringLiteral("todoTaskId")).toString()) {
                        continue;
                    }
                    if (existingMeta.value(QStringLiteral("todoTaskKind")).toString()
                        != meta.value(QStringLiteral("todoTaskKind")).toString()) {
                        continue;
                    }
                    const bool hasExistingKey = existingMeta.contains(QStringLiteral("todoTaskMessageId"));
                    // An identified message is never matched by text: a history card without an
                    // identity must not swallow a genuinely new resume that repeats the same text.
                    if (hasCardKey) {
                        if (hasExistingKey
                            && existingMeta.value(QStringLiteral("todoTaskMessageId")).toString()
                                == meta.value(QStringLiteral("todoTaskMessageId")).toString()) {
                            duplicate = true;
                            break;
                        }
                        continue;
                    }
                    if (hasExistingKey) continue;
                    // Legacy senders carry no identity; keep the timestamp-bounded text fallback.
                    if (existingRow.value(QStringLiteral("text")).toString() != text) continue;
                    const QJsonValue existingAt = existingMeta.value(QStringLiteral("todoTaskAt"));
                    if (!hasSentAt || (existingAt.isDouble() && existingAt.toDouble() == sentAt)) {
                        duplicate = true;
                        break;
                    }
                }
                if (duplicate) continue;
                // Only the sender's identity travels with the live card; `_piDeckMsgSeq`
                // and `entryId` belong to the file projection and would otherwise make
                // the same card differ between live and reloaded history.
                QJsonObject cardMeta{
                    {QStringLiteral("type"), QStringLiteral("todoTask")},
                    {QStringLiteral("todoTaskKind"), meta.value(QStringLiteral("todoTaskKind"))},
                };
                if (meta.contains(QStringLiteral("todoTaskId"))) {
                    cardMeta.insert(QStringLiteral("todoTaskId"), meta.value(QStringLiteral("todoTaskId")));
                }
                if (hasCardKey) {
                    cardMeta.insert(QStringLiteral("todoTaskMessageId"),
                                    meta.value(QStringLiteral("todoTaskMessageId")));
                }
                if (meta.contains(QStringLiteral("todoTaskCommandName"))) {
                    cardMeta.insert(QStringLiteral("todoTaskCommandName"), meta.value(QStringLiteral("todoTaskCommandName")));
                    cardMeta.insert(QStringLiteral("todoTaskCommandArgs"), meta.value(QStringLiteral("todoTaskCommandArgs")));
                }
                if (hasSentAt) cardMeta.insert(QStringLiteral("todoTaskAt"), sentAt);
                transcript.appendTodoTask(text, cardMeta);
                flushMessages(session, hooks);
            }
        }
        return;
    }

    if (type == QLatin1String("tool_execution_start") || type == QLatin1String("tool_execution_update")
        || type == QLatin1String("tool_execution_end")) {
        // Parallel calls aggregate by toolCallId, so the `isExecutingTool:false` edge waits
        // for the batch's last call (AgentToolEvents.cpp).
        handleToolEvent(session, event, hooks);
        return;
    }

    if (type == QLatin1String("extension_ui_request")) {
        handleUiRequest(session, event, hooks);
        return;
    }

    if (type == QLatin1String("extension_error")) {
        const QString reason = event.value(QStringLiteral("error")).toString(QStringLiteral("Extension error"));
        transcript.appendLocalized(QStringLiteral("error"), QStringLiteral("diagnostic.extensionError"),
                                   QStringLiteral("Extension error."),
                                   QJsonObject{{QStringLiteral("debugDetails"), reason}});
        flushMessages(session, hooks);
        return;
    }

    if (type == QLatin1String("auto_retry_start") || type == QLatin1String("auto_retry_end")) {
        const bool start = type == QLatin1String("auto_retry_start");
        const bool success = event.value(QStringLiteral("success")).toBool(false);
        // Oracle `upsertRetryStatusMessage` normalizes the event against the row it is about
        // to rewrite: `auto_retry_end` may omit `attempt`/`maxAttempts`/`errorMessage`, and
        // the inherited values also feed `count`/`text` — not just the row meta.
        const QJsonObject previous = session.transcript().retryStatusMeta();
        const auto pickInt = [&event, &previous](const QString &key) {
            const QJsonValue value = event.value(key);
            if (value.isDouble()) return value.toInt();
            return previous.value(key).toInt(0);
        };
        const int attempt = pickInt(QStringLiteral("attempt"));
        const int maxAttempts = pickInt(QStringLiteral("maxAttempts"));
        const int delayMs = event.value(QStringLiteral("delayMs")).toInt(0);
        // Oracle: `event.errorMessage ?? event.finalError ?? message.meta?.errorMessage`.
        // `??` falls through only for an *absent* (or null) field, so an explicit empty string
        // is a value: pi redacts a reason to `""` and the row must then drop the previous one
        // instead of keeping the stale text visible. Treating `""` like a missing field
        // re-published the earlier raw reason (and its `debugDetails`) after the redaction.
        const auto presentReason = [&event](const QString &key) -> std::optional<QString> {
            const QJsonValue value = event.value(key);
            if (value.isUndefined() || value.isNull()) return std::nullopt;
            return value.toString();
        };
        QString error;
        if (const std::optional<QString> ownReason = presentReason(QStringLiteral("errorMessage"))) {
            error = *ownReason;
        } else if (const std::optional<QString> finalReason = presentReason(QStringLiteral("finalError"))) {
            error = *finalReason;
        } else {
            error = previous.value(QStringLiteral("errorMessage")).toString();
        }
        // Oracle `upsertRetryStatusMessage`: ONE row per agent, re-written for every event.
        // `count` is `attempt/maxAttempts` (or the bare attempt), and the i18n key is the
        // one the renderer treats as a floating toast, so the row never lingers as a card.
        const QString countText = maxAttempts > 0
            ? QStringLiteral("%1/%2").arg(attempt).arg(maxAttempts)
            : QString::number(attempt > 0 ? attempt : 1);
        const int delaySeconds = (delayMs + 999) / 1000;
        const QJsonObject params{{QStringLiteral("attempt"), attempt},
                                 {QStringLiteral("count"), countText},
                                 {QStringLiteral("delaySeconds"), delaySeconds}};
        const QString status = start ? QStringLiteral("running")
                                     : (success ? QStringLiteral("success")
                                                : QStringLiteral("error"));
        QString i18nKey;
        if (start) {
            i18nKey = delayMs > 0 ? QStringLiteral("diagnostic.retryScheduledAfterDelay")
                                  : QStringLiteral("diagnostic.retryScheduled");
        } else if (success) {
            i18nKey = QStringLiteral("diagnostic.retrySucceeded");
        } else {
            i18nKey = QStringLiteral("diagnostic.retryFailed");
        }
        QJsonObject meta{{QStringLiteral("attempt"), attempt},
                         {QStringLiteral("maxAttempts"), maxAttempts},
                         {QStringLiteral("delayMs"), delayMs},
                         {QStringLiteral("errorMessage"), error}};
        // Oracle: `...(reason && status !== "success" ? { debugDetails: reason } : {})`.
        if (!error.isEmpty() && !success) meta.insert(QStringLiteral("debugDetails"), error);
        session.transcript().upsertRetryStatus(status, i18nKey, params, meta);
        flushMessages(session, hooks);
        if (start) {
            // A late retry must not re-light `running` after the user stopped the turn: the
            // oracle keeps the aborted status until the next real `agent_start`.
            if (!session.recentlyAborted()) {
                session.tab().status = QStringLiteral("running");
                if (hooks.emitState) hooks.emitState();
            }
        } else if (!success && !session.recentlyAborted()) {
            // Same guard on the failure side: an aborted turn must not be painted as a
            // failed one (that would also suppress the next completion notice via
            // `status == error`).
            session.markError(QStringLiteral("turn"));
            // This card uses the end event, not the status row's inherited reason. Oracle:
            // `typed.finalError ?? typed.errorMessage ?? "API 请求失败"`; an explicit empty
            // string remains a value, and finalError takes priority only for this card.
            const QString finalReason = presentReason(QStringLiteral("finalError"))
                                            .value_or(presentReason(QStringLiteral("errorMessage"))
                                                          .value_or(QStringLiteral("API 请求失败")));
            transcript.appendError(QStringLiteral("请求失败：") + finalReason);
            flushMessages(session, hooks);
        }
        return;
    }

    if (type == QLatin1String("compaction_start") || type == QLatin1String("auto_compaction_start")) {
        // pi acknowledged the compaction it is running: until the matching end event the
        // manual completion path must not claim idle, and a manual `compact` must be
        // refused (oracle `rpcCompactingAgents`, fed by *every* compaction start, not just
        // a manual RPC's own — a second RPC mid-auto-compaction was rejected by pi).
        session.setManualCompactionEvent(true);
        // Auto-compaction runs *after* `agent_end` and never re-sends `agent_start`, so the
        // tab has to hold `running` or the user believes the session is idle and sends
        // again. An aborted or already failed turn keeps its status (oracle guards).
        if (!session.recentlyAborted() && session.tab().status != QLatin1String("error")) {
            session.tab().status = QStringLiteral("running");
            if (hooks.emitState) hooks.emitState();
            if (hooks.emitRuntimeState) hooks.emitRuntimeState();
        }
        return;
    }
    if (type == QLatin1String("compaction_end") || type == QLatin1String("auto_compaction_end")) {
        if (event.value(QStringLiteral("result")).isObject()
            && !event.value(QStringLiteral("aborted")).toBool(false)) {
            session.tab().compactionCount += 1;
        }
        session.setManualCompactionEvent(false);
        // Only an in-flight *manual* compact owns the reload: the RPC path re-reads the
        // history itself and claims the reload, so reloading here would race it and let a
        // short pre-summary snapshot overwrite the answer the user just read. The claim is
        // also consumed here, exactly like the oracle, so it can never leak into a later
        // auto-compaction.
        const bool manualReloadOwned = session.consumeManualCompactionReloadClaim();
        if (!session.manualCompaction() && !manualReloadOwned && hooks.reloadMessages) {
            hooks.reloadMessages(true);
        }
        // A finished compaction is still not a finished turn: pi may continue with an
        // overflow retry or a queued follow-up and will not send another `agent_start`.
        // Only `agent_settled` (or the bounded poll below) may claim idle, and an aborted
        // or already failed turn keeps its status (oracle guards).
        if (!session.recentlyAborted() && session.tab().status != QLatin1String("error")) {
            session.tab().status = QStringLiteral("running");
        }
        if (hooks.emitState) hooks.emitState();
        if (hooks.emitRuntimeState) hooks.emitRuntimeState();
        // 300 ms after a compaction ends the oracle re-checks `get_state`; a runtime that
        // compacts without ever settling would otherwise stay `running`.
        if (hooks.armSettleWatchdog) hooks.armSettleWatchdog(SettleWatchdog::CompactionEnd);
        return;
    }

    if (type == QLatin1String("agent_end")) {
        handleAgentEnd(session, event, hooks);
        return;
    }

    if (type == QLatin1String("agent_settled")) {
        handleAgentSettled(session, event, hooks);
        return;
    }
}

} // namespace agentruntime
