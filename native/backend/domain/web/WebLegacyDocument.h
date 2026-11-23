#pragma once

#include <QByteArray>

/**
 * Embedded LAN web client document (port of `WebServiceManager.renderPage()`).
 *
 * The oracle's page is one TS template literal with exactly one dynamic value: the
 * client dictionaries (`const dictionaries = …`). Both halves are carried here
 * *verbatim* (the emitted bytes, not the TypeScript source), so the served page can be
 * compared against the oracle template by a test instead of by eye:
 * `tests/helpers/native2LegacyWebOracle.mjs` decodes the same literal and
 * `tests/native2LegacyWebClient.test.mjs` asserts byte equality around the
 * dictionaries.
 *
 * Embedded rather than shipped as a file because this document is also the
 * *no-bundle* fallback: it must be servable when `app/renderer/web.html` is missing
 * from an install, so it cannot live in the bundle it is replacing.
 *
 * Generated — do not edit by hand. Regenerate from the oracle with:
 *
 *   node tests/fixtures/regen-legacy-web-page.mjs
 */
namespace weblegacy {

/** Head, styles, markup, `<script>` and the opening `const dictionaries = `. */
QByteArray documentPrefix();

/** From the `;` that ends the dictionaries statement to `</html>`. */
QByteArray documentSuffix();

} // namespace weblegacy
