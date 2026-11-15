#include "SubagentRunUpdates.h"

#include <QJsonArray>

namespace agentruntime {
namespace subagentupdates {

namespace {

/** Same per-frame bound as the tracker (`SubagentRunTrackerLimits.maxRunsPerAgent`). */
constexpr int kMaxRowsPerFrame = 64;

/**
 * Status of a settled tool result (`resultStatus` in subagentRunUpdates.ts).
 *
 * `progress.status` wins over the legacy flags because a workflow keeps reporting
 * progress after a subagent's own result row was written.
 */
QString resultStatus(const QJsonObject &item)
{
    const QJsonValue progress = item.value(QStringLiteral("progress"));
    if (progress.isObject()) {
        const QString status = progress.toObject().value(QStringLiteral("status")).toString();
        if (status == QLatin1String("running") || status == QLatin1String("pending")) {
            return QStringLiteral("running");
        }
        if (status == QLatin1String("failed")) return QStringLiteral("error");
        if (status == QLatin1String("completed") || status == QLatin1String("detached")) {
            return QStringLiteral("completed");
        }
    }
    if (item.value(QStringLiteral("success")).toBool(false)) return QStringLiteral("completed");
    for (const char *flag : {"stopped", "timedOut", "interrupted", "turnBudgetExceeded"}) {
        if (item.value(QLatin1String(flag)).toBool(false)) return QStringLiteral("error");
    }
    const QString error = item.value(QStringLiteral("error")).toString();
    if (!error.trimmed().isEmpty()) return QStringLiteral("error");
    if (item.value(QStringLiteral("exitCode")).isDouble()) {
        return item.value(QStringLiteral("exitCode")).toInt() == 0 ? QStringLiteral("completed")
                                                                   : QStringLiteral("error");
    }
    return QStringLiteral("running");
}

/** Workflow child state (`workflowStatus`): `pending` is queued, never lit. */
QString workflowStatus(const QJsonValue &value)
{
    const QString state = value.toString();
    if (state == QLatin1String("running")) return QStringLiteral("running");
    if (state == QLatin1String("failed") || state == QLatin1String("rejected")) {
        return QStringLiteral("error");
    }
    if (state == QLatin1String("completed") || state == QLatin1String("stopped")
        || state == QLatin1String("detached") || state == QLatin1String("paused")) {
        return QStringLiteral("completed");
    }
    return {};
}

} // namespace

/** `extractSubagentRunUpdates`: results first, then workflow children, then completions. */
QVector<Update> extract(const QJsonObject &details)
{
    QVector<Update> observed;
    if (details.value(QStringLiteral("mode")).toString() != QLatin1String("management")) {
        const QJsonObject summary = details.value(QStringLiteral("workflowChildren")).toObject();
        QString workflowRunId = bounded(summary.value(QStringLiteral("workflowRunId")), kMaxIdChars);
        if (workflowRunId.isEmpty()) {
            workflowRunId = bounded(details.value(QStringLiteral("runId")), kMaxIdChars);
        }
        QVector<QJsonObject> rows;
        const QJsonArray childRows = summary.value(QStringLiteral("children")).toArray();
        for (const QJsonValue &child : childRows) {
            if (rows.size() >= kMaxRowsPerFrame) break;
            if (child.isObject()) rows.append(child.toObject());
        }
        const QJsonArray results = details.value(QStringLiteral("results")).toArray();

        QHash<QString, Update> settled;
        QStringList settledOrder;
        for (const QJsonValue &value : results) {
            if (settled.size() >= kMaxRowsPerFrame) break;
            if (!value.isObject()) continue;
            const QJsonObject result = value.toObject();
            const QString sessionFile = bounded(result.value(QStringLiteral("sessionFile")), kMaxPathChars);
            if (sessionFile.isEmpty()) continue;
            QString taskKey = bounded(result.value(QStringLiteral("workflowKey")), kMaxIdChars);
            if (taskKey.isEmpty()) taskKey = QStringLiteral("single");
            QString executionId = bounded(result.value(QStringLiteral("runId")), kMaxIdChars);
            if (executionId.isEmpty()) {
                for (const QJsonObject &row : rows) {
                    if (row.value(QStringLiteral("childId")).toString() != taskKey) continue;
                    executionId = bounded(row.value(QStringLiteral("runId")), kMaxIdChars);
                    break;
                }
            }
            if (executionId.isEmpty() && summary.isEmpty()) {
                executionId = bounded(details.value(QStringLiteral("runId")), kMaxIdChars);
            }
            Update update{sessionFile, resultStatus(result),
                                   bounded(result.value(QStringLiteral("agent")), kMaxAgentChars),
                                   taskKey, workflowRunId, executionId};
            if (!settled.contains(sessionFile)) settledOrder.append(sessionFile);
            settled.insert(sessionFile, update);
        }

        QHash<QString, Update> bySession;
        QStringList order;
        for (const QJsonObject &child : rows) {
            const QString sessionFile = bounded(child.value(QStringLiteral("sessionFile")), kMaxPathChars);
            const QString status = workflowStatus(child.value(QStringLiteral("state")));
            if (sessionFile.isEmpty() || status.isEmpty()) continue;
            Update update;
            update.sessionFile = sessionFile;
            update.status = status;
            update.agent = bounded(child.value(QStringLiteral("agent")), kMaxAgentChars);
            if (update.agent.isEmpty() && settled.contains(sessionFile)) {
                update.agent = settled.value(sessionFile).agent;
            }
            update.taskKey = bounded(child.value(QStringLiteral("childId")), kMaxIdChars);
            if (update.taskKey.isEmpty()) update.taskKey = QStringLiteral("single");
            update.workflowRunId = workflowRunId;
            update.executionId = bounded(child.value(QStringLiteral("runId")), kMaxIdChars);
            if (!bySession.contains(sessionFile)) order.append(sessionFile);
            bySession.insert(sessionFile, update);
        }
        for (const QString &sessionFile : settledOrder) {
            const Update terminal = settled.value(sessionFile);
            const auto current = bySession.constFind(sessionFile);
            if (current == bySession.constEnd()) {
                if (!bySession.contains(sessionFile)) order.append(sessionFile);
                bySession.insert(sessionFile, terminal);
                continue;
            }
            // With identities only the SAME execution may settle a row: old results stay
            // in a workflow's result list for the whole task, so a path match alone would
            // let an older execution close a newer one.
            const Update existing = current.value();
            const bool haveExecutionId =
                !existing.executionId.isEmpty() || !terminal.executionId.isEmpty();
            // `rows.filter(row => row.sessionFile === sessionFile).length === 1` in the
            // oracle: only a single-row workflow may settle by task key alone.
            int rowsForSession = 0;
            for (const QJsonObject &row : rows) {
                if (bounded(row.value(QStringLiteral("sessionFile")), kMaxPathChars) == sessionFile) {
                    ++rowsForSession;
                }
            }
            const bool sameExecution = haveExecutionId
                ? (!existing.executionId.isEmpty() && existing.executionId == terminal.executionId)
                : (existing.taskKey == terminal.taskKey
                   || (terminal.taskKey == QLatin1String("single") && rowsForSession == 1));
            if (!sameExecution) continue;
            if (existing.status == QLatin1String("running") && terminal.status != QLatin1String("running")) {
                Update merged = terminal;
                merged.taskKey = existing.taskKey;
                bySession.insert(sessionFile, merged);
            }
        }
        for (const QString &sessionFile : order) observed.append(bySession.value(sessionFile));
    }

    // `bg_wait` completions bypass the management filter: they are the only frame that
    // can close rows a management call opened.
    const QJsonArray completions = details.value(QStringLiteral("completions")).toArray();
    for (const QJsonValue &value : completions) {
        if (observed.size() >= kMaxRowsPerFrame * 2) break;
        if (!value.isObject()) continue;
        const QJsonObject completion = value.toObject();
        const QString completionRunId = bounded(completion.value(QStringLiteral("runId")), kMaxIdChars);
        const QJsonArray children = completion.value(QStringLiteral("results")).toArray();
        for (const QJsonValue &child : children) {
            if (!child.isObject()) continue;
            const QJsonObject result = child.toObject();
            const QString sessionFile = bounded(result.value(QStringLiteral("sessionFile")), kMaxPathChars);
            if (sessionFile.isEmpty()) continue;
            QString executionId = bounded(result.value(QStringLiteral("runId")), kMaxIdChars);
            if (executionId.isEmpty()) executionId = completionRunId;
            observed.append(Update{
                sessionFile,
                result.value(QStringLiteral("success")).toBool(true) ? QStringLiteral("completed")
                                                                    : QStringLiteral("error"),
                QString(), QStringLiteral("single"), QString(), executionId});
        }
    }
    return observed;
}

QString bounded(const QJsonValue &value, int maxChars)
{
    if (!value.isString()) return {};
    const QString trimmed = value.toString().trimmed();
    if (trimmed.isEmpty() || trimmed.size() > maxChars) return {};
    return trimmed;
}

} // namespace subagentupdates
} // namespace agentruntime
