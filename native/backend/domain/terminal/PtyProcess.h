#pragma once

#include <QByteArray>
#include <QProcessEnvironment>
#include <QString>
#include <QStringList>

#include <functional>
#include <memory>

/**
 * One OS pseudo terminal with a live child process.
 *
 * Windows: ConPTY (`CreatePseudoConsole` + `PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE`).
 * POSIX: `forkpty`. Both implementations are non-blocking from the caller's point of
 * view: output is read on a dedicated reader thread and the exit is observed on a
 * waiter thread, so the Qt event loop never waits for the shell.
 *
 * Callbacks are invoked on those worker threads. The owner is responsible for
 * marshalling them onto its own thread; `terminal::Manager` does that with a queued
 * invocation so the replay buffer has a single owner.
 *
 * Lifetime: the destructor terminates the child and joins both threads, so no callback
 * can run after the object is gone. `kill()` alone is asynchronous — the exit callback
 * still fires.
 */
namespace terminal {

struct PtySize {
    int cols = 80;
    int rows = 24;
};

class PtyProcess {
public:
    struct Callbacks {
        /** Raw PTY bytes, in order. UTF-8 decoding belongs to the owner. */
        std::function<void(const QByteArray &)> onData;
        /** Child exit; exactly once, after every data callback returned. */
        std::function<void(int exitCode)> onExit;
    };

    /**
     * Spawn `command` with `args` inside a new PTY.
     *
     * Returns null and fills `error` when the executable cannot be started (missing
     * binary, invalid cwd, ConPTY unavailable). The caller uses that to fall back to
     * the next shell candidate.
     */
    static std::unique_ptr<PtyProcess> spawn(const QString &command, const QStringList &args,
                                             const QString &cwd, const PtySize &size,
                                             const QProcessEnvironment &environment,
                                             Callbacks callbacks, QString *error);

    ~PtyProcess();
    PtyProcess(const PtyProcess &) = delete;
    PtyProcess &operator=(const PtyProcess &) = delete;

    /** Write raw bytes to the PTY. Returns false when the child is gone. */
    bool write(const QByteArray &data, QString *error);

    /** Resize the PTY; a no-op after exit. */
    bool resize(int cols, int rows);

    /** Terminate the child. Idempotent; the exit callback still runs. */
    void kill();

    bool running() const;

private:
    struct State;
    explicit PtyProcess(std::shared_ptr<State> state);
    std::shared_ptr<State> m_state;
};

} // namespace terminal
