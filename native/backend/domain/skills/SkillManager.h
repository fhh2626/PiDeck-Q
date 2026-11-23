#pragma once

#include "MainCopy.h"

#include "../wsl/WslEnvironment.h"

#include <QJsonObject>
#include <QSet>
#include <QString>
#include <QStringList>
#include <QVector>

/**
 * Global pi skills (`skills:*`).
 *
 * Port of src/main/skills/SkillManager.ts. Two locations are managed and nothing else:
 * `~/.pi/agent/skills` (directory skills plus root-level `.md` skills) and
 * `~/.agents/skills` (directory skills only). Project-level `.pi/skills` and
 * `.agents/skills` belong to the project-resources manager, which owns edits to
 * project assets. This manager changes only user-level skills.
 *
 * A skill is a directory containing `SKILL.md`, or (pi-global only) a single `.md` file.
 * `disable-model-invocation: true` in its frontmatter means "disabled"; PiDeck toggles
 * that field instead of moving files, so pi's own discovery stays authoritative.
 */
namespace skills {

struct Location {
    QString id;
    QString label;
    QString path;
    bool rootMarkdownEnabled = false;
};

struct Summary {
    QString id;
    QString name;
    QString description;
    QString path;
    QString dir;
    QString sourceId;
    QString sourceLabel;
    /** "directory" | "markdown" */
    QString type;
    bool enabled = true;
    bool valid = true;
    QStringList warnings;
};

struct ListResult {
    QVector<Location> locations;
    QVector<Summary> skills;
};

QJsonObject locationToJson(const Location &location);
QJsonObject summaryToJson(const Summary &skill);
QJsonObject listToJson(const ListResult &result);

/** A deletion the channel performs through the host recycle bin. */
struct DeleteTarget {
    QString path;
    QString source;
};

class Manager {
public:
    Manager(QString homeDir, maincopy::Translator translate);

    /**
     * Switch both managed locations to the resolved WSL home; `nullptr` restores the
     * home injected at construction (never `os.homedir()`, so an isolated test HOME is
     * not overwritten by the startup task).
     */
    void configureWsl(const wsl::Environment *environment);

    /** The two managed locations, in discovery order. */
    const QVector<Location> &locations() const { return m_locations; }
    /** Skill roots, for the desktop file authorization scope. */
    QStringList dirs() const;

    ListResult list() const;
    Summary create(const QString &name, const QString &description, const QString &locationId) const;
    Summary toggle(const QString &skillPath, bool enabled) const;
    DeleteTarget prepareDelete(const QString &skillPath) const;
    /** Directory to open: the first location root, or the skill's own directory. */
    QString folderToOpen(const QString &skillPath) const;
    Summary rename(const QString &skillPath, const QString &newName) const;

    /** `normalizeSkillName`: Unicode letters/digits/hyphens, collapsed, lowercase. */
    static QString normalizeName(const QString &value);

private:
    /** The two global locations for one home directory. */
    static QVector<Location> buildLocations(const QString &home);

    Summary readSkill(const QString &skillPath, const Location &location, const QString &type) const;
    Summary findByPath(const QString &skillPath) const;
    const Location &requireLocation(const QString &id) const;
    QVector<Summary> scanLocation(const Location &location) const;
    /** Recursive directory walk with an ancestor set so a symlink loop terminates. */
    void collectDirectorySkills(const QString &dir, const Location &location,
                                QVector<Summary> *out, const QSet<QString> &ancestors) const;

    QVector<Location> m_locations;
    /** Construction-time home; `configureWsl(nullptr)` restores it. */
    QString m_localHome;
    maincopy::Translator m_translate;
};

} // namespace skills
