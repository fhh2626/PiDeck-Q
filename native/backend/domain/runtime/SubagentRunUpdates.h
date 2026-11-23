#pragma once

#include <QJsonArray>
#include <QJsonObject>
#include <QJsonValue>
#include <QString>
#include <QVector>

/**
 * Subagent tool-payload extraction (port of src/main/pi/subagentRunUpdates.ts).
 *
 * Split out of SubagentRuns.cpp so the tracker (row lifecycle, ownership fence, TTL)
 * and the untrusted-payload parsing stay separate owners, mirroring the two oracle files.
 * Everything here is length-bounded: `details` comes from pi, i.e. from a model's tool
 * result, and may be arbitrarily large or hostile.
 */
namespace agentruntime {
namespace subagentupdates {

constexpr int kMaxIdChars = 128;
constexpr int kMaxAgentChars = 96;
constexpr int kMaxPathChars = 1024;

/** Length-bounded string; `undefined`/non-string/oversized values become empty. */
QString bounded(const QJsonValue &value, int maxChars);

/** One observed execution state for a child session file. */
struct Update {
    QString sessionFile;
    QString status;
    QString agent;
    QString taskKey;
    QString workflowRunId;
    QString executionId;
};

/** Latest execution of each session in one tool frame (results, workflow children, completions). */
QVector<Update> extract(const QJsonObject &details);

} // namespace subagentupdates
} // namespace agentruntime
