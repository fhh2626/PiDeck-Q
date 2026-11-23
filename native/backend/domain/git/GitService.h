#pragma once

#include <QJsonObject>
#include <QJsonValue>
#include <QString>

/**
 * Branch and remote-tracking surface of the git domain.
 *
 * `getBranches` degrades to `{current: null, branches: []}` for a non-repository or a
 * missing git, which is what lets the Git panel render its "no git" state instead of
 * an error. Every other entry point propagates failures so the user sees the reason.
 */
namespace gitservice {

/**
 * `git rev-parse --is-inside-work-tree` succeeded.
 *
 * Used before enabling workspace mode: a non-repository would only produce an empty
 * worktree list and an error on create, so the toggle rejects it up front.
 */
bool isGitRepo(const QString &cwd);

QJsonObject getBranches(const QString &cwd);

/** Checkout an existing local branch; returns the refreshed branch list. */
QJsonObject checkout(const QString &cwd, const QString &branch);

/** Create a branch from the current HEAD and switch to it. */
QJsonObject createBranch(const QString &cwd, const QString &branchName);

/** Local ahead/behind against @{upstream}; null when there is no upstream. */
QJsonValue getAheadBehind(const QString &cwd);

} // namespace gitservice
