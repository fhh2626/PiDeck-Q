#pragma once

#include <QJsonValue>
#include <QSet>
#include <QString>
#include <QStringList>
#include <QVector>

/**
 * entryId alignment and tool-call pairing (ports of sessionEntryIds.ts and
 * missingToolResultCalls.ts).
 *
 * The rule that matters: a `message` entry always consumes one `activeEntryIds` slot,
 * even when the projection skips rendering it (empty user text, thinking-only
 * assistant). Skipping the slot shifts every later entryId by one and makes
 * edit/delete/resend land on the wrong turn.
 */
namespace sessionentryids {

struct TakeResult {
    QString entryId;
    int nextIndex = 0;
};

TakeResult take(const QStringList &activeEntryIds, int entryIndex);

/** A persisted message consumes a slot even when its role has no display row. */
bool consumesMessageEntry(const QJsonValue &message);
int countMessageEntries(const QVector<QJsonValue> &messages);

/**
 * entryIds aligned with pi `get_messages` (root→leaf), honouring the last compaction's
 * `firstKeptEntryId`. Returns an empty list when the anchor is missing so callers fall
 * back to file/serial matching instead of binding ids to the wrong turns.
 * `includeCompacted` returns the complete file branch for history paging cursors.
 */
QStringList buildActiveBranchEntryIds(const QVector<QJsonValue> &entries, const QString &leafId,
                                      bool includeCompacted = false);

} // namespace sessionentryids

namespace missingtoolcalls {

struct DeclaredCall {
    QString toolCallId;
    QString toolName;
    QJsonValue args;
    bool hasTimestamp = false;
    qint64 timestamp = 0;
};

/** toolResult ids present in this slice. */
QSet<QString> collectToolResultIds(const QVector<QJsonValue> &messages);

/**
 * Group "declared but never recorded" calls by the index of the assistant message
 * that declared them, preserving declaration order.
 *
 * `branchResultIds` must contain results from other pages / the compacted archive,
 * otherwise an older page would invent a bogus "missing result" card for a call whose
 * result simply lives elsewhere.
 */
QHash<int, QVector<DeclaredCall>> collect(const QVector<QJsonValue> &messages,
                                          const QSet<QString> &knownResultIds,
                                          const QSet<QString> &branchResultIds);

} // namespace missingtoolcalls
