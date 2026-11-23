#include "MimeTypes.h"

#include <QFileInfo>
#include <QHash>

QByteArray contentTypeForPath(const QString &path)
{
    static const QHash<QString, QByteArray> types = {
        {QStringLiteral("html"), QByteArrayLiteral("text/html; charset=utf-8")},
        {QStringLiteral("js"), QByteArrayLiteral("text/javascript; charset=utf-8")},
        {QStringLiteral("mjs"), QByteArrayLiteral("text/javascript; charset=utf-8")},
        {QStringLiteral("css"), QByteArrayLiteral("text/css; charset=utf-8")},
        {QStringLiteral("json"), QByteArrayLiteral("application/json; charset=utf-8")},
        {QStringLiteral("map"), QByteArrayLiteral("application/json; charset=utf-8")},
        {QStringLiteral("svg"), QByteArrayLiteral("image/svg+xml")},
        {QStringLiteral("png"), QByteArrayLiteral("image/png")},
        {QStringLiteral("jpg"), QByteArrayLiteral("image/jpeg")},
        {QStringLiteral("jpeg"), QByteArrayLiteral("image/jpeg")},
        {QStringLiteral("webp"), QByteArrayLiteral("image/webp")},
        {QStringLiteral("gif"), QByteArrayLiteral("image/gif")},
        {QStringLiteral("avif"), QByteArrayLiteral("image/avif")},
        {QStringLiteral("ico"), QByteArrayLiteral("image/x-icon")},
        {QStringLiteral("woff"), QByteArrayLiteral("font/woff")},
        {QStringLiteral("woff2"), QByteArrayLiteral("font/woff2")},
        {QStringLiteral("ttf"), QByteArrayLiteral("font/ttf")},
        {QStringLiteral("wasm"), QByteArrayLiteral("application/wasm")},
        {QStringLiteral("txt"), QByteArrayLiteral("text/plain; charset=utf-8")},
    };
    const QString suffix = QFileInfo(path).suffix().toLower();
    return types.value(suffix, QByteArrayLiteral("application/octet-stream"));
}
