#include "ProjectResources.h"

#include "JsonFile.h"
#include "ProjectResourcesInternal.h"
#include "TrashHelper.h"

#include "../../process/TextEncoding.h"

#include <algorithm>

#include <QDir>
#include <QFileInfo>
#include <QJsonArray>
#include <QStringList>

namespace projectresources {
namespace {

using internal::SkillLocation;
using internal::kSkillFile;

/** The two project skill roots, in the oracle's order (`.pi` first). */
QList<SkillLocation> skillLocations(const QString &projectPath)
{
    return {
        SkillLocation{QStringLiteral("project-pi"), QStringLiteral(".pi/skills"),
                      QDir(projectPath).filePath(QStringLiteral(".pi/skills")), true},
        SkillLocation{QStringLiteral("project-agents"), QStringLiteral(".agents/skills"),
                      QDir(projectPath).filePath(QStringLiteral(".agents/skills")), false},
    };
}

QJsonObject readSkill(const QString &skillPath, const SkillLocation &location, const QString &type,
                      const maincopy::Translator &translate)
{
    QString raw;
    jsonfile::readText(skillPath, &raw);
    const QHash<QString, QString> frontmatter = internal::parseFrontmatter(raw);
    const QString name = frontmatter.value(QStringLiteral("name")).trimmed();
    const QString description = frontmatter.value(QStringLiteral("description")).trimmed();
    const QStringList warnings = internal::validateSkill(name, description, translate);
    QString displayName = name;
    if (displayName.isEmpty()) {
        displayName = QFileInfo(skillPath).dir().dirName();
        if (displayName.isEmpty()) displayName = translate(QStringLiteral("mainSkill.unnamed"), {});
    }
    return QJsonObject{
        {QStringLiteral("id"), location.id + QLatin1Char(':') + skillPath},
        {QStringLiteral("name"), displayName},
        {QStringLiteral("description"), description},
        {QStringLiteral("path"), skillPath},
        {QStringLiteral("dir"), QFileInfo(skillPath).absolutePath()},
        {QStringLiteral("sourceId"), location.id},
        {QStringLiteral("sourceLabel"), location.label},
        {QStringLiteral("type"), type},
        {QStringLiteral("enabled"),
         frontmatter.value(QStringLiteral("disable-model-invocation")) != QStringLiteral("true")},
        {QStringLiteral("valid"), warnings.isEmpty()},
        {QStringLiteral("warnings"), internal::toJsonArray(warnings)},
    };
}

void collectDirectorySkills(const QString &dir, const SkillLocation &location, QJsonArray *out,
                            const maincopy::Translator &translate)
{
    const QString skillPath = QDir(dir).filePath(kSkillFile);
    if (QFileInfo::exists(skillPath)) {
        out->append(readSkill(skillPath, location, QStringLiteral("directory"), translate));
        return;
    }
    const QFileInfoList entries =
        QDir(dir).entryInfoList(QDir::Dirs | QDir::NoDotAndDotDot, QDir::Name);
    for (const QFileInfo &entry : entries) {
        collectDirectorySkills(entry.absoluteFilePath(), location, out, translate);
    }
}

QJsonArray scanSkillLocation(const SkillLocation &location, const maincopy::Translator &translate)
{
    QJsonArray skills;
    const QFileInfoList entries = QDir(location.path).entryInfoList(
        QDir::Dirs | QDir::Files | QDir::NoDotAndDotDot, QDir::Name);
    for (const QFileInfo &entry : entries) {
        if (entry.isDir()) {
            collectDirectorySkills(entry.absoluteFilePath(), location, &skills, translate);
        } else if (location.rootMarkdownEnabled
                   && entry.fileName().toLower().endsWith(QStringLiteral(".md"))) {
            skills.append(readSkill(entry.absoluteFilePath(), location, QStringLiteral("markdown"),
                                    translate));
        }
    }
    return skills;
}

QJsonArray listSkills(const QString &projectPath, const maincopy::Translator &translate)
{
    QList<QJsonObject> collected;
    for (const SkillLocation &location : skillLocations(projectPath)) {
        for (const QJsonValue &value : scanSkillLocation(location, translate)) {
            collected.append(value.toObject());
        }
    }
    std::stable_sort(collected.begin(), collected.end(),
                     [](const QJsonObject &left, const QJsonObject &right) {
                         return QString::localeAwareCompare(
                                    left.value(QStringLiteral("name")).toString(),
                                    right.value(QStringLiteral("name")).toString())
                             < 0;
                     });
    QJsonArray result;
    for (const QJsonObject &skill : collected) result.append(skill);
    return result;
}

QJsonObject findSkill(const QString &projectPath, const QString &skillPath,
                      const maincopy::Translator &translate)
{
    for (const QJsonValue &value : listSkills(projectPath, translate)) {
        const QJsonObject skill = value.toObject();
        if (skill.value(QStringLiteral("path")).toString() == skillPath) return skill;
    }
    throw textenc::error(translate(QStringLiteral("mainProjectResource.skillNotFound"), {}));
}

} // namespace

namespace internal {

void assertInsideProject(const QString &projectPath, const QString &targetPath,
                         const maincopy::Translator &translate)
{
    const QString root = QDir::cleanPath(QDir(projectPath).absolutePath());
    const QString target = QDir::cleanPath(QDir(targetPath).absolutePath());
    const QString relative = QDir(root).relativeFilePath(target);
    const bool inside = !relative.isEmpty() && relative != QStringLiteral(".")
        && !relative.startsWith(QStringLiteral("..")) && !QDir::isAbsolutePath(relative);
    if (!inside) {
        throw textenc::error(
            translate(QStringLiteral("mainProjectResource.pathOutsideProject"), {}));
    }
}

QJsonObject requireProject(const ProjectProvider &provider, const QString &projectId,
                           const maincopy::Translator &translate)
{
    const QJsonObject project = provider ? provider(projectId) : QJsonObject{};
    if (project.isEmpty()) {
        throw textenc::error(translate(QStringLiteral("project.notFound"), {}));
    }
    if (project.value(QStringLiteral("kind")).toString() == QStringLiteral("chat")) {
        throw textenc::error(
            translate(QStringLiteral("mainProjectResource.chatUnsupported"), {}));
    }
    return project;
}

} // namespace internal

Manager::Manager(ProjectProvider provider, maincopy::Translator translate)
    : m_provider(std::move(provider))
    , m_translate(std::move(translate))
{
}

QJsonObject Manager::list(const QString &projectId) const
{
    const QJsonObject project = internal::requireProject(m_provider, projectId, m_translate);
    const QString projectPath = project.value(QStringLiteral("path")).toString();
    return QJsonObject{
        {QStringLiteral("skills"), listSkills(projectPath, m_translate)},
        {QStringLiteral("extensions"), internal::listExtensions(projectPath)},
    };
}

QJsonObject Manager::createSkill(const QString &projectId, const QString &name,
                                 const QString &description) const
{
    const QJsonObject project = internal::requireProject(m_provider, projectId, m_translate);
    const QString projectPath = project.value(QStringLiteral("path")).toString();
    const SkillLocation location = skillLocations(projectPath).first();
    const QString normalized = internal::normalizeSkillName(name);
    if (normalized.isEmpty()) {
        throw textenc::error(
            m_translate(QStringLiteral("mainProjectResource.skillNameCharacters"), {}));
    }
    // The user's original input stays the display name; only the folder/SKILL.md path is
    // normalized, so the UI keeps showing what was typed.
    const QString displayName = name.trimmed();
    const QString trimmedDescription = description.trimmed();
    if (trimmedDescription.isEmpty()) {
        throw textenc::error(m_translate(QStringLiteral("mainSkill.descriptionRequired"), {}));
    }
    const QString skillDir = QDir(location.path).filePath(normalized);
    internal::assertInsideProject(projectPath, skillDir, m_translate);
    if (QFileInfo::exists(skillDir)) {
        throw textenc::error(m_translate(QStringLiteral("mainProjectResource.skillAlreadyExists"),
                                         QJsonObject{{QStringLiteral("name"), normalized}}));
    }
    if (!QDir().mkpath(skillDir)) {
        throw textenc::error(QStringLiteral("Unable to create skill directory: %1").arg(skillDir));
    }
    QString singleLineDescription = trimmedDescription;
    singleLineDescription.replace(QLatin1Char('\n'), QLatin1Char(' '));
    const QString skillPath = QDir(skillDir).filePath(kSkillFile);
    const QString content = QStringLiteral("---\nname: %1\ndescription: %2\n---\n\n# %1\n\n"
                                           "## Usage\n\nReplace this section with your skill "
                                           "instructions.\nSee https://agentskills.io/specification "
                                           "for the SKILL.md format.\n")
                                .arg(displayName, singleLineDescription);
    QString error;
    if (!jsonfile::writeBytesAtomic(skillPath, content.toUtf8(), &error)) {
        throw textenc::error(error);
    }
    const QStringList warnings = internal::validateSkill(normalized, trimmedDescription, m_translate);
    return QJsonObject{
        {QStringLiteral("id"), location.id + QLatin1Char(':') + skillPath},
        {QStringLiteral("name"), displayName},
        {QStringLiteral("description"), trimmedDescription},
        {QStringLiteral("path"), skillPath},
        {QStringLiteral("dir"), skillDir},
        {QStringLiteral("sourceId"), location.id},
        {QStringLiteral("sourceLabel"), location.label},
        {QStringLiteral("type"), QStringLiteral("directory")},
        {QStringLiteral("enabled"), true},
        {QStringLiteral("valid"), warnings.isEmpty()},
        {QStringLiteral("warnings"), internal::toJsonArray(warnings)},
    };
}

QJsonObject Manager::renameSkill(const QString &projectId, const QString &skillPath,
                                 const QString &newName) const
{
    const QJsonObject project = internal::requireProject(m_provider, projectId, m_translate);
    const QString projectPath = project.value(QStringLiteral("path")).toString();
    const QJsonObject skill = findSkill(projectPath, skillPath, m_translate);
    const QString normalizedNew = internal::normalizeSkillName(newName);
    if (normalizedNew.isEmpty()) {
        throw textenc::error(m_translate(QStringLiteral("mainSkill.nameRequired"), {}));
    }
    const QString displayName = newName.trimmed();
    const QString oldDir = skill.value(QStringLiteral("dir")).toString();
    const QString parentDir = QFileInfo(oldDir).absolutePath();
    const QString newDir = QDir(parentDir).filePath(normalizedNew);
    internal::assertInsideProject(projectPath, newDir, m_translate);
    if (QDir::cleanPath(oldDir) == QDir::cleanPath(newDir)) {
        throw textenc::error(m_translate(QStringLiteral("mainSkill.sameName"), {}));
    }
    if (QFileInfo::exists(newDir)) {
        throw textenc::error(m_translate(QStringLiteral("mainProjectResource.skillAlreadyExists"),
                                         QJsonObject{{QStringLiteral("name"), normalizedNew}}));
    }
    QString raw;
    if (!jsonfile::readText(skillPath, &raw)) {
        throw textenc::error(
            m_translate(QStringLiteral("mainProjectResource.skillNotFound"), {}));
    }
    QString error;
    if (!jsonfile::writeBytesAtomic(skillPath, internal::setFrontmatterName(raw, displayName).toUtf8(),
                                    &error)) {
        throw textenc::error(error);
    }
    if (!QDir().rename(oldDir, newDir)) {
        throw textenc::error(QStringLiteral("Unable to rename skill directory: %1").arg(oldDir));
    }
    const QString newSkillPath = QDir(newDir).filePath(QFileInfo(skillPath).fileName());
    const QList<SkillLocation> locations = skillLocations(projectPath);
    SkillLocation location = locations.first();
    for (const SkillLocation &candidate : locations) {
        if (newSkillPath.startsWith(candidate.path)) {
            location = candidate;
            break;
        }
    }
    return readSkill(newSkillPath, location, skill.value(QStringLiteral("type")).toString(),
                     m_translate);
}

QJsonObject Manager::toggleSkill(const QString &projectId, const QString &skillPath,
                                 bool enabled) const
{
    const QJsonObject project = internal::requireProject(m_provider, projectId, m_translate);
    const QString projectPath = project.value(QStringLiteral("path")).toString();
    const QJsonObject skill = findSkill(projectPath, skillPath, m_translate);
    internal::assertInsideProject(projectPath, skillPath, m_translate);
    QString raw;
    if (!jsonfile::readText(skillPath, &raw)) {
        throw textenc::error(
            m_translate(QStringLiteral("mainProjectResource.skillNotFound"), {}));
    }
    const QString next =
        internal::setFrontmatterBoolean(raw, QStringLiteral("disable-model-invocation"), !enabled);
    QString error;
    if (!jsonfile::writeBytesAtomic(skillPath, next.toUtf8(), &error)) {
        throw textenc::error(error);
    }
    // Re-read so the returned summary reflects the frontmatter that is now on disk.
    const QList<SkillLocation> locations = skillLocations(projectPath);
    SkillLocation location = locations.first();
    for (const SkillLocation &candidate : locations) {
        if (candidate.id == skill.value(QStringLiteral("sourceId")).toString()) {
            location = candidate;
            break;
        }
    }
    return readSkill(skillPath, location, skill.value(QStringLiteral("type")).toString(), m_translate);
}

void Manager::deleteSkill(const QString &projectId, const QString &skillPath, HostRpcClient *host,
                          TrashDone done) const
{
    const QJsonObject project = internal::requireProject(m_provider, projectId, m_translate);
    const QString projectPath = project.value(QStringLiteral("path")).toString();
    const QJsonObject skill = findSkill(projectPath, skillPath, m_translate);
    // A directory skill is a whole capability package, so the directory is trashed; a
    // markdown skill is a single file.
    const QString target = skill.value(QStringLiteral("type")).toString() == QStringLiteral("directory")
        ? skill.value(QStringLiteral("dir")).toString()
        : skill.value(QStringLiteral("path")).toString();
    internal::assertInsideProject(projectPath, target, m_translate);
    if (!host) return done(false, QStringLiteral("Trash service unavailable"));
    trashhelper::trashAll(host, QStringList{target}, [done](bool ok, const QString &error) {
        done(ok, error);
    });
}

} // namespace projectresources
