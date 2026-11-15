#include "SessionFileDocument.h"

#include <QDateTime>
#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QJsonDocument>
#include <QSaveFile>
#include <QSet>
#include <QUuid>

#include <algorithm>

namespace sessionfiledoc {

QString entryIdOf(const QJsonObject &entry)
{
    const QString id = entry.value(QStringLiteral("id")).toString();
    if (!id.isEmpty()) return id;
    return entry.value(QStringLiteral("entryId")).toString();
}

QJsonValue parentIdOf(const QJsonObject &entry)
{
    if (entry.value(QStringLiteral("parentId")).isNull()) return QJsonValue(QJsonValue::Null);
    if (entry.value(QStringLiteral("parentId")).isString()) return entry.value(QStringLiteral("parentId"));
    return QJsonValue(QJsonValue::Undefined);
}

QJsonObject messageOf(const QJsonObject &entry)
{
    const QJsonValue message = entry.value(QStringLiteral("message"));
    return message.isObject() ? message.toObject() : QJsonObject{};
}

QString textOf(const QJsonValue &content)
{
    if (content.isString()) return content.toString();
    if (!content.isArray()) return QString();
    QStringList parts;
    for (const QJsonValue &value : content.toArray()) {
        if (!value.isObject()) continue;
        const QJsonObject block = value.toObject();
        if (block.value(QStringLiteral("type")).toString() != QLatin1String("text")) continue;
        if (block.value(QStringLiteral("text")).isString()) parts.append(block.value(QStringLiteral("text")).toString());
    }
    return parts.join(QString());
}

void setMessageText(QJsonObject &message, const QString &text)
{
    const QJsonValue content = message.value(QStringLiteral("content"));
    if (content.isString()) {
        message.insert(QStringLiteral("content"), text);
        return;
    }
    if (content.isArray()) {
        QJsonArray next;
        bool replaced = false;
        for (const QJsonValue &value : content.toArray()) {
            if (!value.isObject()
                || value.toObject().value(QStringLiteral("type")).toString() != QLatin1String("text")) {
                next.append(value);
                continue;
            }
            if (replaced) continue;
            QJsonObject block = value.toObject();
            block.insert(QStringLiteral("text"), text);
            next.append(block);
            replaced = true;
        }
        if (!replaced) next.append(QJsonObject{{QStringLiteral("type"), QStringLiteral("text")},
                                               {QStringLiteral("text"), text}});
        message.insert(QStringLiteral("content"), next);
        return;
    }
    message.insert(QStringLiteral("content"),
                   QJsonArray{QJsonObject{{QStringLiteral("type"), QStringLiteral("text")},
                                          {QStringLiteral("text"), text}}});
}

bool fail(Result *result, const QString &code, const QString &error)
{
    result->ok = false;
    result->code = code;
    result->error = error;
    return false;
}

bool parseDocument(const QByteArray &bytes, Document *document, Result *result)
{
    const QString text = QString::fromUtf8(bytes);
    if (text.isEmpty()) return fail(result, QStringLiteral("SESSION_FILE_EMPTY"),
                                    QStringLiteral("Session file is empty"));
    int start = 0;
    for (int index = 0; index < text.size(); ++index) {
        const QChar character = text.at(index);
        if (character != QLatin1Char('\r') && character != QLatin1Char('\n')) continue;
        QString eol(character);
        if (character == QLatin1Char('\r') && index + 1 < text.size()
            && text.at(index + 1) == QLatin1Char('\n')) {
            eol = QStringLiteral("\r\n");
            ++index;
        }
        const int end = index + 1 - eol.size();
        document->lines.append(Line{text.mid(start, end - start), eol, QJsonObject{}, false});
        start = index + 1;
    }
    if (start < text.size()) {
        document->lines.append(Line{text.mid(start), QString(), QJsonObject{}, false});
    }
    int headerCount = 0;
    for (int index = 0; index < document->lines.size(); ++index) {
        Line &line = document->lines[index];
        if (line.content.trimmed().isEmpty()) continue;
        const QJsonDocument parsed = QJsonDocument::fromJson(line.content.toUtf8());
        if (!parsed.isObject()) {
            return fail(result, QStringLiteral("SESSION_FILE_INVALID_JSONL"),
                        QStringLiteral("Session file contains invalid JSONL at line %1").arg(index + 1));
        }
        line.entry = parsed.object();
        line.hasEntry = true;
        if (line.entry.value(QStringLiteral("type")).toString() == QLatin1String("session")) ++headerCount;
        const QString id = entryIdOf(line.entry);
        if (id.isEmpty()) continue;
        if (document->entryLineById.contains(id)) {
            return fail(result, QStringLiteral("SESSION_FILE_INVALID_JSONL"),
                        QStringLiteral("Session file contains duplicate entry ID %1").arg(id));
        }
        document->entryLineById.insert(id, index);
    }
    if (headerCount != 1) {
        return fail(result, QStringLiteral("SESSION_FILE_INVALID_JSONL"),
                    QStringLiteral("Session file must contain exactly one session header; found %1")
                        .arg(headerCount));
    }
    return true;
}

QByteArray serializeDocument(const Document &document)
{
    QString text;
    for (const Line &line : document.lines) text += line.content + line.eol;
    return text.toUtf8();
}

void replaceLine(Document *document, int lineIndex, const QJsonObject &entry)
{
    Line &line = document->lines[lineIndex];
    line.entry = entry;
    line.hasEntry = true;
    line.content = QString::fromUtf8(QJsonDocument(entry).toJson(QJsonDocument::Compact));
}

QSet<QString> activeBranchIds(const Document &document, const QString &activeLeafId, Result *result)
{
    QString leafId = activeLeafId;
    if (!leafId.isEmpty() && !document.entryLineById.contains(leafId)) {
        fail(result, QStringLiteral("SESSION_ENTRY_NOT_FOUND"),
             QStringLiteral("The active session branch is no longer present in the file"));
        return {};
    }
    if (leafId.isEmpty()) {
        for (int index = document.lines.size() - 1; index >= 0; --index) {
            const Line &line = document.lines.at(index);
            if (!line.hasEntry || line.entry.value(QStringLiteral("type")).toString() == QLatin1String("deleted")) {
                continue;
            }
            const QString candidate = entryIdOf(line.entry);
            if (!candidate.isEmpty()) {
                leafId = candidate;
                break;
            }
        }
    }
    QSet<QString> ids;
    QString current = leafId;
    while (!current.isEmpty() && !ids.contains(current)) {
        ids.insert(current);
        const int lineIndex = document.entryLineById.value(current, -1);
        if (lineIndex < 0) break;
        const QJsonValue parent = parentIdOf(document.lines.at(lineIndex).entry);
        current = parent.isString() ? parent.toString() : QString();
    }
    return ids;
}

QString legacyEntryId(const Target &target)
{
    if (target.legacyMessageId.isEmpty()) return QString();
    // History ids are `<agentId>-history-<entryId>`; the prefix is the *session* id for
    // history pages and the runtime agent id for live rows, so only the marker is stable.
    const QString marker = QStringLiteral("-history-");
    const int index = target.legacyMessageId.lastIndexOf(marker);
    if (index < 0) return QString();
    return target.legacyMessageId.mid(index + marker.size());
}

bool locateById(const Document &document, const QString &entryId, const Target &target,
                const QSet<QString> &branchIds, Located *out, Result *result)
{
    if (entryId.isEmpty()) return false;
    const int lineIndex = document.entryLineById.value(entryId, -1);
    if (lineIndex < 0) return false;
    if (!branchIds.contains(entryId)) {
        fail(result, QStringLiteral("SESSION_ENTRY_NOT_FOUND"),
             QStringLiteral("The requested entry is not part of the active session branch"));
        return false;
    }
    const QJsonObject entry = document.lines.at(lineIndex).entry;
    if (entry.value(QStringLiteral("type")).toString() == QLatin1String("deleted")) {
        fail(result, QStringLiteral("SESSION_ENTRY_NOT_FOUND"),
             QStringLiteral("The requested entry has already been deleted"));
        return false;
    }
    const QString role = messageOf(entry).value(QStringLiteral("role")).toString();
    if (role != target.role) {
        fail(result, QStringLiteral("SESSION_ENTRY_ROLE_INVALID"),
             QStringLiteral("Session entry role %1 cannot be used as %2").arg(role, target.role));
        return false;
    }
    out->lineIndex = lineIndex;
    out->entryId = entryId;
    return true;
}

bool locateEntry(const Document &document, const Target &target, Located *out, Result *result)
{
    const QSet<QString> branchIds = activeBranchIds(document, target.activeLeafId, result);
    if (!result->error.isEmpty()) return false;
    if (locateById(document, target.entryId, target, branchIds, out, result)) return true;
    if (!result->error.isEmpty()) return false;
    if (locateById(document, legacyEntryId(target), target, branchIds, out, result)) return true;
    if (!result->error.isEmpty()) return false;

    QVector<Located> candidates;
    for (const QString &entryId : branchIds) {
        const int lineIndex = document.entryLineById.value(entryId, -1);
        if (lineIndex < 0) continue;
        const QJsonObject entry = document.lines.at(lineIndex).entry;
        const QJsonObject message = messageOf(entry);
        if (message.value(QStringLiteral("role")).toString() != target.role) continue;
        if (textOf(message.value(QStringLiteral("content"))) != target.text) continue;
        candidates.append(Located{lineIndex, entryId});
    }
    if (candidates.size() == 1) {
        *out = candidates.first();
        return true;
    }
    if (candidates.size() > 1) {
        fail(result, QStringLiteral("SESSION_ENTRY_AMBIGUOUS"),
             QStringLiteral("More than one entry matches the requested message on the active branch"));
        return false;
    }
    fail(result, QStringLiteral("SESSION_ENTRY_NOT_FOUND"),
         QStringLiteral("Message was not found on the active session branch"));
    return false;
}

QString inputRole(const QJsonObject &entry)
{
    return messageOf(entry).value(QStringLiteral("role")).toString();
}

QStringList turnSegmentMessageIds(const Document &document, const QString &targetEntryId,
                                 const QString &activeLeafId, Result *result)
{
    QStringList branchIds = activeBranchIds(document, activeLeafId, result).values();
    if (!result->error.isEmpty()) return {};
    // Rebuild the branch in root->leaf order: parentId chain from the leaf.
    QStringList ordered;
    QString current = activeLeafId;
    if (current.isEmpty()) {
        for (int index = document.lines.size() - 1; index >= 0; --index) {
            const Line &line = document.lines.at(index);
            if (!line.hasEntry || line.entry.value(QStringLiteral("type")).toString() == QLatin1String("deleted")) {
                continue;
            }
            const QString candidate = entryIdOf(line.entry);
            if (!candidate.isEmpty()) {
                current = candidate;
                break;
            }
        }
    }
    QSet<QString> seen;
    while (!current.isEmpty() && !seen.contains(current)) {
        seen.insert(current);
        ordered.prepend(current);
        const int lineIndex = document.entryLineById.value(current, -1);
        if (lineIndex < 0) break;
        const QJsonValue parent = parentIdOf(document.lines.at(lineIndex).entry);
        current = parent.isString() ? parent.toString() : QString();
    }
    branchIds = ordered;

    const auto entryAt = [&document](const QString &id) {
        const int lineIndex = document.entryLineById.value(id, -1);
        return lineIndex < 0 ? QJsonObject{} : document.lines.at(lineIndex).entry;
    };
    const auto isUserMessage = [&entryAt](const QString &id) {
        const QJsonObject entry = entryAt(id);
        return entry.value(QStringLiteral("type")).toString() == QLatin1String("message")
            && inputRole(entry) == QLatin1String("user");
    };
    const int targetIndex = branchIds.indexOf(targetEntryId);
    if (targetIndex < 0) {
        fail(result, QStringLiteral("SESSION_ENTRY_NOT_FOUND"),
             QStringLiteral("The requested entry is not on the active session branch"));
        return {};
    }
    int start = targetIndex;
    if (!isUserMessage(targetEntryId)) {
        int anchor = -1;
        for (int index = targetIndex - 1; index >= 0; --index) {
            if (isUserMessage(branchIds.at(index))) {
                anchor = index;
                break;
            }
        }
        start = anchor >= 0 ? anchor + 1 : 0;
    }
    int end = branchIds.size();
    for (int index = start + 1; index < branchIds.size(); ++index) {
        if (isUserMessage(branchIds.at(index))) {
            end = index;
            break;
        }
    }
    QStringList resultIds;
    for (int index = start; index < end; ++index) {
        const QString id = branchIds.at(index);
        if (entryAt(id).value(QStringLiteral("type")).toString() == QLatin1String("message")) {
            resultIds.append(id);
        }
    }
    return resultIds;
}

QSet<QString> descendantEntryIds(const Document &document, const QString &rootEntryId)
{
    QSet<QString> descendants{rootEntryId};
    bool changed = true;
    while (changed) {
        changed = false;
        for (const Line &line : document.lines) {
            if (!line.hasEntry || line.entry.value(QStringLiteral("type")).toString() == QLatin1String("deleted")) {
                continue;
            }
            const QString id = entryIdOf(line.entry);
            const QJsonValue parent = parentIdOf(line.entry);
            if (id.isEmpty() || !parent.isString() || descendants.contains(id)) continue;
            if (!descendants.contains(parent.toString())) continue;
            descendants.insert(id);
            changed = true;
        }
    }
    return descendants;
}

QStringList rewriteCompactionFirstKept(Document *document, const QSet<QString> &removeSet)
{
    QStringList changed;
    for (int index = 0; index < document->lines.size(); ++index) {
        const QJsonObject entry = document->lines.at(index).entry;
        if (!document->lines.at(index).hasEntry) continue;
        if (entry.value(QStringLiteral("type")).toString() != QLatin1String("compaction")) continue;
        const QString compactionId = entryIdOf(entry);
        const QString firstKept = entry.value(QStringLiteral("firstKeptEntryId")).toString();
        if (compactionId.isEmpty() || firstKept.isEmpty() || !removeSet.contains(firstKept)) continue;

        QStringList ancestors;
        QSet<QString> visited{compactionId};
        QJsonValue cursor = parentIdOf(entry);
        while (cursor.isString() && !visited.contains(cursor.toString())) {
            visited.insert(cursor.toString());
            ancestors.prepend(cursor.toString());
            const int lineIndex = document->entryLineById.value(cursor.toString(), -1);
            if (lineIndex < 0) break;
            cursor = parentIdOf(document->lines.at(lineIndex).entry);
        }
        const int anchorIndex = ancestors.indexOf(firstKept);
        if (anchorIndex < 0) continue;
        QString nextKept = compactionId;
        for (int candidate = anchorIndex + 1; candidate < ancestors.size(); ++candidate) {
            if (!removeSet.contains(ancestors.at(candidate))) {
                nextKept = ancestors.at(candidate);
                break;
            }
        }
        QJsonObject updated = entry;
        updated.insert(QStringLiteral("firstKeptEntryId"), nextKept);
        replaceLine(document, index, updated);
        changed.append(compactionId);
    }
    return changed;
}

QJsonObject tombstone(const QString &entryId, qint64 now, const QJsonValue &parentId,
                      const QString &reason)
{
    QJsonObject entry{
        {QStringLiteral("type"), QStringLiteral("deleted")},
        {QStringLiteral("id"), entryId},
        {QStringLiteral("originalEntryId"), entryId},
        {QStringLiteral("parentId"), parentId},
        {QStringLiteral("ts"), static_cast<double>(now)},
    };
    if (!reason.isEmpty()) entry.insert(QStringLiteral("reason"), reason);
    return entry;
}

bool writeBackup(const QString &filePath, const QByteArray &original, Result *result)
{
    const QString stamp = QString::number(QDateTime::currentMSecsSinceEpoch());
    const QString suffix = QUuid::createUuid().toString(QUuid::WithoutBraces);
    const QString backupPath = QStringLiteral("%1.%2-%3.edit-backup").arg(filePath, stamp, suffix);
    QFile backup(backupPath);
    if (!backup.open(QIODevice::WriteOnly) || backup.write(original) != original.size()) {
        return fail(result, QStringLiteral("SESSION_BACKUP_FAILED"),
                    QStringLiteral("Unable to write the session backup"));
    }
    backup.close();
    result->backupPath = backupPath;
    return true;
}

/** Atomic replace: QSaveFile writes a sibling temp file and renames over the target. */
bool writeSessionFile(const QString &filePath, const QByteArray &bytes, Result *result)
{
    QSaveFile file(filePath);
    if (!file.open(QIODevice::WriteOnly) || file.write(bytes) != bytes.size() || !file.commit()) {
        return fail(result, QStringLiteral("SESSION_WRITE_FAILED"),
                    QStringLiteral("Unable to write the session file"));
    }
    return true;
}
} // namespace sessionfiledoc
