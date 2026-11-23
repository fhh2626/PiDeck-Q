#pragma once

#include <QHash>
#include <QString>
#include <QStringList>

#include <deque>

namespace agentruntime {

/**
 * Execution admission ledger for pi-owned child sessions.
 *
 * Port of `src/main/pi/SubagentExecutionOwnership.ts` (one instance per runtime, so the
 * oracle's per-agent map collapses into this object's own maps).
 *
 * Why a separate ledger from the visible rows: a pi subagent keeps writing to the same
 * child session file across resumes, and a superseded execution's late heartbeat must not
 * re-light the sidebar. Admission is therefore decided by execution identity, not by the
 * path alone:
 *  - identifiers are opaque, so only first observation orders executions (never id/time);
 *  - a source key first seen *without* an execution id owns the same attempt when the id
 *    arrives later (metadata enrichment is not a new launch);
 *  - a known retired attempt never reclaims a path, even after success/clear removed the
 *    row (the `finished` flag is the tombstone);
 *  - complete/clear fences survive row cleanup so a closed workflow cannot be reopened by
 *    a duplicate or higher-sequence frame.
 *
 * Everything is bounded: 64 executions per session file, 64 session files and 64 snapshot
 * fences per runtime, all expiring after 30 minutes without a source.
 */
class SubagentOwnership {
public:
    /** Mirrors `SUBAGENT_RUN_TRACKER_LIMITS`. */
    static constexpr int kMaxSessions = 64;
    static constexpr int kMaxSnapshotFences = 64;
    static constexpr int kMaxExecutionsPerSession = 64;
    static constexpr qint64 kFenceTtlMs = 30 * 60'000;
    /** At most two aliases per producer (workflow id and parent tool id) plus the legacy key. */
    static constexpr int kMaxSourceKeys = 4;

    /** One execution identity observed for a child session file. */
    struct Source {
        QString workflowRunId;
        QString toolCallId;
        QString taskKey;
        QString executionId;
    };

    struct Execution {
        QStringList sourceKeys;
        QString executionId;
        QString workflowRunId;
        QString toolCallId;
        QString snapshotRunId;
        /** Successful/cleared execution stays a tombstone even though its light is gone. */
        bool finished = false;
    };

    /** One accepted status-slot frame; the fence is per workflow run id. */
    struct SnapshotFenceFrame {
        QString ownerSessionId;
        QString workflowRunId;
        qint64 sequence = 0;
        bool complete = false;
        int childCount = 0;
    };

    /** Sequence/closed-task fence for one status publisher; `false` means "drop this frame". */
    bool acceptSnapshot(const SnapshotFenceFrame &frame, qint64 now);
    /** Explicit slot clear: close the source so it cannot reopen itself. */
    void closeSnapshot(const QString &workflowRunId);

    /** Current owner of a path, or nullptr when nothing was ever claimed. */
    Execution *current(const QString &sessionFile);
    const Execution *current(const QString &sessionFile) const;

    /**
     * Resolve aliases first, then admit a new execution when allowed.
     *
     * Returns nullptr when no known execution matches and `allowNew` is false, and also
     * when the matched execution was superseded by a newer one (the caller must then skip
     * the frame instead of publishing a stale row). A returned pointer stays valid until
     * the next `claim`/`prune`/`clear` call on this ledger.
     */
    Execution *claim(const QString &sessionFile, const Source &source, qint64 now,
                     bool allowNew = true);

    void clear();
    /** Drop session files and fences with no source for 30 minutes (oracle `prune`). */
    void prune(qint64 now);

private:
    struct SessionState {
        std::deque<Execution> executions;
        /** Index into `executions`; -1 when the current execution was evicted. */
        int currentIndex = -1;
        qint64 updatedAt = 0;
    };
    struct SnapshotFence {
        QString ownerSessionId;
        qint64 sequence = 0;
        bool closed = false;
        qint64 updatedAt = 0;
    };

    static QStringList sourceKeys(const Source &source);
    void touchSessionOrder(const QString &sessionFile);
    void touchFenceOrder(const QString &workflowRunId);

    QHash<QString, SessionState> m_sessions;
    QStringList m_sessionOrder;
    QHash<QString, SnapshotFence> m_snapshots;
    QStringList m_snapshotOrder;
};

} // namespace agentruntime
