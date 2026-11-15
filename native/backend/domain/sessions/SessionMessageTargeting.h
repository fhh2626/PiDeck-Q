#pragma once

#include "JsonlIndex.h"

#include <QJsonArray>
#include <QString>
#include <QStringList>
#include <QVector>

/**
 * Renderer message id -> session-file entry targeting for edit/delete/resend.
 *
 * Port of `mapCachedMessageToEntryCandidates` (src/main/pi/agentUtils.ts) and the
 * lookup ladder in `AgentManager.locateMessageTarget`.
 *
 * Why the turn anchor exists: an abort makes pi append an *empty* assistant entry while
 * the desktop projection drops the corresponding event, so the file has one more
 * assistant than the live cache. Aligning by the total user+assistant count then shifts
 * every later row by one and edit/delete hits the wrong entry. Aligning users by turn
 * position is immune to that skew; assistant rows are resolved inside their turn by body
 * text. Comparing user text is deliberately skipped: host instructions and mode
 * templates rewrite the cached text, the file keeps the original.
 */
namespace messagetargeting {

/** Collapse runs of whitespace and trim (agentUtils.normalizeMessageTextForMatch). */
QString normalizeText(const QString &text);

struct TurnMapping {
    enum Role { None, User, Assistant };
    Role role = None;
    /** role == User: the file entry that starts the turn. */
    QString entryId;
    /** role == Assistant: every assistant entry in that turn, in file order. */
    QStringList candidateIds;
};

/**
 * Map one live-cache message id onto the active-branch entries of the session file.
 * `cached` is the live `ChatMessage[]` (`role`, `id`, `meta.type=todoTask`), `fileEntries`
 * are the index's active message entries in root->leaf order.
 */
TurnMapping mapCachedToEntries(const QJsonArray &cached, const QVector<IndexEntry> &fileEntries,
                               const QString &messageId);

/**
 * Resolve a renderer id without relying on `meta.entryId` (absent after a reconnect):
 *  1. JSONL native `message.id`, raw `entry.id`, or the synthetic `<agent>-history-<entry>`
 *     id (delegated to HistoryText so the id rules stay in one place);
 *  2. the turn-anchored mapping above for a live row whose id is a runtime UUID;
 *  3. empty, letting the caller fall back to role+text equality (the oracle's last resort).
 * `cachedText` is the live row's body, used to choose among same-turn assistants.
 */
QString locateActiveEntry(const JsonlIndex &index, const QJsonArray &cached,
                          const QString &messageId, const QString &cachedText);

} // namespace messagetargeting
