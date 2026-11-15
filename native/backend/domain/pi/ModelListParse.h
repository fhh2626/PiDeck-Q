#pragma once

#include <QJsonArray>
#include <QJsonValue>
#include <QString>

/**
 * Model-list payload parsing (port of `src/main/pi/modelListCache.ts`).
 *
 * Two data sources have to normalise into the same `AvailableModel[]`:
 *  - the implementation-neutral RPC payload (`get_available_models`), where the Rust
 *    implementation calls image capability `input` and older builds expose `images`;
 *  - the human-readable `pi --list-models` table, used as a compatibility fallback.
 *
 * Both parsers are pure and must stay byte-faithful: the renderer renders the returned
 * object keys directly, and `models:changed` consumers compare them.
 */
namespace modellist {

/** `normalizePiRpcModels(data)`: `{models:[...]}` → narrow `AvailableModel[]`. */
QJsonArray normalizeRpcModels(const QJsonValue &data);

/**
 * `parsePiListModels(stdout)`: provider/model/context/max-out/thinking/images table.
 *
 * Columns are parsed from the right because a provider name may contain spaces (users
 * copy provider ids like "grok.example.com copy"), which would break a left split. The
 * three-column legacy form (`provider model thinking`) is still accepted, and a Rust
 * "Showing N of M providers..." trailer is rejected because it has no yes/no tail.
 */
QJsonArray parseTextModels(const QString &output);

/**
 * `parseTokenSize("1M") == 1048576`, `"65.5K" == 67109`, `"200" == 200`.
 * Returns false when the cell is not a token size (the key is then omitted).
 */
bool parseTokenSize(const QString &value, qint64 *bytes);

} // namespace modellist
