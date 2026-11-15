#pragma once

#include <QJsonArray>
#include <QJsonObject>
#include <QString>

/**
 * git worktree management.
 *
 * The main worktree is derived from `--git-common-dir` and always excluded from the
 * list: when PiDeck is opened from a linked worktree, the main checkout would
 * otherwise appear as a normal entry and a click on "remove" would delete the whole
 * project directory.
 */
namespace gitworktree {

struct Entry {
    QString path;
    QString branch;
};

QList<Entry> list(const QString &projectPath);

/** Create `{dirname(projectPath)}/{slug}` on a new branch; throws on conflict. */
QJsonObject create(const QString &projectPath, const QString &branchName);

/**
 * Remove one linked worktree. Returns false when the target is not a removable
 * worktree (unknown entry, main checkout, or git refused and the directory survived).
 */
bool remove(const QString &worktreePath, const QString &projectPath);

} // namespace gitworktree
