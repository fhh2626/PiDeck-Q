#pragma once

#include <QJsonValue>
#include <QString>

#include <functional>

/**
 * Off-thread execution for blocking domain work.
 *
 * The Node oracle runs git and filesystem calls through async libuv APIs, so a slow
 * `git push` never stalls the renderer RPC, SSE stream or heartbeat. The C++ backend
 * keeps domain code synchronous (much easier to keep correct) but runs it on a worker
 * thread and settles the channel back on the main thread, which gives the same
 * externally observable property: the event loop is never blocked by a child process.
 *
 * Execution model: exactly ONE dedicated worker thread ("serial domain executor").
 *
 * The oracle is single threaded: every domain mutation runs on the JS event loop, so a
 * catalog read-modify-write, an archive index update or a JSONL index cache eviction can
 * never interleave with another one. The C++ backend keeps that guarantee by serialising
 * every blocking domain body instead of spreading them over QThreadPool::globalInstance()
 * (which used to run N bodies concurrently against unsynchronised QHash/QVector state).
 *
 * Consequences that are deliberate, not accidental:
 *  - domain state needs no per-structure locks, and the observable order equals the
 *    oracle's order for the same request sequence;
 *  - a long body (network git, `npx` install) delays *other* domain bodies, but never the
 *    HTTP/SSE/host transport, which all stay on the main thread. That head-of-line cost is
 *    the price of single-owner state, and it is bounded by the child process timeout.
 *
 * Exceptions thrown by the task (ChannelError included) are captured and reported as
 * `Outcome::ok == false`; they are never rethrown on the main thread, because that
 * would unwind through the Qt event loop.
 */
namespace background {

struct Outcome {
    bool ok = false;
    QJsonValue value;
    QString error;
};

/** Queue `task` on the serial domain executor; `continuation` always runs on the main thread. */
void runBlocking(std::function<QJsonValue()> task, std::function<void(Outcome)> continuation);

/**
 * Stop the executor: refuse new work, drop bodies that are still queued, and let the body
 * in flight finish (then join).
 *
 * Once this has been called the process is leaving: the event loop is about to stop and the
 * services a continuation captures are about to be destroyed, so
 *  - a body that is still queued is discarded instead of run (it would extend the exit past
 *    the host's budget), and
 *  - a body that finishes from now on must NOT post its continuation into the queue.
 *
 * Returns false when the body in flight did not finish within `timeoutMs`, or when an
 * earlier call already gave up. The caller must then exit the process without running
 * destructors: the body is still using the services owned by the application object, so
 * freeing them would be a use-after-free. A second call therefore never waits twice — the
 * drain deadline is spent once, and main() can go straight to the emergency exit.
 */
bool drainAndStop(int timeoutMs);

/** True after a timed-out drainAndStop: continuations are quarantined instead of posted. */
bool abandoned();

} // namespace background
