#include "HostRpcClient.h"

#include <QElapsedTimer>
#include <QJsonDocument>
#include <QTimer>
#include <QUuid>

#include <utility>

HostRequest::HostRequest(QString method, QObject *parent)
    : QObject(parent), m_method(std::move(method))
{
}

HostRequest &HostRequest::then(Resolve callback)
{
    m_resolve = std::move(callback);
    return *this;
}

HostRequest &HostRequest::fail(Reject callback)
{
    m_reject = std::move(callback);
    return *this;
}

void HostRequest::resolve(const QJsonValue &value)
{
    if (m_settled) return;
    m_settled = true;
    if (m_resolve) m_resolve(value);
}

void HostRequest::reject(const QString &error)
{
    if (m_settled) return;
    m_settled = true;
    if (m_reject) m_reject(error);
}

HostRpcClient::HostRpcClient(QString token, QObject *parent)
    : QObject(parent), m_token(std::move(token))
{
    connect(&m_socket, &QTcpSocket::readyRead, this, [this] { handleReadyRead(); });
    connect(&m_socket, &QTcpSocket::disconnected, this, [this] {
        handleDisconnected(QStringLiteral("Native host connection closed"));
    });
    connect(&m_socket, &QTcpSocket::errorOccurred, this, [this](QAbstractSocket::SocketError) {
        handleDisconnected(QStringLiteral("Native host connection closed: %1").arg(m_socket.errorString()));
    });
}

bool HostRpcClient::connectToHost(quint16 port, int timeoutMs)
{
    m_socket.connectToHost(QHostAddress::LocalHost, port);
    if (!m_socket.waitForConnected(timeoutMs)) return false;

    // The host answers the handshake with {type:"hello", ok:bool}. Nothing else may
    // be sent before it arrives, so wait synchronously here: this runs once at
    // startup, before any window or renderer exists.
    send(QJsonObject{
        {QStringLiteral("type"), QStringLiteral("hello")},
        {QStringLiteral("token"), m_token},
    });
    QElapsedTimer clock;
    clock.start();
    while (!m_authenticated && !m_closed) {
        const int remaining = timeoutMs - int(clock.elapsed());
        if (remaining <= 0) break;
        if (!m_socket.waitForReadyRead(remaining)) break;
        handleReadyRead();
    }
    if (!m_authenticated) {
        m_socket.abort();
        return false;
    }
    return true;
}

std::shared_ptr<HostRequest> HostRpcClient::request(const QString &method, const QJsonObject &params,
                                                 int timeoutMs, TimeoutPolicy timeoutPolicy)
{
    // No QObject parent: the shared_ptr owns the lifetime, and a parent would
    // double-delete it when the client is destroyed.
    auto handle = std::make_shared<HostRequest>(method);
    if (m_closed) {
        handle->reject(QStringLiteral("Native host connection is not available"));
        return handle;
    }
    const QString id = QUuid::createUuid().toString(QUuid::WithoutBraces);
    m_pending.insert(id, handle);
    // A timeout cannot retract an already delivered destructive request. Its
    // caller must retain its mutation reservation until the host replies or the
    // bridge closes. Connection loss still rejects every pending request and is
    // fatal to the backend, so no runtime may continue past that shutdown.
    if (timeoutPolicy == TimeoutPolicy::Deadline) {
        QTimer::singleShot(timeoutMs, handle.get(), [this, id, method] {
            const auto pending = m_pending.take(id);
            if (!pending) return;
            pending->reject(QStringLiteral("Native host request timed out: %1").arg(method));
        });
    }
    send(QJsonObject{
        {QStringLiteral("type"), QStringLiteral("request")},
        {QStringLiteral("id"), id},
        {QStringLiteral("method"), method},
        {QStringLiteral("params"), params},
    });
    return handle;
}

void HostRpcClient::emitEvent(const QString &name, const QJsonValue &payload)
{
    if (m_closed) return;
    send(QJsonObject{
        {QStringLiteral("type"), QStringLiteral("event")},
        {QStringLiteral("name"), name},
        {QStringLiteral("payload"), payload},
    });
}

void HostRpcClient::onEvent(const QString &name, std::function<void(const QJsonValue &)> handler)
{
    m_listeners.insert(name, std::move(handler));
}

void HostRpcClient::onFatal(std::function<void(const QString &)> handler)
{
    if (!m_fatalError.isEmpty()) {
        handler(m_fatalError);
        return;
    }
    m_fatalListeners.append(std::move(handler));
}

void HostRpcClient::handleReadyRead()
{
    m_decoder.append(m_socket.readAll());
    for (;;) {
        QByteArray payload;
        const host::FrameDecoder::Result result = m_decoder.next(&payload);
        if (result == host::FrameDecoder::Result::NeedMore) return;
        if (result == host::FrameDecoder::Result::Oversized) {
            handleDisconnected(QStringLiteral("Native host frame exceeds 32 MB"));
            return;
        }
        QJsonParseError parseError;
        const QJsonDocument document = QJsonDocument::fromJson(payload, &parseError);
        if (parseError.error != QJsonParseError::NoError || !document.isObject()) {
            handleDisconnected(QStringLiteral("Native host sent invalid JSON"));
            return;
        }
        handleFrame(document.object());
        if (m_closed) return;
    }
}

void HostRpcClient::handleFrame(const QJsonObject &frame)
{
    const QString type = frame.value(QStringLiteral("type")).toString();
    if (type == QStringLiteral("hello")) {
        if (frame.value(QStringLiteral("ok")).toBool(false)) {
            m_authenticated = true;
        } else {
            handleDisconnected(frame.value(QStringLiteral("error")).toObject()
                                   .value(QStringLiteral("message")).toString(
                                       QStringLiteral("Native host authentication failed")));
        }
        return;
    }
    if (!m_authenticated) {
        // The host rejects post-handshake traffic on unauthenticated sockets; do the same.
        handleDisconnected(QStringLiteral("Native host frame before authentication"));
        return;
    }
    if (type == QStringLiteral("response")) {
        const auto pending = m_pending.take(frame.value(QStringLiteral("id")).toString());
        if (!pending) return;
        if (frame.value(QStringLiteral("ok")).toBool(false)) {
            pending->resolve(frame.value(QStringLiteral("result")));
        } else {
            const QString message = frame.value(QStringLiteral("error")).toObject()
                                        .value(QStringLiteral("message")).toString(
                                            QStringLiteral("Native host request failed"));
            pending->reject(message);
        }
        return;
    }
    if (type != QStringLiteral("event")) return;
    const auto listener = m_listeners.constFind(frame.value(QStringLiteral("name")).toString());
    if (listener == m_listeners.constEnd()) return;
    listener.value()(frame.value(QStringLiteral("payload")));
}

void HostRpcClient::send(const QJsonObject &frame)
{
    if (m_closed || m_socket.state() != QAbstractSocket::ConnectedState) return;
    const QByteArray packet = host::encodeFrame(frame);
    if (m_socket.bytesToWrite() + packet.size() > host::kMaxPendingWriteBytes) {
        handleDisconnected(QStringLiteral("Native host write backpressure limit exceeded"));
        return;
    }
    if (m_socket.write(packet) != packet.size()) {
        handleDisconnected(QStringLiteral("Native host write failed"));
    }
}

void HostRpcClient::handleDisconnected(const QString &reason)
{
    if (m_closed) return;
    const bool fatal = m_authenticated && !m_intentionalClose;
    m_closed = true;
    m_authenticated = false;
    m_decoder.reset();
    m_socket.abort();
    rejectAll(reason);
    if (fatal) {
        m_fatalError = reason;
        for (const auto &listener : std::as_const(m_fatalListeners)) listener(reason);
    }
    m_fatalListeners.clear();
}

void HostRpcClient::rejectAll(const QString &reason)
{
    const auto pending = m_pending;
    m_pending.clear();
    for (const auto &request : pending) request->reject(reason);
}

void HostRpcClient::close()
{
    m_intentionalClose = true;
    handleDisconnected(QStringLiteral("Native host bridge disposed"));
}

void HostRpcClient::closeGracefully(int drainTimeoutMs)
{
    m_intentionalClose = true;
    if (m_closed) return;
    const int deadline = drainTimeoutMs;
    if (m_socket.bytesToWrite() > 0) m_socket.waitForBytesWritten(deadline);
    m_socket.disconnectFromHost();
    if (m_socket.state() != QAbstractSocket::UnconnectedState) {
        m_socket.waitForDisconnected(qMax(1, deadline));
    }
    handleDisconnected(QStringLiteral("Native host bridge disposed"));
}
