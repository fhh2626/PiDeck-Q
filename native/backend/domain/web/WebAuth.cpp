#include "WebAuth.h"

#include <QList>
#include <QUrl>

namespace {

/** 30 days, matching COOKIE_MAX_AGE_SECONDS in webServiceAuth.ts. */
constexpr int kCookieMaxAgeSeconds = 30 * 24 * 60 * 60;

/** Percent-decode one query component; `+` is a space per application/x-www-form-urlencoded. */
QString decodeQueryComponent(const QByteArray &raw)
{
    QByteArray normalized = raw;
    normalized.replace('+', ' ');
    return QUrl::fromPercentEncoding(normalized);
}

/**
 * First value of a query parameter, using URLSearchParams semantics.
 *
 * Returns false when the parameter is absent; `value` is empty for `?name=` and for
 * a bare `?name`. Auth must distinguish "absent" from "present but empty", because an
 * empty token is an explicit failing attempt, not a missing parameter.
 */
bool queryParameter(const QByteArray &query, const QString &name, QString *value)
{
    if (query.isEmpty()) return false;
    for (const QByteArray &pair : query.split('&')) {
        const int separator = pair.indexOf('=');
        const QByteArray rawKey = separator < 0 ? pair : pair.left(separator);
        if (decodeQueryComponent(rawKey) != name) continue;
        *value = separator < 0 ? QString() : decodeQueryComponent(pair.mid(separator + 1));
        return true;
    }
    return false;
}

/** `?pideck_token=` / `?pideck_token` anywhere in the query. */
bool hasQueryParameter(const QByteArray &query, const QString &name)
{
    QString ignored;
    return queryParameter(query, name, &ignored);
}

/**
 * `url.pathname + url.search` with `pideck_token` removed.
 *
 * The oracle rebuilds the URL through WHATWG `URL`/`URLSearchParams`, which re-encodes
 * every remaining parameter. Re-serializing the raw pairs instead keeps the client's
 * original encoding; the only observable difference is the exact escape form in the
 * `Location` header, which no consumer depends on.
 */
QString cleanedLocation(const QByteArray &rawPath, const QByteArray &query)
{
    QList<QByteArray> kept;
    if (!query.isEmpty()) {
        for (const QByteArray &pair : query.split('&')) {
            const int separator = pair.indexOf('=');
            const QByteArray rawKey = separator < 0 ? pair : pair.left(separator);
            if (decodeQueryComponent(rawKey) == QLatin1String("pideck_token")) continue;
            kept.append(pair);
        }
    }
    QString location = QString::fromUtf8(rawPath);
    if (location.isEmpty()) location = QStringLiteral("/");
    if (!kept.isEmpty()) {
        location += QLatin1Char('?');
        location += QString::fromUtf8(kept.join('&'));
    }
    return location;
}

} // namespace

namespace webauth {

QString cookieName(int port)
{
    return QStringLiteral("pideck_web_token_%1").arg(port);
}

QString readCookie(const QByteArray &cookieHeader, const QString &name)
{
    if (cookieHeader.isEmpty()) return {};
    for (const QByteArray &part : cookieHeader.split(';')) {
        const int index = part.indexOf('=');
        if (index < 0) continue;
        if (QString::fromUtf8(part.left(index)).trimmed() != name) continue;
        return QString::fromUtf8(part.mid(index + 1)).trimmed();
    }
    return {};
}

bool tokensEqual(const QString &expected, const QString &actual)
{
    if (expected.isEmpty() || actual.isEmpty()) return false;
    const QByteArray left = expected.toUtf8();
    const QByteArray right = actual.toUtf8();
    if (left.size() != right.size()) return false;
    // Volatile accumulator: the loop must not be short-circuited by the optimizer into
    // an early-exit comparison, which is the whole point of a constant-time check.
    volatile unsigned char difference = 0;
    for (int index = 0; index < left.size(); ++index) {
        difference = difference | static_cast<unsigned char>(left.at(index) ^ right.at(index));
    }
    return difference == 0;
}

Decision authorize(const RequestView &request, int port, const QString &expectedToken)
{
    Decision decision;
    if (request.rawPath == QByteArrayLiteral("/api/health")) {
        decision.kind = Kind::Public;
        return decision;
    }

    const bool safeMethod = request.method == "GET" || request.method == "HEAD"
        || request.method == "OPTIONS";
    if (!safeMethod && !request.origin.isEmpty()) {
        QByteArray expectedOrigin = QByteArrayLiteral("http://") + request.host;
        if (request.origin != expectedOrigin) {
            decision.kind = Kind::ForbiddenOrigin;
            return decision;
        }
    }

    QString queryToken;
    if (queryParameter(request.query, QStringLiteral("pideck_token"), &queryToken)) {
        if (request.method != "GET" || !tokensEqual(expectedToken, queryToken)) {
            decision.kind = Kind::Unauthorized;
            return decision;
        }
        decision.kind = Kind::Exchange;
        decision.location = cleanedLocation(request.rawPath, request.query);
        decision.setCookie = QStringLiteral("%1=%2; Path=/; HttpOnly; SameSite=Strict; Max-Age=%3")
                                 .arg(cookieName(port), queryToken)
                                 .arg(kCookieMaxAgeSeconds);
        return decision;
    }

    if (request.authorization.startsWith(QByteArrayLiteral("Bearer "))) {
        const QString bearer = QString::fromUtf8(request.authorization.mid(7)).trimmed();
        if (tokensEqual(expectedToken, bearer)) {
            decision.kind = Kind::Authorized;
            return decision;
        }
    }
    const QString cookie = readCookie(request.cookie, cookieName(port));
    if (tokensEqual(expectedToken, cookie)) {
        decision.kind = Kind::Authorized;
        return decision;
    }
    decision.kind = Kind::Unauthorized;
    return decision;
}

} // namespace webauth
