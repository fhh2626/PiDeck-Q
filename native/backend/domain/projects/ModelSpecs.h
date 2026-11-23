#pragma once

#include <QJsonObject>
#include <QJsonValue>
#include <QString>

/**
 * Model capability specs shipped in `resources/model-specs.db`.
 *
 * Port of src/main/pi/modelSpecsStore.ts + modelSpecsIndex.ts. The database is bundled
 * with the app (no network at runtime), so the lookup is a pure in-memory match over the
 * whole table; the SQLite file is read once and cached for the process lifetime.
 *
 * Matching is by model id, not by base URL, so a relay that keeps upstream ids still
 * resolves. Two sources are merged: OpenRouter supplies context/output limits, models.dev
 * (plus the `builtin` official rows) supplies reasoning/vision capability.
 */
namespace modelspecs {

/**
 * Look up one model spec. Returns a null value when the model is unknown or the database
 * is missing/unreadable, which is what the renderer treats as "no local spec".
 */
QJsonValue lookup(const QString &resourcesDir, const QString &providerName, const QString &modelId);

/** Number of rows loaded from the last successful database read (diagnostics/tests). */
int loadedRowCount();

/** Drop the cached index (tests only). */
void resetCache();

} // namespace modelspecs
