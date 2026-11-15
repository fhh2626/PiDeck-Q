#include "WebDevUpstream.h"

#include <QList>

namespace webdevupstream {
namespace {

/** Headers that must never be forwarded to the dev server (credentials / framing). */
bool isDroppedUpgradeHeader(const QByteArray &name)
{
    static const QList<QByteArray> dropped = {
        "host", "origin", "cookie", "authorization", "content-length", "transfer-encoding",
        // Sending `accept-encoding` would make Vite compress; the relay forwards
        // `content-encoding` when present, but identity is the simpler contract.
        "accept-encoding",
    };
    return dropped.contains(name);
}

/**
 * Header value guard for the upstream request.
 *
 * The request parser lower-cases and token-validates header *names*, but a value may
 * still contain a lone CR (a `\r` that was not part of CRLF). Forwarding it verbatim
 * would let a LAN client inject a second header or a request into the dev server, so
 * such a header is skipped instead.
 */
bool isSafeHeaderValue(const QByteArray &value)
{
    for (const char byte : value) {
        const unsigned char c = static_cast<unsigned char>(byte);
        if (c == '\t') continue;
        if (c < 0x20 || c == 0x7f) return false;
    }
    return true;
}

QByteArray targetPath(const webdevproxy::Target &target, const QByteArray &upstreamTarget)
{
    if (target.basePath.isEmpty()) return upstreamTarget;
    return target.basePath.toLatin1() + upstreamTarget;
}

/** Standard phrase for statuses the proxy itself produces or passes through. */
QByteArray defaultReason(int status)
{
    switch (status) {
    case 200: return QByteArrayLiteral("OK");
    case 204: return QByteArrayLiteral("No Content");
    case 301: return QByteArrayLiteral("Moved Permanently");
    case 302: return QByteArrayLiteral("Found");
    case 304: return QByteArrayLiteral("Not Modified");
    case 400: return QByteArrayLiteral("Bad Request");
    case 401: return QByteArrayLiteral("Unauthorized");
    case 403: return QByteArrayLiteral("Forbidden");
    case 404: return QByteArrayLiteral("Not Found");
    case 405: return QByteArrayLiteral("Method Not Allowed");
    case 500: return QByteArrayLiteral("Internal Server Error");
    case 502: return QByteArrayLiteral("Bad Gateway");
    case 503: return QByteArrayLiteral("Service Unavailable");
    case 504: return QByteArrayLiteral("Gateway Timeout");
    default: return QByteArrayLiteral("Error");
    }
}

/** Printable ASCII only; empty when the phrase is unusable. */
QByteArray printableReason(const QByteArray &reason)
{
    if (reason.isEmpty()) return {};
    for (const char byte : reason) {
        const unsigned char c = static_cast<unsigned char>(byte);
        if (c < 0x20 || c > 0x7e) return {};
    }
    return reason.trimmed();
}

} // namespace

QByteArray requestHead(const webdevproxy::Target &target, const QByteArray &upstreamTarget)
{
    QByteArray head = QByteArrayLiteral("GET ") + targetPath(target, upstreamTarget)
        + " HTTP/1.1\r\n";
    head += "host: " + target.hostHeader.toLatin1() + "\r\n";
    head += "accept: */*\r\n";
    // One request per upstream connection: the relay never pipelines, and a close-
    // delimited response (no content-length, no chunked) then ends at EOF exactly as the
    // browser expects.
    head += "connection: close\r\n\r\n";
    return head;
}

QByteArray upgradeHead(const webdevproxy::Target &target, const HttpRequest &request,
                       const QByteArray &upstreamTarget)
{
    QByteArray head = QByteArrayLiteral("GET ") + targetPath(target, upstreamTarget)
        + " HTTP/1.1\r\n";
    head += "host: " + target.hostHeader.toLatin1() + "\r\n";
    head += "origin: " + target.origin.toLatin1() + "\r\n";
    for (auto iterator = request.headers.cbegin(); iterator != request.headers.cend(); ++iterator) {
        if (isDroppedUpgradeHeader(iterator.key())) continue;
        if (!isSafeHeaderValue(iterator.value())) continue;
        head += iterator.key() + ": " + iterator.value() + "\r\n";
    }
    head += "\r\n";
    return head;
}

bool parseHead(const QByteArray &block, ResponseHead *out)
{
    if (!out) return false;
    const QList<QByteArray> lines = block.split('\n');
    if (lines.isEmpty()) return false;

    QByteArray statusText = lines.first();
    if (statusText.endsWith('\r')) statusText.chop(1);
    const QList<QByteArray> parts = statusText.split(' ');
    if (parts.size() < 2) return false;
    if (!parts.at(0).startsWith(QByteArrayLiteral("HTTP/1."))) return false;
    bool ok = false;
    const int status = parts.at(1).toInt(&ok);
    if (!ok || status < 100 || status > 599) return false;

    ResponseHead head;
    head.status = status;
    if (parts.size() > 2) head.reason = parts.mid(2).join(' ');

    for (int index = 1; index < lines.size(); ++index) {
        QByteArray line = lines.at(index);
        if (line.endsWith('\r')) line.chop(1);
        if (line.isEmpty()) continue;
        const qsizetype separator = line.indexOf(':');
        if (separator <= 0) return false;
        const QByteArray name = line.left(separator).trimmed().toLower();
        const QByteArray value = line.mid(separator + 1).trimmed();
        if (name == "content-type") {
            if (!value.isEmpty()) head.contentType = value;
        } else if (name == "content-encoding") {
            head.contentEncoding = value;
        } else if (name == "content-length") {
            head.contentLength = value;
        } else if (name == "transfer-encoding") {
            head.chunked = value.toLower().contains("chunked");
        }
    }
    *out = head;
    return true;
}

QByteArray statusLine(int status, const QByteArray &upstreamReason)
{
    QByteArray reason = printableReason(upstreamReason);
    if (reason.isEmpty()) reason = defaultReason(status);
    return QByteArrayLiteral("HTTP/1.1 ") + QByteArray::number(status) + ' ' + reason + "\r\n";
}

QByteArray downstreamHead(const ResponseHead &head)
{
    QByteArray out = statusLine(head.status, head.reason);
    out += "content-type: " + head.contentType + "\r\n";
    // The dev bundle must never be cached: a stale hashed chunk name is exactly the
    // failure mode the proxy's 404 branch exists for.
    out += "cache-control: no-store\r\n";
    if (!head.contentEncoding.isEmpty()) out += "content-encoding: " + head.contentEncoding + "\r\n";
    if (!head.contentLength.isEmpty()) {
        out += "content-length: " + head.contentLength + "\r\n";
    } else if (head.chunked) {
        // The relay forwards the body bytes verbatim, so upstream chunk framing stays
        // valid and is declared as such instead of being re-framed here.
        out += "transfer-encoding: chunked\r\n";
    }
    out += "connection: close\r\n\r\n";
    return out;
}

QByteArray emptyHead(int status, const QByteArray &contentType)
{
    const QByteArray type = contentType.trimmed().isEmpty()
        ? QByteArrayLiteral("application/octet-stream")
        : contentType.trimmed();
    QByteArray out = statusLine(status, {});
    out += "content-type: " + type + "\r\n";
    out += "cache-control: no-store\r\n";
    out += "content-length: 0\r\n";
    out += "connection: close\r\n\r\n";
    return out;
}

} // namespace webdevupstream
