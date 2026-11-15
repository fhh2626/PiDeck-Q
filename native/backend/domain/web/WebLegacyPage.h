#pragma once

#include <QByteArray>

/**
 * The embedded LAN web client page (port of `WebServiceManager.renderPage()`).
 *
 * One document, assembled from the oracle's verbatim template (WebLegacyDocument.cpp /
 * WebLegacyScript.cpp) plus the client dictionaries. Served in two situations, exactly
 * like the oracle:
 *
 *   - `?view=legacy` — the explicit "show me the old vanilla client" switch;
 *   - no bundle — a document request that resolves to no `web.html`/`index.html`.
 *
 * The second case is why this cannot be a file in the renderer bundle: it replaces the
 * bundle when the bundle is missing. The page therefore has no external dependencies
 * (inline CSS and script) and talks to the same `/api/*` HTTP surface as the React web
 * client.
 */
namespace weblegacy {

/** Complete HTML document, ready for `text/html; charset=utf-8`. */
QByteArray page();

} // namespace weblegacy
