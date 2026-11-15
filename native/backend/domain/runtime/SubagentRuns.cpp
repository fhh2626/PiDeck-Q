#include "SubagentRuns.h"

#include "SessionIdentity.h"
#include "SubagentRunUpdates.h"
#include "SubagentStatusSnapshot.h"

#include <QDir>
#include <QSet>
#include <QtGlobal>

namespace agentruntime {

namespace {

// The payload parser is a separate owner; these aliases keep the tracker readable.
using subagentupdates::extract;
using subagentupdates::kMaxIdChars;
using ExtractedUpdate = subagentupdates::Update;

/** Bounded millisecond override; `0` means "keep the oracle default". */
qint64 ttlOverride(const char *name, qint64 maximum)
{
    bool ok = false;
    const qint64 value = qEnvironmentVariable(name).trimmed().toLongLong(&ok);
    if (!ok || value <= 0 || value > maximum) return 0;
    return value;
}

} // namespace

SubagentRuns::Limits SubagentRuns::limitsFromEnvironment()
{
    Limits limits;
    if (const qint64 value = ttlOverride("PIDECK_SUBAGENT_SNAPSHOT_STALE_MS", 60 * 60'000)) {
        limits.snapshotStaleMs = value;
    }
    if (const qint64 value = ttlOverride("PIDECK_SUBAGENT_RUNNING_TTL_MS", 24 * 60 * 60'000)) {
        limits.runningTtlMs = value;
    }
    if (const qint64 value = ttlOverride("PIDECK_SUBAGENT_ERROR_TTL_MS", 24 * 60 * 60'000)) {
        limits.errorTtlMs = value;
    }
    return limits;
}

SubagentRuns::SubagentRuns() = default;

SubagentRuns::SubagentRuns(Limits limits) : m_limits(limits) {}

void SubagentRuns::setScheduleHook(std::function<void()> hook)
{
    m_schedule = std::move(hook);
}

QString SubagentRuns::statusKeyPrefix()
{
    // Must stay byte-identical to `SUBAGENT_STATUS_KEY_PREFIX` in
    // src/shared/types/subagents.ts: the extension composes the key with this prefix and
    // any drift silently drops every heartbeat.
    return QStringLiteral("pideck.subagent-status.v1:");
}

bool SubagentRuns::sameSessionPath(const QString &left, const QString &right)
{
    const auto normalize = [](QString value) {
        value = QDir::cleanPath(QDir::fromNativeSeparators(value.trimmed()));
        while (value.size() > 1 && value.endsWith(QLatin1Char('/'))) value.chop(1);
#ifdef Q_OS_WIN
        // Windows drive letters and separators are case-insensitive; a case-only
        // difference must not be read as "another session".
        value = value.toLower();
#endif
        return value;
    };
    if (left.isEmpty() || right.isEmpty()) return false;
    return normalize(left) == normalize(right);
}

bool SubagentRuns::observeToolResult(const QString &toolName, const QJsonObject &details,
                                     const QString &toolCallId, qint64 now)
{
    // Only the two tools that can own a pi child session contribute rows; anything else
    // (including another extension reusing `details.results`) must not light the sidebar.
    const QString name = toolName.toLower();
    if (name != QLatin1String("subagent") && name != QLatin1String("bg_wait")) return false;
    bool changed = prune(now);
    const QVector<ExtractedUpdate> updates = extract(details);
    const QString boundedToolCallId = toolCallId.size() <= kMaxIdChars ? toolCallId : QString();
    for (const ExtractedUpdate &update : updates) {
        const SubagentOwnership::Execution *previousOwner = m_ownership.current(update.sessionFile);
        // An anonymous detach receipt cannot prove a NEW execution. Known aliases still
        // resolve normally; actual new launches identify themselves with runId or running.
        const bool allowNew = update.status == QLatin1String("running")
            || !update.executionId.isEmpty() || !update.workflowRunId.isEmpty()
            || previousOwner == nullptr || previousOwner->snapshotRunId.isEmpty();
        SubagentOwnership::Source source;
        source.workflowRunId = update.workflowRunId;
        source.toolCallId = boundedToolCallId;
        source.taskKey = update.taskKey;
        source.executionId = update.executionId;
        SubagentOwnership::Execution *owner = m_ownership.claim(update.sessionFile, source, now, allowNew);
        if (!owner) continue;
        // A live heartbeat outlives the tool call that started it: handoff is the whole
        // reason the status slot exists, so the slot is authoritative while it beats.
        if (!owner->snapshotRunId.isEmpty() && hasLiveSnapshotTask(owner->snapshotRunId, now)) continue;
        // Completion closes liveness, not the outcome: a current terminal failure may
        // arrive after an empty complete frame and still needs its red row.
        if (owner->finished && !owner->executionId.isEmpty()
            && update.status == QLatin1String("running")) {
            continue;
        }
        if (update.status == QLatin1String("completed")) {
            owner->finished = true;
            if (removeRow(update.sessionFile)) changed = true;
            continue;
        }
        if (update.status != QLatin1String("running") && update.status != QLatin1String("error")) {
            continue;
        }
        Run run;
        run.sessionFile = update.sessionFile;
        run.status = update.status;
        run.agent = update.agent;
        run.toolCallId = owner->toolCallId;
        run.workflowRunId = owner->workflowRunId;
        run.updatedAt = now;
        changed = writeRun(run) || changed;
    }
    return settle(now) || changed;
}

bool SubagentRuns::observeStatusSnapshot(const QString &workflowRunId, const QString &statusText,
                                         const QString &ownerSessionPath, const QString &ownerBasePath,
                                         const QString &environment, qint64 now)
{
    bool changed = prune(now);
    const QString runId = workflowRunId.trimmed();
    if (runId.isEmpty() || statusText.isEmpty()) return changed;
    const std::optional<SubagentStatusSnapshot> parsed = parseSubagentStatusSnapshot(statusText);
    // The key and the payload must name the same task, otherwise one workflow could
    // overwrite another workflow's slot.
    if (!parsed || parsed->workflowRunId != runId) {
        schedule();
        return changed;
    }
    // Session identity gate: after `switch_session` inside one pi process the old
    // publisher keeps heartbeating, and its rows would light the wrong session's sidebar.
    // The extension may hand over a project-relative id, so resolve it against the project
    // root first (oracle `AgentManager.observeSubagentStatusSlot` -> `toAbsoluteSessionPath`);
    // comparing the raw value would silently drop every relative publisher.
    if (!ownerSessionPath.isEmpty()) {
        const QString resolvedOwner = ownerBasePath.isEmpty()
            ? parsed->ownerSessionId
            : sessionidentity::toAbsoluteSessionPath(parsed->ownerSessionId, ownerBasePath, environment);
        if (!sameSessionPath(resolvedOwner, ownerSessionPath)) {
            schedule();
            return changed;
        }
    }
    SubagentOwnership::SnapshotFenceFrame fenceFrame;
    fenceFrame.ownerSessionId = parsed->ownerSessionId;
    fenceFrame.workflowRunId = runId;
    fenceFrame.sequence = parsed->sequence;
    fenceFrame.complete = parsed->complete;
    fenceFrame.childCount = parsed->children.size();
    if (!m_ownership.acceptSnapshot(fenceFrame, now)) {
        // Duplicate, reordered, foreign-owner or already-closed frame: nothing to publish,
        // but the armed deadline may still need a refresh.
        schedule();
        return changed;
    }

    QSet<QString> nextFiles;
    QSet<QString> supersededFiles;
    for (const SubagentStatusChild &child : parsed->children) {
        nextFiles.insert(child.sessionFile);
        SubagentOwnership::Source source;
        source.workflowRunId = runId;
        source.toolCallId = parsed->parentToolCallId;
        source.taskKey = child.taskKey;
        source.executionId = child.executionId;
        SubagentOwnership::Execution *owner = m_ownership.claim(child.sessionFile, source, now);
        if (!owner) {
            // A superseded attempt: keep whatever row the newer owner published.
            supersededFiles.insert(child.sessionFile);
            continue;
        }
        owner->snapshotRunId = runId;
        if (owner->finished && !owner->executionId.isEmpty()
            && child.state == QLatin1String("running")) {
            continue;
        }
        const QString status = child.state == QLatin1String("failed") ? QStringLiteral("error")
            : (child.state == QLatin1String("running") && !parsed->complete) ? QStringLiteral("running")
                                                                           : QString();
        if (status.isEmpty()) {
            // Terminal / non-live child: close the row unless it is a failure the
            // sidebar should keep showing until its TTL expires.
            owner->finished = true;
            if (removeRow(child.sessionFile)) changed = true;
            continue;
        }
        Run run;
        run.sessionFile = child.sessionFile;
        run.status = status;
        run.agent = child.agent;
        run.toolCallId = parsed->parentToolCallId;
        run.snapshotRunId = runId;
        run.workflowRunId = runId;
        run.updatedAt = now;
        changed = writeRun(run) || changed;
    }

    // A complete frame is a full list: rows still owned by this workflow are gone, but
    // failures stay (the outcome is not liveness) and superseded attempts keep their
    // newer row. Truncated frames only ever update the rows they actually contain,
    // except when the frame also declares the task complete: then the inventory is final
    // and every remaining owned row closes.
    QStringList dropped;
    for (auto iterator = m_runs.constBegin(); iterator != m_runs.constEnd(); ++iterator) {
        const Run &run = iterator.value();
        const QString &sessionFile = iterator.key();
        if (supersededFiles.contains(sessionFile)) continue;
        if (parsed->complete) {
            if (run.snapshotRunId != runId && run.workflowRunId != runId) continue;
            if (run.status == QLatin1String("error")) continue;
        } else if (parsed->truncated || run.snapshotRunId != runId || nextFiles.contains(sessionFile)) {
            continue;
        }
        dropped.append(sessionFile);
    }
    for (const QString &sessionFile : dropped) {
        SubagentOwnership::Execution *owner = m_ownership.current(sessionFile);
        if (owner) owner->finished = true;
        if (removeRow(sessionFile)) changed = true;
    }

    if (parsed->complete) {
        if (m_tasks.remove(runId)) m_taskOrder.removeAll(runId);
    } else if (!parsed->children.isEmpty() || m_tasks.contains(runId)) {
        // Heartbeat refreshed: the task is the last to be capped away.
        m_taskOrder.removeAll(runId);
        m_taskOrder.append(runId);
        m_tasks.insert(runId, now);
    }
    // Bounded publisher flood: the oldest task loses its running rows.
    while (m_tasks.size() > kMaxSnapshotTasks) {
        const QString oldest = m_taskOrder.value(0);
        if (oldest.isEmpty()) break;
        m_taskOrder.removeFirst();
        m_tasks.remove(oldest);
        changed = removeTaskRunning(oldest) || changed;
    }
    return settle(now) || changed;
}

bool SubagentRuns::clearStatusTask(const QString &workflowRunId, qint64 now)
{
    if (workflowRunId.isEmpty()) return false;
    // Explicit clear closes the source: a later heartbeat for this workflow cannot reopen it.
    m_ownership.closeSnapshot(workflowRunId);
    if (m_tasks.remove(workflowRunId)) m_taskOrder.removeAll(workflowRunId);
    for (auto iterator = m_runs.constBegin(); iterator != m_runs.constEnd(); ++iterator) {
        const Run &run = iterator.value();
        if (run.status != QLatin1String("running")
            || (run.snapshotRunId != workflowRunId && run.workflowRunId != workflowRunId)) {
            continue;
        }
        SubagentOwnership::Execution *owner = m_ownership.current(iterator.key());
        if (owner) owner->finished = true;
    }
    // Both sides must run: `settle` caps/flushes, `removeTaskRunning` closes the rows.
    const bool removed = removeTaskRunning(workflowRunId);
    return settle(now) || removed;
}

bool SubagentRuns::clearToolCall(const QString &toolCallId, qint64 now)
{
    bool changed = false;
    if (!toolCallId.isEmpty()) {
        QStringList closing;
        for (auto iterator = m_runs.constBegin(); iterator != m_runs.constEnd(); ++iterator) {
            const Run &run = iterator.value();
            if (run.toolCallId != toolCallId || run.status != QLatin1String("running")) continue;
            // A live heartbeat outlives the tool call that started it.
            if (!run.snapshotRunId.isEmpty() && hasLiveSnapshotTask(run.snapshotRunId, now)) continue;
            closing.append(iterator.key());
        }
        for (const QString &sessionFile : closing) changed = removeRow(sessionFile) || changed;
    }
    return settle(now) || changed;
}

bool SubagentRuns::clearRunning(qint64 now)
{
    bool changed = false;
    QStringList closing;
    for (auto iterator = m_runs.constBegin(); iterator != m_runs.constEnd(); ++iterator) {
        const Run &run = iterator.value();
        if (run.status != QLatin1String("running")) continue;
        if (!run.snapshotRunId.isEmpty() && hasLiveSnapshotTask(run.snapshotRunId, now)) continue;
        closing.append(iterator.key());
    }
    for (const QString &sessionFile : closing) changed = removeRow(sessionFile) || changed;
    return settle(now) || changed;
}

QJsonArray SubagentRuns::snapshot(qint64 now)
{
    prune(now);
    settle(now);
    QJsonArray runs;
    for (const QString &sessionFile : m_order) {
        const auto found = m_runs.constFind(sessionFile);
        if (found == m_runs.constEnd()) continue;
        const Run &run = found.value();
        QJsonObject row{
            {QStringLiteral("sessionFile"), run.sessionFile},
            {QStringLiteral("status"), run.status},
            {QStringLiteral("updatedAt"), static_cast<double>(run.updatedAt)},
        };
        if (!run.agent.isEmpty()) row.insert(QStringLiteral("agent"), run.agent);
        runs.append(row);
    }
    return runs;
}

bool SubagentRuns::expire(qint64 now)
{
    const bool changed = prune(now);
    // Even an unchanged projection must re-arm: the deadline that just elapsed may have
    // been followed by a heartbeat that pushed it out again.
    schedule();
    return changed;
}

qint64 SubagentRuns::nextExpiryDeadline() const
{
    qint64 deadline = 0;
    const auto consider = [&deadline](qint64 candidate) {
        if (candidate <= 0) return;
        if (deadline == 0 || candidate < deadline) deadline = candidate;
    };
    for (auto iterator = m_tasks.constBegin(); iterator != m_tasks.constEnd(); ++iterator) {
        consider(iterator.value() + m_limits.snapshotStaleMs);
    }
    for (auto iterator = m_runs.constBegin(); iterator != m_runs.constEnd(); ++iterator) {
        const Run &run = iterator.value();
        consider(run.updatedAt
                 + (run.status == QLatin1String("error") ? m_limits.errorTtlMs : m_limits.runningTtlMs));
    }
    return deadline;
}

void SubagentRuns::clear()
{
    m_runs.clear();
    m_order.clear();
    m_tasks.clear();
    m_taskOrder.clear();
    m_ownership.clear();
    schedule();
}

bool SubagentRuns::removeRow(const QString &sessionFile)
{
    if (!m_runs.remove(sessionFile)) return false;
    m_order.removeAll(sessionFile);
    return true;
}

bool SubagentRuns::prune(qint64 now)
{
    m_ownership.prune(now);
    bool changed = false;
    QStringList staleTasks;
    for (auto iterator = m_tasks.constBegin(); iterator != m_tasks.constEnd(); ++iterator) {
        if (now - iterator.value() >= m_limits.snapshotStaleMs) staleTasks.append(iterator.key());
    }
    for (const QString &runId : staleTasks) {
        m_tasks.remove(runId);
        m_taskOrder.removeAll(runId);
        // A lost heartbeat only invalidates `running`; failures stay until their TTL.
        changed = removeTaskRunning(runId) || changed;
    }
    QStringList expiredRuns;
    for (auto iterator = m_runs.constBegin(); iterator != m_runs.constEnd(); ++iterator) {
        const Run &run = iterator.value();
        const qint64 ttl = run.status == QLatin1String("error") ? m_limits.errorTtlMs : m_limits.runningTtlMs;
        if (now - run.updatedAt >= ttl) expiredRuns.append(iterator.key());
    }
    for (const QString &sessionFile : expiredRuns) changed = removeRow(sessionFile) || changed;
    dropEmptyTasks();
    return changed;
}

bool SubagentRuns::writeRun(const Run &run)
{
    const auto previous = m_runs.constFind(run.sessionFile);
    // `updatedAt` deliberately does not count as a change: the same heartbeat must not
    // wake the sidebar every second.
    const bool changed = previous == m_runs.constEnd() || previous->status != run.status
        || previous->agent != run.agent;
    m_runs.insert(run.sessionFile, run);
    // Most recently written row is the last capped away (oracle Map delete + set).
    if (!m_order.isEmpty() && m_order.last() == run.sessionFile) return changed;
    m_order.removeAll(run.sessionFile);
    m_order.append(run.sessionFile);
    return changed;
}

bool SubagentRuns::settle(qint64 now)
{
    Q_UNUSED(now);
    bool changed = false;
    while (m_runs.size() > kMaxRuns) {
        const QString oldest = m_order.value(0);
        if (oldest.isEmpty()) break;
        m_order.removeFirst();
        m_runs.remove(oldest);
        changed = true;
    }
    QStringList visible;
    visible.reserve(m_order.size());
    for (const QString &sessionFile : m_order) {
        if (m_runs.contains(sessionFile)) visible.append(sessionFile);
    }
    m_order = visible;
    dropEmptyTasks();
    schedule();
    return changed;
}

bool SubagentRuns::removeTaskRunning(const QString &workflowRunId)
{
    if (workflowRunId.isEmpty()) return false;
    QStringList closing;
    for (auto iterator = m_runs.constBegin(); iterator != m_runs.constEnd(); ++iterator) {
        const Run &run = iterator.value();
        if (run.status == QLatin1String("error")) continue;
        if (run.snapshotRunId != workflowRunId && run.workflowRunId != workflowRunId) continue;
        closing.append(iterator.key());
    }
    bool changed = false;
    for (const QString &sessionFile : closing) changed = removeRow(sessionFile) || changed;
    return changed;
}

bool SubagentRuns::hasLiveSnapshotTask(const QString &workflowRunId, qint64 now) const
{
    if (workflowRunId.isEmpty()) return false;
    const auto found = m_tasks.constFind(workflowRunId);
    return found != m_tasks.constEnd() && now - found.value() < m_limits.snapshotStaleMs;
}

void SubagentRuns::dropEmptyTasks()
{
    if (m_tasks.isEmpty()) return;
    QSet<QString> owners;
    for (const QString &sessionFile : m_order) {
        const auto found = m_runs.constFind(sessionFile);
        if (found == m_runs.constEnd()) continue;
        if (!found->snapshotRunId.isEmpty()) owners.insert(found->snapshotRunId);
    }
    QStringList closing;
    for (auto iterator = m_tasks.constBegin(); iterator != m_tasks.constEnd(); ++iterator) {
        if (!owners.contains(iterator.key())) closing.append(iterator.key());
    }
    for (const QString &runId : closing) {
        m_tasks.remove(runId);
        m_taskOrder.removeAll(runId);
    }
}

void SubagentRuns::schedule()
{
    if (m_schedule) m_schedule();
}

} // namespace agentruntime
