#include "GitService.h"
#include "../../process/TextEncoding.h"

#include "GitExec.h"

#include <QJsonArray>
#include <QRegularExpression>

#include <stdexcept>

namespace gitservice {
namespace {

constexpr int kMutationTimeoutMs = 30'000;
constexpr qint64 kBranchMaxBytes = 10 * 1024 * 1024;

QJsonObject emptyBranches()
{
    return QJsonObject{
        {QStringLiteral("current"), QJsonValue(QJsonValue::Null)},
        {QStringLiteral("branches"), QJsonArray{}},
    };
}

std::runtime_error failure(const QString &message)
{
    return textenc::error(message);
}

} // namespace

bool isGitRepo(const QString &cwd)
{
    const gitexec::Result result = gitexec::run(
        cwd, QStringList{QStringLiteral("rev-parse"), QStringLiteral("--is-inside-work-tree")});
    return result.ok();
}

QJsonObject getBranches(const QString &cwd)
{
    // HEAD and the full local ref share one process and one snapshot. Keep the
    // old ref-list budget available even when the extra columns exceed it.
    const auto localResult = gitexec::run(
        cwd, QStringList{QStringLiteral("branch"), QStringLiteral("--no-color"), QStringLiteral("--list"),
                         QStringLiteral("--format=%(HEAD)%09%(refname)")},
        gitexec::kDefaultTimeoutMs, kBranchMaxBytes);
    if (!localResult.ok() && !localResult.truncated) return emptyBranches();

    QString current;
    QStringList branches;
    bool hasHead = false;
    const auto withoutCarriageReturn = [](QString line) {
        if (line.endsWith(QLatin1Char('\r'))) line.chop(1);
        return line;
    };
    if (localResult.ok()) {
        const QString localPrefix = QStringLiteral("\trefs/heads/");
        for (const QString &line : localResult.stdoutText.split(QLatin1Char('\n'))) {
            if (line.size() < 2 || line.at(1) != QLatin1Char('\t')) continue;
            const bool head = line.at(0) == QLatin1Char('*');
            hasHead |= head;
            // A detached/rebasing HEAD can be marked but has no local branch ref.
            if (!QStringView(line).sliced(1).startsWith(localPrefix)) continue;
            const QString name = withoutCarriageReturn(line.mid(1 + localPrefix.size()));
            branches.append(name);
            if (head) current = name;
        }
    } else {
        // Keep branch.sort, but omit the detached pseudo-row and column overhead.
        const auto shortList = gitexec::run(
            cwd, QStringList{QStringLiteral("branch"), QStringLiteral("--no-color"), QStringLiteral("--list"),
                             QStringLiteral("--format=%(if:equals=refs)%(refname:rstrip=-1)%(then)%(refname:lstrip=2)%(end)")},
            gitexec::kDefaultTimeoutMs, kBranchMaxBytes);
        if (!shortList.ok()) return emptyBranches();
        for (const QString &line : shortList.stdoutText.split(QLatin1Char('\n'), Qt::SkipEmptyParts)) {
            const QString name = withoutCarriageReturn(line);
            if (!name.isEmpty()) branches.append(name);
        }
    }
    // An unborn branch has no ref to mark, including after checkout --orphan.
    if (!hasHead) {
        const auto result = gitexec::run(cwd, QStringList{QStringLiteral("branch"), QStringLiteral("--show-current")});
        if (!result.ok()) return emptyBranches();
        current = result.stdoutText.section(QLatin1Char('\n'), 0, 0);
        current = withoutCarriageReturn(current);
    }
    // The current branch is listed first so the panel shows it without extra sorting.
    QStringList sorted;
    if (!current.isEmpty()) sorted.append(current);
    for (const QString &branch : branches) {
        if (branch != current) sorted.append(branch);
    }
    QJsonArray branchArray;
    for (const QString &branch : sorted) branchArray.append(branch);
    return QJsonObject{
        {QStringLiteral("current"), current.isEmpty() ? QJsonValue(QJsonValue::Null) : QJsonValue(current)},
        {QStringLiteral("branches"), branchArray},
    };
}

QJsonObject checkout(const QString &cwd, const QString &branch)
{
    if (branch.isEmpty() || branch.startsWith(QLatin1Char('-'))) throw failure(QStringLiteral("Invalid branch name"));
    const QString fullRef = QStringLiteral("refs/heads/%1").arg(branch);
    const gitexec::Result format = gitexec::run(cwd, QStringList{QStringLiteral("check-ref-format"), fullRef});
    if (!format.ok()) {
        throw failure(QStringLiteral("Git checkout \"%1\" failed: %2").arg(branch, format.errorMessage()));
    }
    const gitexec::Result exists = gitexec::run(
        cwd, QStringList{QStringLiteral("show-ref"), QStringLiteral("--verify"), QStringLiteral("--quiet"), fullRef});
    if (!exists.ok()) {
        throw failure(QStringLiteral("Git checkout \"%1\" failed: %2").arg(branch, exists.errorMessage()));
    }
    const gitexec::Result checkedOut = gitexec::run(
        cwd, QStringList{QStringLiteral("checkout"), QStringLiteral("--end-of-options"), branch}, kMutationTimeoutMs);
    if (!checkedOut.ok()) {
        throw failure(QStringLiteral("Git checkout \"%1\" failed: %2").arg(branch, checkedOut.errorMessage()));
    }
    return getBranches(cwd);
}

QJsonObject createBranch(const QString &cwd, const QString &branchName)
{
    if (branchName.isEmpty() || branchName.startsWith(QLatin1Char('-'))) {
        throw failure(QStringLiteral("Invalid branch name"));
    }
    const gitexec::Result format =
        gitexec::run(cwd, QStringList{QStringLiteral("check-ref-format"), QStringLiteral("refs/heads/%1").arg(branchName)});
    if (!format.ok()) throw failure(format.errorMessage());
    const gitexec::Result created = gitexec::run(
        cwd, QStringList{QStringLiteral("checkout"), QStringLiteral("-b"), branchName}, kMutationTimeoutMs);
    if (!created.ok()) throw failure(created.errorMessage());
    return getBranches(cwd);
}

QJsonValue getAheadBehind(const QString &cwd)
{
    // No upstream makes the command fail with exit 128; that is the "no badge" case.
    const gitexec::Result upstreamResult = gitexec::run(
        cwd, QStringList{QStringLiteral("rev-parse"), QStringLiteral("--abbrev-ref"),
                         QStringLiteral("--symbolic-full-name"), QStringLiteral("@{upstream}")},
        kMutationTimeoutMs);
    if (!upstreamResult.ok()) return QJsonValue(QJsonValue::Null);
    const QString upstream = upstreamResult.stdoutText.trimmed();
    if (upstream.isEmpty()) return QJsonValue(QJsonValue::Null);
    const gitexec::Result countResult = gitexec::run(
        cwd, QStringList{QStringLiteral("rev-list"), QStringLiteral("--left-right"), QStringLiteral("--count"),
                         QStringLiteral("HEAD...%1").arg(upstream)},
        kMutationTimeoutMs);
    if (!countResult.ok()) return QJsonValue(QJsonValue::Null);
    const QStringList parts = countResult.stdoutText.trimmed().split(QRegularExpression(QStringLiteral("\\s+")),
                                                                    Qt::SkipEmptyParts);
    const int ahead = parts.size() > 0 ? parts.at(0).toInt() : 0;
    const int behind = parts.size() > 1 ? parts.at(1).toInt() : 0;
    return QJsonObject{
        {QStringLiteral("ahead"), ahead},
        {QStringLiteral("behind"), behind},
    };
}

} // namespace gitservice
