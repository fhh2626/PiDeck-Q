#pragma once

#include <QString>
#include <QStringList>

/**
 * Git mutations.
 *
 * Every path-taking mutation first re-reads the status context and matches the
 * renderer's request against it. That is what keeps a stale renderer snapshot from
 * staging, discarding or deleting something outside the project, and it is also where
 * rename/copy resources get their second pathspec.
 *
 * Deletions never unlink user content: untracked discards and `git:delete-files` both
 * report the paths to move to the recycle bin, and the channel layer performs the
 * trash through the host (`shell.trashItem`) so the operation is recoverable.
 */
namespace gitmutations {

/** Paths the channel must move to the recycle bin after a discard. */
struct TrashPlan {
    bool needed = false;
    /** A symlink is unlinked directly: only the link itself disappears. */
    bool unlinkInstead = false;
    QString path;
};

void stageFiles(const QString &cwd, const QStringList &paths);
void unstageFiles(const QString &cwd, const QStringList &paths);

/**
 * Discard one unstaged resource. Tracked files are restored from the index (so staged
 * content survives); untracked files come back as a trash plan.
 */
TrashPlan discardFile(const QString &cwd, const QString &group, const QString &filePath);

/** Remove one symlink without touching its referent. */
void unlinkPath(const QString &path);

void commit(const QString &cwd, const QString &message);
void cherryPick(const QString &cwd, const QString &hash);
void revertCommit(const QString &cwd, const QString &hash);
void resetToCommit(const QString &cwd, const QString &hash, const QString &mode);
void dropCommit(const QString &cwd, const QString &hash);
void push(const QString &cwd);
void pull(const QString &cwd);
void fetch(const QString &cwd);
void init(const QString &cwd);

/** Absolute paths of status-listed files to move to the recycle bin. */
QStringList deleteFiles(const QString &cwd, const QStringList &paths);

} // namespace gitmutations
