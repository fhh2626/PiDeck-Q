#pragma once

#include "CatalogTypes.h"

#include <QJsonArray>
#include <QJsonObject>
#include <QString>
#include <QStringList>
#include <QVector>

#include <functional>

/**
 * Catalog load-time repair (port of src/main/sessions/sessionCatalogMigration.ts).
 *
 * Two historical defects are repaired here, both observable to the user:
 *  1. pi can report a relative `sessionFile`; storing it verbatim created a second
 *     record for a file the scanner reports with an absolute path (duplicate rows in
 *     the sidebar, and file operations landing in the wrong place);
 *  2. the same file could already be persisted twice, so the repair must merge the
 *     duplicates and keep the stable id plus the user's preferences.
 */
namespace catalogmigration {

using FilePathResolver = std::function<QString(const QString &projectId, const QString &filePath,
                                               const QString &environment)>;

/**
 * Normalize paths and merge durable origin collisions.
 * `originKeys` is parallel to `entries` and is the pre-computed key for each entry.
 * Returns the migrated list; `changed` reports whether anything actually changed.
 */
QVector<CatalogEntry> migrate(const QVector<CatalogEntry> &entries, const QStringList &originKeys,
                              const FilePathResolver &resolveFilePath, bool *changed);

/**
 * Fill `parentSessionId` for every record in one project group.
 * Records must already belong to the same project (the caller groups them).
 */
void assignParentSessionIds(QVector<QJsonObject> *records);

} // namespace catalogmigration
