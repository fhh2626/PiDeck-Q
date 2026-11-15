#pragma once

#include <QByteArray>
#include <QJsonObject>
#include <QObject>
#include <QString>

#include <functional>

class QTcpSocket;
class QTimer;

/**
 * One open SSE response on the LAN web service.
 *
 * The desktop loopback server writes SSE from its own transport module; this one is
 * separate because the LAN socket is the *browser's* connection: it must survive for the
 * whole turn, carry `x-vercel-ai-ui-message-stream: v1`, and never buffer unbounded when
 * a phone stops reading.
 *
 * Framing: chunked transfer encoding (like Node's HTTP server) because the body length
 * is unknown when it starts. The AI SDK's `fetch`/`useChat` client reads it as a normal
 * streaming response.
 */
class WebStreamConnection : public QObject {
public:
    struct Options {
        /**
         * Backpressure cap for one socket.
         *
         * The Node oracle buffers in memory without a limit; a LAN phone on a bad link
         * would grow the backend's RSS until the process died. Over the cap the socket is
         * dropped (the browser reconnects through `/stream` and gets `[DONE]`), which is
         * the only bounded option without an on-disk spool.
         */
        qint64 maxBufferedBytes = 4LL * 1024LL * 1024LL;
        /** Comment-frame interval; proxies and phones drop idle long connections. */
        int heartbeatMs = 15'000;
    };

    using LogSink = std::function<void(const QString &level, const QString &message,
                                       const QJsonObject &detail)>;

    /** Takes ownership of `socket` and sends the SSE headers immediately. */
    WebStreamConnection(QTcpSocket *socket, Options options, QObject *parent = nullptr);
    ~WebStreamConnection() override;

    /** Raw SSE bytes (`data: …\n\n`, `: ping\n\n`); false when the socket is gone. */
    bool writeRaw(const QString &wire);

    /** End the response after the terminal frame (`[DONE]`). Idempotent. */
    void finish();

    /** Abrupt close (service stop): no further callbacks, socket destroyed later. */
    void abort();

    bool closed() const { return m_closed; }
    qint64 bufferedBytes() const;

    void setLogSink(LogSink sink) { m_logSink = std::move(sink); }
    /**
     * Owner notification when this response is over (client gone, stream finished or
     * dropped). Invoked exactly once; a later reassignment is a no-op for the old value.
     */
    void setClosedHandler(std::function<void()> handler) { m_onClientClosed = std::move(handler); }

private:
    void handleDisconnect();
    void notifyClosed();
    void sendHeaders();
    void stopHeartbeat();
    void flushPending();
    void log(const QString &level, const QString &message, const QJsonObject &detail = QJsonObject{});

    QTcpSocket *m_socket = nullptr;
    QTimer *m_heartbeat = nullptr;
    Options m_options;
    LogSink m_logSink;
    std::function<void()> m_onClientClosed;
    bool m_closed = false;
    bool m_chunkedTerminated = false;
};
