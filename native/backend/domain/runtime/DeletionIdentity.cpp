#include "DeletionIdentity.h"

#include "../ChannelRegistry.h"
#include "../sessions/SessionCatalogStore.h"

#include <QDir>
#include <QElapsedTimer>
#include <QSet>

namespace deletionidentity {
namespace {

QString clean(const QString &path) { return path.isEmpty() ? QString() : QDir::cleanPath(path); }

bool inside(const QString &file, const QString &directory)
{
    return !directory.isEmpty() && file.startsWith(directory + QLatin1Char('/'));
}

// The script is constant. Paths are positional arguments, never interpolated into shell
// code. A missing leaf is acceptable only after a positive ENOENT result from lstat
// and strict parent resolution. `test ! -L` is insufficient: EACCES also looks false.
// WSL already requires GNU stat/realpath. Fix the diagnostic locale and match the
// complete errno suffix, never text embedded in the (newline-free) path. All other
// errors, including a dangling link (lstat succeeds), leave the identity unresolved.
const QString IDENTITY_SCRIPT = QStringLiteral(
    // A sentinel prevents command substitution from stripping newlines belonging
    // to a symlink target's name. Remove only it and realpath's single terminator.
    "for p do c=$(realpath -e -- \"$p\" 2>/dev/null && printf .) "
    "&& c=${c%?} && c=${c%?} || { "
    "d=${p%/*}; test -n \"$d\" || d=/; c=; "
    "e=$(LC_ALL=C stat --printf='' -- \"$p\" 2>&1); s=$?; "
    "if test \"$s\" -ne 0; then case \"$e\" in "
    "*': No such file or directory') "
    "c=$(realpath -e -- \"$d\" 2>/dev/null && printf .) "
    "&& c=${c%?} && c=${c%?} && c=\"${c%/}/${p##*/}\" || c= ;; esac; fi; }; "
    "printf '%s\\0%s\\0' \"$p\" \"$c\"; done");

} // namespace

bool sameNamespace(const CatalogEntry &left, const CatalogEntry &right)
{
    if (left.environment != right.environment) return false;
    if (left.environment != QLatin1String("wsl")) return true;
    return left.wslDistro.isEmpty() || right.wslDistro.isEmpty()
        || left.wslDistro.compare(right.wslDistro, Qt::CaseInsensitive) == 0;
}

CatalogEntry forLaunch(const CatalogEntry &entry, const pilaunch::Launch &launch)
{
    CatalogEntry actual = entry;
    actual.environment = launch.viaWsl ? QStringLiteral("wsl") : QStringLiteral("native");
    const qsizetype distro = launch.arguments.indexOf(QStringLiteral("-d"));
    const qsizetype user = launch.arguments.indexOf(QStringLiteral("-u"));
    actual.wslDistro = launch.viaWsl && distro >= 0 ? launch.arguments.value(distro + 1) : QString();
    actual.wslUser = launch.viaWsl && user >= 0 ? launch.arguments.value(user + 1) : QString();
    return actual;
}

bool compatibleLaunch(const CatalogEntry &entry, const CatalogEntry &launched)
{
    // Drafts have no persisted path to reinterpret. Once launched, their tabs still
    // carry the actual namespace so future deletion checks see a trustworthy identity.
    return entry.filePath.isEmpty() || sameNamespace(entry, launched);
}

bool sameTarget(const CatalogEntry &left, const CatalogEntry &right)
{
    return SessionCatalogStore::sameDeletionTarget(left, right);
}

QStringList pathsFor(const QString &file)
{
    if (file.isEmpty()) return {};
    // Preserve Linux traversal order: /link/../file may differ from its lexical
    // cleanPath when link points into a different tree. realpath owns normalization.
    QStringList paths{file};
    if (file.endsWith(QLatin1String(".jsonl"), Qt::CaseInsensitive))
        paths.append(file.left(file.size() - 6));
    return paths;
}

QHash<QString, QString> resolve(const SessionFs &fs, const QStringList &paths)
{
    QHash<QString, QString> identities;
    QStringList unique;
    QSet<QString> seen;
    qsizetype bytes = 0;
    for (const QString &raw : paths) {
        const QString path = raw;
        if (!path.startsWith(QLatin1Char('/')) || path.contains(QChar::Null)
            || path.contains(QLatin1Char('\n')) || path.contains(QLatin1Char('\r')))
            throw ChannelError(QStringLiteral("Unable to resolve WSL session identity"));
        if (seen.contains(path)) continue;
        seen.insert(path);
        unique.append(path);
        bytes += path.size();
    }
    if (unique.size() > 10'000 || bytes > 2 * 1024 * 1024)
        throw ChannelError(QStringLiteral("WSL session identity resolution limit exceeded"));
    QElapsedTimer budget;
    budget.start();
    for (qsizetype start = 0; start < unique.size();) {
        QStringList batch;
        qsizetype length = 0;
        do {
            const QString path = unique.at(start++);
            length += path.size() + 4;
            batch.append(path);
        } while (start < unique.size() && length + unique.at(start).size() < 6000);
        const int remaining = 12'000 - int(budget.elapsed());
        if (remaining <= 0)
            throw ChannelError(QStringLiteral("WSL session identity resolution timed out"));
        QStringList args{QStringLiteral("sh"), QStringLiteral("-c"), IDENTITY_SCRIPT,
                         QStringLiteral("pideck-delete-identities")};
        args.append(batch);
        const sessioncmd::Result result = fs.runCapture(args, remaining, 4 * 1024 * 1024);
        // Under heavy load the subprocess timer may be delivered late. A successful
        // late reply must not turn an expired admission probe into deletion authority.
        if (budget.elapsed() >= 12'000)
            throw ChannelError(QStringLiteral("WSL session identity resolution timed out"));
        if (!result.ok()) throw ChannelError(QStringLiteral("Unable to resolve WSL session identities"));
        QStringList fields = result.stdoutText.split(QChar::Null);
        if (fields.size() != batch.size() * 2 + 1 || !fields.last().isEmpty())
            throw ChannelError(QStringLiteral("Invalid WSL session identity response"));
        for (qsizetype i = 0; i < batch.size(); ++i) {
            QString canonical = fields.at(i * 2 + 1);
            // A newline-free alias may resolve to a framing-sensitive target. Retain
            // no trusted identity for it rather than trimming or guessing its spelling.
            if (canonical.contains(QLatin1Char('\n')) || canonical.contains(QLatin1Char('\r')))
                canonical.clear();
            if (fields.at(i * 2) != batch.at(i)
                || (!canonical.isEmpty() && (!canonical.startsWith(QLatin1Char('/'))
                    || clean(canonical) != canonical)))
                throw ChannelError(QStringLiteral("Invalid WSL session identity response"));
            identities.insert(batch.at(i), canonical);
        }
    }
    return identities;
}

bool Lease::blocks(const CatalogEntry &candidate) const
{
    if (!sameNamespace(root, candidate)) return false;
    if (root.id == candidate.id || provisional) return true;
    const QStringList rootPaths = pathsFor(root.filePath);
    const QStringList candidatePaths = pathsFor(candidate.filePath);
    if (rootPaths.size() != 2 || candidatePaths.size() != 2) return true;
    const QString file = identities.value(rootPaths.first());
    const QString tree = identities.value(rootPaths.last());
    const QString otherFile = identities.value(candidatePaths.first());
    const QString otherTree = identities.value(candidatePaths.last());
    if (file.isEmpty() || tree.isEmpty() || otherFile.isEmpty() || otherTree.isEmpty()) return true;
    return file == otherFile || tree == otherTree || inside(otherFile, tree) || inside(file, otherTree)
        || inside(otherTree, tree) || inside(tree, otherTree);
}

} // namespace deletionidentity
