#pragma once

#include <QByteArray>
#include <QString>

/**
 * Renderer bundle file resolution (static assets + SPA fallback).
 *
 * Resolution rules mirror NativeRendererServer.serveStatic:
 *   - "/" and extension-less paths map to index.html (SPA routes);
 *   - a missing asset falls back to index.html so client-side routing works;
 *   - anything that escapes the renderer root (.., symlink, junction, other drive)
 *     is refused instead of served;
 *   - files above the frame budget are refused with 413.
 */
namespace staticfiles {

enum class Kind { File, NotFound, Forbidden, TooLarge };

struct Resolution {
    Kind kind = Kind::NotFound;
    QString path;
    qint64 size = 0;
};

Resolution resolve(const QString &root, const QByteArray &decodedPath, qint64 maxBytes);

/** True when `candidate` is the root itself or a descendant of it. */
bool isInsideRoot(const QString &root, const QString &candidate);

} // namespace staticfiles
