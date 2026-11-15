#pragma once

#include <QString>
#include <QStringList>

/**
 * The single `projectId -> path` resolver.
 *
 * The Node oracle resolves every project-scoped channel through ProjectStore.get().
 * Accepting a raw path from the renderer instead would both break the desktopApi
 * contract and turn the backend into an arbitrary-path primitive, so every git and
 * filesystem channel goes through here.
 */
namespace projectresolver {

struct Project {
    QString id;
    QString path;
    QString name;
};

/** Look up one project by its stable id. Returns false when it is unknown. */
bool findById(const QString &projectsFile, const QString &projectId, Project *out);
/** Look up one project by path (case-insensitive on Windows). */
bool findByPath(const QString &projectsFile, const QString &path, Project *out);
/** Every registered project path, used to extend the authorization scope. */
QStringList allPaths(const QString &projectsFile);

} // namespace projectresolver
