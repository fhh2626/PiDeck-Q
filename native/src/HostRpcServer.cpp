#include "HostRpcServer.h"

#include <QDataStream>
#include <QJsonDocument>
#include <QRandomGenerator>

#include <utility>

namespace {
constexpr quint32 kMaxFrameBytes = 32U * 1024U * 1024U;

QString randomToken()
{
    QByteArray bytes;
    bytes.reserve(32);
    auto *generator = QRandomGenerator::system();
    for (int i = 0; i < 4; ++i) {
        const quint64 value = generator->generate64();
        for (int shift = 0; shift < 64; shift += 8) {
            bytes.append(char((value >> shift) & 0xff));
        }
    }
    return QString::fromLatin1(bytes.toHex());
}

bool constantTimeEquals(const QString &left, const QString &right)
{
    const QByteArray a = left.toUtf8();
    const QByteArray b = right.toUtf8();
    const int maxLength = qMax(a.size(), b.size());
    unsigned char difference = static_cast<unsigned char>(a.size() ^ b.size());
    for (int i = 0; i < maxLength; ++i) {
        const unsigned char av = i < a.size() ? static_cast<unsigned char>(a.at(i)) : 0;
        const unsigned char bv = i < b.size() ? static_cast<unsigned char>(b.at(i)) : 0;
        difference = static_cast<unsigned char>(difference | (av ^ bv));
    }
    return difference == 0;
}
}

HostRpcServer::HostRpcServer(QObject *parent)
    : QTcpServer(parent),
      m_token(randomToken())
{
    connect(this, &QTcpServer::newConnection, this, [this] {
        while (hasPendingConnections()) {
            auto *socket = nextPendingConnection();
            if (m_socket) {
                m_socket->disconnectFromHost();
                m_socket->deleteLater();
            }
            m_socket = socket;
            m_receiveBuffer.clear();
            m_authenticated = false;
            connect(socket, &QTcpSocket::readyRead, this, [this, socket] {
                handleData(socket, socket->readAll());
            });
            connect(socket, &QTcpSocket::disconnected, this, [this, socket] {
                if (m_socket == socket) m_socket = nullptr;
                socket->deleteLater();
            });
        }
    });
}

bool HostRpcServer::start()
{
    return listen(QHostAddress::LocalHost, 0);
}

quint16 HostRpcServer::port() const
{
    return serverPort();
}

const QString &HostRpcServer::token() const
{
    return m_token;
}

void HostRpcServer::registerHandler(const QString &method, Handler handler)
{
    m_handlers.insert(method, std::move(handler));
}

void HostRpcServer::setEventHandler(EventHandler handler)
{
    m_eventHandler = std::move(handler);
}

void HostRpcServer::sendEvent(const QString &name, const QJsonValue &payload)
{
    if (!m_socket) return;
    QJsonObject frame;
    frame.insert(QStringLiteral("type"), QStringLiteral("event"));
    frame.insert(QStringLiteral("name"), name);
    frame.insert(QStringLiteral("payload"), payload);
    writeFrame(m_socket, frame);
}

void HostRpcServer::incomingConnection(qintptr socketDescriptor)
{
    auto *socket = new QTcpSocket(this);
    if (!socket->setSocketDescriptor(socketDescriptor)) {
        socket->deleteLater();
        return;
    }
    addPendingConnection(socket);
}

void HostRpcServer::handleData(QTcpSocket *socket, const QByteArray &chunk)
{
    m_receiveBuffer.append(chunk);
    while (m_receiveBuffer.size() >= 4) {
        const auto *header = reinterpret_cast<const unsigned char *>(m_receiveBuffer.constData());
        const quint32 frameLength = quint32(header[0])
            | (quint32(header[1]) << 8)
            | (quint32(header[2]) << 16)
            | (quint32(header[3]) << 24);
        if (frameLength > kMaxFrameBytes) {
            socket->disconnectFromHost();
            return;
        }
        if (m_receiveBuffer.size() < 4 + qsizetype(frameLength)) return;
        const QByteArray payload = m_receiveBuffer.mid(4, qsizetype(frameLength));
        m_receiveBuffer.remove(0, 4 + qsizetype(frameLength));
        handleFrame(socket, payload);
        if (socket->state() != QAbstractSocket::ConnectedState) return;
    }
}

void HostRpcServer::handleFrame(QTcpSocket *socket, const QByteArray &payload)
{
    QJsonParseError parseError;
    const QJsonDocument document = QJsonDocument::fromJson(payload, &parseError);
    if (parseError.error != QJsonParseError::NoError || !document.isObject()) {
        socket->disconnectFromHost();
        return;
    }
    const QJsonObject frame = document.object();
    const QString type = frame.value(QStringLiteral("type")).toString();

    if (type == QStringLiteral("hello")) {
        const bool valid = isTokenValid(frame.value(QStringLiteral("token")).toString());
        QJsonObject response;
        response.insert(QStringLiteral("type"), QStringLiteral("hello"));
        response.insert(QStringLiteral("ok"), valid);
        if (!valid) response.insert(QStringLiteral("error"), QJsonObject{{QStringLiteral("message"), QStringLiteral("Authentication failed")}});
        writeFrame(socket, response);
        if (!valid) {
            m_authenticated = false;
            socket->disconnectFromHost();
        } else {
            m_authenticated = true;
        }
        return;
    }

    // The first non-hello frame is rejected. A connected sidecar is accepted only
    // after the token handshake has completed.
    if (!m_authenticated) {
        socket->disconnectFromHost();
        return;
    }

    if (type == QStringLiteral("event")) {
        if (m_eventHandler) {
            m_eventHandler(frame.value(QStringLiteral("name")).toString(), frame.value(QStringLiteral("payload")));
        }
        return;
    }
    if (type != QStringLiteral("request")) return;

    const QString id = frame.value(QStringLiteral("id")).toString();
    const QString method = frame.value(QStringLiteral("method")).toString();
    const auto iterator = m_handlers.constFind(method);
    if (iterator == m_handlers.constEnd()) {
        sendResponse(socket, id, false, QJsonValue(QJsonValue::Undefined), QStringLiteral("Unknown native host method: %1").arg(method));
        return;
    }
    const QJsonValue rawParams = frame.value(QStringLiteral("params"));
    const QJsonObject params = rawParams.isObject() ? rawParams.toObject() : QJsonObject{};
    try {
        sendResponse(socket, id, true, iterator.value()(params));
    } catch (...) {
        sendResponse(socket, id, false, QJsonValue(QJsonValue::Undefined), QStringLiteral("Native host handler failed"));
    }
}

void HostRpcServer::writeFrame(QTcpSocket *socket, const QJsonObject &frame)
{
    const QByteArray payload = QJsonDocument(frame).toJson(QJsonDocument::Compact);
    if (payload.size() > qsizetype(kMaxFrameBytes)) {
        socket->disconnectFromHost();
        return;
    }
    QByteArray packet;
    packet.resize(4);
    const quint32 length = static_cast<quint32>(payload.size());
    packet[0] = char(length & 0xff);
    packet[1] = char((length >> 8) & 0xff);
    packet[2] = char((length >> 16) & 0xff);
    packet[3] = char((length >> 24) & 0xff);
    packet.append(payload);
    socket->write(packet);
}

void HostRpcServer::sendResponse(QTcpSocket *socket, const QString &id, bool ok,
                                 const QJsonValue &result, const QString &error)
{
    QJsonObject frame;
    frame.insert(QStringLiteral("type"), QStringLiteral("response"));
    frame.insert(QStringLiteral("id"), id);
    frame.insert(QStringLiteral("ok"), ok);
    if (ok) frame.insert(QStringLiteral("result"), result);
    else frame.insert(QStringLiteral("error"), QJsonObject{{QStringLiteral("message"), error}});
    writeFrame(socket, frame);
}

bool HostRpcServer::isTokenValid(const QString &candidate) const
{
    return constantTimeEquals(candidate, m_token);
}
