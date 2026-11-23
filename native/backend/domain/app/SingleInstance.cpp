#include "app/SingleInstance.h"

#include <QCoreApplication>
#include <QDateTime>
#include <QDir>
#include <QElapsedTimer>
#include <QFile>
#include <QFileInfo>
#include <QJsonDocument>
#include <QJsonObject>
#include <QLocalServer>
#include <QLocalSocket>
#include <QThread>
#include <QUuid>

#include <optional>
#include <utility>

namespace singleinstance {
namespace {

constexpr int kConnectTimeoutMs = 300;
constexpr int kAckTimeoutMs = 300;

bool endpointReachable(const QString &endpoint, int timeoutMs = 250)
{
    QLocalSocket socket;
    socket.connectToServer(endpointName(endpoint));
    const bool reachable = socket.waitForConnected(timeoutMs);
    socket.abort();
    return reachable;
}

/** Exclusive create; a lock that already exists is never overwritten here. */
bool writeLockAtomic(const QString &lockPath, const QJsonObject &payload)
{
    QFile file(lockPath);
    if (!file.open(QIODevice::WriteOnly | QIODevice::NewOnly)) return false;
    const QByteArray data = QJsonDocument(payload).toJson(QJsonDocument::Compact);
    const bool written = file.write(data) == data.size();
    file.close();
    if (!written) {
        // A half-written lock would block the next launch with a payload that cannot be
        // parsed, so a failed write leaves no file behind.
        QFile::remove(lockPath);
        return false;
    }
    return true;
}

} // namespace

bool readEnabled(const QString &userDataDir)
{
    QFile file(QDir(userDataDir).filePath(QStringLiteral("settings.json")));
    if (!file.open(QIODevice::ReadOnly)) return true;
    QJsonParseError error;
    const QJsonDocument document = QJsonDocument::fromJson(file.readAll(), &error);
    if (error.error != QJsonParseError::NoError || !document.isObject()) return true;
    // `singleInstance` defaults to on; only an explicit `false` turns the lock off, so a
    // settings file written by an older build cannot accidentally disable it.
    return document.object().value(QStringLiteral("singleInstance")).toBool(true);
}

Guard::Guard(QString endpoint, QString lockPath, QString instanceToken)
    : m_endpoint(std::move(endpoint)), m_lockPath(std::move(lockPath)),
      m_instanceToken(std::move(instanceToken))
{
}

Guard::~Guard()
{
    dispose();
}

std::unique_ptr<Guard> Guard::claim(const QString &version, const QString &userDataDir, QString *error)
{
    // The lock directory holds this version's metadata; it must exist before the claim.
    QDir().mkpath(locksDirectory(userDataDir));
    bool secondary = false;
    std::unique_ptr<Claim> claim = Claim::acquire(version, userDataDir, &secondary, error);
    if (!claim) {
        // `secondary` is the normal "another launch is already running" answer; only a
        // non-empty error stops this process.
        Q_UNUSED(secondary);
        return nullptr;
    }

    const QString endpoint = endpointFor(userDataDir, version);
    const QString lockPath = lockPathFor(userDataDir, version);
#ifndef Q_OS_WIN
    // A socket file left by a crashed process would block a legitimate primary; the claim
    // we just took proves nobody is serving it.
    if (QFileInfo::exists(endpoint)) QFile::remove(endpoint);
#endif
    auto server = std::make_unique<QLocalServer>();
    if (!server->listen(endpointName(endpoint))) {
        if (endpointReachable(endpoint)) {
            // Another sidecar kind (Node) owns a pipe this backend cannot create. Treat it
            // as the primary instead of starting a second writer over the same catalogs.
            claim.reset();
            return nullptr;
        }
        if (error) *error = server->errorString();
        return nullptr;
    }
    server->setSocketOptions(QLocalServer::UserAccessOption);

    const QString instanceToken = QUuid::createUuid().toString(QUuid::WithoutBraces);
    const QJsonObject lockPayload{
        {QStringLiteral("pid"), double(QCoreApplication::applicationPid())},
        {QStringLiteral("version"), version},
        {QStringLiteral("at"), double(QDateTime::currentMSecsSinceEpoch())},
        {QStringLiteral("instanceToken"), instanceToken},
        {QStringLiteral("endpoint"), endpoint},
    };
    if (!writeLockAtomic(lockPath, lockPayload)) {
        // The claim proves no other live instance exists, so a lock file here is stale
        // metadata left by a crashed process.
        QFile::remove(lockPath);
        if (!writeLockAtomic(lockPath, lockPayload)) {
            server->close();
            if (error) *error = QStringLiteral("Unable to write the single-instance lock");
            return nullptr;
        }
    }

    std::unique_ptr<Guard> guard(new Guard(endpoint, lockPath, instanceToken));
    guard->m_claim = std::move(claim);
    guard->m_server = server.release();
    guard->m_server->setParent(guard.get());

    QLocalServer *listening = guard->m_server;
    QObject::connect(listening, &QLocalServer::newConnection, guard.get(), [guard = guard.get(), listening] {
        while (listening->hasPendingConnections()) {
            QLocalSocket *socket = listening->nextPendingConnection();
            if (!socket) continue;
            guard->m_connections.insert(socket, Connection{});
            QObject::connect(socket, &QLocalSocket::readyRead, guard, [guard, socket] {
                Guard::readAvailable(guard, socket);
            });
            QObject::connect(socket, &QLocalSocket::disconnected, guard, [guard, socket] {
                // An older sender may close right after writing its JSON without the
                // delimiter; accept that buffered payload exactly once.
                Guard::finishConnection(guard, socket);
            });
            QObject::connect(socket, &QLocalSocket::disconnected, socket, &QObject::deleteLater);
            // A broken peer is a normal condition on a local endpoint; never crash.
            QObject::connect(socket, &QLocalSocket::errorOccurred, socket, [](QLocalSocket::LocalSocketError) {});
        }
    });
    return guard;
}

void Guard::setOnFocusRequest(std::function<void(const appfocus::Payload &)> handler)
{
    m_onFocusRequest = std::move(handler);
}

void Guard::dispose()
{
    if (m_disposed) return;
    m_disposed = true;
    for (auto iterator = m_connections.begin(); iterator != m_connections.end(); ++iterator) {
        QLocalSocket *socket = iterator.key();
        socket->disconnect(this);
        socket->abort();
        socket->deleteLater();
    }
    m_connections.clear();
    if (m_server) {
        m_server->close();
        // QLocalServer removes the Unix socket file on close, but the endpoint is also
        // removed explicitly so a crash-during-close cannot leave a blocking path behind.
#ifndef Q_OS_WIN
        QFile::remove(m_endpoint);
#endif
        m_server = nullptr;
    }
    if (!m_lockPath.isEmpty()) {
        QFile lockFile(m_lockPath);
        if (lockFile.open(QIODevice::ReadOnly)) {
            const QJsonDocument document = QJsonDocument::fromJson(lockFile.readAll());
            const QString token = document.isObject()
                ? document.object().value(QStringLiteral("instanceToken")).toString()
                : QString();
            lockFile.close();
            // Only this instance's lock may be removed: a restarted primary may already own
            // the same path, and deleting its lock would let a third launch become primary.
            if (token == m_instanceToken) QFile::remove(m_lockPath);
        }
    }
    // Release the OS claim last: once it is gone another process may become primary.
    m_claim.reset();
}

void Guard::readAvailable(Guard *self, QLocalSocket *socket)
{
    auto iterator = self->m_connections.find(socket);
    if (iterator == self->m_connections.end()) return;
    Connection &connection = *iterator;
    if (connection.handled || connection.rejected) return;
    connection.buffer += socket->readAll();
    if (connection.buffer.size() > appfocus::kMaxPayloadBytes) {
        connection.rejected = true;
        socket->abort();
        return;
    }
    const int delimiter = int(connection.buffer.indexOf('\n'));
    if (delimiter < 0) return;
    Guard::settle(self, socket, connection, connection.buffer.left(delimiter));
}

void Guard::finishConnection(Guard *self, QLocalSocket *socket)
{
    auto iterator = self->m_connections.find(socket);
    if (iterator == self->m_connections.end()) return;
    Connection connection = *iterator;
    self->m_connections.erase(iterator);
    if (connection.handled || connection.rejected || connection.buffer.isEmpty()) return;
    Guard::settle(self, socket, connection, connection.buffer);
}

void Guard::settle(Guard *self, QLocalSocket *socket, Connection &connection, const QByteArray &raw)
{
    const std::optional<appfocus::Payload> payload = appfocus::parseFocusPayload(raw);
    if (!payload) {
        connection.rejected = true;
        socket->abort();
        return;
    }
    connection.handled = true;
    if (self->m_onFocusRequest) self->m_onFocusRequest(*payload);
    // The ACK is what makes the secondary's exit meaningful: the primary has consumed
    // the payload, not merely accepted a local write.
    socket->write("focus-ack");
    socket->flush();
    socket->disconnectFromServer();
}

bool forwardFocusRequest(const QString &endpoint, const appfocus::Payload &payload, int attempts)
{
    const QByteArray raw = appfocus::encodeFocusPayload(payload);
    // `+1` is the delimiter; an oversized payload is refused instead of truncated.
    if (raw.size() + 1 > appfocus::kMaxPayloadBytes) return false;
    for (int attempt = 0; attempt < attempts; ++attempt) {
        QLocalSocket socket;
        bool delivered = false;
        socket.connectToServer(endpointName(endpoint));
        if (socket.waitForConnected(kConnectTimeoutMs)) {
            socket.write(raw + '\n');
            socket.flush();
            QByteArray acknowledgement;
            QElapsedTimer elapsed;
            elapsed.start();
            while (elapsed.elapsed() < kAckTimeoutMs) {
                const int remaining = int(qMax<qint64>(1, kAckTimeoutMs - elapsed.elapsed()));
                if (!socket.waitForReadyRead(remaining)) {
                    if (socket.state() != QLocalSocket::ConnectedState) break;
                    continue;
                }
                acknowledgement += socket.readAll();
                if (acknowledgement.contains("focus-ack")) {
                    delivered = true;
                    break;
                }
            }
        }
        socket.abort();
        if (delivered) return true;
        if (attempt + 1 < attempts) QThread::msleep(ulong(50 * (attempt + 1)));
    }
    return false;
}

} // namespace singleinstance
