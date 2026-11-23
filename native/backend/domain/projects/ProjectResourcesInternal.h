#pragma once

#include "ProjectResources.h"

#include <QJsonArray>
#include <QJsonObject>
#include <QString>
#include <QStringList>

/**
 * Internals shared by the project-resource translation units.
 *
 * `ProjectResources.cpp` owns the skill side (scan, create, rename, toggle, delete),
 * `ProjectExtensions.cpp` owns the `.pi/extensions` side, and
 * `ProjectSkillFrontmatter.cpp` owns the SKILL.md frontmatter rules. Everything here is
 * private to the domain: include ProjectResources.h for the channel-facing API.
 */
namespace projectresources {
namespace internal {

/** The file name every directory skill is addressed by. */
extern const QString kSkillFile;

/** One skill root (`<project>/.pi/skills` or `<project>/.agents/skills`). */
struct SkillLocation {
    QString id;
    QString label;
    QString path;
    bool rootMarkdownEnabled = false;
};

/** `key: value` pairs from the leading `---` block; empty when there is none. */
QHash<QString, QString> parseFrontmatter(const QString &raw);

/** Set (or append) a boolean frontmatter key, creating the block when missing. */
QString setFrontmatterBoolean(const QString &raw, const QString &key, bool value);

/** Rewrite the `name` frontmatter entry, creating the block when missing. */
QString setFrontmatterName(const QString &raw, const QString &name);

/** Lowercase kebab-case folder name derived from the user's display name. */
QString normalizeSkillName(const QString &value);

/** Validation warnings for a skill's name/description (already localized). */
QStringList validateSkill(const QString &name, const QString &description,
                          const maincopy::Translator &translate);

/** `QStringList` → `QJsonArray` for wire results. */
QJsonArray toJsonArray(const QStringList &values);

/** Reject any target that does not resolve strictly inside the project directory. */
void assertInsideProject(const QString &projectPath, const QString &targetPath,
                         const maincopy::Translator &translate);

/** Resolve a project id to its record, rejecting unknown ids and the chat project. */
QJsonObject requireProject(const ProjectProvider &provider, const QString &projectId,
                           const maincopy::Translator &translate);

/** `{id, source, path, scope, enabled}` for every `.pi/extensions` entry. */
QJsonArray listExtensions(const QString &projectPath);

} // namespace internal
} // namespace projectresources
