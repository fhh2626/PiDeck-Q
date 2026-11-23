#include "WebDevProxy.h"

#include "WebDevUpstream.h"

#include <QAbstractSocket>
#include <QByteArray>
#include <QJsonObject>
#include <QPointer>
#include <QTcpSocket>
#include <QTimer>

namespace webdevproxy {
namespace {

/**
 * Bytes read per socket before Qt stops reading from the OS.
 *
 * Bounding this is what turns "the browser is slow" into TCP backpressure on the dev
 * server instead of an unbounded buffer in the backend (the Node oracle pipes streams
 * and inherits Node's own backpressure).
 */
constexpr qint64 kReadChunkBytes = 64 * 1024;

QByteArray rawPathOf(const QByteArray &target)
{
    const qsizetype queryStart = target.indexOf('?');
    return queryStart < 0 ? target : target.left(queryStart);
}

/**
 * One proxied exchange: one browser socket and one dev-server socket.
 *
 * Both modes share the connect/head/deadline/teardown skeleton and differ only in what
 * happens after the upstream head: HTTP decides (stream / legacy page / 503 / 404 /
 * pass-through) and relays one direction; WebSocket relays `101` plus both directions.
 */
class Relay : public RelayNode {
public:
    enum class Mode {
        Http,
        WebSocket,
    };

    Relay(Mode mode, Proxy::Options options, Proxy::Writers writers, const HttpRequest &request,
          QTcpSocket *downstream, const QByteArray &clientHead)
        : m_mode(mode),
          m_options(std::move(options)),
          m_writers(std::move(writers)),
          m_target(m_options.target),
          m_request(request),
          m_downstream(downstream),
          m_clientHead(clientHead)
    {
        const QByteArray rawPath = rawPathOf(request.target);
        m_mapping = mapRequest(rawPath, request.query);
        m_upstreamTarget = passthroughTarget(rawPath, request.query);
        m_requestedPath = QString::fromUtf8(request.path);
    }

    ~Relay() override = default;

    void setLogSink(Proxy::LogSink sink) override { m_logSink = std::move(sink); }

    void start() override
    {
        if (!m_downstream) return cleanupAndDelete();
        m_downstream->setParent(this);
        m_downstream->setReadBufferSize(kReadChunkBytes);
        connect(m_downstream, &QTcpSocket::readyRead, this, [this] { onDownstreamReadable(); });
        connect(m_downstream, &QTcpSocket::bytesWritten, this, [this] { onDownstreamWritten(); });
        connect(m_downstream, &QTcpSocket::disconnected, this, [this] { cleanupAndDelete(); });
        connect(m_downstream, &QTcpSocket::errorOccurred, this, [this](QAbstractSocket::SocketError) {
            forceClose();
        });

        m_upstream = new QTcpSocket(this);
        m_upstream->setReadBufferSize(kReadChunkBytes);
        connect(m_upstream, &QTcpSocket::connected, this, [this] { onUpstreamConnected(); });
        connect(m_upstream, &QTcpSocket::readyRead, this, [this] { onUpstreamReadable(); });
        connect(m_upstream, &QTcpSocket::bytesWritten, this, [this] { onUpstreamWritten(); });
        connect(m_upstream, &QTcpSocket::disconnected, this, [this] { onUpstreamClosed(); });
        connect(m_upstream, &QTcpSocket::errorOccurred, this, [this](QAbstractSocket::SocketError error) {
            onUpstreamError(error);
        });

        // One deadline for connect + head. A dev server that accepts the connection and
        // then never answers must not hold a browser request forever; the body itself is
        // allowed to stream for as long as it takes.
        m_deadline = new QTimer(this);
        m_deadline->setSingleShot(true);
        m_deadline->setInterval(m_options.headTimeoutMs);
        connect(m_deadline, &QTimer::timeout, this, [this] { onDeadline(); });
        m_deadline->start();

        m_upstream->connectToHost(m_target.host, m_target.port);
    }

    void forceClose() override
    {
        m_closing = true;
        cleanupAndDelete();
    }

private:
    void onUpstreamConnected()
    {
        if (m_closing) return;
        m_upstream->write(m_mode == Mode::WebSocket
                              ? webdevupstream::upgradeHead(m_target, m_request, m_upstreamTarget)
                              : webdevupstream::requestHead(m_target, m_mapping.upstreamTarget));
    }

    void onUpstreamReadable()
    {
        if (m_closing) return;
        if (m_headParsed) {
            pump(m_upstream, m_downstream);
            return;
        }
        m_headBuffer += m_upstream->readAll();
        const qsizetype end = m_headBuffer.indexOf("\r\n\r\n");
        if (end < 0) {
            if (m_headBuffer.size() > webdevupstream::kMaxHeadBytes) {
                failBeforeHead(QStringLiteral("response head exceeded the size limit"));
            }
            return;
        }
        const QByteArray block = m_headBuffer.left(end);
        const QByteArray leftover = m_headBuffer.mid(end + 4);
        m_headBuffer.clear();

        webdevupstream::ResponseHead head;
        if (!webdevupstream::parseHead(block, &head)) {
            failBeforeHead(QStringLiteral("response head is malformed"));
            return;
        }
        m_headParsed = true;
        stopDeadline();
        if (m_mode == Mode::WebSocket) return beginWebSocket(head, block, leftover);
        beginHttp(head, leftover);
    }

    void beginHttp(const webdevupstream::ResponseHead &head, const QByteArray &leftover)
    {
        const Decision decision = onUpstreamHead(head.status, m_mapping.document, head.contentType);
        switch (decision.action) {
        case Action::Stream:
            m_downstream->write(webdevupstream::downstreamHead(head));
            if (!leftover.isEmpty()) m_downstream->write(leftover);
            pump(m_upstream, m_downstream);
            return;
        case Action::PassStatus:
            // Non-200 for a module: hand the status over without the upstream body. A
            // redirect is never followed and its `location` is never forwarded, so the
            // proxy cannot be used to bounce a LAN client somewhere it did not ask for.
            m_downstream->write(webdevupstream::emptyHead(decision.status, decision.contentType));
            return finishGracefully();
        case Action::NotFound:
            m_writers.failure(m_downstream, 404, QStringLiteral("webError.apiNotFound"),
                              notFoundMessage(m_requestedPath));
            return finishGracefully();
        case Action::Unavailable:
            m_writers.failure(m_downstream, 503, QStringLiteral("webError.internal"),
                              unavailableMessage());
            return finishGracefully();
        case Action::LegacyPage:
            m_writers.legacyPage(m_downstream);
            return finishGracefully();
        }
    }

    void beginWebSocket(const webdevupstream::ResponseHead &head, const QByteArray &block,
                        const QByteArray &leftover)
    {
        if (head.status != 101) {
            // The oracle registers no `response` listener for a refused upgrade, which
            // leaves the browser socket hanging. Relaying the refusal and closing is the
            // same decision with a bounded outcome.
            log(QStringLiteral("warn"), QStringLiteral("Dev HMR upgrade refused"),
                QJsonObject{{QStringLiteral("status"), head.status}});
            m_downstream->write(block + "\r\n\r\n");
            if (!leftover.isEmpty()) m_downstream->write(leftover);
            return finishGracefully();
        }
        // `101` is relayed verbatim: `Sec-WebSocket-Accept` is computed by the dev server
        // from the key the browser sent, so re-serializing headers here could only break it.
        m_downstream->write(block + "\r\n\r\n");
        if (!leftover.isEmpty()) m_downstream->write(leftover);
        if (!m_clientHead.isEmpty()) m_upstream->write(m_clientHead);
        m_bidirectional = true;
        pump(m_upstream, m_downstream);
        pump(m_downstream, m_upstream);
    }

    void onDownstreamReadable()
    {
        if (m_closing || !m_bidirectional) return;
        pump(m_downstream, m_upstream);
    }

    void onDownstreamWritten()
    {
        if (m_closing) return;
        pump(m_upstream, m_downstream);
    }

    void onUpstreamWritten()
    {
        if (m_closing || !m_bidirectional) return;
        pump(m_downstream, m_upstream);
    }

    void onUpstreamClosed()
    {
        if (m_closing) return;
        if (!m_headParsed) {
            failBeforeHead(QStringLiteral("dev server closed the connection"));
            return;
        }
        // EOF is the end of a `connection: close` body (and of the upstream side of an HMR
        // socket). The pump deliberately stops reading when the browser is congested, so
        // at EOF the upstream read buffer can still hold the tail of the body. Closing
        // without it hands the browser a body shorter than its `content-length` — a module
        // load that fails intermittently and only for large assets. Drain it first, then
        // let the downstream queue flush.
        drainUpstream();
        finishGracefully();
    }

    void onUpstreamError(QAbstractSocket::SocketError error)
    {
        if (m_closing) return;
        if (!m_headParsed) {
            failBeforeHead(QStringLiteral("dev server connection failed"));
            return;
        }
        // Qt reports an orderly peer close (`connection: close` EOF) as
        // RemoteHostClosedError *and* `disconnected`. Aborting here would destroy a body
        // whose tail is still buffered upstream, so a peer close is completed like EOF.
        if (error == QAbstractSocket::RemoteHostClosedError) {
            drainUpstream();
            finishGracefully();
            return;
        }
        // After the head, any other failure is a truncated response: destroy the browser
        // socket so a module load fails instead of completing with missing bytes (the
        // oracle does the same with `response.destroy()`).
        forceClose();
    }

    void onDeadline()
    {
        if (m_closing || m_headParsed) return;
        failBeforeHead(QStringLiteral("dev server did not answer before the deadline"));
    }

    /** Upstream never produced a usable head: HTTP falls back, HMR just drops. */
    void failBeforeHead(const QString &reason)
    {
        stopDeadline();
        log(QStringLiteral("warn"), QStringLiteral("Dev renderer proxy request failed"),
            QJsonObject{{QStringLiteral("reason"), reason},
                        {QStringLiteral("path"), m_requestedPath}});
        if (m_mode == Mode::WebSocket || !m_downstream) return forceClose();
        const Decision decision = onTransportFailure(m_mapping.document);
        if (decision.action == Action::LegacyPage) {
            m_writers.legacyPage(m_downstream);
        } else {
            m_writers.failure(m_downstream, 503, QStringLiteral("webError.internal"),
                              unavailableMessage());
        }
        finishGracefully();
    }

    /**
     * Forward the upstream tail without the backpressure guard.
     *
     * Only used when the upstream has closed: no more bytes will arrive, so the read buffer
     * holds a bounded remainder (at most one `readBufferSize`) and refusing to buffer it
     * would truncate the response instead of protecting memory.
     */
    void drainUpstream()
    {
        if (!m_upstream || !m_downstream) return;
        while (!m_closing && m_upstream->bytesAvailable() > 0) {
            const QByteArray chunk = m_upstream->readAll();
            if (chunk.isEmpty()) break;
            m_downstream->write(chunk);
        }
    }

    /**
     * Forward everything already buffered from `from` to `to`.
     *
     * When `to` is congested nothing is drained: `from`'s read buffer stays full, Qt stops
     * reading the OS socket and the dev server is throttled by TCP instead of this process
     * buffering the whole payload.
     */
    void pump(QTcpSocket *from, QTcpSocket *to)
    {
        if (m_closing || !from || !to) return;
        if (to->bytesToWrite() > m_options.highWaterBytes) return;
        if (from->bytesAvailable() <= 0) return;
        const QByteArray chunk = from->readAll();
        if (!chunk.isEmpty()) to->write(chunk);
    }

    /** Flush the browser socket, close it, and let `disconnected` delete this relay. */
    void finishGracefully()
    {
        if (m_closing) return;
        m_closing = true;
        stopDeadline();
        if (m_upstream) m_upstream->abort();
        if (!m_downstream || m_downstream->state() == QAbstractSocket::UnconnectedState) {
            return cleanupAndDelete();
        }
        // `disconnectFromHost` flushes the queued reply first; the relay is destroyed from
        // the `disconnected` handler, never while bytes are still pending.
        m_downstream->disconnectFromHost();
    }

    void cleanupAndDelete()
    {
        if (m_deleted) return;
        m_deleted = true;
        m_closing = true;
        stopDeadline();
        QTcpSocket *upstream = m_upstream.data();
        QTcpSocket *downstream = m_downstream.data();
        m_upstream.clear();
        m_downstream.clear();
        for (QTcpSocket *socket : {upstream, downstream}) {
            if (!socket) continue;
            disconnect(socket, nullptr, this, nullptr);
            if (socket->state() != QAbstractSocket::UnconnectedState) socket->abort();
        }
        // Both sockets are children of this relay, so deleting it closes them for good.
        deleteLater();
    }

    void stopDeadline()
    {
        if (!m_deadline) return;
        m_deadline->stop();
        m_deadline->deleteLater();
        m_deadline = nullptr;
    }

    void log(const QString &level, const QString &message, const QJsonObject &detail)
    {
        if (m_logSink) m_logSink(level, message, detail);
    }

    Mode m_mode;
    Proxy::Options m_options;
    Proxy::Writers m_writers;
    Proxy::LogSink m_logSink;
    Target m_target;
    HttpRequest m_request;
    Mapping m_mapping;
    QByteArray m_upstreamTarget;
    QString m_requestedPath;
    QPointer<QTcpSocket> m_downstream;
    QPointer<QTcpSocket> m_upstream;
    QTimer *m_deadline = nullptr;
    QByteArray m_headBuffer;
    QByteArray m_clientHead;
    bool m_headParsed = false;
    bool m_bidirectional = false;
    bool m_closing = false;
    bool m_deleted = false;
};

} // namespace

Proxy::Proxy(Options options, Writers writers, QObject *parent)
    : QObject(parent), m_options(std::move(options)), m_writers(std::move(writers))
{
}

void Proxy::forwardHttp(const HttpRequest &request, QTcpSocket *socket)
{
    attach(new Relay(Relay::Mode::Http, m_options, m_writers, request, socket, QByteArray()));
}

void Proxy::forwardWebSocket(const HttpRequest &request, QTcpSocket *socket, const QByteArray &head)
{
    attach(new Relay(Relay::Mode::WebSocket, m_options, m_writers, request, socket, head));
}

void Proxy::attach(RelayNode *relay)
{
    relay->setParent(this);
    relay->setLogSink(m_logSink);
    m_relays.insert(relay);
    // A relay deletes itself once its exchange ends; unregister it first so this set can
    // never hold a dangling pointer (see the member comment for why not `QPointer`).
    connect(relay, &QObject::destroyed, this, [this, relay] { m_relays.remove(relay); });
    relay->start();
}

void Proxy::abortAll()
{
    const QList<RelayNode *> relays = m_relays.values();
    m_relays.clear();
    for (RelayNode *relay : relays) relay->forceClose();
}

int Proxy::activeRelays() const
{
    return m_relays.size();
}

} // namespace webdevproxy
