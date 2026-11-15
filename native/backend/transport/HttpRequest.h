#pragma once

#include <QByteArray>
#include <QHash>
#include <QList>
#include <QPair>
#include <QString>

/**
 * Hardened HTTP/1.1 request head parser for the loopback renderer server.
 *
 * The Qt distribution used by this project does not ship QtHttpServer, so the
 * parser is hand written. It therefore has to be explicit about every case Node's
 * http server handles for free (ADR-1):
 *   - header size cap and request-line length cap (slowloris);
 *   - duplicate/conflicting Content-Length rejected;
 *   - Transfer-Encoding rejected instead of silently mis-framed;
 *   - Host required for HTTP/1.1;
 *   - absolute-form targets and non-origin-form paths rejected;
 *   - percent-decoding validated before any filesystem use.
 * Bodies are length-delimited only; the backend never accepts chunked bodies.
 */
struct HttpRequest {
    QByteArray method;
    QByteArray target;
    /** Percent-decoded path, always starting with '/'. */
    QByteArray path;
    /** Raw query string without the leading '?'. */
    QByteArray query;
    QByteArray version;
    /** Header names are stored lower-cased; values are trimmed. */
    QHash<QByteArray, QByteArray> headers;
    QByteArray body;

    bool hasHeader(const QByteArray &lowerName) const { return headers.contains(lowerName); }
    QByteArray header(const QByteArray &lowerName) const { return headers.value(lowerName); }
    /** First value of a comma separated query parameter, percent-decoded. */
    QString queryParameter(const QByteArray &name) const;
};

class HttpRequestParser {
public:
    enum class Status {
        NeedMore,
        Complete,
        BadRequest,
        HeaderTooLarge,
        PayloadTooLarge,
        LengthRequired,
        UnsupportedTransferEncoding,
        VersionNotSupported,
        MethodNotAllowed,
    };

    explicit HttpRequestParser(qint64 maxBodyBytes, int maxHeaderBytes = 64 * 1024, int maxTargetBytes = 8 * 1024);

    /** Append bytes read from the socket and (re)try to parse the head/body. */
    Status feed(const QByteArray &chunk);
    Status status() const { return m_status; }
    const HttpRequest &request() const { return m_request; }
    const QString &error() const { return m_error; }
    /** Bytes consumed by the completed request (head + body). */
    qsizetype consumedBytes() const { return m_consumed; }
    /**
     * Bytes that arrived after the completed request (a pipelined second request).
     *
     * The parser stops at the first `Complete`, so those bytes were never examined.
     * Callers must consume them explicitly; re-feeding them through the same parser
     * would replay the *previous* request instead of parsing the next one.
     */
    qsizetype unconsumedBytes() const { return m_buffer.size() - m_consumed; }
    /**
     * The unconsumed bytes themselves.
     *
     * A WebSocket client is not allowed to send frames before the `101`, but the bytes
     * can already be in the socket buffer when the handshake head completes; the relay
     * forwards them upstream instead of dropping them (Node's `upgrade` handler does the
     * same with its `head` buffer).
     */
    QByteArray unconsumedData() const { return m_buffer.mid(m_consumed); }
    void reset();

private:
    Status fail(Status status, const QString &error);
    Status parseHead();
    /** Body framing only; the head is parsed exactly once even when it spans reads. */
    Status parseBody();

    qint64 m_maxBodyBytes;
    int m_maxHeaderBytes;
    int m_maxTargetBytes;
    QByteArray m_buffer;
    HttpRequest m_request;
    Status m_status = Status::NeedMore;
    QString m_error;
    qsizetype m_consumed = 0;
    qint64 m_contentLength = -1;
    /**
     * True once the header block has been parsed.
     *
     * A large body normally arrives in several socket reads. Re-running `parseHead()` on
     * each read would re-parse the same header block already in `m_buffer` and reject every
     * legitimate request with `Duplicate Content-Length header`.
     */
    bool m_headParsed = false;
    qsizetype m_headBytes = 0;
};

/** Percent-decode a URL path. Returns false for malformed escapes or NUL bytes. */
bool percentDecodePath(const QByteArray &raw, QByteArray *decoded);
