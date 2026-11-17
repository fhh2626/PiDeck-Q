#include "SessionFs.h"

#include "../fs/PathPolicy.h"

#include <QDir>

namespace {

/** Linux paths must remain positional arguments and cannot contain framing characters. */
bool validLinuxPath(const QString &path)
{
    return path.startsWith(QLatin1Char('/')) && !path.contains(QChar(0))
        && !path.contains(QLatin1Char('\n')) && !path.contains(QLatin1Char('\r'))
        && !path.contains(QLatin1Char('\\'));
}

bool contains(const QString &root, const QString &path)
{
    return path == root || path.startsWith(root == QLatin1String("/") ? root : root + QLatin1Char('/'));
}

/** Resolve missing suffixes inside WSL rather than interpreting Linux paths on Windows. */
QString realPath(const SessionFs &fs, const QString &path)
{
    const sessioncmd::Result result = fs.runCapture(
        {QStringLiteral("realpath"), QStringLiteral("-m"), QStringLiteral("--"), path}, 10'000, 16 * 1024);
    if (!result.ok()) return {};
    QString resolved = result.stdoutText;
    if (resolved.endsWith(QLatin1Char('\n'))) resolved.chop(1);
    return validLinuxPath(resolved) ? resolved : QString();
}

} // namespace

bool SessionFs::authorizeDeletionPath(const QString &path, const QStringList &roots, bool allowLeafLink) const
{
    if (!wsl()) {
        return pathpolicy::assertAuthorized(path, roots, QStringLiteral("session deletion"),
            allowLeafLink ? pathpolicy::Mode::Link : pathpolicy::Mode::Read).ok;
    }
    if (!validLinuxPath(path)) return false;
    const QString normalized = QDir::cleanPath(path);
    // For a move, authorize the parent: moving a leaf symlink preserves its referent.
    const QString resolved = realPath(*this, allowLeafLink ? dirname(path) : path);
    if (resolved.isEmpty()) return false;
    for (const QString &root : roots) {
        if (!validLinuxPath(root)) continue;
        const QString normalizedRoot = QDir::cleanPath(root);
        if (!contains(normalizedRoot, normalized)) continue;
        const QString resolvedRoot = realPath(*this, root);
        if (resolvedRoot.isEmpty() || !contains(resolvedRoot, resolved)) continue;
        // Configured root links are explicit authority. Every directory below that
        // root must be a real entry, so artifact discovery cannot traverse a link.
        QString current = allowLeafLink ? dirname(normalized) : normalized;
        bool safe = true;
        while (current != normalizedRoot) {
            if (!contains(normalizedRoot, current)) { safe = false; break; }
            const sessioncmd::Result link = runCapture(
                {QStringLiteral("test"), QStringLiteral("-L"), current}, 10'000, 1024);
            if (!link.started || link.timedOut || link.truncated || link.exitCode != 1
                || !link.stderrText.trimmed().isEmpty()) { safe = false; break; }
            const QString parent = dirname(current);
            if (parent == current) { safe = false; break; }
            current = parent;
        }
        if (safe) return true;
    }
    return false;
}
