#include "ToolCallBatch.h"

namespace toolbatch {
namespace {

State result(const Calls &current, Calls calls, bool completedBatch)
{
    State state;
    state.calls = calls;
    state.isExecutingTool = !calls.isEmpty();
    // `Array.from(calls.values()).at(-1)`: the most recently inserted open call.
    if (!calls.isEmpty()) state.executingToolName = calls.last().second;
    state.completedBatch = completedBatch && !current.isEmpty() && calls.isEmpty();
    return state;
}

} // namespace

State started(const Calls &current, const QString &toolCallId, const QString &toolName)
{
    Calls calls = current;
    bool replaced = false;
    for (int index = 0; index < calls.size(); ++index) {
        if (calls.at(index).first != toolCallId) continue;
        // `Map.set` keeps the original insertion position and only replaces the value.
        calls[index] = qMakePair(toolCallId, toolName);
        replaced = true;
        break;
    }
    if (!replaced) calls.append(qMakePair(toolCallId, toolName));
    return result(current, calls, false);
}

State ended(const Calls &current, const QString &toolCallId)
{
    Calls calls = current;
    for (int index = 0; index < calls.size(); ++index) {
        if (calls.at(index).first != toolCallId) continue;
        calls.removeAt(index);
        break;
    }
    return result(current, calls, true);
}

} // namespace toolbatch
