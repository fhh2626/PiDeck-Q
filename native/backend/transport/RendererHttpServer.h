#pragma once

#include "EventHub.h"
#include "HttpRequest.h"
#include "HttpResponse.h"

#include <QByteArray>
#include <QHash>
#include <QJsonObject>
#include <QJsonValue>
#include <QObject>
#include <QPointer>
#include <QSet>
#include <QTcpServer>
#include <QTcpSocket>
#include <QTimer>

#include <functional>

class ChannelRegistry;

/** Bootstrap snapshot returned by GET /__pideck/bootstrap. */
struct RendererBootstrap {
    QJsonObject clipboard;
    double zoomFactor = 1.0;
    bool memoryProfileEnabled = false;
};

/**
 * Loopback HTTP/SSE server used only by the native React surface.
 *
 * Endpoint contract is fixed by src/native-node/transport/NativeRendererServer.ts:
 *   POST /__pideck/rpc, GET /__pideck/bootstrap, GET /__pideck/events,
 *   POST /__pideck/heartbeat, POST /__pideck/diagnostics/memory,
 *   GET /__pideck/background/<name>, plus the renderer bundle with SPA fallback.
 */
class RendererHttpServer : public QObject {

public:
    using BootstrapProvider = std::function<void(std::function<void(const RendererBootstrap &)>)>;
    using EventChannelDiagnostic = std::function<void(const QString &kind, const QJsonObject &detail)>;

    struct Options {
        QString token;
        QString rendererRoot;
        QString backgroundDirectory;
        qint64 maxBodyBytes = 32LL * 1024LL * 1024LL;
        /** Per-connection deadline for receiving a complete request head. */
        int requestTimeoutMs = 30'000;
        qint64 maxPendingEventBytes = 64LL * 1024LL * 1024LL;
        int heartbeatIntervalMs = 15'000;
    };

    RendererHttpServer(ChannelRegistry *registry, EventHub *events, Options options, QObject *parent = nullptr);

    bool start();
    quint16 port() const;
    QString url() const;
    void stop();

    void setBootstrapProvider(BootstrapProvider provider) { m_bootstrapProvider = std::move(provider); }
    void setHeartbeatObserver(std::function<void(const QJsonObject &payload, const EventHub::HeartbeatState &)> observer)
    {
        m_heartbeatObserver = std::move(observer);
    }
    void setMemoryDiagnosticsSink(std::function<void(const QJsonValue &)> sink)
    {
        m_memoryDiagnosticsSink = std::move(sink);
    }
    void setReplayGapHandler(std::function<void(const QString &reason, qint64 lostSinceMs, bool hasLostSince)> handler)
    {
        m_replayGapHandler = std::move(handler);
    }
    void setEventChannelDiagnostic(EventChannelDiagnostic sink) { m_eventChannelDiagnostic = std::move(sink); }
    void setServerErrorHandler(std::function<void(const QString &)> handler) { m_serverErrorHandler = std::move(handler); }

private:
    struct Connection {
        explicit Connection(qint64 maxBodyBytes) : parser(maxBodyBytes) {}
        HttpRequestParser parser;
        QTimer *timeout = nullptr;
        bool sse = false;
        /**
         * One request per connection.
         *
         * Every response carries `connection: close`, so a second request on the same
         * socket is never served. The flag makes that explicit instead of relying on the
         * socket state, and it is what stops a pipelined body from being re-dispatched.
         */
        bool dispatched = false;
    };

    void acceptConnections();
    void readFromSocket(QTcpSocket *socket);
    void reportPipelinedBytes(qsizetype bytes);
    void handleRequest(QTcpSocket *socket, const HttpRequest &request);
    void handleRpc(QTcpSocket *socket, const HttpRequest &request);
    void handleBootstrap(QTcpSocket *socket);
    void handleEvents(QTcpSocket *socket, const HttpRequest &request);
    void handleHeartbeat(QTcpSocket *socket, const HttpRequest &request);
    void handleBackground(QTcpSocket *socket, const HttpRequest &request);
    void serveStatic(QTcpSocket *socket, const HttpRequest &request);

    bool isAuthorized(const HttpRequest &request) const;
    void deliverEventFrame(quint64 seq, const QByteArray &frame, qint64 bytes);
    void dropSseClient(QTcpSocket *socket, const QString &reason, qint64 pendingBytes, qint64 frameBytes);

    ChannelRegistry *m_registry = nullptr;
    EventHub *m_events = nullptr;
    Options m_options;
    QTcpServer m_server;
    QHash<QTcpSocket *, Connection> m_connections;
    QSet<QTcpSocket *> m_sseClients;
    QTimer m_heartbeatTimer;
    BootstrapProvider m_bootstrapProvider;
    std::function<void(const QJsonObject &, const EventHub::HeartbeatState &)> m_heartbeatObserver;
    std::function<void(const QJsonValue &)> m_memoryDiagnosticsSink;
    std::function<void(const QString &, qint64, bool)> m_replayGapHandler;
    EventChannelDiagnostic m_eventChannelDiagnostic;
    std::function<void(const QString &)> m_serverErrorHandler;
};
