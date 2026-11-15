#pragma once

#include <QByteArray>
#include <QString>
#include <QStringList>

/**
 * One `git` invocation.
 *
 * ADR-8 keeps the git CLI as the implementation (no libgit2), so this module is the
 * only place that spawns it. Argument arrays are mandatory — never a shell string —
 * and the child environment is sanitized so the host bridge credential cannot reach
 * hooks or helpers.
 *
 * The call is synchronous by design and must run on a worker thread (see
 * process/BackgroundWork.h): the Node oracle uses async execFile, so a slow
 * `git push` must not stall the renderer RPC or the SSE stream.
 */
namespace gitexec {

struct Result {
    int exitCode = 0;
    QByteArray stdoutBytes;
    QString stdoutText;
    QString stderrText;
    bool timedOut = false;
    /** Output exceeded the byte cap and the child was killed (Node's maxBuffer). */
    bool truncated = false;
    bool started = false;

    bool ok() const { return started && !timedOut && !truncated && exitCode == 0; }
    /** First non-empty stderr line, or a generic message, for error reporting. */
    QString errorMessage() const;
};

/** Default per-command timeout, matching GIT_MUTATION_TIMEOUT_MS. */
constexpr int kDefaultTimeoutMs = 30'000;
/** Default stdout cap; matches the 32 MiB maxBuffer used by the history commands. */
constexpr qint64 kDefaultMaxBytes = 32 * 1024 * 1024;

Result run(const QString &cwd, const QStringList &arguments, int timeoutMs = kDefaultTimeoutMs,
           qint64 maxBytes = kDefaultMaxBytes);

/** Run and throw on failure. Used by mutations where a failure must surface. */
QString runOrThrow(const QString &cwd, const QStringList &arguments, int timeoutMs = kDefaultTimeoutMs,
                   qint64 maxBytes = kDefaultMaxBytes);

/** Run and return the trimmed stdout, or an empty string on any failure. */
QString tryRun(const QString &cwd, const QStringList &arguments, int timeoutMs = kDefaultTimeoutMs,
               qint64 maxBytes = kDefaultMaxBytes);

} // namespace gitexec
