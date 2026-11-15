#include "SessionFileMutations.h"

#include "SessionFileDocument.h"

#include <QDateTime>
#include <QFile>
#include <QFileInfo>
#include <QJsonDocument>
#include <QSaveFile>
#include <QSet>

namespace sessionmutations {
namespace {

using namespace sessionfiledoc;
Result mutate(const QString &filePath, const Target &target, const QString &kind,
              const QString &newText)
{
    Result result;
    QFile file(filePath);
    if (!file.open(QIODevice::ReadOnly)) {
        fail(&result, QStringLiteral("SESSION_FILE_NOT_FOUND"),
             QStringLiteral("Session file is not readable: %1").arg(filePath));
        return result;
    }
    const QByteArray original = file.readAll();
    file.close();

    Document document;
    if (!parseDocument(original, &document, &result)) return result;
    Located located;
    if (!locateEntry(document, target, &located, &result)) return result;

    if (kind == QLatin1String("edit")) {
        QJsonObject entry = document.lines.at(located.lineIndex).entry;
        QJsonObject message = messageOf(entry);
        const QString role = message.value(QStringLiteral("role")).toString();
        if (role != QLatin1String("user") && role != QLatin1String("assistant")) {
            fail(&result, QStringLiteral("SESSION_ENTRY_ROLE_INVALID"),
                 QStringLiteral("Only user and assistant message entries can be edited"));
            return result;
        }
        setMessageText(message, newText);
        entry.insert(QStringLiteral("message"), message);
        replaceLine(&document, located.lineIndex, entry);
        result.changedEntryIds = QStringList{located.entryId};
    } else if (kind == QLatin1String("delete")) {
        const QStringList removeIds = turnSegmentMessageIds(document, located.entryId,
                                                           target.activeLeafId, &result);
        if (!result.error.isEmpty()) return result;
        const QSet<QString> removeSet(removeIds.begin(), removeIds.end());
        QHash<QString, QJsonValue> originalParent;
        for (const QString &entryId : removeIds) {
            const int lineIndex = document.entryLineById.value(entryId, -1);
            if (lineIndex < 0) continue;
            originalParent.insert(entryId, parentIdOf(document.lines.at(lineIndex).entry));
        }
        const auto keptAncestor = [&removeSet, &originalParent](const QString &parentId) {
            QString cursor = parentId;
            QSet<QString> visited;
            while (!cursor.isEmpty() && removeSet.contains(cursor) && !visited.contains(cursor)) {
                visited.insert(cursor);
                const QJsonValue next = originalParent.value(cursor);
                cursor = next.isString() ? next.toString() : QString();
            }
            return cursor;
        };
        result.changedEntryIds = removeIds;
        result.changedEntryIds.append(rewriteCompactionFirstKept(&document, removeSet));
        for (int index = 0; index < document.lines.size(); ++index) {
            QJsonObject child = document.lines.at(index).entry;
            if (!document.lines.at(index).hasEntry) continue;
            if (child.value(QStringLiteral("type")).toString() == QLatin1String("deleted")) continue;
            const QString childId = entryIdOf(child);
            if (!childId.isEmpty() && removeSet.contains(childId)) continue;
            const QJsonValue childParent = parentIdOf(child);
            if (!childParent.isString() || !removeSet.contains(childParent.toString())) continue;
            const QString kept = keptAncestor(childParent.toString());
            child.insert(QStringLiteral("parentId"),
                         kept.isEmpty() ? QJsonValue(QJsonValue::Null) : QJsonValue(kept));
            replaceLine(&document, index, child);
            if (!childId.isEmpty()) result.changedEntryIds.append(childId);
        }
        const qint64 now = QDateTime::currentMSecsSinceEpoch();
        for (const QString &entryId : removeIds) {
            const int lineIndex = document.entryLineById.value(entryId, -1);
            if (lineIndex < 0) continue;
            replaceLine(&document, lineIndex,
                        tombstone(entryId, now, originalParent.value(entryId)));
        }
    } else {
        if (inputRole(document.lines.at(located.lineIndex).entry) != QLatin1String("user")) {
            fail(&result, QStringLiteral("SESSION_ENTRY_ROLE_INVALID"),
                 QStringLiteral("Only user messages can be truncated for resend"));
            return result;
        }
        const QSet<QString> removeIds = descendantEntryIds(document, located.entryId);
        const qint64 now = QDateTime::currentMSecsSinceEpoch();
        for (int index = 0; index < document.lines.size(); ++index) {
            QJsonObject entry = document.lines.at(index).entry;
            if (!document.lines.at(index).hasEntry) continue;
            if (entry.value(QStringLiteral("type")).toString() == QLatin1String("deleted")) continue;
            const QString entryId = entryIdOf(entry);
            if (entryId.isEmpty() || !removeIds.contains(entryId)) continue;
            replaceLine(&document, index,
                        tombstone(entryId, now, parentIdOf(entry), QStringLiteral("resend-truncate")));
        }
        result.changedEntryIds = QStringList(removeIds.begin(), removeIds.end());
    }

    const QByteArray next = serializeDocument(document);
    if (!writeBackup(filePath, original, &result)) return result;
    if (!writeSessionFile(filePath, next, &result)) return result;
    result.ok = true;
    return result;
}


} // namespace
Result edit(const QString &filePath, const Target &target, const QString &newText)
{
    return mutate(filePath, target, QStringLiteral("edit"), newText);
}

Result remove(const QString &filePath, const Target &target)
{
    return mutate(filePath, target, QStringLiteral("delete"), QString());
}

Result truncateForResend(const QString &filePath, const Target &target)
{
    return mutate(filePath, target, QStringLiteral("resend"), QString());
}

bool resolveTarget(const QString &filePath, Target *target, QString *error)
{
    QFile file(filePath);
    if (!file.open(QIODevice::ReadOnly)) {
        if (error) *error = QStringLiteral("Session file is not readable: %1").arg(filePath);
        return false;
    }
    const QByteArray original = file.readAll();
    file.close();
    Document document;
    Result result;
    if (!parseDocument(original, &document, &result)) {
        if (error) *error = result.error;
        return false;
    }
    const QSet<QString> branchIds = activeBranchIds(document, target->activeLeafId, &result);
    if (!result.error.isEmpty()) {
        if (error) *error = result.error;
        return false;
    }
    QStringList candidates{target->entryId, legacyEntryId(*target)};
    for (const QString &entryId : candidates) {
        if (entryId.isEmpty() || !branchIds.contains(entryId)) continue;
        const int lineIndex = document.entryLineById.value(entryId, -1);
        if (lineIndex < 0) continue;
        const QJsonObject entry = document.lines.at(lineIndex).entry;
        if (entry.value(QStringLiteral("type")).toString() == QLatin1String("deleted")) {
            if (error) *error = QStringLiteral("The requested entry has already been deleted");
            return false;
        }
        const QJsonObject message = messageOf(entry);
        target->entryId = entryId;
        target->role = message.value(QStringLiteral("role")).toString();
        target->text = textOf(message.value(QStringLiteral("content")));
        target->images = QJsonArray();
        const QJsonValue content = message.value(QStringLiteral("content"));
        if (content.isArray()) {
            for (const QJsonValue &block : content.toArray()) {
                if (!block.isObject()) continue;
                if (block.toObject().value(QStringLiteral("type")).toString() != QLatin1String("image")) {
                    continue;
                }
                target->images.append(block);
            }
        }
        return true;
    }
    if (error) *error = QStringLiteral("Message was not found on the active session branch");
    return false;
}

bool restoreBackup(const QString &filePath, const QString &backupPath)
{
    if (backupPath.isEmpty() || !QFileInfo::exists(backupPath)) return false;
    QFile backup(backupPath);
    if (!backup.open(QIODevice::ReadOnly)) return false;
    const QByteArray bytes = backup.readAll();
    backup.close();
    QSaveFile file(filePath);
    if (!file.open(QIODevice::WriteOnly) || file.write(bytes) != bytes.size()) return false;
    return file.commit();
}

} // namespace sessionmutations
