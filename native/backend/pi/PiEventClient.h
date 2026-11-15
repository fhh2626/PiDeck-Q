#pragma once

#include <QByteArray>
#include <QHash>
#include <QJsonObject>
#include <QProcess>
#include <QProcessEnvironment>
#include <QString>
#include <QStringList>

#include <functional>

/**
 * Event-capable pi stdio client.
 *
 * pi speaks newline-delimited JSON on stdio: a line carrying our request `id` is the
 * response, and every other line is an agent event (`message_update`,
 * `tool_execution_*`, `extension_ui_request`, ...). The prototype client discarded
 * every non-matching line, which is why no streaming, tool or ask surface could ever
 * work. This client keeps both directions: responses settle their pending promise and
 * events are delivered to the owner.
 *
 * Scope: this is the transport used by the git AI commit-message generator. The
 * session runtime's full coordinator (generation, lease, idempotency) is a separate
 * stage; it can build on this same client.
 */
class PiEventClient {
public:
    using EventHandler = std::function<void(const QJsonObject &)>;
    using ResponseHandler = std::function<void(bool ok, const QJsonObject &response, const QString &error)>;

    PiEventClient();
    ~PiEventClient();

    bool start(const QString &program, const QStringList &arguments, const QString &cwd,
               const QProcessEnvironment &environment,
               const QString &nativeArguments = QString());
    void setEventHandler(EventHandler handler);

    /**
     * Every RPC frame in both directions, for the `rpc-logs:*` debug panel.
     *
     * The oracle logs inside `PiRpcClient.write`/`handleLine`, so the payload is the
     * exact JSON that crossed the pipe (a send already carries its generated `id`).
     * Frames are only reported when the owner installed a handler: building summaries
     * for an agent whose recording is off would cost work for data nobody reads.
     */
    using LogHandler = std::function<void(const QString &direction, const QJsonObject &data)>;
    void setLogHandler(LogHandler handler) { m_logHandler = std::move(handler); }

    /** Send one command; the handler runs exactly once, on the owner thread. */
    void request(const QJsonObject &command, int timeoutMs, ResponseHandler done);

    /**
     * Write one raw JSONL frame without tracking a pending response.
     *
     * Port of `PiRpcClient.sendRaw`: `extension_ui_response` is a notification pi acts
     * on, not an RPC whose answer the renderer waits for. Correlating it by the ask's
     * request id (which is what pi expects in `id`) would also collide with the RPC
     * registry and make a timed-out ask look like a failed write.
     */
    void sendRaw(const QJsonObject &command);

    /** Reject every pending request and stop the child. */
    void close(const QString &reason);
    bool running() const;
    QProcess *process() { return &m_process; }

    /**
     * Non-blocking shutdown used by the session runtime: close stdin (pi exits once its
     * input ends) and let the owner decide when to escalate to terminate/kill. Blocking
     * here would stall the renderer HTTP/SSE loop for the whole grace period.
     */
    void requestClose();
    void terminateNow();

    /** Exit notification for the owner (fires once per started process). */
    using ExitHandler = std::function<void(int exitCode, QProcess::ExitStatus status)>;
    void setExitHandler(ExitHandler handler) { m_exitHandler = std::move(handler); }

    /** Raw stderr lines (renderer `agents:log`), already bounded by the tail buffer. */
    using StderrHandler = std::function<void(const QString &text)>;
    void setStderrHandler(StderrHandler handler) { m_stderrHandler = std::move(handler); }

    /** Bounded stderr tail kept for diagnostics; never contains prompts or paths. */
    QString stderrTail() const { return m_stderrTail; }

    static constexpr int kMaxLineBytes = 64 * 1024 * 1024;

private:
    struct Pending {
        ResponseHandler done;
    };

    void consumeStdout();
    void dispatchLine(const QByteArray &line);
    void invokeGuarded(const ResponseHandler &handler, const QJsonObject &message);
    void reportHandlerFailure(const char *what);
    void failAllPending(const QString &reason);

    QProcess m_process;
    QByteArray m_buffer;
    QHash<QString, Pending> m_pending;
    EventHandler m_eventHandler;
    ExitHandler m_exitHandler;
    StderrHandler m_stderrHandler;
    LogHandler m_logHandler;
    QString m_stderrTail;
};
