#include "WebService.h"

#include "HttpResponse.h"
#include "MimeTypes.h"
#include "WebAssets.h"
#include "WebAuth.h"
#include "WebCopy.h"
#include "WebDevProxy.h"
#include "WebLegacyPage.h"
#include "WebRoutes.h"
#include "WebStreamService.h"

#include <QHostAddress>

#include <QHostInfo>
#include <QJsonDocument>
#include <QPointer>
#include <QUuid>

namespace {

int statusForParseFailure(HttpRequestParser::Status status)
{
    switch (status) {
    case HttpRequestParser::Status::HeaderTooLarge: return 431;
    case HttpRequestParser::Status::PayloadTooLarge: return 413;
    case HttpRequestParser::Status::LengthRequired: return 411;
    case HttpRequestParser::Status::VersionNotSupported: return 505;
    case HttpRequestParser::Status::MethodNotAllowed: return 405;
    default: return 400;
    }
}

/** Raw (still-encoded) path of the request target, without the query. */
QByteArray rawPathOf(const HttpRequest &request)
{
    const int queryStart = request.target.indexOf('?');
    return queryStart < 0 ? request.target : request.target.left(queryStart);
}

} // namespace

LanWebService::LanWebService(ChannelRegistry *registry, ChannelServices *services, Options options,
                             QObject *parent)
    : QObject(parent), m_registry(registry), m_services(services), m_options(std::move(options))
{
    connect(&m_server, &QTcpServer::newConnection, this, [this] { acceptConnections(); });
    // The stream owner is created once and reused across restarts; it subscribes to pi
    // only while the listener runs (see start/stop) so a disabled service costs nothing.
    webstream::Service::Deps deps;
    deps.coordinator = m_services ? m_services->runtimeCoordinator : nullptr;
    deps.log = [this](const QString &level, const QString &message, const QJsonObject &detail) {
        log(level, message, detail);
    };
    m_streams = new webstream::Service(std::move(deps), this);
    // Dev renderer relay. Built once: the target comes from the process environment and
    // never changes at runtime, so a stop/start cycle only has to drop its sockets.
    if (!m_options.devRendererUrl.trimmed().isEmpty()) {
        webdevproxy::Target target;
        QString error;
        if (webdevproxy::parseTarget(m_options.devRendererUrl, &target, &error)) {
            webdevproxy::Proxy::Options proxyOptions;
            proxyOptions.target = target;
            // The head deadline reuses the request timeout: a dev server that accepts a
            // connection and then stalls is the same slowloris-shaped problem.
            proxyOptions.headTimeoutMs = m_options.requestTimeoutMs;
            webdevproxy::Proxy::Writers writers;
            writers.failure = [this](QTcpSocket *socket, int status, const QString &code,
                                     const QString &message) {
                replyJson(socket, status,
                          webdispatch::errorBody(status, code, message));
            };
            writers.legacyPage = [](QTcpSocket *socket) {
                httpresponse::sendBytes(socket, 200, QByteArrayLiteral("text/html; charset=utf-8"),
                                        weblegacy::page(),
                                        QByteArrayLiteral("cache-control: no-store\r\n"));
            };
            m_devProxy = new webdevproxy::Proxy(proxyOptions, std::move(writers), this);
            m_devProxy->setLogSink([this](const QString &level, const QString &message,
                                          const QJsonObject &detail) {
                log(level, message, detail);
            });
            m_devProxyOrigin = target.origin;
        } else {
            // A bad dev setting must not disable the LAN service: log it and keep serving
            // the bundle (or the embedded page) exactly as a production build would.
            m_devProxyError = error;
        }
    }
}

bool LanWebService::start(const QString &host, int port, const QString &accessToken)
{
    if (m_server.isListening()) return true;
    if (!m_registry || !m_services) return false;

    QHostAddress address;
    if (!address.setAddress(host)) {
        // Node's `server.listen(port, host)` resolves DNS. Settings accept a name, so the
        // same resolution happens here; a literal address takes the fast path above.
        if (host.compare(QLatin1String("localhost"), Qt::CaseInsensitive) == 0) {
            address = QHostAddress(QHostAddress::LocalHost);
        } else {
            const QHostInfo info = QHostInfo::fromName(host);
            if (info.addresses().isEmpty()) {
                log(QStringLiteral("warn"), QStringLiteral("Web service host could not be resolved"),
                    QJsonObject{{QStringLiteral("host"), host}});
                return false;
            }
            address = info.addresses().first();
        }
    }
    if (!m_server.listen(address, quint16(port))) {
        log(QStringLiteral("warn"), QStringLiteral("Web service failed to listen"),
            QJsonObject{{QStringLiteral("host"), host},
                        {QStringLiteral("port"), port},
                        {QStringLiteral("error"), m_server.errorString()}});
        m_server.close();
        return false;
    }
    m_host = host;
    // A real port was requested (0 is rejected by the settings validator), so the bound
    // port is authoritative for the cookie name and the health payload.
    m_port = m_server.serverPort();
    m_accessToken = accessToken;
    if (m_streams) m_streams->start();
    if (m_devProxy) {
        log(QStringLiteral("info"), QStringLiteral("Dev renderer proxy enabled"),
            QJsonObject{{QStringLiteral("origin"), m_devProxyOrigin}});
    } else if (!m_devProxyError.isEmpty()) {
        log(QStringLiteral("warn"), QStringLiteral("Dev renderer proxy disabled"),
            QJsonObject{{QStringLiteral("error"), m_devProxyError}});
    }
    log(QStringLiteral("info"), QStringLiteral("Web service started"),
        QJsonObject{{QStringLiteral("host"), m_host}, {QStringLiteral("port"), m_port}});
    return true;
}

void LanWebService::stop()
{
    if (m_server.isListening()) {
        log(QStringLiteral("info"), QStringLiteral("Web service stopping"),
            QJsonObject{{QStringLiteral("host"), m_host}, {QStringLiteral("port"), m_port}});
    }
    // Unbind pi first: a stopped service must never forward an event into a socket that
    // is being torn down, and the streams own sockets that are not in m_connections.
    if (m_streams) m_streams->stop();
    // Dev proxy sockets are the same kind of leak: an upgraded HMR connection and a
    // half-relayed asset are not in m_connections, so they must be closed explicitly or
    // they would outlive the listener (the oracle's `upgradedSockets` set).
    if (m_devProxy) m_devProxy->abortAll();
    // Detach before aborting: `disconnected` runs synchronously from `abort()` and erases
    // the entry from m_connections, so iterating the live container would invalidate it.
    QHash<QTcpSocket *, Connection> connections = std::move(m_connections);
    m_connections.clear();
    for (auto iterator = connections.begin(); iterator != connections.end(); ++iterator) {
        if (iterator->timeout) {
            iterator->timeout->stop();
            iterator->timeout->deleteLater();
        }
        iterator.key()->abort();
    }
    m_server.close();
    m_host.clear();
    m_port = 0;
    m_accessToken.clear();
}

void LanWebService::log(const QString &level, const QString &message, const QJsonObject &detail)
{
    if (m_logSink) m_logSink(level, message, detail);
}

void LanWebService::acceptConnections()
{
    while (m_server.hasPendingConnections()) {
        QTcpSocket *socket = m_server.nextPendingConnection();
        if (!socket) return;
        socket->setParent(this);
        Connection connection(m_options.maxBodyBytes);
        connection.timeout = new QTimer(this);
        connection.timeout->setSingleShot(true);
        connection.timeout->setInterval(m_options.requestTimeoutMs);
        connect(connection.timeout, &QTimer::timeout, this, [this, socket] {
            // Slowloris guard: a LAN client that never completes a request head must not
            // hold a connection slot forever.
            const auto iterator = m_connections.find(socket);
            if (iterator == m_connections.end()) return;
            socket->abort();
        });
        m_connections.insert(socket, connection);
        connection.timeout->start();
        connect(socket, &QTcpSocket::readyRead, this, [this, socket] { readFromSocket(socket); });
        connect(socket, &QTcpSocket::disconnected, this, [this, socket] {
            const auto iterator = m_connections.find(socket);
            if (iterator != m_connections.end()) {
                if (iterator->timeout) iterator->timeout->deleteLater();
                m_connections.erase(iterator);
            }
            socket->deleteLater();
        });
    }
}

void LanWebService::readFromSocket(QTcpSocket *socket)
{
    const auto iterator = m_connections.find(socket);
    if (iterator == m_connections.end()) {
        socket->readAll();
        return;
    }
    Connection &connection = *iterator;
    const QByteArray chunk = socket->readAll();
    if (connection.dispatched) return;
    const HttpRequestParser::Status status = connection.parser.feed(chunk);
    if (status == HttpRequestParser::Status::NeedMore) return;
    if (status != HttpRequestParser::Status::Complete) {
        connection.dispatched = true;
        if (connection.timeout) connection.timeout->stop();
        // Node answers a client parse error with a bare 400 line; keep the JSON error body
        // so a browser client sees a structured failure instead of an empty reply.
        replyJson(socket, statusForParseFailure(status),
                  webdispatch::errorBody(statusForParseFailure(status),
                                         QStringLiteral("webError.internal"),
                                         connection.parser.error()));
        return;
    }
    if (connection.timeout) connection.timeout->stop();
    connection.dispatched = true;
    handleRequest(socket, connection.parser.request());
}

void LanWebService::replyJson(QTcpSocket *socket, int status, const QJsonValue &body)
{
    const QJsonValue sanitized = webcopy::serializePublic(body);
    QByteArray json;
    if (sanitized.isArray()) {
        json = QJsonDocument(sanitized.toArray()).toJson(QJsonDocument::Compact);
    } else if (sanitized.isObject()) {
        json = QJsonDocument(sanitized.toObject()).toJson(QJsonDocument::Compact);
    } else {
        json = QByteArrayLiteral("null");
    }
    httpresponse::sendBytes(socket, status, QByteArrayLiteral("application/json; charset=utf-8"),
                            json, QByteArrayLiteral("cache-control: no-store\r\n"));
}

void LanWebService::handleRequest(QTcpSocket *socket, const HttpRequest &requestIn)
{
    // Work on a copy: a streaming endpoint hands the socket (and the request parser that
    // owns this object) to the stream owner, which would otherwise free `request` while
    // the handler still reads it.
    const HttpRequest request = requestIn;
    const QByteArray rawPath = rawPathOf(request);
    webauth::RequestView view;
    view.method = request.method;
    view.rawPath = rawPath;
    view.query = request.query;
    view.host = request.header("host");
    view.origin = request.header("origin");
    view.authorization = request.header("authorization");
    view.cookie = request.header("cookie");

    const int port = m_port;
    const webauth::Decision decision = webauth::authorize(view, port, m_accessToken);
    switch (decision.kind) {
    case webauth::Kind::ForbiddenOrigin:
        return replyJson(socket, 403,
                         webdispatch::errorBody(403, QStringLiteral("webError.forbiddenOrigin"),
                                                webcopy::errorEn(QStringLiteral("webError.forbiddenOrigin"))));
    case webauth::Kind::Unauthorized: {
        if (rawPath.startsWith(QByteArrayLiteral("/api/"))) {
            return replyJson(socket, 401,
                             webdispatch::errorBody(401, QStringLiteral("webError.unauthorized"),
                                                    webcopy::errorEn(QStringLiteral("webError.unauthorized"))));
        }
        // A browser opening the LAN URL without a token gets a page, not JSON: it is the
        // entry point the user pasted into a phone, so it has to explain what to do.
        httpresponse::sendBytes(socket, 401, QByteArrayLiteral("text/html; charset=utf-8"),
                                webcopy::unauthorizedPageHtml(),
                                QByteArrayLiteral("cache-control: no-store\r\n"));
        return;
    }
    case webauth::Kind::Exchange: {
        QByteArray headers = "location: " + decision.location.toUtf8() + "\r\n";
        headers += "set-cookie: " + decision.setCookie.toUtf8() + "\r\n";
        headers += "cache-control: no-store\r\n";
        return httpresponse::sendEmpty(socket, 302, headers);
    }
    case webauth::Kind::Public:
    case webauth::Kind::Authorized:
        break;
    }

    if (request.method == "OPTIONS") return httpresponse::sendEmpty(socket, 204, QByteArrayLiteral("cache-control: no-store\r\n"));

    // Vite's HMR socket. Handled before the route table because no business route answers
    // an upgrade; the auth ladder above already ran, which is the whole point (`/` is a
    // page route, and an unauthenticated upgrade must not reach the dev server).
    if (m_devProxy && webdevproxy::isWebSocketUpgrade(request)) {
        QByteArray pipelined;
        QTcpSocket *upgradeSocket = detachForStream(socket, &pipelined);
        if (!upgradeSocket) return;
        return m_devProxy->forwardWebSocket(request, upgradeSocket, pipelined);
    }

    const webroute::Match match = webroute::match(request.method, rawPath);
    if (match.action == webroute::Action::Asset) return serveAsset(socket, request);
    // The two streaming endpoints must be answered at the transport layer: they keep the
    // connection open, so the one-request-one-response dispatcher cannot serve them.
    if (match.action == webroute::Action::Stream) return serveSessionStream(match.sessionId, socket);
    if (match.action == webroute::Action::Chat) return serveChat(socket, request);

    const QPointer<QTcpSocket> guarded(socket);
    webdispatch::Context context;
    context.host = m_host;
    context.port = port;
    webdispatch::handle(
        match, request, context, *m_services, *m_registry,
        [this, guarded](webdispatch::Reply reply) {
            // The socket may already be gone: the browser cancels a request it no longer
            // needs, and writing to a deleted socket would crash the backend.
            if (!guarded) return;
            // Channel rejections are logged at the transport edge (the dispatcher has no
            // logger); the browser only ever sees the generic copy.
            if (reply.status == 500) {
                log(QStringLiteral("warn"), QStringLiteral("Web request failed"));
            }
            replyJson(guarded, reply.status, reply.body);
        });
}

void LanWebService::serveSessionStream(const QString &sessionId, QTcpSocket *socket)
{
    if (!m_streams || !m_streams->available()) {
        return replyJson(socket, 501,
                         webdispatch::errorBody(501, QStringLiteral("webError.streamUnavailable"),
                                                webcopy::errorEn(
                                                    QStringLiteral("webError.streamUnavailable"))));
    }
    QTcpSocket *streamSocket = detachForStream(socket);
    if (!streamSocket) return;
    // GET only observes an execution that already exists: with nothing running the run
    // finishes immediately instead of hanging until the phone gives up.
    m_streams->open(sessionId, streamSocket, webstream::Admission::Observe, true);
}

void LanWebService::serveChat(QTcpSocket *socket, const HttpRequest &request)
{
    QJsonObject body;
    if (!webdispatch::readJsonObject(request, &body)) {
        const webdispatch::Reply reply = webdispatch::internalError();
        return replyJson(socket, reply.status, reply.body);
    }
    const QString sessionId = body.value(QStringLiteral("id")).toString().trimmed();
    if (sessionId.isEmpty()) {
        // Same code/English copy as the oracle (`webError.requestIdRequired` is reused).
        const webdispatch::Reply reply = webdispatch::badRequest(QStringLiteral("webError.requestIdRequired"));
        return replyJson(socket, reply.status, reply.body);
    }
    // `useChat` sends the whole conversation; only the last user turn is dispatched (the
    // runtime owns history, so replaying it here would duplicate every earlier message).
    QString message;
    const QJsonArray messages = body.value(QStringLiteral("messages")).toArray();
    for (int index = messages.size() - 1; index >= 0; --index) {
        const QJsonObject entry = messages.at(index).toObject();
        if (entry.value(QStringLiteral("role")).toString() != QLatin1String("user")) continue;
        QString parts;
        for (const QJsonValue &partValue : entry.value(QStringLiteral("parts")).toArray()) {
            const QJsonObject part = partValue.toObject();
            if (part.value(QStringLiteral("type")).toString() != QLatin1String("text")) continue;
            if (!part.value(QStringLiteral("text")).isString()) continue;
            parts += part.value(QStringLiteral("text")).toString();
        }
        const QJsonValue content = entry.value(QStringLiteral("content"));
        message = (parts.isEmpty() && content.isString() ? content.toString() : parts).trimmed();
        break;
    }
    if (message.isEmpty()) {
        const webdispatch::Reply reply = webdispatch::badRequest(QStringLiteral("webError.messageRequired"));
        return replyJson(socket, reply.status, reply.body);
    }
    if (!m_streams || !m_streams->available()) {
        return replyJson(socket, 501,
                         webdispatch::errorBody(501, QStringLiteral("webError.streamUnavailable"),
                                                webcopy::errorEn(
                                                    QStringLiteral("webError.streamUnavailable"))));
    }

    QTcpSocket *streamSocket = detachForStream(socket);
    if (!streamSocket) return;
    // Subscribe *before* dispatching: pi can answer the prompt before its RPC reply even
    // returns, and a later subscription would drop the opening `start` frame.
    m_streams->open(sessionId, streamSocket, webstream::Admission::Dispatch, false);

    QJsonObject input{
        {QStringLiteral("sessionId"), sessionId},
        // `useChat`'s message id is not a delivery id: the runtime caches by
        // sessionId+requestId for 10 minutes, so a reused id would swallow the second
        // send as "already delivered".
        {QStringLiteral("requestId"), QUuid::createUuid().toString(QUuid::WithoutBraces)},
        {QStringLiteral("message"), message},
    };
    const QPointer<LanWebService> self(this);
    m_registry->invoke(
        QStringLiteral("sessions:send-prompt"), QJsonArray{QJsonValue(input)},
        ChannelResponder(
            [self, sessionId](const QJsonValue &value) {
                if (!self) return;
                const QJsonObject result = value.toObject();
                if (result.value(QStringLiteral("accepted")).toBool(false)) {
                    self->m_streams->promptDispatched(sessionId, QString());
                    return;
                }
                const QString error = result.value(QStringLiteral("error")).toString();
                // A rejected prompt ends the run with an `error` frame: closing only the
                // HTTP body would leave `useChat` rendering an empty successful reply.
                self->m_streams->promptDispatched(
                    sessionId,
                    error.isEmpty() ? QStringLiteral("Prompt was rejected") : error);
            },
            [self, sessionId](const QString &error) {
                if (!self) return;
                self->m_streams->promptDispatched(
                    sessionId, error.isEmpty() ? QStringLiteral("Prompt was rejected") : error);
            }));
}

QTcpSocket *LanWebService::detachForStream(QTcpSocket *socket, QByteArray *pipelined)
{
    if (!socket) return nullptr;
    const auto iterator = m_connections.find(socket);
    if (iterator != m_connections.end()) {
        if (pipelined) *pipelined = iterator->parser.unconsumedData();
        if (iterator->timeout) {
            iterator->timeout->stop();
            iterator->timeout->deleteLater();
        }
        m_connections.erase(iterator);
    }
    // The request handlers were installed with `this` as context; release that ownership
    // before the stream connection reparents the socket.
    socket->disconnect(this);
    socket->setParent(nullptr);
    return socket;
}

void LanWebService::serveAsset(QTcpSocket *socket, const HttpRequest &request)
{
    const QString requested = QString::fromUtf8(request.path);
    // `?view=legacy` forces the embedded page, matching the oracle's A1 fallback switch.
    // Checked before the dev proxy: the switch exists to compare the old page against the
    // new one *in dev*, so the proxy must not swallow it.
    if (request.queryParameter("view") == QLatin1String("legacy")) {
        return httpresponse::sendBytes(socket, 200, QByteArrayLiteral("text/html; charset=utf-8"),
                                       weblegacy::page(),
                                       QByteArrayLiteral("cache-control: no-store\r\n"));
    }
    // Dev mode: the bundle is not built, so every asset request is relayed to the dev
    // server (or answered with the embedded page / 503 / 404 by the relay).
    if (m_devProxy) {
        QTcpSocket *proxySocket = detachForStream(socket);
        if (!proxySocket) return;
        return m_devProxy->forwardHttp(request, proxySocket);
    }
    const webassets::Resolution resolution = webassets::resolve(m_options.rendererRoot, request.path);
    switch (resolution.kind) {
    case webassets::Kind::File:
        return httpresponse::sendFile(socket, resolution.path, contentTypeForPath(resolution.path),
                                      webassets::cacheControlFor(resolution.path));
    case webassets::Kind::Fallback:
        return httpresponse::sendBytes(socket, 200, QByteArrayLiteral("text/html; charset=utf-8"),
                                       weblegacy::page(),
                                       QByteArrayLiteral("cache-control: no-store\r\n"));
    case webassets::Kind::NotFound:
        return replyJson(socket, 404,
                         webdispatch::errorBody(404, QStringLiteral("webError.apiNotFound"),
                                                QStringLiteral("Not found: ") + requested));
    case webassets::Kind::Forbidden:
        break;
    }
    replyJson(socket, 404, webdispatch::errorBody(404, QStringLiteral("webError.apiNotFound"),
                                                  QStringLiteral("Not found: ") + requested));
}
