#include "WebDevProxyPlan.h"

#include <QHostAddress>
#include <QList>
#include <QUrl>

namespace webdevproxy {
namespace {

/** `application/x-www-form-urlencoded` semantics: `+` is a space. */
QString decodeQueryComponent(QByteArray raw)
{
    raw.replace('+', ' ');
    return QUrl::fromPercentEncoding(raw);
}

} // namespace
bool parseTarget(const QString &raw, Target *out, QString *error)
{
    const auto fail = [error](const QString &message) {
        if (error) *error = message;
        return false;
    };
    const QString trimmed = raw.trimmed();
    if (trimmed.isEmpty()) return fail(QStringLiteral("dev renderer URL is empty"));

    const QUrl url(trimmed, QUrl::StrictMode);
    if (!url.isValid()) return fail(QStringLiteral("dev renderer URL is not a valid URL"));
    // Vite's plain-text HMR path is `ws://` on the same origin; TLS would need a
    // certificate the dev server does not have by default, so `https` is not supported
    // here and is refused instead of being silently downgraded.
    if (url.scheme().compare(QLatin1String("http"), Qt::CaseInsensitive) != 0) {
        return fail(QStringLiteral("dev renderer URL must use http://"));
    }
    if (!url.userInfo().isEmpty()) {
        return fail(QStringLiteral("dev renderer URL must not carry credentials"));
    }
    if (!url.query().isEmpty() || url.hasFragment()) {
        return fail(QStringLiteral("dev renderer URL must not carry a query or fragment"));
    }

    const QString host = url.host();
    if (host.isEmpty()) return fail(QStringLiteral("dev renderer URL has no host"));
    bool loopback = host.compare(QLatin1String("localhost"), Qt::CaseInsensitive) == 0;
    if (!loopback) {
        QHostAddress address;
        loopback = address.setAddress(host) && address.isLoopback();
    }
    if (!loopback) {
        return fail(QStringLiteral("dev renderer host must be a loopback address"));
    }

    const int port = url.port(80);
    if (port < 1 || port > 65535) return fail(QStringLiteral("dev renderer port is out of range"));

    // The base path is a prefix that the oracle's `${devRendererUrl}${targetPath}` also
    // supported. `..` is refused: the proxy must not be usable to walk a dev server's
    // parent directories through a crafted base URL.
    QString basePath = url.path();
    if (basePath.contains(QLatin1String(".."))) {
        return fail(QStringLiteral("dev renderer URL must not contain '..'"));
    }
    while (basePath.endsWith(QLatin1Char('/'))) basePath.chop(1);

    const bool ipv6 = host.contains(QLatin1Char(':'));
    QString hostHeader = ipv6 ? QStringLiteral("[%1]").arg(host) : host;
    if (port != 80) hostHeader += QStringLiteral(":%1").arg(port);

    if (out) {
        Target target;
        target.valid = true;
        target.host = host;
        target.port = quint16(port);
        target.origin = QStringLiteral("http://") + hostHeader;
        target.hostHeader = hostHeader;
        target.basePath = basePath;
        *out = target;
    }
    return true;
}

bool hasExtension(const QByteArray &path)
{
    const qsizetype slash = path.lastIndexOf('/');
    const qsizetype dot = path.lastIndexOf('.');
    // `/.well-known` is a hidden directory name, not an extension.
    return dot > slash + 1;
}

bool documentRequest(const QByteArray &path)
{
    if (path.startsWith(QByteArrayLiteral("/@"))) return false;
    if (path == QByteArrayLiteral("/") || !hasExtension(path)) return true;
    return path.size() >= 5 && path.right(5).toLower() == QByteArrayLiteral(".html");
}

QByteArray stripTokenQuery(const QByteArray &rawQuery)
{
    if (rawQuery.isEmpty()) return {};
    QList<QByteArray> kept;
    for (const QByteArray &pair : rawQuery.split('&')) {
        const qsizetype separator = pair.indexOf('=');
        const QByteArray key = separator < 0 ? pair : pair.left(separator);
        if (decodeQueryComponent(key) == QLatin1String("pideck_token")) continue;
        kept.append(pair);
    }
    return kept.join('&');
}

Mapping mapRequest(const QByteArray &rawPath, const QByteArray &rawQuery)
{
    const QByteArray path = rawPath.isEmpty() ? QByteArrayLiteral("/") : rawPath;
    Mapping mapping;
    mapping.document = documentRequest(path);

    // `/@*` (Vite internals) and `/api/*` are forwarded as they are. `/api/*` normally
    // never reaches the proxy (the route table answers or 404s first); it is kept here
    // because the oracle's mapping includes it and dropping it would silently rewrite a
    // path if a future route changes.
    const bool passthrough = path.startsWith(QByteArrayLiteral("/@"))
        || path.startsWith(QByteArrayLiteral("/api/"));
    QByteArray target;
    if (passthrough) {
        target = path;
    } else if (path == QByteArrayLiteral("/") || !hasExtension(path)) {
        // Client routes all load the web entry document. The oracle drops the query on
        // this branch (`"/web.html"`), so it is dropped here too.
        return Mapping{QByteArrayLiteral("/web.html"), mapping.document};
    } else {
        target = path;
    }
    const QByteArray query = stripTokenQuery(rawQuery);
    if (!query.isEmpty()) {
        target += '?';
        target += query;
    }
    mapping.upstreamTarget = target;
    return mapping;
}

QByteArray passthroughTarget(const QByteArray &rawPath, const QByteArray &rawQuery)
{
    QByteArray target = rawPath.isEmpty() ? QByteArrayLiteral("/") : rawPath;
    const QByteArray query = stripTokenQuery(rawQuery);
    if (!query.isEmpty()) {
        target += '?';
        target += query;
    }
    return target;
}

bool isWebSocketUpgrade(const HttpRequest &request)
{
    // Browsers always send both headers; requiring both keeps a plain GET with a stray
    // `Upgrade` header on the asset path instead of handing it to the HMR relay.
    if (request.method != "GET") return false;
    if (!request.header("upgrade").toLower().contains("websocket")) return false;
    return request.header("connection").toLower().contains("upgrade");
}

Decision onTransportFailure(bool document)
{
    Decision decision;
    if (document) {
        decision.action = Action::LegacyPage;
        return decision;
    }
    decision.action = Action::Unavailable;
    decision.status = 503;
    return decision;
}

Decision onUpstreamHead(int status, bool document, const QByteArray &contentType)
{
    const QByteArray type = contentType.trimmed();
    Decision decision;
    decision.contentType = type.isEmpty() ? QByteArrayLiteral("application/octet-stream") : type;

    if (status != 200) {
        if (document) {
            decision.action = Action::LegacyPage;
            return decision;
        }
        decision.action = Action::PassStatus;
        decision.status = status;
        return decision;
    }
    // Vite answers an unknown path with its SPA fallback: 200 plus `index.html`. A module
    // request served that HTML fails as a MIME error and leaves a blank page, so it is
    // reported as missing instead.
    if (!document && decision.contentType.toLower().contains("text/html")) {
        decision.action = Action::NotFound;
        return decision;
    }
    decision.action = Action::Stream;
    return decision;
}

QString unavailableMessage()
{
    return QStringLiteral("Renderer dev server not ready");
}

QString notFoundMessage(const QString &requestedPath)
{
    return QStringLiteral("Not found: ") + requestedPath;
}

} // namespace webdevproxy
