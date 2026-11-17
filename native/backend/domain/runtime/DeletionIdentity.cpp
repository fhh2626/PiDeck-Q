#include "DeletionIdentity.h"

#include "../ChannelRegistry.h"
#include "../sessions/SessionCatalogStore.h"
#include "../sessions/SessionIdentity.h"
#include "../fs/PathPolicy.h"
#include "../../../common/NativeCanonicalPath.h"

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

/** POSIX resolves link/.. in traversal order, before any lexical normalization. */
QString resolvedNativePath(const QString &path)
{
#ifdef Q_OS_WIN
    return pathpolicy::realpathWithMissingSuffix(path);
#else
    return nativecanonical::withMissingSuffix(path).path;
#endif
}

/** Resolve the companion independently because its alias can differ from the JSONL file. */
QStringList resolvedNativePaths(QStringList paths)
{
    for (QString &path : paths) {
        // Empty retains an unverified identity. Keeping the original alias here
        // would let a live runtime inside an unrepresentable tree evade its fence.
        path = resolvedNativePath(path);
    }
    return paths;
}

/** The configured root may be an alias, but a leaf link itself is the mutation entry. */
QStringList nativeEntryPaths(const QString &file)
{
    if (file.isEmpty()) return {};
#ifndef Q_OS_WIN
    if (!nativecanonical::validPathText(file)) return {QString()};
#endif
    const QString separated = QDir::fromNativeSeparators(file);
    const qsizetype slash = separated.lastIndexOf(QLatin1Char('/'));
    if (slash < 0) return {QString()};
    // Keep the separator on filesystem roots. "C:" names the drive's current
    // directory on Windows, whereas "C:/" identifies its root.
    const bool rootSeparator = slash == 0 || (slash == 2 && separated.at(1) == QLatin1Char(':'));
    const QString parent = resolvedNativePath(separated.left(slash + (rootSeparator ? 1 : 0)));
    if (parent.isEmpty()) return {QString()};
    return pathsFor(QDir(parent).filePath(separated.mid(slash + 1)));
}

/** Runtime overlap stays conservative about native case aliases. */
bool nativeTreesOverlap(QStringList left, QStringList right, const QString &environment)
{
    for (QString &path : left) path = sessionidentity::canonicalizeSessionPath(path, environment);
    for (QString &path : right) path = sessionidentity::canonicalizeSessionPath(path, environment);
    // The first path is a file. Only companion directories own descendants.
    for (qsizetype i = 0; i < left.size(); ++i) {
        for (qsizetype j = 0; j < right.size(); ++j) {
            if (left.at(i) == right.at(j)
                || (i > 0 && inside(right.at(j), left.at(i)))
                || (j > 0 && inside(left.at(i), right.at(j)))) return true;
        }
    }
    return false;
}

/** Mutation authority must keep exact POSIX names, including on case-sensitive macOS volumes. */
bool sameNativePaths(const QStringList &left, const QStringList &right)
{
    if (left.size() != right.size()) return false;
#ifdef Q_OS_WIN
    constexpr auto sensitivity = Qt::CaseInsensitive;
#else
    constexpr auto sensitivity = Qt::CaseSensitive;
#endif
    for (qsizetype i = 0; i < left.size(); ++i)
        if (left.at(i).compare(right.at(i), sensitivity) != 0) return false;
    return true;
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

QStringList wslPathsFor(const QString &file)
{
    QStringList paths = pathsFor(file);
    QString prefix = file;
    while (!prefix.isEmpty() && prefix != QLatin1String("/")) {
        const qsizetype slash = prefix.lastIndexOf(QLatin1Char('/'));
        if (slash < 0) break;
        prefix = slash == 0 ? QStringLiteral("/") : prefix.left(slash);
        paths.append(prefix);
    }
    return paths;
}

NativeLease captureNative(const CatalogEntry &root)
{
    const QStringList entries = nativeEntryPaths(root.filePath);
    return {root, resolvedNativePaths(entries), entries};
}

bool NativeLease::blocks(const CatalogEntry &candidate) const
{
    if (root.id == candidate.id) return true;
    if (physicalPaths.isEmpty() || !sameNamespace(root, candidate)) return false;
    // Persistent drafts may start writing only after their first turn. Until pi
    // reports that target, their tree cannot be proved separate from this deletion.
    // In-memory runtimes have no persistent JSONL tree to reserve.
    if (candidate.filePath.isEmpty()) return !candidate.noSession;
    if (physicalPaths.contains(QString()) || entryPaths.contains(QString())) return true;
    const QStringList candidatePaths = resolvedNativePaths(pathsFor(candidate.filePath));
    if (candidatePaths.contains(QString())) return true;
    // Retain the original physical tree, and the actual entries the plan removes.
    // A companion link can change or become a real directory after planning. Its
    // new runtime users must stay blocked even if the configured root alias changed.
    const QStringList currentEntries = resolvedNativePaths(entryPaths);
    if (currentEntries.contains(QString())) return true;
    const auto overlaps = [&](const QStringList &used) {
        return nativeTreesOverlap(physicalPaths, used, root.environment)
            || nativeTreesOverlap(entryPaths, used, root.environment)
            || nativeTreesOverlap(currentEntries, used, root.environment);
    };
    if (overlaps(candidatePaths)) return true;
    // A runtime also depends on the entries traversed on its way to the final
    // referent. A link nested in the deleted tree can lead outside that tree.
    // Each prefix is a single used entry, never an owner of all its descendants.
    QString prefix = QDir::fromNativeSeparators(candidate.filePath);
    while (true) {
        const qsizetype slash = prefix.lastIndexOf(QLatin1Char('/'));
        if (slash <= 0 || (slash == 2 && prefix.at(1) == QLatin1Char(':'))) break;
        prefix = prefix.left(slash);
        const QStringList traversal = resolvedNativePaths({prefix});
        if (traversal.contains(QString()) || overlaps(traversal)) return true;
    }
    return false;
}

bool NativeLease::matchesPlan(const QString &sessionFile) const
{
    if (root.id.isEmpty()) return true;
    const QStringList plannedEntries = nativeEntryPaths(sessionFile);
    if (entryPaths.contains(QString()) || plannedEntries.contains(QString())) return false;
    // A stable leaf under a verified physical parent may retain an unknown
    // referent, such as a dangling link. The plan removes a primary leaf link
    // without reading ownership through it; runtime candidates stay fenced by
    // the unknown identity. Never substitute the leaf spelling for its referent.
    return sameNativePaths(entryPaths, plannedEntries)
        && sameNativePaths(physicalPaths, resolvedNativePaths(plannedEntries));
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
        if (!result.ok() || !result.stdoutLosslessUtf8)
            throw ChannelError(QStringLiteral("Unable to resolve WSL session identities"));
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

bool Lease::matchesPlan(const SessionFs &fs, const QString &sessionFile) const
{
    if (root.id.isEmpty()) return true;
    if (provisional || !fs.wsl()) return false;
    const QStringList admittedPaths = pathsFor(root.filePath);
    const QStringList plannedPaths = pathsFor(sessionFile);
    if (admittedPaths.size() != 2 || plannedPaths.size() != 2) return false;
    // A leaf link authorizes moving that entry, so equal referents alone cannot
    // authorize a different parent directory selected by a retargeted root link.
    const QString parent = identities.value(fs.dirname(root.filePath));
    if (parent.isEmpty() || sessionFile != fs.join(parent, fs.basename(root.filePath))) return false;
    const auto current = resolve(fs, plannedPaths);
    for (qsizetype index = 0; index < admittedPaths.size(); ++index) {
        const QString expected = identities.value(admittedPaths.at(index));
        if (expected.isEmpty() || expected != current.value(plannedPaths.at(index))) return false;
    }
    return true;
}

bool Lease::blocks(const CatalogEntry &candidate) const
{
    if (!sameNamespace(root, candidate)) return false;
    if (root.id == candidate.id || provisional) return true;
    // A running in-memory session with no file cannot own this deletion's tree.
    if (candidate.noSession && candidate.filePath.isEmpty()) return false;
    const QStringList rootPaths = pathsFor(root.filePath);
    const QStringList candidatePaths = pathsFor(candidate.filePath);
    if (rootPaths.size() != 2 || candidatePaths.size() != 2) return true;
    const QStringList owned{identities.value(rootPaths.first()), identities.value(rootPaths.last())};
    const QStringList other{identities.value(candidatePaths.first()), identities.value(candidatePaths.last())};
    if (owned.contains(QString()) || other.contains(QString())) return true;
    const auto overlaps = [&owned](const QStringList &used) {
        for (qsizetype i = 0; i < owned.size(); ++i) {
            for (qsizetype j = 0; j < used.size(); ++j) {
                if (owned.at(i) == used.at(j)
                    || (i > 0 && inside(used.at(j), owned.at(i)))
                    || (j > 0 && inside(owned.at(i), used.at(j)))) return true;
            }
        }
        return false;
    };
    if (overlaps(other)) return true;
    const QStringList traversal = wslPathsFor(candidate.filePath);
    for (qsizetype index = candidatePaths.size(); index < traversal.size(); ++index) {
        const QString entry = identities.value(traversal.at(index));
        // Each prefix is one entry used by this runtime, never ownership of every
        // descendant of /home or another common ancestor. Missing proof stays fenced.
        if (entry.isEmpty() || overlaps({entry})) return true;
    }
    return false;
}

} // namespace deletionidentity
