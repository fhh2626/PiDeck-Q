#include "AgentRunEndEvents.h"

#include <QDateTime>
#include <QJsonArray>
#include <QJsonObject>

namespace agentruntime {
namespace {

/** `agent_end` error extraction: top-level, per-message, then the last assistant block. */
QString agentEndError(const QJsonObject &event, const QJsonArray &messages)
{
    const QString topLevel = event.value(QStringLiteral("errorMessage")).toString();
    if (!topLevel.isEmpty()) return topLevel;
    QString lastError;
    QString lastAssistantError;
    for (const QJsonValue &value : messages) {
        if (!value.isObject()) continue;
        const QJsonObject message = value.toObject();
        if (message.value(QStringLiteral("stopReason")).toString() == QLatin1String("error")) {
            const QString text = message.value(QStringLiteral("errorMessage")).toString();
            if (!text.isEmpty()) lastError = text;
        }
        if (message.value(QStringLiteral("role")).toString() == QLatin1String("assistant")) {
            lastAssistantError.clear();
            const QJsonArray content = message.value(QStringLiteral("content")).toArray();
            for (const QJsonValue &block : content) {
                if (!block.isObject()) continue;
                const QJsonObject object = block.toObject();
                if (object.value(QStringLiteral("type")).toString() != QLatin1String("error")) continue;
                QString text = object.value(QStringLiteral("text")).toString();
                if (text.isEmpty()) text = object.value(QStringLiteral("message")).toString();
                if (!text.isEmpty()) lastAssistantError = text;
            }
        }
    }
    if (!lastError.isEmpty()) return lastError;
    if (!lastAssistantError.isEmpty()) return lastAssistantError;
    return event.value(QStringLiteral("error")).toString();
}

/** True when any message in the `agent_end` payload stopped with `stopReason:"error"`. */
bool messagesReportError(const QJsonArray &messages)
{
    for (const QJsonValue &value : messages) {
        if (!value.isObject()) continue;
        if (value.toObject().value(QStringLiteral("stopReason")).toString()
            == QLatin1String("error")) {
            return true;
        }
    }
    return false;
}

/**
 * Failed-turn diagnostic row (port of `AgentManager.addDetailedErrorMessage`).
 *
 * The retry counters come from the row the turn already wrote, so a failure after
 * `auto_retry_*` reports "after retries" and its `attempt/maxAttempts` even when pi's
 * `agent_end` carries no counters. Without the `i18nKey` the renderer kept a permanent raw
 * card: the floating failure toast (and its disposable detail view) needs both the key and
 * the raw text in `debugDetails`.
 */
void appendDetailedError(AgentSession &session, const QString &error)
{
    const QJsonObject retry = session.transcript().retryStatusMeta();
    const int attempt = retry.value(QStringLiteral("attempt")).toInt(0);
    const int maxAttempts = retry.value(QStringLiteral("maxAttempts")).toInt(0);
    const bool hasRetries = maxAttempts > 0;
    QString i18nKey;
    if (!error.isEmpty()) {
        i18nKey = hasRetries ? QStringLiteral("diagnostic.requestFailedAfterRetries")
                             : QStringLiteral("diagnostic.requestFailed");
    } else {
        i18nKey = hasRetries ? QStringLiteral("diagnostic.requestFailedUnknownAfterRetries")
                             : QStringLiteral("diagnostic.requestFailedUnknown");
    }
    // The oracle's zh-CN sentence is the fallback used only when a locale table lost the key.
    QString fallback = QStringLiteral("请求失败。");
    if (hasRetries) {
        fallback += QStringLiteral("\n\n已自动重试：%1/%2 次").arg(attempt).arg(maxAttempts);
    }
    if (error.isEmpty()) fallback += QStringLiteral("\n\n请稍后重试。");
    session.transcript().appendDetailedError(
        i18nKey, fallback,
        QJsonObject{{QStringLiteral("attempt"), attempt},
                    {QStringLiteral("maxAttempts"), maxAttempts}},
        error);
}

} // namespace

void handleAgentEnd(AgentSession &session, const QJsonObject &event, const EventHooks &hooks)
{
    session.setTurnActive(false);
    session.tab().isStreaming = false;
    session.transcript().clearActiveAssistant();
    // Turn end is not child end after handoff: rows a live heartbeat still owns stay
    // lit, everything else is dropped so a yellow dot cannot outlive its turn.
    if (session.subagentRuns().clearRunning(QDateTime::currentMSecsSinceEpoch())) {
        emitSubagentStatus(session, hooks);
    }
    const QJsonArray messages = event.value(QStringLiteral("messages")).toArray();
    const QString error = agentEndError(event, messages);
    // Oracle also fails the turn when pi reports a failed stop without any error text
    // (`else if (typed.stopReason === "error" || errorMessages.length > 0)`); without this
    // the settle watchdog reported a failed turn as a clean completion.
    const bool failedStop = event.value(QStringLiteral("stopReason")).toString()
                                == QLatin1String("error")
        || messagesReportError(messages);
    if (event.value(QStringLiteral("willRetry")).toBool(false)) {
        // pi already decided this finish retries: the sidebar must not read as failed or
        // done, and the final error (if any) belongs to the retry's own end event.
        session.tab().status = QStringLiteral("running");
        // Oracle writes the "retrying" status row from `agent_end` too when the retry has
        // not published one yet, so a retry that starts here is visible immediately. The
        // row is flushed right away: pi may not send another event until the backoff ends,
        // and the renderer's toast must not wait for it.
        if (!error.isEmpty() && !session.transcript().hasRetryStatus()) {
            session.transcript().upsertRetryStatus(
                QStringLiteral("running"), QStringLiteral("diagnostic.retryScheduled"),
                QJsonObject{{QStringLiteral("attempt"), 0},
                            {QStringLiteral("count"), QStringLiteral("1")},
                            {QStringLiteral("delaySeconds"), 0}},
                QJsonObject{{QStringLiteral("attempt"), 0},
                            {QStringLiteral("maxAttempts"), 0},
                            {QStringLiteral("delayMs"), 0},
                            {QStringLiteral("errorMessage"), error},
                            {QStringLiteral("debugDetails"), error}});
            flushMessages(session, hooks);
        }
    } else if (!error.isEmpty()) {
        // Oracle `addDetailedErrorMessage(agentId, errorMsg)`: the row is a localized
        // `diagnostic.requestFailed[AfterRetries]` whose `debugDetails` keeps pi's raw text
        // (provider message, HTTP status, stack), and `markAgentError` keeps the turn out of
        // the completion notification.
        appendDetailedError(session, error);
        session.markError(QStringLiteral("turn"));
        flushMessages(session, hooks);
    } else if (failedStop) {
        // No error text to show: the same oracle fallback with the `…Unknown` variant.
        appendDetailedError(session, QString());
        session.markError(QStringLiteral("turn"));
        flushMessages(session, hooks);
    }
    if (hooks.emitState) hooks.emitState();
    // `agent_end` is not the final idle signal (`agent_settled` is): pi may still run an
    // auto-retry, an auto-compaction or a queued follow-up. The poll is only a bound so a
    // runtime that never sends `agent_settled` cannot stay `running` forever.
    if (hooks.emitRuntimeState) hooks.emitRuntimeState();
    if (hooks.armSettleWatchdog) hooks.armSettleWatchdog(SettleWatchdog::TurnEnd);
}

void handleAgentSettled(AgentSession &session, const QJsonObject &event, const EventHooks &hooks)
{
    Q_UNUSED(event);
    session.setTurnActive(false);
    session.tab().isStreaming = false;
    session.tab().isExecutingTool = false;
    session.tab().executingToolName.clear();
    session.activeToolCalls().clear();
    // `recentlyAborted` marks the abort's settled event; the flag lives only until
    // that point (AgentManager deletes it here too), so the next turn starts clean.
    const bool abortSettled = session.recentlyAborted();
    session.setRecentlyAborted(false);
    // A settled that arrives after a *new* run already started is the old run's
    // settled: it must not mark the new run idle. The oracle keeps `running` and
    // returns here, otherwise the LAN stream would send `finish` mid-turn.
    const bool lateSettled =
        session.waitingForAbortSettled() && session.pendingOpenAfterSettled();
    // Publish completed rows and any window trim in one snapshot before closing
    // the live channels. A late settle must not trim the newly started turn.
    if (!lateSettled && session.transcript().trimToTurns(50)) flushMessages(session, hooks);
    else session.liveChannels().flushPendingCompletedRows();
    session.liveChannels().settle();
    // End the abort wait: a turn that started before this settled is now allowed to
    // stream (the stream gate's only legal unseal point).
    session.noteAbortSettled();
    if (lateSettled) {
        if (session.tab().status != QLatin1String("error")
            && session.tab().status != QLatin1String("closed")) {
            session.tab().status = QStringLiteral("running");
            if (hooks.emitState) hooks.emitState();
            if (hooks.emitRuntimeState) hooks.emitRuntimeState();
        }
        return;
    }
    if (session.tab().status != QLatin1String("error")
        && session.tab().status != QLatin1String("closed")) {
        session.tab().status = QStringLiteral("idle");
    }
    if (hooks.emitState) hooks.emitState();
    if (hooks.emitRuntimeState) hooks.emitRuntimeState();
    if (hooks.settled) hooks.settled(abortSettled);
}

} // namespace agentruntime
