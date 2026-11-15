#pragma once

#include <QString>
#include <QVector>

#include <optional>

namespace agentruntime {

/**
 * Validation half of `src/main/pi/subagentStatusSnapshot.ts`.
 *
 * The payload is produced by the bundled subagents extension and arrives through pi's
 * `setStatus` event, i.e. from a separate process over an untrusted boundary. Every field
 * is therefore validated and bounded, and an invalid frame is dropped instead of throwing:
 * a bad heartbeat may cost a sidebar dot, never the pi event loop.
 *
 * A row that fails validation is dropped *and* marks the frame `truncated`, because the
 * frame is then no longer a complete inventory — the tracker must not delete the rows it
 * did not see.
 */
struct SubagentStatusChild {
    QString taskKey;
    QString sessionFile;
    /** One of running/completed/failed/stopped/paused/detached. */
    QString state;
    QString agent;
    QString executionId;
};

struct SubagentStatusSnapshot {
    QString ownerSessionId;
    QString parentToolCallId;
    QString workflowRunId;
    /** Monotonic per publisher; the admission fence rejects replays and reordering. */
    qint64 sequence = 0;
    bool complete = false;
    bool truncated = false;
    QVector<SubagentStatusChild> children;
};

/** Parse one `setStatus` text; `std::nullopt` means "ignore this frame". */
std::optional<SubagentStatusSnapshot> parseSubagentStatusSnapshot(const QString &text);

} // namespace agentruntime
