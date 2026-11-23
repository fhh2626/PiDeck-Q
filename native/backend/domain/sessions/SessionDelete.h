#pragma once

#include "SessionFs.h"
#include "../../../common/ScopedMutation.h"

#include <QSet>
#include <QString>
#include <QStringList>

namespace deletionidentity { struct Lease; }

/**
 * Session deletion ownership (ports of sessionDeleteResidue.ts,
 * sessionDeleteOwnership.ts and sessionDeleteCollection.ts).
 *
 * Deleting `<stem>.jsonl` must also collect the things that belong to that session
 * but live outside `<stem>/`:
 *  - `<file>.<13+ digit stamp>-<uuid>.edit-backup` siblings;
 *  - `subagent-artifacts/<runId>_*` entries.
 *
 * The shared `subagent-artifacts/` directory is used by every session in the project,
 * so artifacts are only collected when a **structured** identity from this session's
 * own tool results proves ownership. A live peer session that still references the
 * same run id keeps it. No path taken from tool output is ever used as a target.
 */
namespace sessiondelete {

/** Directory name shared by all sessions in one project. */
extern const char *const kSharedArtifactsDir;

/** True when `candidate` is an edit backup of `sessionFileName`. */
bool isSessionEditBackupName(const QString &sessionFileName, const QString &candidate);

/** True when the directory name is a subagent run identity (UUID). */
bool isSubagentRunDirectoryName(const QString &name);

/** Identities extracted from persisted subagent tool results. */
QSet<QString> collectSessionRunIdentities(const QString &raw, bool *uncertain = nullptr);

struct Plan {
    scopedmutation::Root nativeRoot;
    QString sessionFile;
    QStringList backups;
    QStringList artifacts;
    QString siblingDir;
    bool hasSibling = false;
    bool hasFile = false;
};

/**
 * Enumerate everything a delete must move. Runs before any mutation so a failed
 * enumeration leaves the session fully intact and retryable.
 */
Plan plan(const SessionFs &fs, const QString &filePath, const QString &authorizedRoot);

/** Remove only planned local targets; missing targets are already deleted. */
void removePermanently(const Plan &plan);

/** Destination bucket for a WSL soft delete (`<root>/.pideck-trash/<ts>-<uuid>`). */
QString wslTrashBucket(const SessionFs &fs, const QString &root);

/** Soft-delete with a captured adapter/root so environment switches cannot retarget IO. */
QString softDeleteWsl(const SessionFs &fs, const QString &filePath, const QString &root,
                      const deletionidentity::Lease *lease = nullptr);

} // namespace sessiondelete
