#include "GitMutations.h"
#include "../../process/TextEncoding.h"

#include "GitExec.h"
#include "GitStatusContext.h"
#include "PorcelainStatus.h"

#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QSet>

#include <stdexcept>

namespace gitmutations {
namespace {

constexpr int kMutationTimeoutMs = 30'000;
constexpr int kRemoteTimeoutMs = kMutationTimeoutMs * 4;

/** Discard/delete match the selected status spelling exactly, as in the Node oracle. */
QString normalizePath(const QString &path)
{
    const QString lexical = QDir::cleanPath(QDir::fromNativeSeparators(path));
#ifdef Q_OS_WIN
    return lexical.toLower();
#else
    return lexical;
#endif
}

/** Stage/unstage additionally resolve existing Windows aliases before matching. */
QString normalizeMutationPath(const QString &path)
{
#ifdef Q_OS_WIN
    // GitService.resolveMutationPaths canonicalizes every existing Windows request
    // with realpathSync.native before matching it against the canonical projectRoot.
    // Status rows keep the ProjectStore spelling (junction / 8.3), so a lexical
    // comparison would report an existing alias row as outside the project once the
    // renderer's snapshot is stale. A missing path falls back to the lexical form,
    // exactly like the oracle's realpathSync.native catch branch.
    return gitstatus::canonicalPath(path).toLower();
#else
    // The oracle deliberately stays lexical on POSIX, so a symlinked spelling must not
    // become an accepted project path here.
    return QDir::cleanPath(QDir::fromNativeSeparators(path));
#endif
}

std::runtime_error failure(const QString &message)
{
    return textenc::error(message);
}

/**
 * Validate the requested paths against a fresh status snapshot and expand rename/copy
 * resources into both pathspecs.
 *
 * A path the renderer still believes in but the repository no longer reports is
 * treated as stale and skipped (the user sees "no operation"), while a path outside
 * the project is a hard authorization failure.
 */
QStringList resolveMutationPaths(const gitstatus::Context &context, const QStringList &paths, bool forUnstage)
{
    QSet<QString> requested;
    for (const QString &path : paths) requested.insert(normalizeMutationPath(path));

    QList<porcelain::Resource> candidates;
    for (const porcelain::Resource &resource : context.resources) {
        const bool isIndex = resource.status == porcelain::INDEX_MODIFIED
            || resource.status == porcelain::INDEX_ADDED || resource.status == porcelain::INDEX_DELETED
            || resource.status == porcelain::INDEX_RENAMED || resource.status == porcelain::INDEX_COPIED
            || resource.status == porcelain::INDEX_TYPE_CHANGED;
        const bool isMerge = resource.status == porcelain::ADDED_BY_US
            || resource.status == porcelain::ADDED_BY_THEM || resource.status == porcelain::DELETED_BY_US
            || resource.status == porcelain::DELETED_BY_THEM || resource.status == porcelain::BOTH_ADDED
            || resource.status == porcelain::BOTH_DELETED || resource.status == porcelain::BOTH_MODIFIED;
        if (forUnstage) {
            if (isIndex) candidates.append(resource);
        } else if (!isIndex) {
            Q_UNUSED(isMerge);
            candidates.append(resource);
        }
    }

    QStringList matched;
    QSet<QString> matchedKeys;
    for (const porcelain::Resource &resource : candidates) {
        const QString key = normalizeMutationPath(resource.path);
        if (!requested.contains(key)) continue;
        matchedKeys.insert(key);
        matched.append(resource.path);
        // Only an unstaged rename needs both pathspecs for staging, and only a staged
        // rename needs both for unstaging; a plain modification must not carry a
        // non-existent old path into the command.
        const bool includeOldPath = forUnstage || resource.status == porcelain::INTENT_TO_RENAME;
        if (includeOldPath && resource.hasOldPath) matched.append(resource.oldPath);
    }

    const QString projectRoot = normalizeMutationPath(context.projectRoot);
    for (const QString &key : requested) {
        if (matchedKeys.contains(key)) continue;
        const bool insideProject = key == projectRoot || key.startsWith(projectRoot + QLatin1Char('/'));
        if (!insideProject) throw failure(QStringLiteral("Git resource is outside the project"));
    }
    matched.removeDuplicates();
    return matched;
}

QStringList literalPathspec(const QStringList &paths)
{
    QStringList arguments{QStringLiteral("--literal-pathspecs")};
    arguments.append(paths);
    return arguments;
}

} // namespace

void stageFiles(const QString &cwd, const QStringList &paths)
{
    const QStringList safe = resolveMutationPaths(gitstatus::read(cwd), paths, false);
    if (safe.isEmpty()) return;
    QStringList arguments = literalPathspec(QStringList{QStringLiteral("add"), QStringLiteral("--")});
    arguments.append(safe);
    gitexec::runOrThrow(cwd, arguments, kMutationTimeoutMs);
}

void unstageFiles(const QString &cwd, const QStringList &paths)
{
    const QStringList safe = resolveMutationPaths(gitstatus::read(cwd), paths, true);
    if (safe.isEmpty()) return;
    const QString head = gitstatus::resolveCommitHash(cwd, QStringLiteral("HEAD"));
    if (!head.isEmpty()) {
        QStringList arguments = literalPathspec(QStringList{QStringLiteral("restore"), QStringLiteral("--staged"),
                                                            QStringLiteral("--")});
        arguments.append(safe);
        gitexec::runOrThrow(cwd, arguments, kMutationTimeoutMs);
        return;
    }
    // An unborn repository has no HEAD, so `restore --staged` has no baseline: drop
    // the entries from the index but keep the working-tree files.
    QStringList arguments = literalPathspec(QStringList{QStringLiteral("rm"), QStringLiteral("--cached"),
                                                        QStringLiteral("--ignore-unmatch"), QStringLiteral("--")});
    arguments.append(safe);
    gitexec::runOrThrow(cwd, arguments, kMutationTimeoutMs);
}

TrashPlan discardFile(const QString &cwd, const QString &group, const QString &filePath)
{
    if (group != QLatin1String("workingTree") && group != QLatin1String("untracked")) {
        throw failure(QStringLiteral("Git resource group cannot be discarded"));
    }
    const gitstatus::Context context = gitstatus::read(cwd);
    const QString requested = normalizePath(filePath);
    const porcelain::Resource *resource = nullptr;
    for (const porcelain::Resource &candidate : context.resources) {
        if (normalizePath(candidate.path) != requested) continue;
        const bool isUntracked = candidate.status == porcelain::UNTRACKED;
        if (group == QLatin1String("untracked") ? isUntracked : !isUntracked) {
            resource = &candidate;
            break;
        }
    }
    if (!resource) throw failure(QStringLiteral("Git resource is stale or outside the project"));

    TrashPlan plan;
    if (group == QLatin1String("untracked")) {
        const QFileInfo info(resource->path);
        if (!info.isFile() && !info.isSymLink()) {
            throw failure(QStringLiteral("Only individual untracked files can be discarded"));
        }
        plan.needed = true;
        plan.unlinkInstead = info.isSymLink();
        plan.path = resource->path;
        return plan;
    }
    QStringList arguments = literalPathspec(QStringList{QStringLiteral("restore"), QStringLiteral("--worktree"),
                                                        QStringLiteral("--")});
    arguments.append(resource->path);
    gitexec::runOrThrow(context.repoRoot, arguments, kMutationTimeoutMs);
    return plan;
}

void unlinkPath(const QString &path)
{
    if (!QFile::remove(path)) throw failure(QStringLiteral("Unable to remove %1").arg(path));
}

void commit(const QString &cwd, const QString &message)
{
    gitexec::runOrThrow(cwd, QStringList{QStringLiteral("commit"), QStringLiteral("-m"), message}, kMutationTimeoutMs);
}

void cherryPick(const QString &cwd, const QString &hash)
{
    gitexec::runOrThrow(cwd, QStringList{QStringLiteral("cherry-pick"), hash}, kMutationTimeoutMs);
}

void revertCommit(const QString &cwd, const QString &hash)
{
    gitexec::runOrThrow(cwd, QStringList{QStringLiteral("revert"), QStringLiteral("--no-edit"), hash},
                        kMutationTimeoutMs);
}

void resetToCommit(const QString &cwd, const QString &hash, const QString &mode)
{
    // Only the three documented modes are accepted; anything else must not reach git
    // as an option.
    if (mode != QLatin1String("soft") && mode != QLatin1String("mixed") && mode != QLatin1String("hard")) {
        throw failure(QStringLiteral("Invalid reset mode: %1").arg(mode));
    }
    gitexec::runOrThrow(cwd, QStringList{QStringLiteral("reset"), QStringLiteral("--%1").arg(mode), hash},
                        kMutationTimeoutMs);
}

void dropCommit(const QString &cwd, const QString &hash)
{
    const QString parent = gitexec::tryRun(cwd, QStringList{QStringLiteral("rev-parse"), QStringLiteral("%1^").arg(hash)},
                                           kMutationTimeoutMs);
    if (parent.isEmpty()) throw failure(QStringLiteral("Unable to resolve the parent of %1").arg(hash));
    gitexec::runOrThrow(cwd, QStringList{QStringLiteral("rebase"), QStringLiteral("--onto"), parent, hash},
                        kMutationTimeoutMs);
}

void push(const QString &cwd)
{
    gitexec::runOrThrow(cwd, QStringList{QStringLiteral("push")}, kRemoteTimeoutMs);
}

void pull(const QString &cwd)
{
    gitexec::runOrThrow(cwd, QStringList{QStringLiteral("pull")}, kRemoteTimeoutMs);
}

void fetch(const QString &cwd)
{
    gitexec::runOrThrow(cwd, QStringList{QStringLiteral("fetch")}, kRemoteTimeoutMs);
}

void init(const QString &cwd)
{
    gitexec::runOrThrow(cwd, QStringList{QStringLiteral("init")}, kMutationTimeoutMs);
}

QStringList deleteFiles(const QString &cwd, const QStringList &paths)
{
    if (paths.isEmpty()) return QStringList();
    const gitstatus::Context context = gitstatus::read(cwd);
    QSet<QString> requested;
    for (const QString &path : paths) requested.insert(normalizePath(path));
    QSet<QString> matchedKeys;
    QStringList result;
    QSet<QString> seen;
    for (const porcelain::Resource &resource : context.resources) {
        const QString key = normalizePath(resource.path);
        if (!requested.contains(key)) continue;
        matchedKeys.insert(key);
        if (seen.contains(key)) continue;
        seen.insert(key);
        const QFileInfo info(resource.path);
        if (!info.isFile() && !info.isSymLink()) {
            throw failure(QStringLiteral("Only individual files can be deleted"));
        }
        result.append(resource.path);
    }
    // Every requested path must be a status-listed resource: that blocks traversal and
    // stale rows in one check.
    if (matchedKeys.size() != requested.size()) {
        throw failure(QStringLiteral("Git resource is stale or outside the project"));
    }
    return result;
}

} // namespace gitmutations
