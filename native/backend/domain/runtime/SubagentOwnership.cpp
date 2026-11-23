#include "SubagentOwnership.h"

namespace agentruntime {

namespace {

/**
 * Alias key for one (kind, id, taskKey) triple.
 *
 * The oracle encodes aliases as `JSON.stringify([kind, id, taskKey])`; equality is all
 * that matters here, so a length-prefixed form keeps ids containing separators distinct.
 */
QString aliasKey(const QString &kind, const QString &id, const QString &taskKey)
{
    return QStringLiteral("%1|%2:%3|%4").arg(kind, QString::number(id.size()), id, taskKey);
}

} // namespace

QStringList SubagentOwnership::sourceKeys(const Source &source)
{
    QStringList keys;
    if (!source.workflowRunId.isEmpty()) {
        keys.append(aliasKey(QStringLiteral("workflow"), source.workflowRunId, source.taskKey));
    }
    if (!source.toolCallId.isEmpty()) {
        keys.append(aliasKey(QStringLiteral("tool"), source.toolCallId, source.taskKey));
    }
    // Legacy publishers carry only the task key; an id-less update of the same key cannot
    // distinguish another execution, so current publishers include runId.
    if (keys.isEmpty()) keys.append(aliasKey(QStringLiteral("legacy"), QString(), source.taskKey));
    return keys;
}

bool SubagentOwnership::acceptSnapshot(const SnapshotFenceFrame &frame, qint64 now)
{
    if (frame.workflowRunId.isEmpty()) return false;
    prune(now);
    const auto previous = m_snapshots.constFind(frame.workflowRunId);
    if (previous != m_snapshots.constEnd()) {
        const SnapshotFence &fence = previous.value();
        // Closed tasks stay closed, publishers cannot migrate between sessions, and
        // sequence must strictly increase: replaying or reordering a frame is a no-op.
        if (fence.closed || fence.ownerSessionId != frame.ownerSessionId
            || frame.sequence <= fence.sequence) {
            return false;
        }
    }
    // Empty unknown slots have no ownership to fence; do not accumulate empty tasks.
    if (previous != m_snapshots.constEnd() || frame.childCount > 0) {
        m_snapshots.insert(frame.workflowRunId, SnapshotFence{frame.ownerSessionId, frame.sequence,
                                                              frame.complete, now});
        touchFenceOrder(frame.workflowRunId);
        while (m_snapshotOrder.size() > kMaxSnapshotFences) {
            const QString oldest = m_snapshotOrder.value(0);
            if (oldest.isEmpty()) break;
            m_snapshotOrder.removeFirst();
            m_snapshots.remove(oldest);
        }
    }
    return true;
}

void SubagentOwnership::closeSnapshot(const QString &workflowRunId)
{
    const auto found = m_snapshots.find(workflowRunId);
    if (found != m_snapshots.end()) found->closed = true;
}

const SubagentOwnership::Execution *SubagentOwnership::current(const QString &sessionFile) const
{
    const auto found = m_sessions.constFind(sessionFile);
    if (found == m_sessions.constEnd() || found->currentIndex < 0) return nullptr;
    return &found->executions[size_t(found->currentIndex)];
}

SubagentOwnership::Execution *SubagentOwnership::current(const QString &sessionFile)
{
    const auto found = m_sessions.find(sessionFile);
    if (found == m_sessions.end() || found->currentIndex < 0) return nullptr;
    return &found->executions[size_t(found->currentIndex)];
}

SubagentOwnership::Execution *SubagentOwnership::claim(const QString &sessionFile,
                                                      const Source &source, qint64 now,
                                                      bool allowNew)
{
    if (sessionFile.isEmpty()) return nullptr;
    const QStringList keys = sourceKeys(source);
    const auto matchesSource = [&keys](const Execution &execution) {
        for (const QString &key : execution.sourceKeys) {
            if (keys.contains(key)) return true;
        }
        return false;
    };

    bool known = m_sessions.contains(sessionFile);
    int matched = -1;
    if (known) {
        SessionState &state = m_sessions[sessionFile];
        const int count = int(state.executions.size());
        if (!source.executionId.isEmpty()) {
            for (int index = 0; index < count; ++index) {
                if (state.executions[size_t(index)].executionId == source.executionId) {
                    matched = index;
                    break;
                }
            }
            // A legacy entry that just learned its id is metadata enrichment, not a new
            // attempt, even when that entry is already retired.
            if (matched < 0) {
                for (int index = 0; index < count; ++index) {
                    const Execution &execution = state.executions[size_t(index)];
                    if (execution.executionId.isEmpty() && matchesSource(execution)) {
                        matched = index;
                        break;
                    }
                }
            }
        } else {
            // `findLast(matchesSource)`: the newest matching attempt owns the path.
            for (int index = count - 1; index >= 0; --index) {
                if (matchesSource(state.executions[size_t(index)])) {
                    matched = index;
                    break;
                }
            }
        }
    }

    if (matched < 0) {
        if (!allowNew) return nullptr;
        Execution execution;
        execution.sourceKeys = keys;
        if (known) {
            SessionState &state = m_sessions[sessionFile];
            state.executions.push_back(execution);
            state.currentIndex = int(state.executions.size()) - 1;
        } else {
            SessionState state;
            state.executions.push_back(execution);
            state.currentIndex = 0;
            m_sessions.insert(sessionFile, state);
        }
        matched = m_sessions[sessionFile].currentIndex;
    }

    {
        SessionState &state = m_sessions[sessionFile];
        Execution &execution = state.executions[size_t(matched)];
        if (!source.executionId.isEmpty()) execution.executionId = source.executionId;
        if (!source.workflowRunId.isEmpty()) execution.workflowRunId = source.workflowRunId;
        if (!source.toolCallId.isEmpty()) execution.toolCallId = source.toolCallId;
        // Bounded alias growth: at most two aliases per producer.
        for (const QString &key : keys) {
            if (execution.sourceKeys.size() >= kMaxSourceKeys) break;
            if (!execution.sourceKeys.contains(key)) execution.sourceKeys.append(key);
        }
        state.updatedAt = now;
    }

    // LRU: the most recently claimed session file is the last to be capped away, exactly
    // like the oracle's `Map.delete` + `Map.set`.
    touchSessionOrder(sessionFile);
    while (m_sessionOrder.size() > kMaxSessions) {
        const QString oldest = m_sessionOrder.value(0);
        if (oldest.isEmpty()) break;
        m_sessionOrder.removeFirst();
        m_sessions.remove(oldest);
    }

    const auto stored = m_sessions.find(sessionFile);
    if (stored == m_sessions.end()) return nullptr;
    SessionState &state = stored.value();
    // Bound the attempt history of one session file (a long-lived resume chain).
    bool evicted = false;
    while (int(state.executions.size()) > kMaxExecutionsPerSession) {
        state.executions.pop_front();
        evicted = true;
        if (state.currentIndex == 0) {
            // The current attempt was the evicted one: no execution owns the path until a
            // new one is claimed (oracle keeps a reference to the shifted-out object, which
            // then never equals a found execution).
            state.currentIndex = -1;
        } else if (state.currentIndex > 0) {
            state.currentIndex -= 1;
        }
    }
    if (evicted && matched > 0) matched -= 1;
    if (matched < 0 || state.currentIndex != matched) return nullptr;
    return &state.executions[size_t(matched)];
}

void SubagentOwnership::clear()
{
    m_sessions.clear();
    m_sessionOrder.clear();
    m_snapshots.clear();
    m_snapshotOrder.clear();
}

void SubagentOwnership::prune(qint64 now)
{
    if (!m_sessions.isEmpty()) {
        QStringList expired;
        for (auto iterator = m_sessions.constBegin(); iterator != m_sessions.constEnd(); ++iterator) {
            if (now - iterator.value().updatedAt >= kFenceTtlMs) expired.append(iterator.key());
        }
        for (const QString &sessionFile : expired) {
            m_sessions.remove(sessionFile);
            m_sessionOrder.removeAll(sessionFile);
        }
    }
    if (!m_snapshots.isEmpty()) {
        QStringList expired;
        for (auto iterator = m_snapshots.constBegin(); iterator != m_snapshots.constEnd(); ++iterator) {
            if (now - iterator.value().updatedAt >= kFenceTtlMs) expired.append(iterator.key());
        }
        for (const QString &workflowRunId : expired) {
            m_snapshots.remove(workflowRunId);
            m_snapshotOrder.removeAll(workflowRunId);
        }
    }
}

void SubagentOwnership::touchSessionOrder(const QString &sessionFile)
{
    if (!m_sessionOrder.isEmpty() && m_sessionOrder.last() == sessionFile) return;
    m_sessionOrder.removeAll(sessionFile);
    m_sessionOrder.append(sessionFile);
}

void SubagentOwnership::touchFenceOrder(const QString &workflowRunId)
{
    if (!m_snapshotOrder.isEmpty() && m_snapshotOrder.last() == workflowRunId) return;
    m_snapshotOrder.removeAll(workflowRunId);
    m_snapshotOrder.append(workflowRunId);
}

} // namespace agentruntime
