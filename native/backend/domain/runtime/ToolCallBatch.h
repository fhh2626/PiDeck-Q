#pragma once

#include <QList>
#include <QPair>
#include <QString>

/**
 * Parallel tool-call aggregation (port of `src/shared/toolRuntimeState.ts`).
 *
 * Why this exists: pi starts every call of a parallel batch with its own
 * `tool_execution_start` and ends them in completion order. Publishing
 * `isExecutingTool:false` on the first `tool_execution_end` claims the whole tool phase
 * is over while another call still runs — the renderer then re-enables steer/edit in the
 * middle of the batch and the manual-compaction completion gate releases early.
 *
 * The oracle keys the open calls by `toolCallId` in a `Map`, so the displayed tool name is
 * the *last inserted* open call. `Calls` therefore keeps insertion order (a `QHash` would
 * not) and `started` updates an existing id in place, exactly like `Map.set`.
 */
namespace toolbatch {

/** Open calls in insertion order: `{toolCallId, toolName}`. */
using Calls = QList<QPair<QString, QString>>;

struct State {
    /** Open calls after the event. */
    Calls calls;
    /** True while at least one call is open. */
    bool isExecutingTool = false;
    /** Last inserted open call's name; empty when nothing is open. */
    QString executingToolName;
    /**
     * The last open call of a non-empty batch just ended.
     *
     * Only this edge means "the tool phase is over"; the oracle uses it to decide when a
     * steer window opens.
     */
    bool completedBatch = false;
};

/** `updateActiveToolCalls` start branch: insert, or update an already open id in place. */
State started(const Calls &current, const QString &toolCallId, const QString &toolName);

/** `updateActiveToolCalls` end branch: drop the id; unknown ids are a no-op. */
State ended(const Calls &current, const QString &toolCallId);

} // namespace toolbatch
