#include "PtyProcess.h"

#ifndef Q_OS_WIN

#include <poll.h>
#include <signal.h>
#include <sys/ioctl.h>
#include <sys/wait.h>
#include <termios.h>
#include <unistd.h>

#if defined(__APPLE__)
#include <util.h>
#else
#include <pty.h>
#endif

#include <atomic>
#include <cerrno>
#include <cstring>
#include <mutex>
#include <thread>
#include <vector>

namespace terminal {
namespace {

QString errnoMessage(const QString &prefix, int code)
{
    return QStringLiteral("%1: %2").arg(prefix, QString::fromLocal8Bit(std::strerror(code)));
}

/** Exit code convention shared with node-pty: signal deaths report 128 + signal. */
int exitCodeFromStatus(int status)
{
    if (WIFEXITED(status)) return WEXITSTATUS(status);
    if (WIFSIGNALED(status)) return 128 + WTERMSIG(status);
    return 0;
}

} // namespace

struct PtyProcess::State {
    int master = -1;
    int wakeRead = -1;
    int wakeWrite = -1;
    pid_t pid = -1;
    std::thread reader;
    std::thread waiter;
    std::thread escalator;
    std::atomic<bool> exited{false};
    std::atomic<bool> killRequested{false};
    Callbacks callbacks;
};

PtyProcess::PtyProcess(std::shared_ptr<State> state)
    : m_state(std::move(state))
{
}

std::unique_ptr<PtyProcess> PtyProcess::spawn(const QString &command, const QStringList &args,
                                              const QString &cwd, const PtySize &size,
                                              const QProcessEnvironment &environment,
                                              Callbacks callbacks, QString *error)
{
    if (command.isEmpty()) {
        if (error) *error = QStringLiteral("terminal program is required");
        return nullptr;
    }

    // Everything the child needs is materialized before fork(): after forkpty only
    // async-signal-safe calls are allowed, so no allocation may happen there.
    const QByteArray program = command.toLocal8Bit();
    std::vector<QByteArray> argumentStorage;
    argumentStorage.push_back(program);
    for (const QString &argument : args) argumentStorage.push_back(argument.toLocal8Bit());
    std::vector<char *> argv;
    argv.reserve(argumentStorage.size() + 1);
    for (QByteArray &value : argumentStorage) argv.push_back(value.data());
    argv.push_back(nullptr);

    const QStringList keys = environment.keys();
    std::vector<QByteArray> environmentStorage;
    environmentStorage.reserve(static_cast<size_t>(keys.size()));
    for (const QString &key : keys) {
        environmentStorage.push_back((key + QLatin1Char('=') + environment.value(key)).toLocal8Bit());
    }
    std::vector<char *> envp;
    envp.reserve(environmentStorage.size() + 1);
    for (QByteArray &value : environmentStorage) envp.push_back(value.data());
    envp.push_back(nullptr);

    const QByteArray workingDirectory = cwd.toLocal8Bit();

    int wake[2] = {-1, -1};
    if (pipe(wake) != 0) {
        if (error) *error = errnoMessage(QStringLiteral("terminal wake pipe failed"), errno);
        return nullptr;
    }

    struct winsize windowSize {};
    windowSize.ws_col = static_cast<unsigned short>(qMax(1, size.cols));
    windowSize.ws_row = static_cast<unsigned short>(qMax(1, size.rows));

    int master = -1;
    const pid_t pid = forkpty(&master, nullptr, nullptr, &windowSize);
    if (pid < 0) {
        const int code = errno;
        close(wake[0]);
        close(wake[1]);
        if (error) *error = errnoMessage(QStringLiteral("terminal forkpty failed"), code);
        return nullptr;
    }
    if (pid == 0) {
        // Child: the PTY is already the controlling terminal.
        if (!workingDirectory.isEmpty()) {
            if (chdir(workingDirectory.constData()) != 0) _exit(127);
        }
        environ = envp.data();
        execvp(argv[0], argv.data());
        _exit(127);
    }

    auto state = std::make_shared<State>();
    state->master = master;
    state->wakeRead = wake[0];
    state->wakeWrite = wake[1];
    state->pid = pid;
    state->callbacks = std::move(callbacks);

    // A blocking read on the master would be unbounded when a grandchild keeps the
    // slave open, so the reader also watches a wake pipe the waiter writes on exit.
    state->reader = std::thread([state] {
        std::vector<char> buffer(64 * 1024);
        struct pollfd descriptors[2] = {};
        descriptors[0].fd = state->master;
        descriptors[0].events = POLLIN;
        descriptors[1].fd = state->wakeRead;
        descriptors[1].events = POLLIN;
        for (;;) {
            const int ready = poll(descriptors, 2, -1);
            if (ready < 0) {
                if (errno == EINTR) continue;
                break;
            }
            if (descriptors[1].revents != 0) break;
            if (descriptors[0].revents == 0) continue;
            const ssize_t read = ::read(state->master, buffer.data(), buffer.size());
            if (read > 0) {
                if (state->callbacks.onData) state->callbacks.onData(QByteArray(buffer.data(), static_cast<int>(read)));
                continue;
            }
            if (read < 0 && (errno == EINTR || errno == EAGAIN)) continue;
            break;
        }
    });

    // The waiter owns the exit sequence: reap the child, wake the reader so every data
    // callback has already run, then report the exit exactly once.
    state->waiter = std::thread([state] {
        int status = 0;
        while (waitpid(state->pid, &status, 0) < 0 && errno == EINTR) {
        }
        state->exited = true;
        const char wakeByte = 1;
        (void)!::write(state->wakeWrite, &wakeByte, 1);
        if (state->reader.joinable()) state->reader.join();
        if (state->callbacks.onExit) state->callbacks.onExit(exitCodeFromStatus(status));
    });

    return std::unique_ptr<PtyProcess>(new PtyProcess(std::move(state)));
}

PtyProcess::~PtyProcess()
{
    if (!m_state) return;
    kill();
    // The escalator bounds the wait for a child that ignores SIGHUP.
    if (m_state->escalator.joinable()) m_state->escalator.join();
    if (m_state->waiter.joinable()) m_state->waiter.join();
    if (m_state->reader.joinable()) m_state->reader.join();
    if (m_state->master >= 0) close(m_state->master);
    if (m_state->wakeRead >= 0) close(m_state->wakeRead);
    if (m_state->wakeWrite >= 0) close(m_state->wakeWrite);
    m_state->master = -1;
    m_state->wakeRead = -1;
    m_state->wakeWrite = -1;
}

bool PtyProcess::write(const QByteArray &data, QString *error)
{
    if (!m_state || m_state->exited) {
        if (error) *error = QStringLiteral("terminal process has exited");
        return false;
    }
    if (data.isEmpty()) return true;
    qsizetype offset = 0;
    while (offset < data.size()) {
        const ssize_t written = ::write(m_state->master, data.constData() + offset,
                                        static_cast<size_t>(data.size() - offset));
        if (written < 0) {
            if (errno == EINTR) continue;
            if (error) *error = errnoMessage(QStringLiteral("terminal input was not written"), errno);
            return false;
        }
        offset += written;
    }
    return true;
}

bool PtyProcess::resize(int cols, int rows)
{
    if (!m_state || m_state->exited) return false;
    struct winsize windowSize {};
    windowSize.ws_col = static_cast<unsigned short>(qMax(1, cols));
    windowSize.ws_row = static_cast<unsigned short>(qMax(1, rows));
    return ioctl(m_state->master, TIOCSWINSZ, &windowSize) == 0;
}

void PtyProcess::kill()
{
    if (!m_state) return;
    if (m_state->killRequested.exchange(true)) return;
    ::kill(m_state->pid, SIGHUP);
    m_state->escalator = std::thread([state = m_state] {
        for (int tick = 0; tick < 25 && !state->exited; ++tick) usleep(10 * 1000);
        if (!state->exited) ::kill(state->pid, SIGKILL);
    });
}

bool PtyProcess::running() const
{
    return m_state && !m_state->exited;
}

} // namespace terminal

#endif // !Q_OS_WIN
