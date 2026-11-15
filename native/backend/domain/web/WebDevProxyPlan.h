#pragma once

#include "HttpRequest.h"

#include <QByteArray>
#include <QString>

/**
 * Pure decisions for the dev-renderer proxy (port of `proxyDevRenderer` /
 * `proxyDevWebSocket` in `src/main/web/WebServiceManager.ts`).
 *
 * Why the proxy exists at all: with `vite dev` there is no `web.html` in the renderer
 * bundle, so without a proxy the LAN page would silently fall back to the embedded
 * legacy page and never show the React client. The proxy is therefore *not* a general
 * forwarder — the target is a loopback dev server, and each rule below is a rule the
 * oracle already answered:
 *   - which paths map to the dev entry document (`/web.html`) and which are passed
 *     through verbatim (`/@vite/*` internal modules keep their `?v=`/`?t=` query);
 *   - when a *document* request degrades to the embedded page (dev server down, upstream
 *     non-200) so the browser is never blank;
 *   - when a *module* request must be a 404 instead of HTML (Vite's SPA fallback returns
 *     `index.html` for unknown paths; parsing that as a module script is a MIME error and
 *     a white page, which does not self-recover).
 *
 * Everything here is a free function so the decisions can be read (and reviewed) without
 * the socket state machine in WebDevProxy.h.
 */
namespace webdevproxy {

/** Parsed dev server base URL (`PIDECK_DEV_RENDERER_URL`). */
struct Target {
    bool valid = false;
    /** Loopback host to connect to, without IPv6 brackets. */
    QString host;
    quint16 port = 0;
    /** `http://host[:port]`; Vite compares the HMR handshake `Origin` against it. */
    QString origin;
    /** Value for the upstream `host:` header (`host[:port]`, IPv6 bracketed). */
    QString hostHeader;
    /** Optional base path from the URL, normalized without a trailing slash. */
    QString basePath;
};

/**
 * Validate and normalize a dev server base URL.
 *
 * Only `http` and only loopback hosts are accepted. The dev server is a local tool (Vite
 * binds 127.0.0.1 by default); accepting a remote host would turn the LAN web service
 * into an open forward proxy for every device on the network, which is exactly the kind
 * of authorization this service must never grant.
 *
 * Returns false with a human readable `error` for anything else; the caller logs it and
 * keeps serving the bundle (a bad dev setting must not disable the LAN service).
 */
bool parseTarget(const QString &raw, Target *out, QString *error);

/** True when `path` has an extension; a leading dot is a hidden name, not an extension. */
bool hasExtension(const QByteArray &path);

/**
 * A request for the entry document (root, client route, or `*.html`).
 *
 * `/@*` are Vite internal modules: they are module requests even without an extension
 * (`/@vite/client`), and answering them with HTML is the blank-page MIME error the
 * oracle documents.
 */
bool documentRequest(const QByteArray &path);

/** Query without `pideck_token`: the LAN access token must never reach the dev server. */
QByteArray stripTokenQuery(const QByteArray &rawQuery);

/** Where one browser request is sent upstream and how its response is judged. */
struct Mapping {
    /** Request target for the dev server: path plus (token-stripped) query. */
    QByteArray upstreamTarget;
    bool document = false;
};

/**
 * Map one browser request onto the dev server.
 *
 * `rawPath` is the still-encoded path and `rawQuery` the raw query, because the oracle
 * forwards `url.pathname + url.search` and Vite's dependency URLs depend on their exact
 * `?v=`/`?t=`/`?import` parameters.
 */
Mapping mapRequest(const QByteArray &rawPath, const QByteArray &rawQuery);

/**
 * Request target for the HMR socket: the browser's own path plus token-stripped query.
 *
 * The path is *not* remapped: Vite's client connects to `/` (or a configured path) and
 * only the query carries its protocol parameters.
 */
QByteArray passthroughTarget(const QByteArray &rawPath, const QByteArray &rawQuery);

/** `Upgrade: websocket` handshake (Vite HMR). */
bool isWebSocketUpgrade(const HttpRequest &request);

/** What to do with one proxied request. */
enum class Action {
    /** 200: pass the upstream head and relay the body. */
    Stream,
    /** Document request without a usable upstream: serve the embedded page. */
    LegacyPage,
    /** Module request without a usable upstream: 503 `webError.internal`. */
    Unavailable,
    /** Upstream answered HTML for a module request: 404 `webError.apiNotFound`. */
    NotFound,
    /** Module request with a non-200 upstream: pass the status through, no body. */
    PassStatus,
};

struct Decision {
    Action action = Action::Unavailable;
    /** Only meaningful for `PassStatus`. */
    int status = 0;
    /** Content type to send; `application/octet-stream` when the upstream had none. */
    QByteArray contentType = QByteArrayLiteral("application/octet-stream");
};

/** Upstream unreachable / timed out / malformed: the oracle's `catch` branch. */
Decision onTransportFailure(bool document);

/**
 * Upstream answered with a complete head.
 *
 * `contentType` is the raw `content-type` header value (empty when absent).
 */
Decision onUpstreamHead(int status, bool document, const QByteArray &contentType);

/**
 * English copy for the two proxy failures.
 *
 * Both strings are the oracle's verbatim `sendError` messages; the code (`webError.*`)
 * and the serializer stay in `LanWebService`.
 */
QString unavailableMessage();

/** `"Not found: " + path`, matching the bundle 404 copy. */
QString notFoundMessage(const QString &requestedPath);

} // namespace webdevproxy
