#include "SessionEntryIds.h"

#include "PiTaskMessage.h"

#include <QJsonArray>
#include <QJsonObject>

#include <algorithm>

namespace sessionentryids {

TakeResult take(const QStringList &activeEntryIds, int entryIndex)
{
    TakeResult result;
    result.nextIndex = entryIndex + 1;
    if (entryIndex >= 0 && entryIndex < activeEntryIds.size()) result.entryId = activeEntryIds.at(entryIndex);
    return result;
}

bool consumesMessageEntry(const QJsonValue &message)
{
    if (!message.isObject()) return false;
    const QString role = message.toObject().value(QStringLiteral("role")).toString();
    pitask::TaskMessage task;
    return role == QLatin1String("user") || role == QLatin1String("assistant")
        || role == QLatin1String("toolResult") || role == QLatin1String("bashExecution")
        || pitask::readTodoTaskMessage(message, &task);
}

int countMessageEntries(const QVector<QJsonValue> &messages)
{
    int count = 0;
    for (const QJsonValue &message : messages) {
        if (consumesMessageEntry(message)) ++count;
    }
    return count;
}

ProjectionIds alignProjection(const QVector<QJsonValue> &entries, const QString &leafId,
                              const QVector<QJsonValue> &messages)
{
    QHash<QString, QJsonObject> byId;
    for (const QJsonValue &value : entries) {
        const QJsonObject entry = value.toObject();
        const QString id = entry.value(QStringLiteral("id")).toString();
        if (!id.isEmpty()) byId.insert(id, entry);
    }

    QVector<QJsonObject> branch;
    QSet<QString> seen;
    QString currentId = leafId;
    while (!currentId.isEmpty() && !seen.contains(currentId)) {
        seen.insert(currentId);
        const auto found = byId.constFind(currentId);
        if (found == byId.constEnd()) break;
        branch.append(*found);
        currentId = found->value(QStringLiteral("parentId")).toString();
    }
    std::reverse(branch.begin(), branch.end());

    ProjectionIds result;
    int compactedAt = -1;
    for (int index = 0; index < branch.size(); ++index) {
        const QJsonObject &entry = branch.at(index);
        const QString type = entry.value(QStringLiteral("type")).toString();
        const QJsonValue body = entry.value(QStringLiteral("message"));
        if (type == QLatin1String("compaction")) compactedAt = index;
        if ((type == QLatin1String("message") && !body.isUndefined() && !body.isNull())
            || pitask::readTodoTaskMessage(entry, nullptr)) {
            result.fileIds.append(entry.value(QStringLiteral("id")).toString());
        }
    }
    // An incomplete branch can still prove RPC identities for its known suffix,
    // but it cannot establish the complete file cursor space.
    if (!currentId.isEmpty()) result.fileIds.clear();

    QStringList ids;
    ids.reserve(messages.size());
    const auto match = [&messages, &ids](const QString &role, const QJsonObject &source, const QString &id = {},
                                         const QJsonValue &replacement = QJsonValue(QJsonValue::Undefined)) {
        // Only compare content for rows with a persisted source, not synthetic summaries.
        // Equal roles and timestamps alone cannot distinguish sibling entries.
        const bool needsTextBlock = role == QLatin1String("assistant") || role == QLatin1String("toolResult");
        const bool editsContent = needsTextBlock || role == QLatin1String("user") || role == QLatin1String("custom");
        QJsonValue content = source.value(QStringLiteral("content"));
        if (!replacement.isUndefined() && editsContent) {
            content = replacement.toObject().value(QStringLiteral("content"));
            if (content.isString() && needsTextBlock) {
                content = QJsonArray{QJsonObject{{QStringLiteral("type"), QStringLiteral("text")},
                                                {QStringLiteral("text"), content}}};
            }
        } else if (content.isUndefined() || content.isNull()) {
            // Pi normalizes older stored rows before returning get_messages.
            if (role == QLatin1String("system")) content = QStringLiteral("");
            else if (needsTextBlock || role == QLatin1String("user")) content = QJsonArray{};
        }
        if (role.isEmpty() || ids.size() >= messages.size()) return false;
        const QJsonObject raw = messages.at(ids.size()).toObject();
        if (raw.value(QStringLiteral("role")).toString() != role) return false;
        if (!id.isEmpty() && content != raw.value(QStringLiteral("content"))) return false;
        // Timestamps and tool/extension identities are stable where both snapshots carry them.
        const auto stamp = source.value(QStringLiteral("timestamp"));
        const auto rawStamp = raw.value(QStringLiteral("timestamp"));
        if (stamp.isDouble() && rawStamp.isDouble() && stamp != rawStamp) return false;
        for (const QString &key : {QStringLiteral("toolCallId"), QStringLiteral("customType")}) {
            const auto expected = source.value(key);
            const auto actual = raw.value(key);
            if (expected.isString() && actual.isString() && expected != actual) return false;
        }
        ids.append(id);
        return true;
    };

    int firstKept = 0;
    if (compactedAt >= 0) {
        const QJsonObject &checkpoint = branch.at(compactedAt);
        const QString anchor = checkpoint.value(QStringLiteral("firstKeptEntryId")).toString();
        while (firstKept < compactedAt && branch.at(firstKept).value(QStringLiteral("id")).toString() != anchor) {
            ++firstKept;
        }
        if (firstKept == compactedAt && checkpoint.value(QStringLiteral("id")).toString() != anchor) return result;
        // A self-anchor means no pre-checkpoint messages survived (for example a fork).
        // Pi emits the latest checkpoint and summary ahead of its retained messages.
        // An embedded system message comes from the compaction, not a file message slot.
        const QJsonObject system = checkpoint.value(QStringLiteral("systemMessage")).toObject();
        if ((!system.isEmpty() && !match(QStringLiteral("system"), system))
            || !match(QStringLiteral("compactionSummary"), {})) return result;
    }
    // Context edits change the RPC rows, not the file cursor space. Use the latest
    // retained edit as identity evidence for its target without changing any display body.
    QHash<QString, QJsonValue> replacements;
    for (int index = firstKept; index < branch.size(); ++index) {
        const QJsonObject &entry = branch.at(index);
        if (entry.value(QStringLiteral("type")).toString() == QLatin1String("context_edit")) {
            replacements.insert(entry.value(QStringLiteral("targetId")).toString(),
                                entry.value(QStringLiteral("replacement")));
        }
    }
    for (int index = firstKept; index < branch.size(); ++index) {
        const QJsonObject &entry = branch.at(index);
        const QString type = entry.value(QStringLiteral("type")).toString();
        const QString id = entry.value(QStringLiteral("id")).toString();
        const QJsonValue replacement = replacements.value(id, QJsonValue(QJsonValue::Undefined));
        if (type == QLatin1String("message")) {
            const QJsonObject message = entry.value(QStringLiteral("message")).toObject();
            const QString role = message.value(QStringLiteral("role")).toString();
            // Pi omits the old system instructions within a compaction's kept range,
            // but still emits ordinary system entries recorded after the checkpoint.
            if (index < compactedAt && role == QLatin1String("system")) continue;
            if (replacement.isNull()) continue;
            if (!match(role, message, id, replacement)) return result;
        } else if (type == QLatin1String("custom_message")) {
            if (replacement.isNull()) continue;
            const QString taskId = pitask::readTodoTaskMessage(entry, nullptr) ? id : QString{};
            if (!match(QStringLiteral("custom"), entry, taskId, replacement)) return result;
        } else if (type == QLatin1String("branch_summary") && !entry.value(QStringLiteral("summary")).toString().isEmpty()) {
            if (!match(QStringLiteral("branchSummary"), {})) return result;
        }
    }
    // If the snapshots disagree, keep the RPC bodies but never attach guessed IDs.
    if (ids.size() == messages.size()) {
        result.messageIds = ids;
        result.matched = true;
    }
    return result;
}

} // namespace sessionentryids

namespace missingtoolcalls {

QSet<QString> collectToolResultIds(const QVector<QJsonValue> &messages)
{
    QSet<QString> ids;
    for (const QJsonValue &value : messages) {
        if (!value.isObject()) continue;
        const QJsonObject message = value.toObject();
        if (message.value(QStringLiteral("role")).toString() != QLatin1String("toolResult")) continue;
        const QString toolCallId = message.value(QStringLiteral("toolCallId")).toString();
        if (!toolCallId.isEmpty()) ids.insert(toolCallId);
    }
    return ids;
}

QHash<int, QVector<DeclaredCall>> collect(const QVector<QJsonValue> &messages,
                                          const QSet<QString> &knownResultIds,
                                          const QSet<QString> &branchResultIds)
{
    QHash<int, QVector<DeclaredCall>> missing;
    QSet<QString> emitted;
    for (int index = 0; index < messages.size(); ++index) {
        if (!messages.at(index).isObject()) continue;
        const QJsonObject message = messages.at(index).toObject();
        if (message.value(QStringLiteral("role")).toString() != QLatin1String("assistant")) continue;
        const QJsonValue content = message.value(QStringLiteral("content"));
        if (!content.isArray()) continue;
        const QJsonValue timestamp = message.value(QStringLiteral("timestamp"));
        for (const QJsonValue &blockValue : content.toArray()) {
            if (!blockValue.isObject()) continue;
            const QJsonObject block = blockValue.toObject();
            if (block.value(QStringLiteral("type")).toString() != QLatin1String("toolCall")) continue;
            const QString id = block.value(QStringLiteral("id")).toString();
            if (id.isEmpty() || knownResultIds.contains(id) || branchResultIds.contains(id)
                || emitted.contains(id)) {
                continue;
            }
            emitted.insert(id);
            DeclaredCall call;
            call.toolCallId = id;
            const QString name = block.value(QStringLiteral("name")).toString();
            call.toolName = name.isEmpty() ? QStringLiteral("tool") : name;
            // pi stores tool arguments in the assistant toolCall block; `input` is the
            // provider-specific spelling some models emit.
            call.args = block.contains(QStringLiteral("arguments")) ? block.value(QStringLiteral("arguments"))
                                                                    : block.value(QStringLiteral("input"));
            if (timestamp.isDouble()) {
                call.hasTimestamp = true;
                call.timestamp = qint64(timestamp.toDouble());
            }
            missing[index].append(call);
        }
    }
    return missing;
}

} // namespace missingtoolcalls
