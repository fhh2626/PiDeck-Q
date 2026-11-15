#pragma once

#include "MainCopy.h"

#include <QByteArray>
#include <QJsonObject>

/**
 * Client dictionary for the embedded LAN web page (port of `WebI18n.ts`).
 *
 * The page localizes itself in the browser from one JSON object indexed by locale:
 *
 *   - `web.*`      UI chrome (titles, buttons, statuses, roles);
 *   - `webError.*` API failures, keyed by the response `code`;
 *   - main-process keys, because a timeline row carries `meta.i18nKey` (for example
 *     `diagnostic.promptRejected`) and the page renders that descriptor. The oracle
 *     spreads the whole `mainProcessCopy` into the dictionary for the same reason; the
 *     C++ side spreads exactly the keys this backend can emit, so every key that can
 *     appear in a message is present.
 *
 * Deliberately not localized here: the page's own language detection. It picks
 * `zh-CN`/`en-US` from `navigator.languages`, and the dictionary supplies both, so the
 * backend's settings `language` does not restrict what a phone can display.
 */
namespace webclientcopy {

/** `web.*` chrome copy for one locale. */
QJsonObject uiEntries(maincopy::Locale locale);

/** One locale table: main-process copy + `webError.*` + `web.*` (later wins). */
QJsonObject localeTable(maincopy::Locale locale);

/** `{"zh-CN": {...}, "en-US": {...}}` as the page's `dictionaries` object. */
QJsonObject dictionaries();

/**
 * `dictionaries()` as compact JSON, ready to inline into the page script.
 *
 * `<` is escaped to `\u003c` exactly like `serializeWebClientDictionaries()`. Without
 * it a copy string containing `</script>` would close the inline script element and the
 * rest of the page would be parsed as HTML — copy is static today, but the guard is what
 * keeps a future translation from turning into an injection vector.
 */
QByteArray serializedDictionaries();

} // namespace webclientcopy
