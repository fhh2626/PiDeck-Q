#include "SubagentStatusSnapshot.h"

#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QSet>

#include <cmath>

namespace agentruntime {

namespace {

/** One frame ceiling; real payloads are far smaller and anything above is malformed. */
constexpr int kMaxStatusTextBytes = 32 * 1024;
// Aligned with the publisher and the tracker: more rows are cut and mark the frame truncated.
constexpr int kMaxChildren = 64;
constexpr int kMaxSessionPathBytes = 1024;
constexpr int kMaxAgentBytes = 96;
constexpr int kMaxIdBytes = 128;

const QSet<QString> &childStates()
{
    static const QSet<QString> states{
        QStringLiteral("running"), QStringLiteral("completed"), QStringLiteral("failed"),
        QStringLiteral("stopped"), QStringLiteral("paused"), QStringLiteral("detached"),
    };
    return states;
}

/** Trimmed, non-empty, byte-bounded string; anything else is invalid. */
QString bounded(const QJsonValue &value, int maxBytes)
{
    if (!value.isString()) return {};
    const QString trimmed = value.toString().trimmed();
    if (trimmed.isEmpty() || trimmed.toUtf8().size() > maxBytes) return {};
    return trimmed;
}

} // namespace

std::optional<SubagentStatusSnapshot> parseSubagentStatusSnapshot(const QString &text)
{
    if (text.toUtf8().size() > kMaxStatusTextBytes) return std::nullopt;
    QJsonParseError parseError{};
    const QJsonDocument document = QJsonDocument::fromJson(text.toUtf8(), &parseError);
    if (parseError.error != QJsonParseError::NoError || !document.isObject()) return std::nullopt;
    const QJsonObject record = document.object();
    const QJsonValue version = record.value(QStringLiteral("version"));
    if (!version.isDouble() || version.toDouble() != 1.0) return std::nullopt;

    SubagentStatusSnapshot snapshot;
    snapshot.ownerSessionId = bounded(record.value(QStringLiteral("ownerSessionId")), kMaxSessionPathBytes);
    snapshot.parentToolCallId = bounded(record.value(QStringLiteral("parentToolCallId")), kMaxIdBytes);
    snapshot.workflowRunId = bounded(record.value(QStringLiteral("workflowRunId")), kMaxIdBytes);
    if (snapshot.ownerSessionId.isEmpty() || snapshot.parentToolCallId.isEmpty()
        || snapshot.workflowRunId.isEmpty()) {
        return std::nullopt;
    }

    const QJsonValue sequence = record.value(QStringLiteral("sequence"));
    if (!sequence.isDouble()) return std::nullopt;
    const double sequenceValue = sequence.toDouble();
    // Safe integer: the publisher's counter must be an exact non-negative integer.
    if (!std::isfinite(sequenceValue) || sequenceValue < 0.0 || std::floor(sequenceValue) != sequenceValue
        || sequenceValue > 9007199254740991.0) {
        return std::nullopt;
    }
    snapshot.sequence = static_cast<qint64>(sequenceValue);

    const QJsonValue complete = record.value(QStringLiteral("complete"));
    const QJsonValue truncated = record.value(QStringLiteral("truncated"));
    if (!complete.isBool() || !truncated.isBool()) return std::nullopt;
    snapshot.complete = complete.toBool();
    const QJsonValue observedAt = record.value(QStringLiteral("observedAt"));
    if (!observedAt.isDouble() || !std::isfinite(observedAt.toDouble())) return std::nullopt;
    const QJsonValue childrenValue = record.value(QStringLiteral("children"));
    if (!childrenValue.isArray()) return std::nullopt;
    const QJsonArray children = childrenValue.toArray();

    // A cut or dropped row means this frame is not a full inventory: force `truncated` so
    // the tracker only applies the rows it actually received.
    bool dropped = children.size() > kMaxChildren;
    const int limit = qMin(children.size(), kMaxChildren);
    snapshot.children.reserve(limit);
    for (int index = 0; index < limit; ++index) {
        const QJsonValue item = children.at(index);
        if (!item.isObject()) {
            dropped = true;
            continue;
        }
        const QJsonObject child = item.toObject();
        const QString taskKey = bounded(child.value(QStringLiteral("taskKey")), kMaxIdBytes);
        const QString sessionFile = bounded(child.value(QStringLiteral("sessionFile")), kMaxSessionPathBytes);
        const QString state = child.value(QStringLiteral("state")).toString();
        // One bad row only loses that row; a frame-wide reject would hide every other dot.
        if (taskKey.isEmpty() || sessionFile.isEmpty() || !childStates().contains(state)) {
            dropped = true;
            continue;
        }
        SubagentStatusChild parsed;
        parsed.taskKey = taskKey;
        parsed.sessionFile = sessionFile;
        parsed.state = state;
        parsed.agent = bounded(child.value(QStringLiteral("agent")), kMaxAgentBytes);
        parsed.executionId = bounded(child.value(QStringLiteral("executionId")), kMaxIdBytes);
        snapshot.children.append(parsed);
    }
    snapshot.truncated = truncated.toBool() || dropped;
    return snapshot;
}

} // namespace agentruntime
