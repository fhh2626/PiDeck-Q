#pragma once

#include "HttpRequest.h"
#include "WebDevProxyPlan.h"

#include <QByteArray>
#include <QString>

/**
 * HTTP/1.1 head plumbing between the browser and the dev server.
 *
 * The relay speaks raw HTTP over `QTcpSocket` on purpose: the HMR handshake needs a real
 * upgrade (`QNetworkAccessManager` cannot do that), and a raw exchange lets the proxy
 * decide *after* the upstream head is known, which is what the oracle's `fetch`-based
 * proxy does (fall back to the embedded page for documents, 503/404/pass-through for
 * modules, `no-store` for everything).
 *
 * Deliberate header policy, both directions:
 *   - browser -> dev server: `host`/`origin` are rewritten to the dev server (Vite
 *     rejects a foreign Origin for HMR as cross-origin), `cookie`/`authorization` and the
 *     `pideck_token` query parameter are *not* forwarded (the LAN access token has no
 *     business in a dev server log);
 *   - dev server -> browser: only the framing/type headers are forwarded
 *     (`content-type`, `content-encoding`, `content-length`/`transfer-encoding`) plus a
 *     forced `cache-control: no-store`; nothing else is passed through.
 */
namespace webdevupstream {

/**
 * Cap for one upstream response head.
 *
 * Vite heads are well below 1 KiB; the cap keeps a hostile/broken local server from
 * growing the backend's buffer while it never sends `\r\n\r\n`.
 */
constexpr qint64 kMaxHeadBytes = 64 * 1024;

/** `GET <target> HTTP/1.1` with the dev server as host; no browser credentials. */
QByteArray requestHead(const webdevproxy::Target &target, const QByteArray &upstreamTarget);

/**
 * WebSocket upgrade request for the HMR socket.
 *
 * Forwards the handshake headers, rewrites `host`/`origin`, drops credentials and any
 * header value carrying control bytes (header-injection guard on an unvalidated value).
 */
QByteArray upgradeHead(const webdevproxy::Target &target, const HttpRequest &request,
                       const QByteArray &upstreamTarget);

/** The parts of an upstream head the proxy acts on. */
struct ResponseHead {
    int status = 0;
    /** Upstream reason phrase, verbatim (sanitized when written). */
    QByteArray reason;
    QByteArray contentType = QByteArrayLiteral("application/octet-stream");
    QByteArray contentEncoding;
    /** `content-length` when the upstream declared one, otherwise empty. */
    QByteArray contentLength;
    bool chunked = false;
};

/** Parse one complete upstream head (without the terminating CRLFCRLF). */
bool parseHead(const QByteArray &block, ResponseHead *out);

/** Head served to the browser for a relayed 200 (`connection: close`, `no-store`). */
QByteArray downstreamHead(const ResponseHead &head);

/** Status without a body: `content-length: 0`, passed-through content type. */
QByteArray emptyHead(int status, const QByteArray &contentType);

/**
 * `HTTP/1.1 <status> <reason>`.
 *
 * The upstream reason is only used when it is printable ASCII; otherwise the standard
 * phrase for the status is substituted. This is the sink where a malformed local server
 * could otherwise inject a second header block.
 */
QByteArray statusLine(int status, const QByteArray &upstreamReason);

} // namespace webdevupstream
