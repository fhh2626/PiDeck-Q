#pragma once

#include <QJsonObject>
#include <QString>

/**
 * `agents:notice` payload builders (port of AgentManager's notice emits).
 *
 * The channel is a renderer toast, not a timeline row: the renderer resolves
 * `i18nKey` through its own copy and falls back to `message`, honours `duration`
 * unless `kind == "error"` (an error toast stays until dismissed) and ignores
 * everything else. Payloads therefore carry only static copy keys and — for the
 * thinking-level downgrade — the two level names.
 *
 * Secrets: nothing here may ever contain pi's raw error text. A notice is emitted
 * for a *local* decision (abort accepted, stop is slow, persisted thinking level
 * clamped), so the payload has no `debugDetails` field at all — unlike the prompt
 * diagnostics (`diagnostic.promptRejected`), which do carry pi's message into the
 * timeline. Keeping the two shapes apart is what stops a transport error from
 * turning into a toast with an unredacted pi string.
 *
 * Oracle call sites (HEAD e978ad8a):
 *  - `AgentManager.abort`                      → abortRequested
 *  - `AgentManager.escalateAbortIfStillRunning` → abortSlow
 *  - `createBackend.onThinkingLevelAdjusted`   → thinkingUnsupported
 * There is no other producer: errors go to the timeline as `role:"error"` rows with
 * their own `diagnostic.*` keys, and `notifySessionEnd` uses the desktop
 * notification service (NativeNotifications), not this channel.
 */
namespace runtime::notices {

/** Info toast: the abort command was written to pi (`app.abortRequested`, 2500 ms). */
QJsonObject abortRequested(const QString &agentId);

/** Warning toast: the abort escalation's second attempt did not stop pi (`app.abortSlow`, 6000 ms). */
QJsonObject abortSlow(const QString &agentId);

/**
 * Info toast: a persisted extended thinking level is unsupported by the model.
 *
 * `i18nParams` carries the requested and the effective level; the copy renders
 * `{level}`/`{fallback}`. Deliberately no `message`: the oracle leaves the fallback
 * text to the main-process copy table, and inventing one here would show up as a
 * duplicate string in every non-i18n consumer.
 */
QJsonObject thinkingUnsupported(const QString &agentId, const QString &level,
                                const QString &fallback);

} // namespace runtime::notices
