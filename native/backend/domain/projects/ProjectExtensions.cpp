#include "ProjectResources.h"

#include "JsonFile.h"
#include "ProjectResourcesInternal.h"
#include "TrashHelper.h"

#include "../../process/TextEncoding.h"

#include <algorithm>

#include <QDir>
#include <QFileInfo>
#include <QJsonArray>
#include <QJsonDocument>
#include <QStringList>

namespace projectresources {
namespace internal {
namespace {

QStringList disabledExtensions(const QString &projectPath)
{
    QString raw;
    if (!jsonfile::readText(QDir(projectPath).filePath(QStringLiteral(".pi/settings.json")), &raw)) {
        return {};
    }
    QJsonParseError error;
    const QJsonDocument document = QJsonDocument::fromJson(raw.toUtf8(), &error);
    if (error.error != QJsonParseError::NoError || !document.isObject()) return {};
    QStringList names;
    for (const QJsonValue &value : document.object().value(QStringLiteral("disabledExtensions")).toArray()) {
        if (value.isString()) names.append(value.toString());
    }
    return names;
}

} // namespace

QJsonArray listExtensions(const QString &projectPath)
{
    const QString extensionsDir = QDir(projectPath).filePath(QStringLiteral(".pi/extensions"));
    const QStringList disabled = disabledExtensions(projectPath);
    QList<QJsonObject> result;
    const QFileInfoList entries = QDir(extensionsDir).entryInfoList(
        QDir::Dirs | QDir::Files | QDir::NoDotAndDotDot, QDir::Name);
    for (const QFileInfo &entry : entries) {
        const QString name = entry.fileName();
        if (name.startsWith(QLatin1Char('.')) || name == QStringLiteral("node_modules")
            || name.endsWith(QStringLiteral(".d.ts"))) {
            continue;
        }
        const QString fullPath = entry.absoluteFilePath();
        if (entry.isFile() && name.endsWith(QStringLiteral(".ts"))) {
            // A flat `.ts` extension is identified without its suffix, while the disable
            // list stores the full file name (see toggleExtension) - the oracle behaves
            // the same way, so the two never match for flat files.
            const QString source = name.left(name.size() - 3);
            result.append(QJsonObject{
                {QStringLiteral("id"), QStringLiteral("project:") + fullPath},
                {QStringLiteral("source"), source},
                {QStringLiteral("path"), fullPath},
                {QStringLiteral("scope"), QStringLiteral("project")},
                {QStringLiteral("enabled"), !disabled.contains(source)},
            });
            continue;
        }
        if (entry.isDir() && QFileInfo::exists(QDir(fullPath).filePath(QStringLiteral("index.ts")))) {
            result.append(QJsonObject{
                {QStringLiteral("id"), QStringLiteral("project:") + fullPath},
                {QStringLiteral("source"), name},
                {QStringLiteral("path"), fullPath},
                {QStringLiteral("scope"), QStringLiteral("project")},
                {QStringLiteral("enabled"), !disabled.contains(name)},
            });
        }
    }
    std::stable_sort(result.begin(), result.end(),
                     [](const QJsonObject &left, const QJsonObject &right) {
                         return QString::localeAwareCompare(
                                    left.value(QStringLiteral("source")).toString(),
                                    right.value(QStringLiteral("source")).toString())
                             < 0;
                     });
    QJsonArray array;
    for (const QJsonObject &extension : result) array.append(extension);
    return array;
}

} // namespace internal

void Manager::toggleExtension(const QString &projectId, const QString &extensionPath,
                              bool enabled) const
{
    const QJsonObject project = internal::requireProject(m_provider, projectId, m_translate);
    const QString projectPath = project.value(QStringLiteral("path")).toString();
    internal::assertInsideProject(projectPath, extensionPath, m_translate);
    const QString settingsFile = QDir(projectPath).filePath(QStringLiteral(".pi/settings.json"));
    QJsonObject settings;
    QJsonValue existing;
    if (jsonfile::readJson(settingsFile, &existing, nullptr) == jsonfile::ReadState::Ok) {
        settings = existing.toObject();
    }
    QStringList disabled;
    for (const QJsonValue &value : settings.value(QStringLiteral("disabledExtensions")).toArray()) {
        if (value.isString()) disabled.append(value.toString());
    }
    // pi matches disabled extensions by file/directory name, not by absolute path.
    const QString extName = QFileInfo(extensionPath).fileName();
    if (enabled) {
        disabled.removeAll(extName);
    } else if (!disabled.contains(extName)) {
        disabled.append(extName);
    }
    settings.insert(QStringLiteral("disabledExtensions"), internal::toJsonArray(disabled));
    QString error;
    if (!jsonfile::writeJsonAtomic(settingsFile, settings, &error)) {
        throw textenc::error(error);
    }
}

void Manager::deleteExtension(const QString &projectId, const QString &extensionPath,
                              HostRpcClient *host, TrashDone done) const
{
    const QJsonObject project = internal::requireProject(m_provider, projectId, m_translate);
    const QString projectPath = project.value(QStringLiteral("path")).toString();
    bool found = false;
    for (const QJsonValue &value : internal::listExtensions(projectPath)) {
        if (value.toObject().value(QStringLiteral("path")).toString() == extensionPath) {
            found = true;
            break;
        }
    }
    if (!found) {
        return done(false,
                    m_translate(QStringLiteral("mainProjectResource.extensionNotFound"), {}));
    }
    internal::assertInsideProject(projectPath, extensionPath, m_translate);
    if (!host) return done(false, QStringLiteral("Trash service unavailable"));
    trashhelper::trashAll(host, QStringList{extensionPath}, [done](bool ok, const QString &error) {
        done(ok, error);
    });
}

} // namespace projectresources
