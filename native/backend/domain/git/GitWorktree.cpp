#include "GitWorktree.h"
#include "../../process/TextEncoding.h"

#include "GitExec.h"

#include <QDir>
#include <QFileInfo>
#include <QRegularExpression>

#include <stdexcept>

namespace gitworktree {
namespace {

constexpr int kTimeoutMs = 30'000;

QString canonical(const QString &path)
{
    const QString normalized = QDir::cleanPath(QDir::fromNativeSeparators(path));
#ifdef Q_OS_WIN
    return normalized.toLower();
#else
    return normalized;
#endif
}

bool samePath(const QString &left, const QString &right)
{
    return canonical(left) == canonical(right);
}

std::runtime_error failure(const QString &message)
{
    return textenc::error(message);
}

/** The repository's main checkout, derived from the shared .git directory. */
QString mainWorktree(const QString &projectPath)
{
    const QString commonDir =
        gitexec::tryRun(projectPath, QStringList{QStringLiteral("rev-parse"), QStringLiteral("--git-common-dir")});
    if (commonDir.isEmpty()) return QString();
    const QString resolved = QDir::cleanPath(QDir(projectPath).absoluteFilePath(QDir::fromNativeSeparators(commonDir)));
    return QFileInfo(resolved).path();
}

/**
 * Slugify a user-entered branch name into a directory name.
 * Unicode letters and digits are preserved so a Chinese branch name is not folded
 * into "workspace".
 */
QString slugify(const QString &input)
{
    QString slug = input.trimmed();
    static const QRegularExpression invalid(QStringLiteral("[^\\p{L}\\p{N}]+"));
    slug.replace(invalid, QStringLiteral("-"));
    static const QRegularExpression leading(QStringLiteral("^-+"));
    static const QRegularExpression trailing(QStringLiteral("-+$"));
    slug.remove(leading);
    slug.remove(trailing);
    return slug.isEmpty() ? QStringLiteral("workspace") : slug;
}

} // namespace

QList<Entry> list(const QString &projectPath)
{
    const gitexec::Result result =
        gitexec::run(projectPath, QStringList{QStringLiteral("worktree"), QStringLiteral("list"), QStringLiteral("--porcelain")});
    if (!result.ok()) return {};
    const QString root = mainWorktree(projectPath);
    const QString normalizedRoot = canonical(root.isEmpty() ? projectPath : root);

    QList<Entry> entries;
    Entry current;
    bool hasCurrent = false;
    const auto flush = [&entries, &current, &hasCurrent, &normalizedRoot]() {
        if (!hasCurrent) return;
        const QString path = QDir::cleanPath(QDir::fromNativeSeparators(current.path));
        if (!samePath(path, normalizedRoot)) {
            Entry entry;
            entry.path = path;
            entry.branch = current.branch.isEmpty() ? QStringLiteral("detached") : current.branch;
            entries.append(entry);
        }
        current = Entry();
        hasCurrent = false;
    };
    for (const QString &line : result.stdoutText.split(QLatin1Char('\n'))) {
        const QString trimmed = line.trimmed();
        if (trimmed.isEmpty()) {
            flush();
            continue;
        }
        if (trimmed.startsWith(QLatin1String("worktree "))) {
            flush();
            current.path = trimmed.mid(9).trimmed();
            hasCurrent = true;
            continue;
        }
        if (hasCurrent && trimmed.startsWith(QLatin1String("branch "))) {
            QString branch = trimmed.mid(7).trimmed();
            if (branch.startsWith(QLatin1String("refs/heads/"))) branch = branch.mid(11);
            current.branch = branch;
        }
    }
    flush();
    return entries;
}

QJsonObject create(const QString &projectPath, const QString &branchName)
{
    const QString slug = slugify(branchName);
    const QString parentDir = QFileInfo(QDir::cleanPath(QDir::fromNativeSeparators(projectPath))).path();
    const QString worktreeDir = QDir(parentDir).filePath(slug);
    if (QFileInfo::exists(worktreeDir)) throw failure(QStringLiteral("The worktree folder already exists. Use a different name."));
    const gitexec::Result existingRef = gitexec::run(
        projectPath, QStringList{QStringLiteral("show-ref"), QStringLiteral("--verify"), QStringLiteral("--quiet"),
                                 QStringLiteral("refs/heads/%1").arg(slug)});
    if (existingRef.ok()) throw failure(QStringLiteral("A branch with this name already exists. Use a different name."));

    // Create the worktree without checking out, then fill it with reset --hard. That
    // keeps a partially initialised directory from being left behind on failure.
    const gitexec::Result added = gitexec::run(
        projectPath, QStringList{QStringLiteral("worktree"), QStringLiteral("add"), QStringLiteral("--no-checkout"),
                                 QStringLiteral("-b"), slug, worktreeDir},
        kTimeoutMs);
    if (!added.ok()) throw failure(QStringLiteral("Failed to create the worktree. Check the Git state and try again."));
    const gitexec::Result reset = gitexec::run(worktreeDir, QStringList{QStringLiteral("reset"), QStringLiteral("--hard")},
                                               kTimeoutMs);
    if (!reset.ok()) {
        remove(worktreeDir, projectPath);
        throw failure(QStringLiteral("Failed to create the worktree. Check the Git state and try again."));
    }
    return QJsonObject{
        {QStringLiteral("path"), worktreeDir},
        {QStringLiteral("branch"), slug},
    };
}

bool remove(const QString &worktreePath, const QString &projectPath)
{
    const QList<Entry> entries = list(projectPath);
    const QString normalizedTarget = canonical(worktreePath);
    const Entry *entry = nullptr;
    for (const Entry &candidate : entries) {
        if (samePath(candidate.path, normalizedTarget)) {
            entry = &candidate;
            break;
        }
    }
    if (!entry) return false;

    // Hard guard: never remove the repository's main checkout, even if the list
    // filter above were bypassed.
    const QString root = mainWorktree(projectPath);
    if (!root.isEmpty() && samePath(root, normalizedTarget)) return false;

    const gitexec::Result removed = gitexec::run(
        projectPath, QStringList{QStringLiteral("worktree"), QStringLiteral("remove"), QStringLiteral("--force"),
                                 worktreePath},
        kTimeoutMs);
    if (!removed.ok()) {
        // git refused. If the directory still exists, refuse to delete it physically:
        // failing the removal is safer than deleting the wrong tree.
        if (QFileInfo::exists(worktreePath)) return false;
    }
    // A surviving directory (external deletion left a stale record) is left for the
    // channel layer to move to the recycle bin.
    const QString worktreeDirName = QFileInfo(worktreePath).fileName();
    if (entry->branch.startsWith(QLatin1String("pideck/")) || entry->branch == worktreeDirName) {
        // -d (not -D): an unmerged branch must stay reachable rather than becoming a
        // dangling commit recoverable only through the reflog.
        gitexec::run(projectPath, QStringList{QStringLiteral("branch"), QStringLiteral("-d"), entry->branch}, kTimeoutMs);
    }
    return true;
}

} // namespace gitworktree
