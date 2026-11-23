#pragma once

#include <QByteArray>
#include <QString>

/**
 * Port of `src/main/web/webServiceAuth.ts`.
 *
 * LAN clients are fully untrusted: they are browsers on the local network, so the
 * auth decision has to reproduce the oracle's ordering exactly. The ordering is the
 * security property — `/api/health` before everything, the cross-origin check before
 * any token comparison, and the query-token exchange only for GET.
 *
 * Deliberately header-only inputs (method/path/query/host/origin/authorization/cookie)
 * instead of a request object: this layer stays testable without a socket.
 */
namespace webauth {

/** `pideck_web_token_<port>`; the port is part of the name so two instances don't clash. */
QString cookieName(int port);

/** Cookie value for `name`, or an empty string when absent/valueless. */
QString readCookie(const QByteArray &cookieHeader, const QString &name);

/**
 * Constant-time comparison.
 *
 * An empty expected token always fails: a disabled/absent token must never authorize
 * anything (fail closed). Length is compared first because constant-time comparison
 * of different lengths is not meaningful, which is exactly what `timingSafeEqual`
 * would throw on; the oracle guards the same way.
 */
bool tokensEqual(const QString &expected, const QString &actual);

enum class Kind {
    /** `/api/health` — reachable without a token. */
    Public,
    Authorized,
    /** Valid `?pideck_token=` on GET: 302 to the cleaned URL and set the cookie. */
    Exchange,
    Unauthorized,
    /** Non-safe method with a cross-site Origin (CSRF / DNS rebinding). */
    ForbiddenOrigin,
};

struct Decision {
    Kind kind = Kind::Unauthorized;
    /** Exchange only: path + query with `pideck_token` removed, no scheme/host. */
    QString location;
    /** Exchange only: `Set-Cookie` value. */
    QString setCookie;
};

struct RequestView {
    QByteArray method;
    /** Percent-encoded path as received (no query). Routes are matched on this form. */
    QByteArray rawPath;
    /** Raw query string without the leading '?'. */
    QByteArray query;
    QByteArray host;
    QByteArray origin;
    QByteArray authorization;
    QByteArray cookie;
};

/**
 * Decision order (webServiceAuth.ts):
 *   1. `/api/health` is public;
 *   2. unsafe method + cross-origin Origin -> forbidden;
 *   3. `?pideck_token=`: GET and correct -> exchange, otherwise unauthorized;
 *   4. `Authorization: Bearer` or the cookie -> authorized;
 *   5. otherwise unauthorized.
 */
Decision authorize(const RequestView &request, int port, const QString &expectedToken);

} // namespace webauth
