#pragma once

#include "AgentSession.h"

#include <QJsonObject>
#include <QJsonValue>
#include <QString>

#include <functional>

/**
 * pi event stream -> renderer payloads.
 *
 * Port of `AgentManager.handlePiEvent` (src/main/pi/AgentManager.ts). Every event that
 * pi writes to stdout without a request id arrives here; nothing is dropped, because a
 * dropped `tool_execution_end` or `agent_settled` leaves the UI stuck forever.
 *
 * Emitted channels and payloads (all wrapped by the coordinator into
 * `sessions:runtime-event` envelopes):
 *  - `agents:text-stream`  {agentId, messageId?, text|delta, done}
 *  - `agents:thinking`     {agentId, id, text|delta, startedAt, endedAt, done}
 *  - `agents:message`      {agentId, messages, totalLength, fileVersion?}
 *  - `agents:state`        AgentTab[]
 *  - `agents:runtime-state`{agentId, state}
 *  - `agents:ui-request`   {agentId, requestId, method, title, ...}
 *  - `agents:notice`       {agentId, message?, i18nKey, i18nParams?, kind, duration}
 *  - `agents:subagent-status` {agentId, runs}
 *  - `agents:log`          {agentId, text}
 */
namespace agentruntime {

/**
 * Why the idle-confirmation watchdog was armed; it decides the delay.
 *
 * `TurnEnd` uses the per-runtime timeout (250 ms for pi_agent_rust/Pi-Bolt, which never
 * emit `agent_settled`, 5 s otherwise); `CompactionEnd` uses the oracle's fixed 300 ms.
 * `ExtensionCommandEnd` checks after 100 ms because a command may emit no run events.
 */
enum class SettleWatchdog {
    TurnEnd,
    CompactionEnd,
    ExtensionCommandEnd,
};

struct EventHooks {
    /** `agents:state` with the full tab list. */
    std::function<void()> emitState;
    /** `agents:runtime-state` from get_state + get_session_stats. */
    std::function<void()> emitRuntimeState;
    /** Re-read get_messages and re-project; `preserveHistory` mirrors the oracle flag. */
    std::function<void(bool preserveHistory)> reloadMessages;
    /** Register a pending interactive request (coordinator owns the map + notification). */
    std::function<void(const AgentSession::PendingUi &request)> uiRequest;
    /**
     * A new run started (`agent_start`).
     *
     * The ask reminder dedupes per agent *per run*, so a new turn has to re-arm it;
     * without this hook a session that asked once would never notify again.
     */
    std::function<void()> runStarted;
    /**
     * A pending ask closed without a renderer answer (pi timeout).
     *
     * The session-level map is already updated by the caller; the coordinator must drop
     * its `sessionId + requestId` entry too, otherwise a late answer would be forwarded
     * to a pi request that no longer exists.
     */
    std::function<void(const QString &requestId)> uiRequestClosed;
    /** A turn reached its final stable point (trim cache, notify).
     *
     * `abortSettled` is true when this turn was stopped by the user: the oracle treats
     * that settled event as "not a completion" and suppresses the done notification.
     */
    std::function<void(bool abortSettled)> settled;
    /** Raw channel emission for the streaming channels. */
    std::function<void(const QString &channel, const QJsonValue &payload)> send;
    /**
     * Arm the idle-confirmation watchdog (`AgentManager.settleTimer`).
     *
     * `agent_end` and `compaction_end` are *not* the final idle signal: pi may still run a
     * retry, a compaction or a queued follow-up. A runtime that never sends
     * `agent_settled` (pi_agent_rust, Pi-Bolt) therefore needs a bounded poll of
     * `get_state`; without it the tab stays `running` forever (no edit/delete/resend, a
     * permanent sidebar spinner and a LAN stream that never finishes).
     */
    std::function<void(SettleWatchdog)> armSettleWatchdog;
    /**
     * Project root for a project id (empty when the project is unknown).
     *
     * Needed to resolve project-relative paths that pi extensions publish (the status slot's
     * `ownerSessionId`), exactly like the oracle's `getProject(projectId)?.path` fallback.
     */
    std::function<QString(const QString &projectId)> projectPath;
};

/** Interactive pi request (ask / notify / widget / status slot); implemented in AgentUiRequests.cpp. */
void handleUiRequest(AgentSession &session, const QJsonObject &event, const EventHooks &hooks);

/** Handle one unsolicited pi event. Never throws into the transport. */
void handlePiEvent(AgentSession &session, const QJsonObject &event, const EventHooks &hooks);

/** Emit the current transcript as a full `agents:message` payload. */
void flushMessages(AgentSession &session, const EventHooks &hooks);

/** Emit `agents:subagent-status` with the current run snapshot. */
void emitSubagentStatus(AgentSession &session, const EventHooks &hooks);

} // namespace agentruntime
