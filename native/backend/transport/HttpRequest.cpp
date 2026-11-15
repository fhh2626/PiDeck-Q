#include "HttpRequest.h"

#include <QUrl>

namespace {

bool isTokenChar(char value)
{
    const unsigned char c = static_cast<unsigned char>(value);
    if (c <= 0x20 || c >= 0x7f) return false;
    switch (c) {
    case '(': case ')': case '<': case '>': case '@': case ',': case ';': case ':':
    case '\\': case '"': case '/': case '[': case ']': case '?': case '=': case '{':
    case '}':
        return false;
    default:
        return true;
    }
}

bool isKnownMethod(const QByteArray &method)
{
    static const QList<QByteArray> methods = {
        "GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS",
    };
    return methods.contains(method);
}

int hexValue(char value)
{
    if (value >= '0' && value <= '9') return value - '0';
    if (value >= 'a' && value <= 'f') return value - 'a' + 10;
    if (value >= 'A' && value <= 'F') return value - 'A' + 10;
    return -1;
}

} // namespace

bool percentDecodePath(const QByteArray &raw, QByteArray *decoded)
{
    QByteArray result;
    result.reserve(raw.size());
    for (qsizetype index = 0; index < raw.size(); ++index) {
        const char value = raw.at(index);
        if (value != '%') {
            // Reject raw control characters: they never appear in a legitimate path
            // and would otherwise reach the filesystem layer verbatim.
            const unsigned char c = static_cast<unsigned char>(value);
            if (c < 0x20 || c == 0x7f) return false;
            result.append(value);
            continue;
        }
        if (index + 2 >= raw.size()) return false;
        const int high = hexValue(raw.at(index + 1));
        const int low = hexValue(raw.at(index + 2));
        if (high < 0 || low < 0) return false;
        const char decodedValue = static_cast<char>((high << 4) | low);
        if (decodedValue == '\0') return false;
        result.append(decodedValue);
        index += 2;
    }
    if (decoded) *decoded = result;
    return true;
}

QString HttpRequest::queryParameter(const QByteArray &name) const
{
    if (query.isEmpty()) return {};
    const QList<QByteArray> pairs = query.split('&');
    for (const QByteArray &pair : pairs) {
        const int separator = pair.indexOf('=');
        const QByteArray key = separator < 0 ? pair : pair.left(separator);
        if (key != name) continue;
        const QByteArray rawValue = separator < 0 ? QByteArray{} : pair.mid(separator + 1);
        return QUrl::fromPercentEncoding(rawValue);
    }
    return {};
}

HttpRequestParser::HttpRequestParser(qint64 maxBodyBytes, int maxHeaderBytes, int maxTargetBytes)
    : m_maxBodyBytes(maxBodyBytes), m_maxHeaderBytes(maxHeaderBytes), m_maxTargetBytes(maxTargetBytes)
{
}

void HttpRequestParser::reset()
{
    m_buffer.clear();
    m_request = HttpRequest{};
    m_status = Status::NeedMore;
    m_error.clear();
    m_consumed = 0;
    m_contentLength = -1;
    m_headParsed = false;
    m_headBytes = 0;
}

HttpRequestParser::Status HttpRequestParser::fail(Status status, const QString &error)
{
    m_status = status;
    m_error = error;
    return status;
}

HttpRequestParser::Status HttpRequestParser::feed(const QByteArray &chunk)
{
    if (m_status != Status::NeedMore) return m_status;
    m_buffer.append(chunk);
    // The head may have completed on an earlier read while the body is still arriving.
    // Re-parsing it would treat the same bytes as a second header block.
    return m_headParsed ? parseBody() : parseHead();
}

HttpRequestParser::Status HttpRequestParser::parseHead()
{
    const int headerEnd = m_buffer.indexOf("\r\n\r\n");
    if (headerEnd < 0) {
        if (m_buffer.size() > m_maxHeaderBytes) {
            return fail(Status::HeaderTooLarge, QStringLiteral("Request headers exceed the size limit"));
        }
        return Status::NeedMore;
    }
    if (headerEnd > m_maxHeaderBytes) {
        return fail(Status::HeaderTooLarge, QStringLiteral("Request headers exceed the size limit"));
    }

    const QByteArray head = m_buffer.left(headerEnd);
    const QList<QByteArray> lines = head.split('\n');
    if (lines.isEmpty()) return fail(Status::BadRequest, QStringLiteral("Malformed request"));

    // Request line: METHOD SP request-target SP HTTP-version.
    QByteArray requestLine = lines.first();
    if (requestLine.endsWith('\r')) requestLine.chop(1);
    const QList<QByteArray> parts = requestLine.split(' ');
    if (parts.size() != 3) return fail(Status::BadRequest, QStringLiteral("Malformed request line"));
    if (parts.at(0).isEmpty() || parts.at(0).size() > 16) {
        return fail(Status::BadRequest, QStringLiteral("Malformed request method"));
    }
    if (!isKnownMethod(parts.at(0))) return fail(Status::MethodNotAllowed, QStringLiteral("Method not allowed"));
    if (parts.at(1).isEmpty() || parts.at(1).size() > m_maxTargetBytes) {
        return fail(Status::BadRequest, QStringLiteral("Request target is invalid"));
    }
    if (parts.at(2) != "HTTP/1.1" && parts.at(2) != "HTTP/1.0") {
        return fail(Status::VersionNotSupported, QStringLiteral("Unsupported HTTP version"));
    }
    m_request.method = parts.at(0);
    m_request.target = parts.at(1);
    m_request.version = parts.at(2);

    // Only origin-form targets are served. Absolute-form ("http://host/path") is a
    // proxy request and "//host/path" is a protocol-relative escape.
    if (!m_request.target.startsWith('/') || m_request.target.startsWith("//")) {
        return fail(Status::BadRequest, QStringLiteral("Unsupported request target form"));
    }
    const int queryStart = m_request.target.indexOf('?');
    const QByteArray rawPath = queryStart < 0 ? m_request.target : m_request.target.left(queryStart);
    m_request.query = queryStart < 0 ? QByteArray{} : m_request.target.mid(queryStart + 1);
    if (!percentDecodePath(rawPath, &m_request.path)) {
        return fail(Status::BadRequest, QStringLiteral("Malformed request path"));
    }
    if (!m_request.path.startsWith('/')) return fail(Status::BadRequest, QStringLiteral("Malformed request path"));

    bool sawContentLength = false;
    bool sawTransferEncoding = false;
    for (int index = 1; index < lines.size(); ++index) {
        QByteArray line = lines.at(index);
        if (line.endsWith('\r')) line.chop(1);
        if (line.isEmpty()) continue;
        // Obsolete line folding is a request-smuggling vector: reject instead of joining.
        if (line.startsWith(' ') || line.startsWith('\t')) {
            return fail(Status::BadRequest, QStringLiteral("Folded headers are not supported"));
        }
        const int separator = line.indexOf(':');
        if (separator <= 0) return fail(Status::BadRequest, QStringLiteral("Malformed header"));
        const QByteArray name = line.left(separator).trimmed().toLower();
        if (name.isEmpty()) return fail(Status::BadRequest, QStringLiteral("Malformed header"));
        for (const char c : name) {
            if (!isTokenChar(c)) return fail(Status::BadRequest, QStringLiteral("Malformed header name"));
        }
        const QByteArray value = line.mid(separator + 1).trimmed();
        if (m_request.headers.contains(name)) {
            // Duplicate Content-Length is a classic smuggling primitive; Node's http
            // parser rejects it and so do we. Other duplicates are harmless (the last
            // value wins) but Content-Length must be unambiguous.
            if (name == "content-length") {
                return fail(Status::BadRequest, QStringLiteral("Duplicate Content-Length header"));
            }
            m_request.headers.insert(name, value);
            continue;
        }
        m_request.headers.insert(name, value);
        if (name == "content-length") {
            sawContentLength = true;
            bool ok = false;
            const qint64 length = value.toLongLong(&ok);
            if (!ok || length < 0) return fail(Status::BadRequest, QStringLiteral("Invalid Content-Length header"));
            m_contentLength = length;
        } else if (name == "transfer-encoding") {
            sawTransferEncoding = true;
        }
    }

    if (sawTransferEncoding) {
        // Length-delimited bodies only. Answering 400 is explicit; silently ignoring
        // the header would let the remaining bytes be parsed as a second request.
        return fail(Status::UnsupportedTransferEncoding, QStringLiteral("Transfer-Encoding is not supported"));
    }
    if (m_request.version == "HTTP/1.1" && !m_request.headers.contains("host")) {
        return fail(Status::BadRequest, QStringLiteral("Missing Host header"));
    }
    if (m_contentLength > m_maxBodyBytes) {
        return fail(Status::PayloadTooLarge, QStringLiteral("Request body exceeds 32 MB"));
    }
    if (!sawContentLength && (m_request.method == "POST" || m_request.method == "PUT" || m_request.method == "PATCH")) {
        // A body-bearing method without Content-Length would be read as an empty body
        // and the payload would be interpreted as a follow-up request.
        return fail(Status::LengthRequired, QStringLiteral("Content-Length is required"));
    }

    const qsizetype headBytes = headerEnd + 4;
    // Headers are parsed once; `parseBody` only waits for the declared length. Keeping
    // the buffered head here is what lets a >socket-read body complete correctly.
    m_headParsed = true;
    m_headBytes = headBytes;
    return parseBody();
}

HttpRequestParser::Status HttpRequestParser::parseBody()
{
    const qint64 bodyLength = m_contentLength > 0 ? m_contentLength : 0;
    if (m_buffer.size() < m_headBytes + bodyLength) return Status::NeedMore;
    m_request.body = m_buffer.mid(m_headBytes, bodyLength);
    m_consumed = m_headBytes + bodyLength;
    m_status = Status::Complete;
    return m_status;
}
