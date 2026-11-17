#include "SessionDelete.h"
#include "SessionScanner.h"
#include "SessionWslTrashScript.h"
#include "SessionWslRootPin.h"
#include "../ChannelRegistry.h"
#include "../runtime/DeletionIdentity.h"

#include <QVector>

namespace sessiondelete {
namespace {
/** Keep path data positional and refuse a plan that escapes its captured authority. */
QString relativePath(const QString &root, const QString &path)
{
    const QString prefix = root.endsWith('/') ? root : root + '/';
    if (!path.startsWith(prefix) || path.size() == prefix.size())
        throw ChannelError(QStringLiteral("Unable to authorize session deletion"));
    const QString relative = path.mid(prefix.size());
    // Host QDir normalization would reinterpret a literal Linux backslash as '/'.
    for (const auto &part : relative.split('/'))
        if (part.isEmpty() || part == "." || part == "..")
            throw ChannelError(QStringLiteral("Unable to authorize session deletion"));
    return relative;
}
QString physicalRoot(const SessionFs &fs, const QString &root)
{
    const auto result = fs.runCapture({QStringLiteral("realpath"), QStringLiteral("-e"), QStringLiteral("--"), root}, 10'000, 16 * 1024);
    QString path = result.stdoutText;
    if (path.endsWith('\n')) path.chop(1);
    if (!result.ok() || !result.stdoutLosslessUtf8 || !path.startsWith('/') || path.contains('\n') || path.contains('\r')
        || path.contains('\\') || path.contains(QChar(0)))
        throw ChannelError(QStringLiteral("Unable to authorize session deletion"));
    return path;
}
} // namespace

/** One root identity and cwd/descriptor-bound Linux moves, without a check/use RPC gap. */
QString softDeleteWsl(const SessionFs &fs, const QString &filePath, const QString &root,
                      const deletionidentity::Lease *lease)
{
    const QString authority = physicalRoot(fs, root);
    const WslRootPin pin(fs.config(), authority);
    // Linux resolves symlink/.. component-by-component. Resolve the parent first,
    // retain the leaf entry, and only then derive a root-relative mutation path.
    const QString parent = physicalRoot(fs, fs.dirname(filePath));
    const QString file = fs.join(authority, relativePath(authority, fs.join(parent, fs.basename(filePath))));
    const Plan planned = plan(fs, file, authority);
    // The runtime fence was admitted before this worker resolved root aliases.
    // Keep that same physical entry and referents through planning, then rely on
    // the retained Linux root descriptor for the actual entry-level moves below.
    if (lease && !lease->matchesPlan(fs, planned.sessionFile))
        throw ChannelError(QStringLiteral("Session deletion identity changed"));
    if (!planned.hasFile && !planned.hasSibling && planned.backups.isEmpty() && planned.artifacts.isEmpty()) return {};
    const QString bucket = wslTrashBucket(fs, authority);
    const QString source = fs.dirname(file);
    QVector<QPair<QString, QString>> moves;
    const QString artifacts = fs.join(source, QLatin1String(kSharedArtifactsDir));
    for (const QString &artifact : planned.artifacts) {
        moves.append({artifact, fs.join(fs.join(bucket, QLatin1String(kSharedArtifactsDir)), relativePath(artifacts, artifact))});
    }
    for (const QString &backup : planned.backups) moves.append({backup, fs.join(bucket, fs.basename(backup))});
    if (planned.hasSibling) moves.append({planned.siblingDir, fs.join(bucket, fs.basename(planned.siblingDir))});
    if (planned.hasFile) moves.append({file, fs.join(bucket, fs.basename(file))});
    // Keep the existing whole-plan validation. The shell then binds cwd/dirfds at
    // the actual operation boundary, including creation of the private trash tree.
    if (!fs.authorizeDeletionPath(bucket, {authority}, false))
        throw ChannelError(QStringLiteral("Unable to authorize session deletion"));
    for (auto &move : moves) {
        if (!fs.authorizeDeletionPath(move.first, {authority}, true))
            throw ChannelError(QStringLiteral("Unable to authorize session deletion"));
        move.first = relativePath(authority, move.first);
        move.second = relativePath(authority, move.second);
    }
    const QStringList common{QStringLiteral("sh"), QStringLiteral("-c"), wslTrashScript(), QStringLiteral("--"), authority, pin.identity(), pin.pid(), pin.startTime()};
    qsizetype overhead = 1000;
    for (const auto &argument : common) overhead += argument.size() * 2 + 4;
    constexpr qsizetype COMMAND_LIMIT = 24'000;
    for (const auto &move : moves) {
        if (overhead + 2 * (move.first.size() + move.second.size()) + 8 > COMMAND_LIMIT)
            throw ChannelError(QStringLiteral("Session deletion command limit exceeded"));
    }
    const auto execute = [&fs](const QStringList &arguments) {
        const auto result = fs.runCapture(arguments, 30'000, 128 * 1024);
        if (result.started && !result.timedOut && !result.truncated && result.exitCode == 42)
            throw WslTrashUnavailable();
        if (!result.ok()) throw ChannelError(QStringLiteral("Unable to move session to trash"));
    };
    // Bound the Windows command line without assuming a small number of artifacts.
    // Every chunk carries the same captured root identity and unique bucket.
    QStringList arguments = common;
    qsizetype size = overhead;
    for (const auto &move : moves) {
        const qsizetype cost = 2 * (move.first.size() + move.second.size()) + 8;
        if (size + cost > COMMAND_LIMIT) { execute(arguments); arguments = common; size = overhead; }
        arguments << move.first << move.second;
        size += cost;
    }
    execute(arguments);
    return bucket;
}
} // namespace sessiondelete

QString SessionScanner::softDeleteWsl(const QString &filePath)
{
    const SessionFs storage = fs();
    return sessiondelete::softDeleteWsl(storage, filePath, findRootForFile(filePath));
}
