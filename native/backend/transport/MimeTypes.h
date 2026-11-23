#pragma once

#include <QByteArray>
#include <QString>

/**
 * Extension -> Content-Type map for the renderer bundle and background images.
 * Mirrors the MIME_TYPES table in src/native-node/transport/NativeRendererServer.ts
 * so the page and its assets are served with the same types as the Node sidecar.
 */
QByteArray contentTypeForPath(const QString &path);
