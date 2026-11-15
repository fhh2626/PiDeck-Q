#include "HistoryPager.h"

#include "PiTaskMessage.h"

#include <QDateTime>
#include <QJsonObject>

#include <algorithm>

namespace historypager {
namespace {

QVector<IndexEntry> slice(const QVector<IndexEntry> &entries, int start, int end)
{
    QVector<IndexEntry> result;
    for (int index = start; index < end && index < entries.size(); ++index) {
        if (index >= 0) result.append(entries.at(index));
    }
    return result;
}

QStringList entryIds(const QVector<IndexEntry> &entries)
{
    QStringList ids;
    ids.reserve(entries.size());
    for (const IndexEntry &entry : entries) ids.append(entry.id);
    return ids;
}

/**
 * Insert the compaction card only when this page crosses its retained-entry boundary.
 * The card id matches the projector's `${agentId}-meta-1` so the runtime window and the
 * paged history de-duplicate to one card.
 */
QJsonArray withCompactionCard(const JsonlIndex &index, const QString &agentId, const QJsonArray &messages,
                              int start, const maincopy::Translator &translate)
{
    QVector<IndexEntry> compactions;
    for (const IndexEntry &entry : index.activeBranch) {
        if (entry.type == QLatin1String("compaction")) compactions.append(entry);
    }
    if (compactions.isEmpty()) return messages;
    const IndexEntry &last = compactions.last();
    int insertAt = -1;
    if (!last.firstKeptEntryId.isEmpty()) {
        for (int position = 0; position < index.activeMessageEntries.size(); ++position) {
            if (index.activeMessageEntries.at(position).id == last.firstKeptEntryId) {
                insertAt = position;
                break;
            }
        }
    }
    if (insertAt < 0) {
        // Fall back to "messages after the compaction entry" (same rule as readSessionDisplayMessages).
        int compactionIndex = -1;
        for (int position = 0; position < index.activeBranch.size(); ++position) {
            if (index.activeBranch.at(position).id == last.id) {
                compactionIndex = position;
                break;
            }
        }
        if (compactionIndex >= 0) {
            insertAt = 0;
            for (int position = 0; position <= compactionIndex; ++position) {
                const IndexEntry &entry = index.activeBranch.at(position);
                if (entry.type == QLatin1String("message") && entry.hasTruthyMessage) ++insertAt;
            }
        } else {
            insertAt = index.activeMessageEntries.size();
        }
    }
    const int relative = insertAt - start;
    if (relative < 0 || relative > messages.size()) return messages;
    const qint64 timestamp = last.timestamp.isEmpty()
        ? QDateTime::currentMSecsSinceEpoch()
        : QDateTime::fromString(last.timestamp, Qt::ISODateWithMs).toMSecsSinceEpoch();
    const QJsonObject card = projector::compactionCard(
        agentId,
        last.summary.isEmpty() ? translate(QStringLiteral("session.summaryPlaceholder"), QJsonObject{})
                               : last.summary,
        timestamp > 0 ? timestamp : QDateTime::currentMSecsSinceEpoch(), last.id, last.firstKeptEntryId,
        last.hasTokensBefore, last.tokensBefore, compactions.size());
    QJsonArray result;
    for (int position = 0; position < messages.size(); ++position) {
        if (position == relative) result.append(card);
        result.append(messages.at(position));
    }
    if (relative == messages.size()) result.append(card);
    return result;
}

QJsonArray projectSlice(const JsonlIndex &index, const QString &agentId, int start, int end,
                        const projector::Deps &deps)
{
    const QVector<IndexEntry> entries = slice(index.activeMessageEntries, start, end);
    const QVector<QJsonValue> raw = jsonlindex::readMessages(index, entries);
    const QJsonArray messages =
        projector::convert(agentId, raw, entryIds(entries), index.activeToolResultIds, deps);
    if (!index.hasCompaction) return messages;
    return withCompactionCard(index, agentId, messages, start, deps.translate);
}

} // namespace

/**
 * `unit:"turn"` aligns page boundaries to turn starts: a user message or a visible
 * task card (`turnBoundary`, whose projected role is `system`). Counting only `role`
 * would split a task card away from its turn — the oracle has treated both as starts
 * since the todo task contract was split into goal/resume.
 */
int findTurnPageStart(const QVector<IndexEntry> &entries, int before, int turnCount, qint64 byteBudget)
{
    if (before <= 0 || turnCount < 1) return 0;
    const auto isTurnStart = [](const IndexEntry &entry) {
        return entry.role == QLatin1String("user") || entry.turnBoundary;
    };
    int turnsSeen = 0;
    int start = 0;
    for (int index = before - 1; index >= 0; --index) {
        if (!isTurnStart(entries.at(index))) continue;
        ++turnsSeen;
        if (turnsSeen == turnCount) {
            start = index;
            break;
        }
    }
    if (turnsSeen < turnCount) {
        // Fewer turns than requested: start at the head so leading fragments join turn 1.
        start = 0;
    } else {
        bool hasEarlierUser = false;
        for (int index = 0; index < start; ++index) {
            if (isTurnStart(entries.at(index))) {
                hasEarlierUser = true;
                break;
            }
        }
        // No turn start before the computed start: merge the leading fragment into this
        // page instead of giving it a page of its own.
        if (!hasEarlierUser) start = 0;
    }
    qint64 bytes = 0;
    for (int index = start; index < before; ++index) bytes += entries.at(index).byteLength;
    while (bytes > byteBudget) {
        int next = start + 1;
        while (next < before && !isTurnStart(entries.at(next))) ++next;
        if (next >= before) break; // only the newest turn left: keep it whole
        for (int index = start; index < next; ++index) bytes -= entries.at(index).byteLength;
        start = next;
    }
    return start;
}

Page readMessagePage(const JsonlIndex &index, const QString &agentId, int before, int pageSize,
                     const projector::Deps &deps)
{
    Page page;
    page.total = index.activeMessageEntries.size();
    const int boundedBefore = qBound(0, before, page.total);
    const int limit = qBound(1, pageSize, kMaxDisplayPageSize);
    int start = boundedBefore;
    qint64 selectedBytes = 0;
    int selectedCount = 0;
    while (start > 0 && selectedCount < limit) {
        const IndexEntry &candidate = index.activeMessageEntries.at(start - 1);
        if (selectedCount > 0 && selectedBytes + candidate.byteLength > kMaxDisplayPageBytes) break;
        selectedBytes += candidate.byteLength;
        ++selectedCount;
        --start;
    }
    page.messages = projectSlice(index, agentId, start, boundedBefore, deps);
    if (start > 0) {
        page.hasNextBefore = true;
        page.nextBefore = start;
    }
    return page;
}

Page readTurnPage(const JsonlIndex &index, const QString &agentId, int before, int turnCount,
                  const QString &beforeEntryId, const projector::Deps &deps)
{
    Page page;
    page.total = index.activeMessageEntries.size();
    int resolvedBefore = before;
    if (!beforeEntryId.isEmpty()) {
        for (int position = 0; position < index.activeMessageEntries.size(); ++position) {
            if (index.activeMessageEntries.at(position).id != beforeEntryId) continue;
            resolvedBefore = position;
            break;
        }
    }
    const int boundedBefore = qBound(0, resolvedBefore, page.total);
    const int boundedTurns = qBound(1, turnCount, kMaxTurnPageSize);
    const int start =
        findTurnPageStart(index.activeMessageEntries, boundedBefore, boundedTurns, kMaxDisplayPageBytes);
    page.messages = projectSlice(index, agentId, start, boundedBefore, deps);
    if (start > 0) {
        page.hasNextBefore = true;
        page.nextBefore = start;
        if (start < index.activeMessageEntries.size()) {
            page.nextBeforeEntryId = index.activeMessageEntries.at(start).id;
        }
    }
    page.indexVersion = index.version();
    return page;
}

QJsonArray readAllMessages(const JsonlIndex &index, const QString &agentId, const projector::Deps &deps)
{
    return projectSlice(index, agentId, 0, index.activeMessageEntries.size(), deps);
}

} // namespace historypager
