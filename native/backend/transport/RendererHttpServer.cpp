#include "RendererHttpServer.h"

#include "ChannelRegistry.h"
#include "HttpResponse.h"
#include "MimeTypes.h"
#include "StaticFiles.h"

#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QHostAddress>
#include <QJsonArray>
#include <QJsonDocument>
#include <QRegularExpression>
#include <QUrl>
#include <QVector>

#include <utility>

namespace {

constexpr qint64 kMaxAssetBytes = 32LL * 1024LL * 1024LL;

bool constantTimeEquals(const QString &left, const QString &right)
{
    const QByteArray a = left.toUtf8();
    const QByteArray b = right.toUtf8();
    const int maxLength = qMax(a.size(), b.size());
    size_t difference = static_cast<size_t>(a.size()) ^ static_cast<size_t>(b.size());
    for (int i = 0; i < maxLength; ++i) {
        const unsigned char av = i < a.size() ? static_cast<unsigned char>(a.at(i)) : 0;
        const unsigned char bv = i < b.size() ? static_cast<unsigned char>(b.at(i)) : 0;
        difference |= static_cast<size_t>(av ^ bv);
    }
    return difference == 0;
}

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

} // namespace

RendererHttpServer::RendererHttpServer(ChannelRegistry *registry, EventHub *events, Options options, QObject *parent)
    : QObject(parent), m_registry(registry), m_events(events), m_options(std::move(options))
{
    connect(&m_server, &QTcpServer::newConnection, this, [this] { acceptConnections(); });
    m_heartbeatTimer.setInterval(m_options.heartbeatIntervalMs);
    connect(&m_heartbeatTimer, &QTimer::timeout, this, [this] {
        for (QTcpSocket *socket : std::as_const(m_sseClients)) {
            if (socket->state() == QAbstractSocket::ConnectedState) socket->write(": heartbeat\n\n");
        }
    });
    m_events->setFrameSink([this](quint64 seq, const QByteArray &frame, qint64 bytes) {
        deliverEventFrame(seq, frame, bytes);
    });
    m_events->setReplayGapSink([this](const QString &reason, qint64 lostSinceMs, bool hasLostSince) {
        if (m_replayGapHandler) m_replayGapHandler(reason, lostSinceMs, hasLostSince);
    });
    m_events->setOversizedSink([this](const QString &channel, qint64 bytes) {
        if (!m_eventChannelDiagnostic) return;
        m_eventChannelDiagnostic(QStringLiteral("oversized-event"),
                                 QJsonObject{{QStringLiteral("channel"), channel}, {QStringLiteral("bytes"), bytes}});
    });
    m_events->setLargeFrameSink([this](const QString &channel, qint64 bytes, int suppressed) {
        if (!m_eventChannelDiagnostic) return;
        m_eventChannelDiagnostic(QStringLiteral("large-frame"), QJsonObject{
            {QStringLiteral("channel"), channel},
            {QStringLiteral("bytes"), bytes},
            {QStringLiteral("suppressedSinceLast"), suppressed},
        });
    });
}

bool RendererHttpServer::start()
{
    if (m_server.isListening()) return true;
    if (!m_server.listen(QHostAddress::LocalHost, 0)) {
        if (m_serverErrorHandler) m_serverErrorHandler(m_server.errorString());
        return false;
    }
    m_heartbeatTimer.start();
    return true;
}

quint16 RendererHttpServer::port() const
{
    return m_server.serverPort();
}

QString RendererHttpServer::url() const
{
    return QStringLiteral("http://127.0.0.1:%1/").arg(m_server.serverPort());
}

void RendererHttpServer::stop()
{
    m_heartbeatTimer.stop();
    // Both containers are detached before iterating: `disconnectFromHost()`/`abort()` deliver
    // `disconnected` synchronously, and that handler erases the socket from m_sseClients and
    // m_connections. Iterating the live containers while they shrink is iterator
    // invalidation (it used to erase the current element mid-loop).
    const QSet<QTcpSocket *> sseClients = m_sseClients;
    m_sseClients.clear();
    for (QTcpSocket *socket : sseClients) {
        socket->write(": server shutting down\n\n");
        socket->disconnectFromHost();
    }
    QHash<QTcpSocket *, Connection> connections = std::move(m_connections);
    m_connections.clear();
    for (auto iterator = connections.begin(); iterator != connections.end(); ++iterator) {
        // The `disconnected` handler no longer owns these timers for a detached socket.
        if (iterator->timeout) {
            iterator->timeout->stop();
            iterator->timeout->deleteLater();
        }
        iterator.key()->abort();
    }
    m_server.close();
}

void RendererHttpServer::acceptConnections()
{
    while (m_server.hasPendingConnections()) {
        QTcpSocket *socket = m_server.nextPendingConnection();
        Connection connection(m_options.maxBodyBytes);
        connection.timeout = new QTimer(this);
        connection.timeout->setSingleShot(true);
        connection.timeout->setInterval(m_options.requestTimeoutMs);
        connect(connection.timeout, &QTimer::timeout, this, [this, socket] {
            // Slowloris guard: a connection that never completes a request head is
            // closed instead of holding a slot forever.
            const auto iterator = m_connections.find(socket);
            if (iterator == m_connections.end()) return;
            if (iterator->sse) return;
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
            m_sseClients.remove(socket);
            socket->deleteLater();
        });
    }
}

void RendererHttpServer::readFromSocket(QTcpSocket *socket)
{
    const auto iterator = m_connections.find(socket);
    if (iterator == m_connections.end() || iterator->sse) {
        socket->readAll();
        return;
    }
    Connection &connection = *iterator;
    const QByteArray chunk = socket->readAll();
    if (connection.dispatched) {
        // The response for the request already dispatched carries `connection: close`;
        // anything arriving afterwards belongs to a request this server will not serve.
        reportPipelinedBytes(chunk.size());
        return;
    }
    const HttpRequestParser::Status status = connection.parser.feed(chunk);
    if (status == HttpRequestParser::Status::NeedMore) return;
    if (status != HttpRequestParser::Status::Complete) {
        connection.dispatched = true;
        httpresponse::sendError(socket, statusForParseFailure(status), connection.parser.error());
        return;
    }
    connection.timeout->stop();
    const HttpRequest request = connection.parser.request();
    // A single TCP segment can carry more than one request. The parser stops at the first
    // complete one and leaves the remainder in its buffer; feeding it again used to
    // re-dispatch the *previous* request, so a pipelined `files:delete` or `git:commit`
    // executed twice. The remainder is reported and dropped: one request per connection.
    reportPipelinedBytes(connection.parser.unconsumedBytes());
    connection.dispatched = true;
    handleRequest(socket, request);
}

void RendererHttpServer::reportPipelinedBytes(qsizetype bytes)
{
    if (bytes <= 0 || !m_eventChannelDiagnostic) return;
    m_eventChannelDiagnostic(QStringLiteral("pipelined-request-dropped"),
                             QJsonObject{{QStringLiteral("bytes"), static_cast<double>(bytes)}});
}

void RendererHttpServer::handleRequest(QTcpSocket *socket, const HttpRequest &request)
{
    const QByteArray path = request.path;
    if (path.startsWith("/__pideck/") && !isAuthorized(request)) {
        httpresponse::sendError(socket, 401, QStringLiteral("Unauthorized"));
        return;
    }
    if (request.method == "POST" && path == "/__pideck/rpc") return handleRpc(socket, request);
    if (request.method == "GET" && path == "/__pideck/bootstrap") return handleBootstrap(socket);
    if (request.method == "GET" && path == "/__pideck/events") return handleEvents(socket, request);
    if (request.method == "POST" && path == "/__pideck/heartbeat") return handleHeartbeat(socket, request);
    if (request.method == "POST" && path == "/__pideck/diagnostics/memory") {
        if (m_memoryDiagnosticsSink) {
            const QJsonDocument document = QJsonDocument::fromJson(request.body);
            m_memoryDiagnosticsSink(document.isNull() ? QJsonValue(QJsonValue::Null) : QJsonValue(document.object()));
        }
        return httpresponse::sendEmpty(socket, 204);
    }
    if (request.method == "GET" && path.startsWith("/__pideck/background/")) return handleBackground(socket, request);
    if (request.method != "GET" && request.method != "HEAD") {
        return httpresponse::sendError(socket, 405, QStringLiteral("Method not allowed"));
    }
    serveStatic(socket, request);
}

bool RendererHttpServer::isAuthorized(const HttpRequest &request) const
{
    const QString header = QString::fromUtf8(request.header("x-pideck-token"));
    if (!header.isEmpty() && constantTimeEquals(header, m_options.token)) return true;
    const QString query = request.queryParameter("token");
    return !query.isEmpty() && constantTimeEquals(query, m_options.token);
}

void RendererHttpServer::handleRpc(QTcpSocket *socket, const HttpRequest &request)
{
    QJsonParseError parseError;
    const QJsonDocument document = QJsonDocument::fromJson(request.body, &parseError);
    if (parseError.error != QJsonParseError::NoError || !document.isObject()) {
        return httpresponse::sendError(socket, 400, QStringLiteral("Invalid RPC request"));
    }
    const QJsonObject input = document.object();
    const QJsonValue channelValue = input.value(QStringLiteral("channel"));
    const QJsonValue argsValue = input.value(QStringLiteral("args"));
    if (!channelValue.isString() || !argsValue.isArray()) {
        return httpresponse::sendError(socket, 400, QStringLiteral("Invalid RPC request"));
    }
    try {
        const QPointer<QTcpSocket> guarded(socket);
        // Host-backed channels answer asynchronously; the responder keeps the HTTP
        // request open without blocking the event loop.
        m_registry->invoke(channelValue.toString(), argsValue.toArray(), ChannelResponder(
            [this, guarded](const QJsonValue &result) {
                if (!guarded) return;
                httpresponse::sendJson(guarded, 200, QJsonObject{
                    {QStringLiteral("ok"), true},
                    {QStringLiteral("result"), result},
                });
            },
            [this, guarded](const QString &message) {
                if (!guarded) return;
                httpresponse::sendJson(guarded, 200, QJsonObject{
                    {QStringLiteral("ok"), false},
                    {QStringLiteral("error"), QJsonObject{{QStringLiteral("message"), message}}},
                });
            }));
    } catch (const std::exception &error) {
        httpresponse::sendJson(socket, 200, QJsonObject{
            {QStringLiteral("ok"), false},
            {QStringLiteral("error"), QJsonObject{{QStringLiteral("message"), QString::fromUtf8(error.what())}}},
        });
    }
}

void RendererHttpServer::handleBootstrap(QTcpSocket *socket)
{
    // Capture the boundary before the (possibly slow) clipboard snapshot so events
    // produced while it is read stay queued and are replayed afterwards.
    const quint64 boundary = m_events->eventSeq();
    // The clipboard snapshot is asynchronous and the page may navigate away while it
    // is in flight, so the response target is guarded.
    const QPointer<QTcpSocket> guarded(socket);
    const auto respond = [this, guarded, boundary](const RendererBootstrap &bootstrap) {
        if (!guarded) return;
        httpresponse::sendJson(guarded, 200, QJsonObject{
            {QStringLiteral("clipboard"), bootstrap.clipboard},
            {QStringLiteral("settings"), QJsonObject{
                 {QStringLiteral("zoomFactor"), bootstrap.zoomFactor},
                 {QStringLiteral("memoryProfileEnabled"), bootstrap.memoryProfileEnabled},
             }},
            {QStringLiteral("eventSeq"), static_cast<qint64>(boundary)},
            {QStringLiteral("eventSourceGeneration"), m_events->generation()},
        });
    };
    if (!m_bootstrapProvider) return respond(RendererBootstrap{});
    m_bootstrapProvider(respond);
}

void RendererHttpServer::handleEvents(QTcpSocket *socket, const HttpRequest &request)
{
    auto iterator = m_connections.find(socket);
    if (iterator == m_connections.end()) return;
    iterator->sse = true;
    iterator->timeout->stop();
    m_sseClients.insert(socket);
    socket->write("HTTP/1.1 200 OK\r\n"
                  "content-type: text/event-stream; charset=utf-8\r\n"
                  "cache-control: no-cache, no-store\r\n"
                  "connection: keep-alive\r\n"
                  "x-accel-buffering: no\r\n\r\n");
    socket->write(": connected\n\n");

    const QByteArray headerLastEventId = request.header("last-event-id");
    const QString queryLastEventId = request.queryParameter("lastEventId");
    const QByteArray rawLastEventId = !headerLastEventId.isEmpty() ? headerLastEventId
                                                                  : queryLastEventId.toUtf8();
    bool hasLastEventId = false;
    quint64 lastEventId = 0;
    if (!rawLastEventId.isEmpty()) {
        bool ok = false;
        const qulonglong parsed = rawLastEventId.toULongLong(&ok);
        if (ok) {
            hasLastEventId = true;
            lastEventId = parsed;
        }
    }

    const EventHub::Replay replay = m_events->replay(lastEventId, hasLastEventId);
    if (replay.gap) {
        // The handler may re-push state synchronously, which appends frames and advances the
        // sequence. The control frame must therefore be built afterwards and read the same
        // `eventSeq` the frame id carries; the oracle writes `this.eventSeq` here for the
        // same reason.
        if (m_replayGapHandler) m_replayGapHandler(replay.gapReason, replay.gapLostSinceMs, replay.hasGapLostSince);
        socket->write(m_events->controlFrame(QStringLiteral("native.resyncRequired"), QJsonObject{
            {QStringLiteral("reason"), replay.gapReason},
            {QStringLiteral("eventSeq"), static_cast<qint64>(m_events->eventSeq())},
        }));
    } else {
        for (const QByteArray &frame : replay.frames) socket->write(frame);
    }
    socket->write(m_events->controlFrame(QStringLiteral("native.eventChannelReady"), QJsonObject{
        {QStringLiteral("eventSeq"), static_cast<qint64>(m_events->eventSeq())},
        {QStringLiteral("eventSourceGeneration"), m_events->generation()},
    }));
}

void RendererHttpServer::handleHeartbeat(QTcpSocket *socket, const HttpRequest &request)
{
    QJsonObject payload;
    if (!request.body.isEmpty()) {
        QJsonParseError parseError;
        const QJsonDocument document = QJsonDocument::fromJson(request.body, &parseError);
        if (parseError.error != QJsonParseError::NoError || !document.isObject()) {
            return httpresponse::sendError(socket, 400, QStringLiteral("Invalid heartbeat payload"));
        }
        payload = document.object();
    }
    const QJsonValue lastEventSeq = payload.value(QStringLiteral("lastEventSeq"));
    const bool hasRendererSeq = lastEventSeq.isDouble() && lastEventSeq.toDouble() >= 0
        && lastEventSeq.toDouble() == qint64(lastEventSeq.toDouble());
    const quint64 rendererSeq = hasRendererSeq ? quint64(lastEventSeq.toDouble()) : 0;
    const QString rendererGeneration = payload.value(QStringLiteral("eventSourceGeneration")).toString();
    const EventHub::HeartbeatState state = m_events->heartbeatState(hasRendererSeq, rendererSeq, rendererGeneration);
    if (m_heartbeatObserver) m_heartbeatObserver(payload, state);
    httpresponse::sendJson(socket, 200, QJsonObject{
        {QStringLiteral("eventSeq"), static_cast<qint64>(state.eventSeq)},
        {QStringLiteral("eventSourceGeneration"), state.generation},
        {QStringLiteral("eventChannelHealthy"), state.healthy},
    });
}

void RendererHttpServer::handleBackground(QTcpSocket *socket, const HttpRequest &request)
{
    const QByteArray prefix = "/__pideck/background/";
    const QString name = QString::fromUtf8(request.path.mid(prefix.size()));
    static const QRegularExpression pattern(QStringLiteral("^bg-[a-zA-Z0-9.]+$"));
    if (!pattern.match(name).hasMatch()) return httpresponse::sendError(socket, 403, QStringLiteral("Forbidden"));
    const QString root = QFileInfo(m_options.backgroundDirectory).canonicalFilePath();
    if (root.isEmpty()) return httpresponse::sendError(socket, 404, QStringLiteral("Not found"));
    const QString candidate = QFileInfo(QDir(root).filePath(name)).canonicalFilePath();
    if (candidate.isEmpty() || !staticfiles::isInsideRoot(root, candidate)) {
        return httpresponse::sendError(socket, 404, QStringLiteral("Not found"));
    }
    httpresponse::sendFile(socket, candidate, contentTypeForPath(name), QByteArrayLiteral("public, max-age=86400"));
}

void RendererHttpServer::serveStatic(QTcpSocket *socket, const HttpRequest &request)
{
    const staticfiles::Resolution resolution =
        staticfiles::resolve(m_options.rendererRoot, request.path, kMaxAssetBytes);
    switch (resolution.kind) {
    case staticfiles::Kind::File:
        return httpresponse::sendFile(socket, resolution.path, contentTypeForPath(resolution.path));
    case staticfiles::Kind::Forbidden:
        return httpresponse::sendError(socket, 403, QStringLiteral("Forbidden"));
    case staticfiles::Kind::TooLarge:
        return httpresponse::sendError(socket, 413, QStringLiteral("Asset exceeds 32 MB"));
    case staticfiles::Kind::NotFound:
        break;
    }
    httpresponse::sendError(socket, 404, QStringLiteral("Not found"));
}

void RendererHttpServer::deliverEventFrame(quint64 seq, const QByteArray &frame, qint64 bytes)
{
    Q_UNUSED(seq);
    // Removals are collected and applied after the loop: dropSseClient() erases from
    // m_sseClients, which would invalidate the iterator of a live range-for.
    QVector<QTcpSocket *> dropped;
    for (QTcpSocket *socket : std::as_const(m_sseClients)) {
        if (socket->state() != QAbstractSocket::ConnectedState) continue;
        if (socket->bytesToWrite() > m_options.maxPendingEventBytes) {
            // Only an already oversized backlog kills the client: a single large frame
            // must never drop a healthy connection.
            dropped.append(socket);
            continue;
        }
        socket->write(frame);
    }
    for (QTcpSocket *socket : dropped) {
        dropSseClient(socket, QStringLiteral("client-backpressure-dropped"), socket->bytesToWrite(), bytes);
    }
}

void RendererHttpServer::dropSseClient(QTcpSocket *socket, const QString &reason, qint64 pendingBytes, qint64 frameBytes)
{
    if (m_eventChannelDiagnostic) {
        m_eventChannelDiagnostic(reason, QJsonObject{
            {QStringLiteral("pendingBytes"), pendingBytes},
            {QStringLiteral("frameBytes"), frameBytes},
        });
    }
    m_sseClients.remove(socket);
    socket->abort();
}
