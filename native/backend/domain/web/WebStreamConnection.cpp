#include "WebStreamConnection.h"

#include <QJsonObject>
#include <QTcpSocket>
#include <QTimer>

namespace {

/** One chunk of a chunked-transfer body. */
QByteArray chunk(const QByteArray &payload)
{
    if (payload.isEmpty()) return {};
    return QByteArray::number(payload.size(), 16) + "\r\n" + payload + "\r\n";
}

} // namespace

WebStreamConnection::WebStreamConnection(QTcpSocket *socket, Options options, QObject *parent)
    : QObject(parent), m_socket(socket), m_options(options)
{
    if (!m_socket) return;
    // The socket belongs to this response now; the request table must have released it.
    m_socket->setParent(this);
    connect(m_socket, &QTcpSocket::disconnected, this, [this] { handleDisconnect(); });
    sendHeaders();
    m_heartbeat = new QTimer(this);
    m_heartbeat->setInterval(qMax(50, m_options.heartbeatMs));
    connect(m_heartbeat, &QTimer::timeout, this, [this] {
        if (m_closed) {
            stopHeartbeat();
            return;
        }
        // Comment frame: SSE parsers ignore it, but it keeps NAT/proxies and mobile
        // radios from treating the connection as dead between two long tool calls.
        writeRaw(QStringLiteral(": ping\n\n"));
    });
    m_heartbeat->start();
}

WebStreamConnection::~WebStreamConnection()
{
    stopHeartbeat();
    // A connection can be destroyed without ever emitting `disconnected` (socket already
    // gone, parent teardown). The owner still has to forget the entry, otherwise it keeps
    // a dangling pointer that would crash the next service stop.
    notifyClosed();
    if (!m_socket) return;
    // Never delete the socket from inside its own signal emission (`disconnected` runs
    // this destructor path): detach and let the event loop delete it.
    m_socket->setParent(nullptr);
    m_socket->disconnect(this);
    m_socket->deleteLater();
    m_socket = nullptr;
}

void WebStreamConnection::sendHeaders()
{
    static const QByteArray header =
        "HTTP/1.1 200 OK\r\n"
        "content-type: text/event-stream; charset=utf-8\r\n"
        "cache-control: no-cache, no-transform\r\n"
        "connection: keep-alive\r\n"
        "transfer-encoding: chunked\r\n"
        "x-accel-buffering: no\r\n"
        // `useChat` refuses a stream without this header; it is the protocol marker.
        "x-vercel-ai-ui-message-stream: v1\r\n"
        "\r\n";
    m_socket->write(header);
}

bool WebStreamConnection::writeRaw(const QString &wire)
{
    if (m_closed || !m_socket || wire.isEmpty()) return false;
    if (m_chunkedTerminated) return false;
    m_socket->write(chunk(wire.toUtf8()));
    if (m_socket->bytesToWrite() <= m_options.maxBufferedBytes) return true;
    log(QStringLiteral("warn"), QStringLiteral("Web stream client is not reading"),
        QJsonObject{{QStringLiteral("bufferedBytes"), double(m_socket->bytesToWrite())},
                    {QStringLiteral("limitBytes"), double(m_options.maxBufferedBytes)}});
    // Over the cap: drop the socket. `abort` closes it without calling back into the
    // router, and the next `writeRaw` returns false so the subscriber is detached.
    abort();
    return false;
}

void WebStreamConnection::finish()
{
    if (m_closed || !m_socket) return;
    m_closed = true;
    stopHeartbeat();
    if (!m_chunkedTerminated) {
        m_socket->write(QByteArrayLiteral("0\r\n\r\n"));
        m_chunkedTerminated = true;
    }
    flushPending();
}

void WebStreamConnection::abort()
{
    if (m_closed) return;
    m_closed = true;
    stopHeartbeat();
    if (!m_socket) return;
    m_socket->abort();
}

qint64 WebStreamConnection::bufferedBytes() const
{
    return m_socket ? m_socket->bytesToWrite() : 0;
}

void WebStreamConnection::flushPending()
{
    if (!m_socket) return;
    // A graceful end must not wait for a client that never reads: `disconnectFromHost`
    // would keep the socket (and the pi subscription) alive forever.
    if (m_socket->bytesToWrite() > m_options.maxBufferedBytes) {
        m_socket->abort();
        return;
    }
    m_socket->disconnectFromHost();
}

void WebStreamConnection::handleDisconnect()
{
    stopHeartbeat();
    m_closed = true;
    // The owner must hear about this even when the *server* ended the response first:
    // `finish()` only marks the stream closed and lets the socket drain, so a finished
    // stream would otherwise stay registered in the service's connection table forever
    // (one stale entry per turn). Releasing the handler makes the notification one-shot.
    notifyClosed();
    // Never delete from inside the socket's own `disconnected` emission.
    deleteLater();
}

void WebStreamConnection::notifyClosed()
{
    const auto handler = m_onClientClosed;
    m_onClientClosed = nullptr;
    if (handler) handler();
}

void WebStreamConnection::stopHeartbeat()
{
    if (!m_heartbeat) return;
    m_heartbeat->stop();
}

void WebStreamConnection::log(const QString &level, const QString &message,
                              const QJsonObject &detail)
{
    if (m_logSink) m_logSink(level, message, detail);
}
