#pragma once

#include <QJsonArray>
#include <QJsonObject>
#include <QString>

/**
 * Pure project-record rules (port of src/main/projects/projectRecordValidation.ts and
 * the path helpers inside ProjectStore.ts).
 *
 * Everything here is stateless so the persisted catalog can be validated, sorted and
 * compared from more than one place (the store, the id resolver, the git channels)
 * without a second copy of the rules.
 */
namespace projects {

/** The built-in chat project identity; it always exists and always sorts first. */
extern const QString kChatProjectId;
extern const QString kChatProjectName;

/**
 * Narrow one persisted record to a Project.
 *
 * Required fields (id/path) missing or mistyped reject the whole record; optional
 * fields with a wrong type are dropped so an older writer's dirty value cannot abort
 * the load of every other project.
 */
QJsonObject parseProjectRecord(const QJsonValue &value);

struct CatalogParse {
    QJsonArray projects;
    /** Records dropped because they were invalid or had a duplicate id. */
    int dropped = 0;
};

/** Validate a whole catalog. Returns false when the value is not an array at all. */
bool parseProjectCatalog(const QJsonValue &value, CatalogParse *out);

/** Sidebar order: chat first, then pinned, then sortOrder, then most recently opened. */
QJsonArray sortProjects(const QJsonArray &projects);

bool isChatProject(const QJsonObject &project);

/**
 * Node's `normalize(resolve(path))` on Windows, except that a leading `/` (a WSL Linux
 * path such as `/mnt/d/x`) only loses its trailing separators: resolving it would turn
 * `/mnt/d/x` into `D:\mnt\d\x`.
 */
QString normalizeProjectPath(const QString &path);

/** Case-insensitive on Windows, case-sensitive for Linux paths and on POSIX. */
bool sameProjectPath(const QString &left, const QString &right);

/** sortOrder with the oracle's `Number.MAX_SAFE_INTEGER` fallback for a missing value. */
double projectSortOrder(const QJsonObject &project);

/** Read the catalog file into records without any chat-project synthesis. */
QJsonArray readProjectRecords(const QString &filePath, int *dropped = nullptr);

} // namespace projects
