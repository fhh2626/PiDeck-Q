#pragma once

#include <QJsonArray>
#include <QJsonObject>
#include <QString>
#include <QStringList>

/**
 * Session JSONL transactions for edit / delete / resend.
 *
 * Port of src/main/pi/SessionFileEditor.ts. pi owns the session file format, so a
 * mutation is a *transactional rewrite*: tombstone entries instead of removing lines
 * (pi resolves the active branch from the last entry id + parentId chain), re-parent
 * surviving children, fix the compaction anchor, keep a `.edit-backup`, and let the
 * caller reload the runtime (`switch_session`) before the change is considered done.
 *
 * Invariants:
 *  - the file must contain exactly one `session` header and a consistent parent graph;
 *  - only `message` entries are tombstoned; `model_change` and friends keep the user's
 *    model/thinking selection;
 *  - a tombstone keeps `id` + `parentId`; dropping them would make pi's leaf resolve to
 *    a parentless entry and `get_messages` return an empty page.
 */
namespace sessionmutations {

struct Target {
    QString entryId;
    /** Runtime message id (`<agentId>-history-<entryId>`) used when entryId is absent. */
    QString legacyMessageId;
    QString legacyAgentId;
    /** "user" | "assistant" */
    QString role;
    QString text;
    /** Image blocks of the message; prepare-resend returns them so the prompt can be resent. */
    QJsonArray images;
    QString activeLeafId;
};

struct Result {
    bool ok = false;
    QString code;
    QString error;
    QString backupPath;
    QStringList changedEntryIds;
};

/** Replace the text of one user/assistant message. */
Result edit(const QString &filePath, const Target &target, const QString &newText);
/** Tombstone the whole turn containing the target message. */
Result remove(const QString &filePath, const Target &target);
/** Tombstone the target user message and everything after it (resend). */
Result truncateForResend(const QString &filePath, const Target &target);

/** Restore a backup file over the session file (reload rollback). */
bool restoreBackup(const QString &filePath, const QString &backupPath);

/**
 * Resolve a renderer message id to a concrete session entry.
 *
 * The renderer sees ids from two sources: the live transcript (a UUID) and the history
 * pager (`<agentId>-history-<entryId>`). Only the file knows the authoritative entry, so
 * edit/delete/resend resolve here first and fall back to the live row for role/text.
 * Fills `target->entryId`, `target->role` and `target->text`.
 */
bool resolveTarget(const QString &filePath, Target *target, QString *error);

} // namespace sessionmutations
