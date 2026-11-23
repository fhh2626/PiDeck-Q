#include "SessionMessageTargeting.h"

#include "HistoryText.h"
#include "MessageContent.h"

#include <QJsonObject>

namespace messagetargeting {
namespace {

/** A live row starts a turn when it is a user row or a visible task card. */
bool isCachedTurnStart(const QJsonObject &message)
{
    const QString role = message.value(QStringLiteral("role")).toString();
    if (role == QLatin1String("user")) return true;
    if (role != QLatin1String("system")) return false;
    // Same predicate as the projector's card: `system` + `meta.type == "todoTask"`.
    return message.value(QStringLiteral("meta")).toObject().value(QStringLiteral("type")).toString()
        == QLatin1String("todoTask");
}

bool isCachedAssistant(const QJsonObject &message)
{
    return message.value(QStringLiteral("role")).toString() == QLatin1String("assistant");
}

bool isFileTurnStart(const IndexEntry &entry)
{
    return entry.role == QLatin1String("user") || entry.turnBoundary;
}

bool isFileAssistant(const IndexEntry &entry)
{
    return entry.role == QLatin1String("assistant");
}

} // namespace

QString normalizeText(const QString &text)
{
    // Equivalent to JS `text.replace(/\s+/g, " ").trim()`: Qt collapses every run of
    // Unicode whitespace to one space and removes the ends.
    return text.simplified();
}

TurnMapping mapCachedToEntries(const QJsonArray &cached, const QVector<IndexEntry> &fileEntries,
                               const QString &messageId)
{
    TurnMapping mapping;
    QVector<QJsonObject> cachedSequence;
    cachedSequence.reserve(cached.size());
    for (const QJsonValue &value : cached) {
        if (!value.isObject()) continue;
        const QJsonObject message = value.toObject();
        if (!isCachedTurnStart(message) && !isCachedAssistant(message)) continue;
        cachedSequence.append(message);
    }
    int targetIndex = -1;
    for (int index = 0; index < cachedSequence.size(); ++index) {
        if (cachedSequence.at(index).value(QStringLiteral("id")).toString() == messageId) {
            targetIndex = index;
            break;
        }
    }
    if (targetIndex < 0) return mapping;

    QVector<IndexEntry> fileSequence;
    QVector<int> fileUserIndexes;
    for (const IndexEntry &entry : fileEntries) {
        if (!isFileTurnStart(entry) && !isFileAssistant(entry)) continue;
        if (isFileTurnStart(entry)) fileUserIndexes.append(fileSequence.size());
        fileSequence.append(entry);
    }
    const auto countUsersAfter = [&cachedSequence](int index) {
        int count = 0;
        for (int cursor = index + 1; cursor < cachedSequence.size(); ++cursor) {
            if (isCachedTurnStart(cachedSequence.at(cursor))) ++count;
        }
        return count;
    };
    const auto fileUserPosition = [&fileUserIndexes](int position) {
        if (position < 0 || position >= fileUserIndexes.size()) return -1;
        return fileUserIndexes.at(position);
    };

    const QJsonObject target = cachedSequence.at(targetIndex);
    if (isCachedTurnStart(target)) {
        // "N-th turn counted from the end" is the only alignment that survives the
        // abort-induced row-count skew described in the header.
        const int position = fileUserIndexes.size() - 1 - countUsersAfter(targetIndex);
        const int sequenceIndex = fileUserPosition(position);
        if (sequenceIndex < 0) return mapping;
        mapping.role = TurnMapping::User;
        mapping.entryId = fileSequence.at(sequenceIndex).id;
        return mapping;
    }

    // Assistant: find the user/task anchor of this turn, then every assistant between it
    // and the next turn start. The caller picks one by body text (abort can leave an
    // empty assistant in the same turn).
    int anchorIndex = -1;
    for (int cursor = targetIndex - 1; cursor >= 0; --cursor) {
        if (isCachedTurnStart(cachedSequence.at(cursor))) {
            anchorIndex = cursor;
            break;
        }
    }
    if (anchorIndex < 0) return mapping;
    const int anchorPosition = fileUserIndexes.size() - 1 - countUsersAfter(anchorIndex);
    const int anchorSequenceIndex = fileUserPosition(anchorPosition);
    if (anchorSequenceIndex < 0) return mapping;
    QStringList candidateIds;
    for (int cursor = anchorSequenceIndex + 1; cursor < fileSequence.size(); ++cursor) {
        if (isFileTurnStart(fileSequence.at(cursor))) break;
        if (isFileAssistant(fileSequence.at(cursor))) candidateIds.append(fileSequence.at(cursor).id);
    }
    mapping.role = TurnMapping::Assistant;
    mapping.candidateIds = candidateIds;
    return mapping;
}

QString locateActiveEntry(const JsonlIndex &index, const QJsonArray &cached,
                          const QString &messageId, const QString &cachedText)
{
    if (messageId.isEmpty()) return QString();

    // 1. File-level id: JSONL message.id, raw entry id, or the synthetic history id.
    const historytext::ResendTarget located = historytext::readMessageByMessageId(index, messageId);
    if (located.found) return located.entryId;

    // 2. Turn-anchored mapping for a live row whose id never appears in the file.
    const TurnMapping mapping = mapCachedToEntries(cached, index.activeMessageEntries, messageId);
    if (mapping.role == TurnMapping::User) return mapping.entryId;
    if (mapping.role != TurnMapping::Assistant || mapping.candidateIds.isEmpty()) return QString();

    QVector<IndexEntry> candidateEntries;
    candidateEntries.reserve(mapping.candidateIds.size());
    for (const QString &entryId : mapping.candidateIds) {
        const auto found = index.entries.constFind(entryId);
        if (found != index.entries.constEnd()) candidateEntries.append(*found);
    }
    if (candidateEntries.isEmpty()) return mapping.candidateIds.last();
    QVector<QJsonValue> raw;
    try {
        raw = jsonlindex::readMessages(index, candidateEntries);
    } catch (const std::exception &) {
        return mapping.candidateIds.last();
    }
    QHash<QString, QString> textByEntryId;
    for (int index_ = 0; index_ < candidateEntries.size() && index_ < raw.size(); ++index_) {
        const QJsonObject message = raw.at(index_).toObject();
        textByEntryId.insert(
            candidateEntries.at(index_).id,
            normalizeText(messagecontent::extractResendContent(
                              message.value(QStringLiteral("content"))).text));
    }

    const QString wanted = normalizeText(cachedText);
    QString lastNonEmpty;
    // Only the last 64 candidates are probed (oracle limit): the user normally acts on
    // the newest answer of the turn and a turn cannot plausibly hold more than that.
    const int limit = qMax(0, mapping.candidateIds.size() - 64);
    for (int cursor = mapping.candidateIds.size() - 1; cursor >= limit; --cursor) {
        const QString entryId = mapping.candidateIds.at(cursor);
        const QString candidateText = textByEntryId.value(entryId);
        if (candidateText == wanted) return entryId;
        if (lastNonEmpty.isEmpty() && !candidateText.isEmpty()) lastNonEmpty = entryId;
    }
    return lastNonEmpty.isEmpty() ? mapping.candidateIds.last() : lastNonEmpty;
}

} // namespace messagetargeting
