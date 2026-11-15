#include "HttpResponse.h"

#include <QFile>
#include <QJsonDocument>
#include <QTcpSocket>

namespace {

QByteArray statusText(int status)
{
    switch (status) {
    case 200: return QByteArrayLiteral("OK");
    case 204: return QByteArrayLiteral("No Content");
    case 302: return QByteArrayLiteral("Found");
    case 400: return QByteArrayLiteral("Bad Request");
    case 401: return QByteArrayLiteral("Unauthorized");
    case 403: return QByteArrayLiteral("Forbidden");
    case 404: return QByteArrayLiteral("Not Found");
    case 405: return QByteArrayLiteral("Method Not Allowed");
    case 409: return QByteArrayLiteral("Conflict");
    case 411: return QByteArrayLiteral("Length Required");
    case 413: return QByteArrayLiteral("Payload Too Large");
    case 431: return QByteArrayLiteral("Request Header Fields Too Large");
    case 500: return QByteArrayLiteral("Internal Server Error");
    case 501: return QByteArrayLiteral("Not Implemented");
    // Proxy-shaped statuses (dev renderer relay): a reason phrase, not the generic
    // "Error", because a browser surfaces it in the network panel.
    case 502: return QByteArrayLiteral("Bad Gateway");
    case 503: return QByteArrayLiteral("Service Unavailable");
    case 504: return QByteArrayLiteral("Gateway Timeout");
    case 505: return QByteArrayLiteral("HTTP Version Not Supported");
    default: return QByteArrayLiteral("Error");
    }
}

QByteArray statusLine(int status)
{
    return QByteArrayLiteral("HTTP/1.1 ") + QByteArray::number(status) + ' ' + statusText(status) + "\r\n";
}

} // namespace

namespace httpresponse {

void sendJson(QTcpSocket *socket, int status, const QJsonObject &body)
{
    sendBytes(socket, status, QByteArrayLiteral("application/json; charset=utf-8"),
              QJsonDocument(body).toJson(QJsonDocument::Compact), QByteArrayLiteral("cache-control: no-store\r\n"));
}

void sendBytes(QTcpSocket *socket, int status, const QByteArray &contentType, const QByteArray &body,
               const QByteArray &extraHeaders)
{
    QByteArray head = statusLine(status);
    head += "content-type: " + contentType + "\r\n";
    head += extraHeaders;
    head += "content-length: " + QByteArray::number(body.size()) + "\r\n";
    head += "connection: close\r\n\r\n";
    socket->write(head);
    if (!body.isEmpty()) socket->write(body);
    socket->disconnectFromHost();
}

void sendEmpty(QTcpSocket *socket, int status, const QByteArray &extraHeaders)
{
    QByteArray head = statusLine(status);
    head += extraHeaders;
    head += "content-length: 0\r\n";
    head += "connection: close\r\n\r\n";
    socket->write(head);
    socket->disconnectFromHost();
}

void sendError(QTcpSocket *socket, int status, const QString &message)
{
    sendJson(socket, status, QJsonObject{
        {QStringLiteral("ok"), false},
        {QStringLiteral("error"), QJsonObject{{QStringLiteral("message"), message}}},
    });
}

void sendFile(QTcpSocket *socket, const QString &filePath, const QByteArray &contentType,
              const QByteArray &cacheControl)
{
    QFile file(filePath);
    if (!file.open(QIODevice::ReadOnly)) return sendError(socket, 404, QStringLiteral("Not found"));
    const qint64 size = file.size();
    if (size > kMaxAssetBytes) return sendError(socket, 413, QStringLiteral("Asset exceeds 32 MB"));
    QByteArray head = statusLine(200);
    head += "content-type: " + contentType + "\r\n";
    if (!cacheControl.isEmpty()) head += "cache-control: " + cacheControl + "\r\n";
    head += "content-length: " + QByteArray::number(size) + "\r\n";
    head += "connection: close\r\n\r\n";
    socket->write(head);
    // Stream in bounded chunks so a large asset never has to be resident twice.
    while (!file.atEnd()) {
        const QByteArray chunk = file.read(256 * 1024);
        if (chunk.isEmpty()) break;
        socket->write(chunk);
    }
    socket->disconnectFromHost();
}

} // namespace httpresponse
