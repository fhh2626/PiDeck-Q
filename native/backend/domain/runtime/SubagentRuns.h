#pragma once

#include "SubagentOwnership.h"

#include <QHash>
#include <QJsonArray>
#include <QJsonObject>
#include <QJsonValue>
#include <QString>
#include <QStringList>

#include <functional>

namespace agentruntime {

/**
 * Sidebar projection for pi-owned child sessions (not PiDeck Agent runtimes).
 *
 * Port of `src/main/pi/SubagentRunTracker.ts` (plus `SubagentExpiryScheduler.ts`): one
 * instance per runtime, i.e. the oracle's per-agent maps collapse into this object.
 *
 * Why a projection at all: a subagent runs inside pi, so it never becomes a PiDeck
 * Agent and never appears in `agents:state`. The sidebar can only light a child row
 * from this channel. Rows are therefore keyed by the child's **session file**, which is
 * the identity the sidebar matches against its own child-session list.
 *
 * Published rows are `{sessionFile, status, agent?, updatedAt}` with `status` limited to
 * `running` / `error`. The renderer sanitizer (`sanitizeRuns`) drops any other status and
 * any row without a session file, so publishing more here is equivalent to publishing
 * nothing — that is exactly how the old tool-detail shape failed.
 *
 * Two sources feed the same map:
 *  - `tool_execution_end` details (`results`, `workflowChildren`, `completions`) while the
 *    tool call is still open;
 *  - `ctx.ui.setStatus` heartbeats from the bundled extension after handoff, when the
 *    tool call has already returned and cannot carry progress any more.
 *
 * Execution identity, finished tombstones and complete/clear fences live in
 * `SubagentOwnership`: a path reused by a resumed child must not let an older heartbeat
 * revive a finished attempt (`SubagentExecutionOwnership.ts`).
 *
 * Expiry is timer driven, not event driven: a child that stops heartbeating would
 * otherwise leave a yellow dot until the next unrelated pi event. `setScheduleHook()` is
 * invoked whenever a deadline may have changed; the owner keeps one timer and calls
 * `expire()` when it fires (oracle `SubagentExpiryScheduler`).
 *
 * Lifecycle: one instance per AgentSession. `clear()` on agent disposal; the coordinator
 * pairs the emit with `agents:subagent-status` so a stopped agent can never leave a
 * yellow dot behind.
 */
class SubagentRuns {
public:
    /** Mirrors `SUBAGENT_RUN_TRACKER_LIMITS`. */
    static constexpr int kMaxRuns = 64;
    static constexpr int kMaxSnapshotTasks = 64;
    static constexpr qint64 kRunningTtlMs = 10 * 60'000;
    static constexpr qint64 kErrorTtlMs = 30 * 60'000;
    static constexpr qint64 kSnapshotStaleMs = 30'000;

    /** TTLs used by the projection; the defaults are the oracle constants. */
    struct Limits {
        qint64 runningTtlMs = kRunningTtlMs;
        qint64 errorTtlMs = kErrorTtlMs;
        qint64 snapshotStaleMs = kSnapshotStaleMs;
    };

    /**
     * TTL override seam for the native2 gates.
     *
     * Those tests are black-box (real backend process, real SSE), so a timer-driven expiry
     * can only be observed by shortening the deadlines:
     * `PIDECK_SUBAGENT_SNAPSHOT_STALE_MS`, `PIDECK_SUBAGENT_RUNNING_TTL_MS`,
     * `PIDECK_SUBAGENT_ERROR_TTL_MS`. Absent, non-numeric, non-positive or absurdly large
     * values keep the oracle defaults, so production never drifts from the Node behaviour.
     */
    static Limits limitsFromEnvironment();

    SubagentRuns();
    explicit SubagentRuns(Limits limits);

    /** Owner hook: re-arm the runtime's expiry timer from `nextExpiryDeadline()`. */
    void setScheduleHook(std::function<void()> hook);

    /**
     * Absorb one `tool_execution_end` frame.
     * `toolName` gates the source (`subagent` / `bg_wait` only) and `details` is pi's
     * untrusted payload: every field is length-bounded before it is kept.
     */
    bool observeToolResult(const QString &toolName, const QJsonObject &details,
                           const QString &toolCallId, qint64 now);

    /**
     * Absorb one status-slot heartbeat.
     *
     * `statusText` is the raw `setStatus` text. An empty text means "slot cleared" and is
     * handled by `clearStatusTask`. `ownerSessionPath` is this runtime's session file: a
     * frame whose `ownerSessionId` names a different session is a stale publisher (pi can
     * switch sessions inside one process) and is dropped. The extension may publish a
     * project-relative id, so `ownerBasePath`/`environment` resolve it exactly like the
     * oracle's `toAbsoluteSessionPath(ownerSessionId, projectPath, environment)` before
     * the comparison; an empty base keeps the strict absolute-only rule. A malformed frame
     * is ignored: a bad heartbeat may cost a sidebar dot, never an exception in the pi
     * event loop.
     */
    bool observeStatusSnapshot(const QString &workflowRunId, const QString &statusText,
                               const QString &ownerSessionPath, const QString &ownerBasePath,
                               const QString &environment, qint64 now);

    /** Extension finished: close the source, keep failure rows for review. */
    bool clearStatusTask(const QString &workflowRunId, qint64 now);

    /** Tool call failed without details: drop the rows that call registered. */
    bool clearToolCall(const QString &toolCallId, qint64 now);

    /** Turn end: drop running rows no live snapshot still owns. */
    bool clearRunning(qint64 now);

    /** Current published rows (pruned by TTL/heartbeat staleness). */
    QJsonArray snapshot(qint64 now);

    /**
     * Timer entry point: drop rows whose TTL or heartbeat elapsed without any new event.
     * Returns true when the published projection changed (the caller then emits).
     */
    bool expire(qint64 now);
    /** Earliest absolute deadline in ms, or 0 when nothing is scheduled. */
    qint64 nextExpiryDeadline() const;

    void clear();
    bool empty() const { return m_runs.isEmpty(); }

    /** Validated status-slot key prefix payload (`pideck.subagent-status.v1:`). */
    static QString statusKeyPrefix();

    /** Windows-safe, separator-agnostic session path comparison. */
    static bool sameSessionPath(const QString &left, const QString &right);

private:
    struct Run {
        QString sessionFile;
        QString status;
        QString agent;
        QString toolCallId;
        /** Workflow that owns this row through a status slot (heartbeat source). */
        QString snapshotRunId;
        QString workflowRunId;
        qint64 updatedAt = 0;
    };

    bool removeRow(const QString &sessionFile);
    bool prune(qint64 now);
    bool writeRun(const Run &run);
    bool settle(qint64 now);
    bool removeTaskRunning(const QString &workflowRunId);
    bool hasLiveSnapshotTask(const QString &workflowRunId, qint64 now) const;
    void dropEmptyTasks();
    /** Notify the owner that deadlines may have changed (oracle `updateExpiry`). */
    void schedule();

    Limits m_limits;
    SubagentOwnership m_ownership;
    QHash<QString, Run> m_runs;
    /** Insertion order of `m_runs` so the oldest row is the one dropped at the cap. */
    QStringList m_order;
    /** workflowRunId -> last heartbeat, used to expire a vanished publisher. */
    QHash<QString, qint64> m_tasks;
    QStringList m_taskOrder;
    std::function<void()> m_schedule;
};

} // namespace agentruntime
