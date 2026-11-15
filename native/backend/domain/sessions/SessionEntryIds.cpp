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

QStringList buildActiveBranchEntryIds(const QVector<QJsonValue> &entries, const QString &leafId)
{
    QHash<QString, QJsonObject> byId;
    for (const QJsonValue &value : entries) {
        if (!value.isObject()) continue;
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
        if (found == byId.constEnd()) {
            branch.append(QJsonObject{{QStringLiteral("id"), currentId}});
            break;
        }
        branch.append(*found);
        currentId = found->value(QStringLiteral("parentId")).toString();
    }
    std::reverse(branch.begin(), branch.end());

    const auto isMessage = [](const QJsonObject &entry) {
        pitask::TaskMessage task;
        return entry.value(QStringLiteral("type")).toString() == QLatin1String("message")
            || pitask::readTodoTaskMessage(QJsonValue(entry), &task);
    };

    // The compaction nearest the leaf is the one pi's get_messages honours.
    int compactionIndex = -1;
    for (int index = branch.size() - 1; index >= 0; --index) {
        if (branch.at(index).value(QStringLiteral("type")).toString() == QLatin1String("compaction")) {
            compactionIndex = index;
            break;
        }
    }
    QStringList ids;
    if (compactionIndex < 0) {
        for (const QJsonObject &entry : branch) {
            if (isMessage(entry)) ids.append(entry.value(QStringLiteral("id")).toString());
        }
        return ids;
    }
    const QString anchorId = branch.at(compactionIndex).value(QStringLiteral("firstKeptEntryId")).toString();
    if (anchorId.isEmpty()) return {};
    int anchorIndex = -1;
    for (int index = 0; index < branch.size(); ++index) {
        if (branch.at(index).value(QStringLiteral("id")).toString() == anchorId) {
            anchorIndex = index;
            break;
        }
    }
    if (anchorIndex < 0) return {};
    for (int index = anchorIndex; index < branch.size(); ++index) {
        const QJsonObject &entry = branch.at(index);
        if (isMessage(entry)) ids.append(entry.value(QStringLiteral("id")).toString());
    }
    return ids;
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
