#pragma once

#include "ChannelContext.h"
#include "HttpRequest.h"
#include "WebDispatch.h"
#include "WebStreamRuntime.h"

#include <QByteArray>
#include <QHash>
#include <QJsonObject>
#include <QObject>
#include <QTcpServer>
#include <QTcpSocket>
#include <QTimer>

#include <functional>

class ChannelRegistry;
namespace webstream {
class Service;
}
namespace webdevproxy {
class Proxy;
}

/**
 * LAN web service: the browser-facing HTTP surface.
 *
 * This is the third protocol in the project (desktop loopback HTTP+SSE, host TCP, LAN
 * web) and it exists for phones/tablets on the same network. It therefore shares the
 * request path with the desktop where it matters:
 *  - auth is the cookie/bearer/query-token ladder from `webServiceAuth.ts`;
 *  - every business route invokes the same channel the desktop renderer invokes;
 *  - responses never carry internal diagnostics (`serializePublicWebPayload`).
 *
 * The service is off unless the user enables it; binding, the token and the port are
 * owned by `Manager`, never by this class.
 */
class LanWebService : public QObject {

public:
    struct Options {
        QString rendererRoot;
        /**
         * Dev renderer base URL (`PIDECK_DEV_RENDERER_URL`), empty when the bundle is served.
         *
         * This is the port of the oracle's `deps.devRendererUrl` (Electron's
         * `ELECTRON_RENDERER_URL`): with a dev server running there is no built `web.html`,
         * so every asset request must be proxied for the LAN page to load the real client.
         * Only loopback targets are accepted (see webdevproxy::parseTarget).
         */
        QString devRendererUrl;
        /** API bodies are small; a bundle asset is streamed from disk, not buffered here. */
        qint64 maxBodyBytes = 8LL * 1024LL * 1024LL;
        int requestTimeoutMs = 30'000;
    };

    using LogSink = std::function<void(const QString &level, const QString &message,
                                       const QJsonObject &detail)>;

    LanWebService(ChannelRegistry *registry, ChannelServices *services, Options options,
                  QObject *parent = nullptr);

    /**
     * Bind and start listening.
     *
     * Returns false when the host cannot be resolved or the port is taken; the caller
     * (`settings:update`) turns that into `webService.startFailed` and disables the
     * service, exactly like the oracle.
     */
    bool start(const QString &host, int port, const QString &accessToken);
    void stop();
    bool running() const { return m_server.isListening(); }
    QString boundHost() const { return m_host; }
    int boundPort() const { return m_port; }

    /** Hot token swap for the "only the token changed" case; no rebind. */
    void setAccessToken(const QString &token) { m_accessToken = token; }

    void setLogSink(LogSink sink) { m_logSink = std::move(sink); }

private:
    struct Connection {
        explicit Connection(qint64 maxBodyBytes) : parser(maxBodyBytes) {}
        HttpRequestParser parser;
        QTimer *timeout = nullptr;
        /** One request per connection: every response carries `connection: close`. */
        bool dispatched = false;
    };

    void acceptConnections();
    void readFromSocket(QTcpSocket *socket);
    void handleRequest(QTcpSocket *socket, const HttpRequest &request);
    void serveAsset(QTcpSocket *socket, const HttpRequest &request);
    /** `GET /api/sessions/:id/stream`: observe an already running session. */
    void serveSessionStream(const QString &sessionId, QTcpSocket *socket);
    /** `POST /api/chat`: open the stream first, then dispatch the prompt. */
    void serveChat(QTcpSocket *socket, const HttpRequest &request);
    /**
     * Hand one socket to the stream owner.
     *
     * The request table drops its entry (and the request timeout) because an SSE
     * response outlives any request deadline; the socket's parent moves to the stream.
     *
     * `pipelined` receives the bytes the parser had already read past the request (a
     * WebSocket client may have done so); they must be forwarded, not dropped, so they
     * are taken before the parser is destroyed with the connection entry.
     */
    QTcpSocket *detachForStream(QTcpSocket *socket, QByteArray *pipelined = nullptr);
    void replyJson(QTcpSocket *socket, int status, const QJsonValue &body);
    void log(const QString &level, const QString &message, const QJsonObject &detail = QJsonObject{});

    ChannelRegistry *m_registry = nullptr;
    ChannelServices *m_services = nullptr;
    Options m_options;
    QTcpServer m_server;
    QHash<QTcpSocket *, Connection> m_connections;
    QString m_host;
    int m_port = 0;
    QString m_accessToken;
    LogSink m_logSink;
    /** LAN AI SDK stream (pi events → UIMessageStream frames). */
    webstream::Service *m_streams = nullptr;
    /** Dev renderer relay; null unless a valid loopback dev URL was configured. */
    webdevproxy::Proxy *m_devProxy = nullptr;
    /** Startup log detail: the enabled dev origin, or why the configured URL was refused. */
    QString m_devProxyOrigin;
    QString m_devProxyError;
};
