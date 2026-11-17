#pragma once

#include "HostFrames.h"

#include <QHash>
#include <QJsonObject>
#include <QJsonValue>
#include <QObject>
#include <QPointer>
#include <QTcpSocket>
#include <QTimer>

#include <functional>
#include <memory>

/**
 * One outstanding host request.
 *
 * The backend must never block the Qt event loop waiting for the host (a modal
 * dialog can take minutes), so every host capability is asynchronous: the caller
 * attaches continuations and keeps running. Exactly one of resolve/reject fires.
 */
class HostRequest : public QObject {

public:
    using Resolve = std::function<void(const QJsonValue &)>;
    using Reject = std::function<void(const QString &)>;

    explicit HostRequest(QString method, QObject *parent = nullptr);

    HostRequest &then(Resolve callback);
    HostRequest &fail(Reject callback);
    bool isSettled() const { return m_settled; }
    const QString &method() const { return m_method; }

private:
    friend class HostRpcClient;
    void resolve(const QJsonValue &value);
    void reject(const QString &error);

    QString m_method;
    Resolve m_resolve;
    Reject m_reject;
    bool m_settled = false;
};

/**
 * Length-prefixed JSON client for the Qt host bridge.
 *
 * Contract (mirrors src/native-node/host/HostBridge.ts):
 *  - the token handshake completes before any request/event is allowed;
 *  - requests are correlated by a unique id and may complete out of order;
 *  - every inbound event name is dispatched to its registered listeners;
 *  - losing an authenticated connection is fatal for the backend, because the
 *    host owns window/tray/quit and nothing can be delivered afterwards.
 */
class HostRpcClient : public QObject {
public:
    /** A sent mutation cannot be cancelled by a local timer; its owner may await the actual reply. */
    enum class TimeoutPolicy { Deadline, AwaitHostCompletion };

    explicit HostRpcClient(QString token, QObject *parent = nullptr);

    /** Connect and complete the hello handshake. Returns false on failure. */
    bool connectToHost(quint16 port, int timeoutMs = host::kHelloTimeoutMs);
    bool isAuthenticated() const { return m_authenticated; }
    bool isClosed() const { return m_closed; }

    std::shared_ptr<HostRequest> request(const QString &method, const QJsonObject &params = {},
                                         int timeoutMs = host::kDefaultRequestTimeoutMs,
                                         TimeoutPolicy timeoutPolicy = TimeoutPolicy::Deadline);
    void emitEvent(const QString &name, const QJsonValue &payload = QJsonValue(QJsonValue::Null));
    void onEvent(const QString &name, std::function<void(const QJsonValue &)> handler);
    void onFatal(std::function<void(const QString &)> handler);

    /** Close immediately (used on unrecoverable errors). */
    void close();
    /** Flush queued frames, then close. Bounded so shutdown cannot hang. */
    void closeGracefully(int drainTimeoutMs = 250);

private:
    void handleReadyRead();
    void handleFrame(const QJsonObject &frame);
    void handleDisconnected(const QString &reason);
    void send(const QJsonObject &frame);
    void rejectAll(const QString &reason);

    QString m_token;
    QTcpSocket m_socket;
    host::FrameDecoder m_decoder;
    QHash<QString, std::shared_ptr<HostRequest>> m_pending;
    QHash<QString, std::function<void(const QJsonValue &)>> m_listeners;
    QList<std::function<void(const QString &)>> m_fatalListeners;
    bool m_authenticated = false;
    bool m_closed = false;
    bool m_intentionalClose = false;
    QString m_fatalError;
};
