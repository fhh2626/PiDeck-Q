#pragma once

#include <QByteArray>
#include <QString>

/**
 * Browser bundle resolution for the LAN web service (port of `serveRenderer`).
 *
 * The web client is a separate entry point (`web.html`) in the same bundle as the
 * desktop shell, so the resolution rules differ from the loopback renderer server:
 *  - `/` and extension-less paths prefer `web.html` and fall back to `index.html`;
 *  - a missing *resource* is a 404, never HTML — a browser parsing HTML as a module
 *    script reports a MIME error and shows a blank page;
 *  - a missing document falls back to the embedded page (WebLegacyPage.h) so the
 *    browser is never blank;
 *  - anything escaping the bundle root is refused.
 */
namespace webassets {

enum class Kind {
    File,
    /** Document request with no bundle: serve `fallbackPage()`. */
    Fallback,
    /** A real asset path that does not exist: 404. */
    NotFound,
    /** Path escaped the bundle root (.., symlink, other drive): 404 as well. */
    Forbidden,
};

struct Resolution {
    Kind kind = Kind::Fallback;
    QString path;
};

Resolution resolve(const QString &root, const QByteArray &decodedPath);

/** Cache-Control for a bundle file: the entry document must not be cached. */
QByteArray cacheControlFor(const QString &filePath);

} // namespace webassets
