#include "ProjectResolver.h"

#include "ProjectRecord.h"

#include <QFileInfo>
#include <QJsonArray>
#include <QJsonObject>

namespace projectresolver {
namespace {

Project toProject(const QJsonObject &record)
{
    Project project;
    project.id = record.value(QStringLiteral("id")).toString();
    project.path = record.value(QStringLiteral("path")).toString();
    project.name = record.value(QStringLiteral("name")).toString();
    if (project.name.isEmpty()) project.name = QFileInfo(project.path).fileName();
    return project;
}

} // namespace

bool findById(const QString &projectsFile, const QString &projectId, Project *out)
{
    if (projectId.isEmpty()) return false;
    for (const QJsonValue &value : projects::readProjectRecords(projectsFile)) {
        const QJsonObject record = value.toObject();
        if (record.value(QStringLiteral("id")).toString() != projectId) continue;
        if (out) *out = toProject(record);
        return true;
    }
    return false;
}

bool findByPath(const QString &projectsFile, const QString &path, Project *out)
{
    for (const QJsonValue &value : projects::readProjectRecords(projectsFile)) {
        const QJsonObject record = value.toObject();
        const QString recordPath = record.value(QStringLiteral("path")).toString();
        if (!projects::sameProjectPath(recordPath, path)) continue;
        if (out) *out = toProject(record);
        return true;
    }
    return false;
}

QStringList allPaths(const QString &projectsFile)
{
    QStringList paths;
    for (const QJsonValue &value : projects::readProjectRecords(projectsFile)) {
        const QString path = value.toObject().value(QStringLiteral("path")).toString();
        if (!path.isEmpty()) paths.append(path);
    }
    return paths;
}

} // namespace projectresolver
