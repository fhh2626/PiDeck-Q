#pragma once

#include "AgentEvents.h"

namespace agentruntime {

/**
 * `tool_execution_start|update|end` for one runtime.
 *
 * Split out of `AgentEvents.cpp` because the tool lifecycle is its own state machine:
 * parallel calls are aggregated by `toolCallId` (`ToolCallBatch`), the subagent
 * projection observes the same frames, and only the batch's final end edge may publish
 * `isExecutingTool:false`.
 */
void handleToolEvent(AgentSession &session, const QJsonObject &event, const EventHooks &hooks);

} // namespace agentruntime
