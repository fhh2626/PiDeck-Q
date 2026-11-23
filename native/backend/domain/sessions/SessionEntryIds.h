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

/** Count ordinary file slots for legacy RPC responses with no entry metadata. */
bool consumesMessageEntry(const QJsonValue &message);
int countMessageEntries(const QVector<QJsonValue> &messages);

struct ProjectionIds {
    QStringList fileIds;
    QStringList messageIds;
    bool matched = false;
};

/**
 * Pair `get_messages` with its `get_entries` sources, checking the complete layout.
 * `fileIds` is the uncompressed branch for paging; `messageIds` is indexed by raw RPC
 * row, with empty slots for rows with no history ID. On mismatch no IDs are attached.
 */
ProjectionIds alignProjection(const QVector<QJsonValue> &entries, const QString &leafId,
                              const QVector<QJsonValue> &messages);

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
