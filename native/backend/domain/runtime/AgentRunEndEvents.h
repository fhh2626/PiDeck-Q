#pragma once

#include "AgentEvents.h"

namespace agentruntime {

/**
 * `agent_end` (one LLM run ended) and `agent_settled` (the runtime's final stable point).
 *
 * Split out of `AgentEvents.cpp`: the completion pair owns its own rules — the error
 * ladder of `agent_end`, the abort/late-settled fencing of `agent_settled`, and the
 * fallback watchdog arm for runtimes that never send `agent_settled`.
 */
void handleAgentEnd(AgentSession &session, const QJsonObject &event, const EventHooks &hooks);

void handleAgentSettled(AgentSession &session, const QJsonObject &event, const EventHooks &hooks);

} // namespace agentruntime
