#pragma once

#include "MainCopy.h"

#include <QJsonObject>
#include <QString>

#include <functional>

class HostRpcClient;

/**
 * Project-scoped pi resources (port of src/main/projects/ProjectResourceManager.ts).
 *
 * Only `<project>/.pi/**` and `<project>/.agents/**` are scanned, so the project dialog
 * can never show or delete a global skill/extension. Every mutation re-checks that the
 * renderer-supplied path still resolves inside the project before touching the disk.
 */
namespace projectresources {

using ProjectProvider = std::function<QJsonObject(const QString &projectId)>;
using TrashDone = std::function<void(bool ok, const QString &error)>;

class Manager {
public:
    Manager(ProjectProvider provider, maincopy::Translator translate);

    /** `{skills, extensions}` for one project. */
    QJsonObject list(const QString &projectId) const;
    /** Create `<project>/.pi/skills/<slug>/SKILL.md` and return the new summary. */
    QJsonObject createSkill(const QString &projectId, const QString &name,
                            const QString &description) const;
    /** Rename the skill directory and rewrite its `name` frontmatter. */
    QJsonObject renameSkill(const QString &projectId, const QString &skillPath,
                            const QString &newName) const;
    /** Toggle `disable-model-invocation` in the skill's frontmatter. */
    QJsonObject toggleSkill(const QString &projectId, const QString &skillPath, bool enabled) const;
    /** Recycle-bin delete of a skill directory or markdown skill. */
    void deleteSkill(const QString &projectId, const QString &skillPath, HostRpcClient *host,
                     TrashDone done) const;
    /** Add/remove the extension name in `<project>/.pi/settings.json`. */
    void toggleExtension(const QString &projectId, const QString &extensionPath, bool enabled) const;
    /** Recycle-bin delete of a project extension. */
    void deleteExtension(const QString &projectId, const QString &extensionPath, HostRpcClient *host,
                         TrashDone done) const;

private:
    ProjectProvider m_provider;
    maincopy::Translator m_translate;
};

} // namespace projectresources
