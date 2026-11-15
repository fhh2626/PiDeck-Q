#pragma once

#include "WebDevProxyPlan.h"

#include <QList>
#include <QObject>
#include <QSet>
#include <QString>

#include <functional>

class QTcpSocket;

namespace webdevproxy {

/** Structured log sink, shared with the service's logger. */
using LogSink = std::function<void(const QString &level, const QString &message,
                                   const QJsonObject &detail)>;

/**
 * Internal handle on one in-flight exchange.
 *
 * Declared here only so `Proxy` can drive a typed list without RTTI casts; the sole
 * implementation lives in WebDevProxy.cpp and nothing outside this module creates one.
 */
class RelayNode : public QObject {
public:
    using QObject::QObject;
    /**
     * Virtual on purpose: exchanges are destroyed through `deleteLater()` and through
     * parent teardown, both of which delete the object as a `QObject*`. A non-virtual
     * destructor would skip `~Relay` (its sockets, timer and buffers would leak).
     */
    ~RelayNode() override = default;
    virtual void setLogSink(LogSink sink) = 0;
    /** Connect the upstream socket and start the exchange (ownership already taken). */
    virtual void start() = 0;
    /** Close both sockets immediately (service stop); the node deletes itself later. */
    virtual void forceClose() = 0;
};

/**
 * Loopback relay to the Vite dev server: static assets over HTTP and the HMR socket.
 *
 * Dev only. `LanWebService` creates one when `PIDECK_DEV_RENDERER_URL` points at a
 * loopback dev server; without it the bundle (or the embedded page) is served as before.
 *
 * Ownership and cleanup: both sockets of an exchange are children of its relay, and the
 * relay is a child of this proxy. `abortAll()` — called from `LanWebService::stop()` —
 * therefore closes every in-flight exchange, and a relay is destroyed as soon as either
 * side closes (the pairing the oracle gets from `socket.once("close", …)`). Without that,
 * an open HMR socket would outlive the listener exactly like Node's `upgradedSockets`
 * set documents.
 */
class Proxy : public QObject {
public:
    struct Options {
        Target target;
        /** Deadline for connect + the upstream response head; the body may stream longer. */
        int headTimeoutMs = 30'000;
        /** Browser-bound write queue that pauses upstream reads (backpressure). */
        qint64 highWaterBytes = 256 * 1024;
    };

    /**
     * Reply writers owned by the service, so the proxy never grows a second serializer
     * or a second copy of the localized error copy.
     */
    struct Writers {
        /** `{code, error}` JSON reply, exactly like `sendError`. */
        std::function<void(QTcpSocket *, int status, const QString &code, const QString &message)> failure;
        /** The embedded legacy page with `no-store` (document fallback). */
        std::function<void(QTcpSocket *)> legacyPage;
    };

    using LogSink = webdevproxy::LogSink;

    Proxy(Options options, Writers writers, QObject *parent = nullptr);

    /** Relay one asset request; takes ownership of `socket`. */
    void forwardHttp(const HttpRequest &request, QTcpSocket *socket);
    /**
     * Relay a WebSocket upgrade; takes ownership of `socket`.
     *
     * `head` are the bytes the request parser had already read beyond the handshake (the
     * browser must not send frames before `101`, but forwarding them is what Node's
     * `upgrade` handler does with its `head` buffer).
     */
    void forwardWebSocket(const HttpRequest &request, QTcpSocket *socket, const QByteArray &head);

    /** Close every in-flight exchange (service stop / restart). */
    void abortAll();
    int activeRelays() const;

    void setLogSink(LogSink sink) { m_logSink = std::move(sink); }

private:
    void attach(RelayNode *relay);

    Options m_options;
    Writers m_writers;
    LogSink m_logSink;
    /**
     * Live exchanges, keyed by raw pointer.
     *
     * A finished relay deletes itself through the event loop, so `attach` drops it from
     * this set from its `destroyed` signal: tracking with `QPointer` left dead entries
     * behind (the list grew for the lifetime of the service) and destroying such a stale
     * entry hung `abortAll()` during backend shutdown.
     */
    QSet<RelayNode *> m_relays;
};

} // namespace webdevproxy
