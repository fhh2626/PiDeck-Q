#include "ChannelContext.h"

#include "ProjectResolver.h"
#include "SettingsCatalog.h"

#include <QDir>

namespace channels {

QJsonValue argAt(const QJsonArray &args, int index)
{
    return index >= 0 && index < args.size() ? args.at(index) : QJsonValue();
}

QString stringArg(const QJsonArray &args, int index)
{
    return argAt(args, index).toString();
}

QJsonObject objectArg(const QJsonArray &args, int index)
{
    return argAt(args, index).toObject();
}

/** Numeric argument; a non-numeric value yields 0 (renderer data is untrusted). */
int intArg(const QJsonArray &args, int index)
{
    return argAt(args, index).toInt();
}

QStringList stringListArg(const QJsonArray &args, int index)
{
    QStringList values;
    const QJsonArray array = argAt(args, index).toArray();
    values.reserve(array.size());
    for (const QJsonValue &value : array) {
        if (value.isString()) values.append(value.toString());
    }
    return values;
}

QJsonValue requireOk(bool ok, const QString &error, const QJsonValue &value)
{
    if (!ok) throw ChannelError(error.isEmpty() ? QStringLiteral("Channel failed") : error);
    return value;
}

QString projectsFile(const ChannelServices &services)
{
    return QDir(services.userDataDir).filePath(QStringLiteral("projects.json"));
}

QString resolveProjectPath(const ChannelServices &services, const QString &projectId)
{
    projectresolver::Project project;
    if (!projectresolver::findById(projectsFile(services), projectId, &project)) {
        throw ChannelError(QStringLiteral("Project not found: %1").arg(projectId));
    }
    return project.path;
}

QStringList authorizedRoots(const ChannelServices &services)
{
    QStringList roots = projectresolver::allPaths(projectsFile(services));
    roots.append(pathpolicy::authorizedRoots(services.userDataDir, services.promptsDir, services.skillsDir,
                                             services.agentDir));
    return roots;
}

QString authorizePath(const ChannelServices &services, const QString &path, const QString &operation,
                      pathpolicy::Mode mode)
{
    const pathpolicy::Result result = pathpolicy::assertAuthorized(path, authorizedRoots(services), operation, mode);
    if (!result.ok) throw ChannelError(result.error);
    return result.path;
}

qint64 maxEditorFileBytes(const ChannelServices &services)
{
    const QJsonValue value = settingValue(services, QStringLiteral("maxEditorFileSizeMB"));
    double megabytes = value.isDouble() ? value.toDouble() : 5.0;
    if (!(megabytes >= 1)) megabytes = 1;
    return qint64(megabytes) * 1024 * 1024;
}

QJsonValue settingValue(const ChannelServices &services, const QString &key)
{
    const SettingsCatalogRead settings =
        readSettingsCatalog(QDir(services.userDataDir).filePath(QStringLiteral("settings.json")));
    return settings.settings.value(key);
}

} // namespace channels
