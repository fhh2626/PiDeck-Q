#pragma once

#include <QByteArray>
#include <QJsonObject>
#include <QString>

class QTcpSocket;

/**
 * HTTP/1.1 response serialization for the loopback renderer server.
 *
 * Every response is single-shot: the connection is closed after the body is
 * queued, so there is no keep-alive state to track. SSE responses are written by
 * the server directly because they stay open.
 */
namespace httpresponse {

constexpr qint64 kMaxAssetBytes = 32LL * 1024LL * 1024LL;

void sendJson(QTcpSocket *socket, int status, const QJsonObject &body);
void sendBytes(QTcpSocket *socket, int status, const QByteArray &contentType, const QByteArray &body,
               const QByteArray &extraHeaders = {});
void sendEmpty(QTcpSocket *socket, int status, const QByteArray &extraHeaders = {});
void sendError(QTcpSocket *socket, int status, const QString &message);
/** Stream a file in bounded chunks; refuses files above kMaxAssetBytes. */
void sendFile(QTcpSocket *socket, const QString &filePath, const QByteArray &contentType,
              const QByteArray &cacheControl = {});

} // namespace httpresponse
