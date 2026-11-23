#include "PiEventClient.h"

#include <QJsonDocument>
#include <QTimer>
#include <QUuid>

PiEventClient::PiEventClient() = default;

PiEventClient::~PiEventClient()
{
    close(QStringLiteral("PiEventClient destroyed"));
}

bool PiEventClient::start(const QString &program, const QStringList &arguments, const QString &cwd,
                          const QProcessEnvironment &environment, const QString &nativeArguments)
{
    if (m_process.state() != QProcess::NotRunning) close(QStringLiteral("PiEventClient restarted"));
    m_buffer.clear();
    m_stderrTail.clear();
    m_process.setProgram(program);
    m_process.setArguments(arguments);
#ifdef Q_OS_WIN
    // An npm `.cmd` shim is launched through cmd.exe; that command line must not be
    // re-escaped by QProcess.
    if (!nativeArguments.isEmpty()) m_process.setNativeArguments(nativeArguments);
#else
    Q_UNUSED(nativeArguments);
#endif
    m_process.setWorkingDirectory(cwd);
    m_process.setProcessEnvironment(environment);
    // stderr must be drained: a full pipe would block pi mid-write.
    m_process.setProcessChannelMode(QProcess::SeparateChannels);
    QObject::connect(&m_process, &QProcess::readyReadStandardOutput, &m_process, [this] { consumeStdout(); });
    QObject::connect(&m_process, &QProcess::readyReadStandardError, &m_process, [this] {
        const QByteArray chunk = m_process.readAllStandardError();
        const QString text = QString::fromUtf8(chunk);
        m_stderrTail += text;
        if (m_stderrTail.size() > 4'096) m_stderrTail = m_stderrTail.right(4'096);
        if (m_stderrHandler && !text.isEmpty()) {
            const StderrHandler handler = m_stderrHandler;
            handler(text);
        }
    });
    QObject::connect(&m_process, QOverload<int, QProcess::ExitStatus>::of(&QProcess::finished), &m_process,
                     [this](int exitCode, QProcess::ExitStatus status) {
                         consumeStdout();
                         failAllPending(QStringLiteral("pi exited"));
                         if (m_exitHandler) {
                             const ExitHandler handler = m_exitHandler;
                             handler(exitCode, status);
                         }
                     });
    m_process.start();
    // Bounded: a broken program path must fail the activation quickly instead of
    // stalling the renderer's HTTP/SSE loop for the full process start timeout.
    return m_process.waitForStarted(3'000);
}

void PiEventClient::setEventHandler(EventHandler handler)
{
    m_eventHandler = std::move(handler);
}

void PiEventClient::request(const QJsonObject &command, int timeoutMs, ResponseHandler done)
{
    QJsonObject payload = command;
    if (!payload.contains(QStringLiteral("id"))) {
        payload.insert(QStringLiteral("id"), QUuid::createUuid().toString(QUuid::WithoutBraces));
    }
    const QString id = payload.value(QStringLiteral("id")).toString();
    m_pending.insert(id, Pending{std::move(done)});
    if (m_process.state() == QProcess::NotRunning) {
        const auto pending = m_pending.take(id);
        if (pending.done) pending.done(false, QJsonObject{}, QStringLiteral("pi is not running"));
        return;
    }
    // Recorded after the id is attached and only for frames that really go out, matching
    // the oracle's log point inside `write`.
    if (m_logHandler) m_logHandler(QStringLiteral("send"), payload);
    m_process.write(QJsonDocument(payload).toJson(QJsonDocument::Compact) + '\n');
    QTimer::singleShot(timeoutMs, &m_process, [this, id]() {
        const auto pending = m_pending.take(id);
        if (!pending.done) return;
        pending.done(false, QJsonObject{}, QStringLiteral("RPC command timed out"));
    });
}

void PiEventClient::sendRaw(const QJsonObject &command)
{
    if (m_process.state() == QProcess::NotRunning) return;
    // Same log point as `request`: the panel shows what really crossed the pipe.
    if (m_logHandler) m_logHandler(QStringLiteral("send"), command);
    m_process.write(QJsonDocument(command).toJson(QJsonDocument::Compact) + '\n');
}

void PiEventClient::close(const QString &reason)
{
    failAllPending(reason);
    m_eventHandler = nullptr;
    // A closed client must stop feeding the log panel, exactly like the oracle's
    // `closed` guard inside `write`/`consumeChunk`.
    m_logHandler = nullptr;
    if (m_process.state() == QProcess::NotRunning) return;
    m_process.closeWriteChannel();
    if (!m_process.waitForFinished(3'000)) {
        m_process.terminate();
        if (!m_process.waitForFinished(1'000)) m_process.kill();
        m_process.waitForFinished(1'000);
    }
}

bool PiEventClient::running() const
{
    return m_process.state() != QProcess::NotRunning;
}

void PiEventClient::requestClose()
{
    if (m_process.state() == QProcess::NotRunning) return;
    // pi exits when its stdin closes; the owner escalates to terminate/kill on a timer.
    m_process.closeWriteChannel();
}

void PiEventClient::terminateNow()
{
    if (m_process.state() == QProcess::NotRunning) return;
    m_process.terminate();
    if (!m_process.waitForFinished(500)) m_process.kill();
}

void PiEventClient::consumeStdout()
{
    m_buffer.append(m_process.readAllStandardOutput());
    while (true) {
        const int newline = m_buffer.indexOf('\n');
        if (newline < 0) break;
        const QByteArray line = m_buffer.left(newline);
        m_buffer.remove(0, newline + 1);
        dispatchLine(line);
    }
    if (m_buffer.size() > kMaxLineBytes) {
        m_buffer.clear();
        failAllPending(QStringLiteral("pi produced an oversized protocol line"));
    }
}

void PiEventClient::dispatchLine(const QByteArray &line)
{
    const QByteArray trimmed = line.trimmed();
    if (trimmed.isEmpty()) return;
    const QJsonDocument document = QJsonDocument::fromJson(trimmed);
    if (!document.isObject()) return;
    const QJsonObject message = document.object();
    // The oracle logs every parsed line before response/event routing.
    if (m_logHandler) m_logHandler(QStringLiteral("recv"), message);
    const QString type = message.value(QStringLiteral("type")).toString();
    const QString id = message.value(QStringLiteral("id")).toString();
    if (type == QLatin1String("response")) {
        // A reply whose id is no longer pending belongs to a timed-out or replaced
        // request. It must never be replayed as an agent event: that is exactly how a
        // stale generation would resurrect a finished turn in the renderer.
        const auto pending = m_pending.take(id);
        if (pending.done) invokeGuarded(pending.done, message);
        return;
    }
    if (!id.isEmpty()) {
        const auto pending = m_pending.take(id);
        if (pending.done) {
            invokeGuarded(pending.done, message);
            return;
        }
    }
    if (m_eventHandler) {
        // Copy before invoking: the handler may clear itself (for example when a
        // generation settles), which would otherwise destroy the running callable.
        const EventHandler handler = m_eventHandler;
        try {
            handler(message);
        } catch (const std::exception &error) {
            reportHandlerFailure(error.what());
        } catch (...) {
            reportHandlerFailure("unknown error");
        }
    }
}

void PiEventClient::invokeGuarded(const ResponseHandler &handler, const QJsonObject &message)
{
    // An exception escaping into Qt's event loop terminates the whole backend, so a
    // failing handler is reported on stderr (renderer `agents:log`) instead.
    try {
        handler(true, message, QString());
    } catch (const std::exception &error) {
        reportHandlerFailure(error.what());
    } catch (...) {
        reportHandlerFailure("unknown error");
    }
}

void PiEventClient::reportHandlerFailure(const char *what)
{
    if (!m_stderrHandler) return;
    const StderrHandler handler = m_stderrHandler;
    handler(QStringLiteral("pi event handler failed: %1\n").arg(QString::fromUtf8(what)));
}

void PiEventClient::failAllPending(const QString &reason)
{
    const auto pending = m_pending;
    m_pending.clear();
    for (const Pending &entry : pending) {
        if (entry.done) entry.done(false, QJsonObject{}, reason);
    }
}
