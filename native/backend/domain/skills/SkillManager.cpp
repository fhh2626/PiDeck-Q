#include "SkillManager.h"

#include "../fs/FileOperations.h"
#include "../fs/PathPolicy.h"
#include "../../process/TextEncoding.h"

#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QJsonArray>
#include <QRegularExpression>
#include <QSaveFile>
#include <QSet>

#include <algorithm>

namespace skills {
namespace {

constexpr const char *kSkillFile = "SKILL.md";

QString frontmatterBlock(const QString &raw, QString *body)
{
    static const QRegularExpression pattern(QStringLiteral("^---\\r?\\n([\\s\\S]*?)\\r?\\n---"));
    const QRegularExpressionMatch match = pattern.match(raw);
    if (!match.hasMatch()) {
        *body = QString();
        return QString();
    }
    *body = match.captured(1);
    return match.captured(0);
}

QHash<QString, QString> parseFrontmatter(const QString &raw)
{
    QHash<QString, QString> result;
    QString body;
    if (frontmatterBlock(raw, &body).isEmpty()) return result;
    const QStringList lines = body.split(QRegularExpression(QStringLiteral("\\r?\\n")));
    for (const QString &line : lines) {
        const int index = line.indexOf(QLatin1Char(':'));
        if (index < 0) continue;
        const QString key = line.left(index).trimmed();
        if (key.isEmpty()) continue;
        QString value = line.mid(index + 1).trimmed();
        if (!value.isEmpty()
            && (value.front() == QLatin1Char('"') || value.front() == QLatin1Char('\''))) {
            value.remove(0, 1);
        }
        if (!value.isEmpty()
            && (value.back() == QLatin1Char('"') || value.back() == QLatin1Char('\''))) {
            value.chop(1);
        }
        result.insert(key, value);
    }
    return result;
}

/**
 * Insert or replace one boolean-ish frontmatter key.
 *
 * Mirrors `setFrontmatterBoolean`: an existing key is replaced in place (keeping its
 * position), a missing key is appended to the block, and a file with no frontmatter
 * gets a fresh block prepended.
 */
QString setFrontmatterValue(const QString &raw, const QString &key, const QString &value,
                            bool prependWhenMissing)
{
    QString body;
    const QString block = frontmatterBlock(raw, &body);
    if (block.isEmpty()) {
        return QStringLiteral("---\n%1: %2\n---\n\n%3").arg(key, value, raw);
    }
    QStringList lines = body.split(QRegularExpression(QStringLiteral("\\r?\\n")));
    bool changed = false;
    for (QString &line : lines) {
        if (!line.trimmed().startsWith(key + QLatin1Char(':'))) continue;
        changed = true;
        line = QStringLiteral("%1: %2").arg(key, value);
    }
    if (!changed) {
        if (prependWhenMissing) lines.prepend(QStringLiteral("%1: %2").arg(key, value));
        else lines.append(QStringLiteral("%1: %2").arg(key, value));
    }
    QString replaced = raw;
    replaced.replace(block, QStringLiteral("---\n%1\n---").arg(lines.join(QLatin1Char('\n'))));
    return replaced;
}

QStringList validateSkill(const QString &name, const QString &description,
                          const maincopy::Translator &translate)
{
    QStringList warnings;
    if (name.isEmpty()) warnings.append(translate(QStringLiteral("mainSkill.warningNameRequired"), {}));
    if (!name.isEmpty()) {
        static const QRegularExpression pattern(
            QStringLiteral("^[\\p{L}\\p{N}]+(?:-[\\p{L}\\p{N}]+)*$"));
        if (!pattern.match(name).hasMatch()) {
            warnings.append(translate(QStringLiteral("mainSkill.warningNameCharacters"), {}));
        }
    }
    if (name.size() > 64) warnings.append(translate(QStringLiteral("mainSkill.warningNameTooLong"), {}));
    if (description.isEmpty()) {
        warnings.append(translate(QStringLiteral("mainSkill.warningDescriptionRequired"), {}));
    }
    if (description.size() > 1024) {
        warnings.append(translate(QStringLiteral("mainSkill.warningDescriptionTooLong"), {}));
    }
    return warnings;
}

QString readAll(const QString &path)
{
    QFile file(path);
    if (!file.open(QIODevice::ReadOnly)) return QString();
    return QString::fromUtf8(file.readAll());
}

void writeAll(const QString &path, const QString &content)
{
    QSaveFile file(path);
    if (!file.open(QIODevice::WriteOnly)) {
        throw textenc::error(QStringLiteral("Unable to write %1").arg(path));
    }
    const QByteArray bytes = content.toUtf8();
    if (file.write(bytes) != bytes.size() || !file.commit()) {
        throw textenc::error(QStringLiteral("Unable to write %1").arg(path));
    }
}

/** Windows/macOS treat a case-only difference as the same entry. */
bool sameRenamePath(const QString &left, const QString &right)
{
    if (left == right) return true;
#ifndef Q_OS_LINUX
    return left.compare(right, Qt::CaseInsensitive) == 0;
#else
    return false;
#endif
}

/** "directory" | "file" | "other", following a symlink the way `getEntryKind` does. */
QString entryKind(const QFileInfo &entry)
{
    if (entry.isDir()) return QStringLiteral("directory");
    if (entry.isFile()) return QStringLiteral("file");
    if (!entry.isSymLink()) return QStringLiteral("other");
    const QFileInfo target(entry.filePath());
    if (target.isDir()) return QStringLiteral("directory");
    if (target.isFile()) return QStringLiteral("file");
    return QStringLiteral("other");
}

} // namespace

QJsonObject locationToJson(const Location &location)
{
    return QJsonObject{
        {QStringLiteral("id"), location.id},
        {QStringLiteral("label"), location.label},
        {QStringLiteral("path"), location.path},
        {QStringLiteral("rootMarkdownEnabled"), location.rootMarkdownEnabled},
    };
}

QJsonObject summaryToJson(const Summary &skill)
{
    QJsonArray warnings;
    for (const QString &warning : skill.warnings) warnings.append(warning);
    return QJsonObject{
        {QStringLiteral("id"), skill.id},
        {QStringLiteral("name"), skill.name},
        {QStringLiteral("description"), skill.description},
        {QStringLiteral("path"), skill.path},
        {QStringLiteral("dir"), skill.dir},
        {QStringLiteral("sourceId"), skill.sourceId},
        {QStringLiteral("sourceLabel"), skill.sourceLabel},
        {QStringLiteral("type"), skill.type},
        {QStringLiteral("enabled"), skill.enabled},
        {QStringLiteral("valid"), skill.valid},
        {QStringLiteral("warnings"), warnings},
    };
}

QJsonObject listToJson(const ListResult &result)
{
    QJsonArray locations;
    for (const Location &location : result.locations) locations.append(locationToJson(location));
    QJsonArray items;
    for (const Summary &skill : result.skills) items.append(summaryToJson(skill));
    return QJsonObject{
        {QStringLiteral("locations"), locations},
        {QStringLiteral("skills"), items},
    };
}

QVector<Location> Manager::buildLocations(const QString &home)
{
    // `~/.pi/agent/skills` also accepts root-level `.md` skills; `~/.agents/skills`
    // only accepts directories. Both are pi's own discovery rules, and the labels stay
    // the `~/...` form in both environments (the oracle does the same).
    return QVector<Location>{
        Location{QStringLiteral("pi-global"), QStringLiteral("~/.pi/agent/skills"),
                 QDir(home).filePath(QStringLiteral(".pi/agent/skills")), true},
        Location{QStringLiteral("agents-global"), QStringLiteral("~/.agents/skills"),
                 QDir(home).filePath(QStringLiteral(".agents/skills")), false},
    };
}

Manager::Manager(QString homeDir, maincopy::Translator translate)
    : m_locations(buildLocations(homeDir)), m_localHome(std::move(homeDir)),
      m_translate(std::move(translate))
{
}

void Manager::configureWsl(const wsl::Environment *environment)
{
    const QString home = environment && environment->isValid() ? environment->windowsHome
                                                              : m_localHome;
    m_locations = buildLocations(home);
}

QStringList Manager::dirs() const
{
    QStringList paths;
    for (const Location &location : m_locations) paths.append(location.path);
    return paths;
}

QString Manager::normalizeName(const QString &value)
{
    QString name = value.trimmed().toLower();
    static const QRegularExpression disallowed(QStringLiteral("[^\\p{L}\\p{N}-]+"));
    name.replace(disallowed, QStringLiteral("-"));
    static const QRegularExpression repeated(QStringLiteral("-+"));
    name.replace(repeated, QStringLiteral("-"));
    while (name.startsWith(QLatin1Char('-'))) name.remove(0, 1);
    while (name.endsWith(QLatin1Char('-'))) name.chop(1);
    return name;
}

const Location &Manager::requireLocation(const QString &id) const
{
    for (const Location &location : m_locations) {
        if (location.id == id) return location;
    }
    throw textenc::error(m_translate(QStringLiteral("mainSkill.unknownLocation"),
                                     QJsonObject{{QStringLiteral("id"), id}}));
}

Summary Manager::readSkill(const QString &skillPath, const Location &location,
                           const QString &type) const
{
    const QString raw = readAll(skillPath);
    const QHash<QString, QString> frontmatter = parseFrontmatter(raw);
    const QString name = frontmatter.value(QStringLiteral("name")).trimmed();
    const QString description = frontmatter.value(QStringLiteral("description")).trimmed();
    Summary skill;
    skill.id = location.id + QLatin1Char(':') + skillPath;
    // The oracle falls back to the *parent directory name*; for a root-level markdown
    // skill that is the location directory itself. Reproduced verbatim.
    skill.name = !name.isEmpty() ? name : QFileInfo(skillPath).dir().dirName();
    if (skill.name.isEmpty()) skill.name = m_translate(QStringLiteral("mainSkill.unnamed"), {});
    skill.description = description;
    skill.path = skillPath;
    skill.dir = QFileInfo(skillPath).absolutePath();
    skill.sourceId = location.id;
    skill.sourceLabel = location.label;
    skill.type = type;
    skill.enabled = frontmatter.value(QStringLiteral("disable-model-invocation")) != QLatin1String("true");
    skill.warnings = validateSkill(name, description, m_translate);
    skill.valid = skill.warnings.isEmpty();
    return skill;
}

void Manager::collectDirectorySkills(const QString &dir, const Location &location,
                                     QVector<Summary> *out, const QSet<QString> &ancestors) const
{
    // Only the current recursion chain is tracked, so a symlink loop cannot recurse
    // forever while two different entries may still resolve to the same skill.
    const QString canonical = pathpolicy::existingRealPath(dir);
    if (canonical.isEmpty() || ancestors.contains(canonical)) return;
    QSet<QString> next = ancestors;
    next.insert(canonical);

    const QString skillPath = QDir(dir).filePath(QLatin1String(kSkillFile));
    if (QFileInfo::exists(skillPath)) {
        out->append(readSkill(skillPath, location, QStringLiteral("directory")));
        return;
    }
    const QFileInfoList entries = QDir(dir).entryInfoList(
        QDir::AllEntries | QDir::NoDotAndDotDot | QDir::Hidden | QDir::System, QDir::NoSort);
    for (const QFileInfo &entry : entries) {
        if (entryKind(entry) != QLatin1String("directory")) continue;
        collectDirectorySkills(entry.absoluteFilePath(), location, out, next);
    }
}

QVector<Summary> Manager::scanLocation(const Location &location) const
{
    QDir().mkpath(location.path);
    QVector<Summary> found;
    QSet<QString> ancestors;
    const QString canonical = pathpolicy::existingRealPath(location.path);
    if (!canonical.isEmpty()) ancestors.insert(canonical);

    const QFileInfoList entries = QDir(location.path).entryInfoList(
        QDir::AllEntries | QDir::NoDotAndDotDot | QDir::Hidden | QDir::System, QDir::NoSort);
    for (const QFileInfo &entry : entries) {
        const QString kind = entryKind(entry);
        if (kind == QLatin1String("directory")) {
            collectDirectorySkills(entry.absoluteFilePath(), location, &found, ancestors);
        } else if (location.rootMarkdownEnabled && kind == QLatin1String("file")
                   && entry.fileName().endsWith(QLatin1String(".md"), Qt::CaseInsensitive)) {
            found.append(readSkill(entry.absoluteFilePath(), location, QStringLiteral("markdown")));
        }
    }
    std::sort(found.begin(), found.end(), [](const Summary &left, const Summary &right) {
        return left.name.localeAwareCompare(right.name) < 0;
    });
    return found;
}

ListResult Manager::list() const
{
    ListResult result;
    result.locations = m_locations;
    QVector<Summary> all;
    for (const Location &location : m_locations) all.append(scanLocation(location));

    // Same name in both roots: `~/.pi/agent/skills` wins, because that is the copy pi
    // loads first and the two directories are frequently out of sync.
    QHash<QString, int> indexByName;
    for (const Summary &skill : all) {
        const QString key = skill.name.toLower();
        const auto existing = indexByName.constFind(key);
        if (existing == indexByName.constEnd()) {
            indexByName.insert(key, result.skills.size());
            result.skills.append(skill);
            continue;
        }
        Summary &current = result.skills[existing.value()];
        if (current.sourceId != QLatin1String("pi-global")
            && skill.sourceId == QLatin1String("pi-global")) {
            current = skill;
        }
    }
    return result;
}

Summary Manager::create(const QString &rawName, const QString &rawDescription,
                        const QString &locationId) const
{
    const Location &location = requireLocation(locationId);
    const QString name = normalizeName(rawName);
    const QString description = rawDescription.trimmed();
    if (name.isEmpty()) {
        throw textenc::error(m_translate(QStringLiteral("mainSkill.nameRequiredDetailed"), {}));
    }
    if (description.isEmpty()) {
        throw textenc::error(m_translate(QStringLiteral("mainSkill.descriptionRequired"), {}));
    }
    const QString skillDir = QDir(location.path).filePath(name);
    if (QFileInfo::exists(skillDir)) {
        throw textenc::error(m_translate(QStringLiteral("mainSkill.alreadyExists"),
                                         QJsonObject{{QStringLiteral("name"), name}}));
    }
    QDir().mkpath(skillDir);
    const QString skillPath = QDir(skillDir).filePath(QLatin1String(kSkillFile));
    const QString content = QStringLiteral(
                                "---\nname: %1\ndescription: %2\n---\n\n# %1\n\n## Usage\n\n"
                                "Describe when and how to use this skill.\n")
                                .arg(name, QString(description).replace(QLatin1Char('\n'),
                                                                       QLatin1Char(' ')));
    writeAll(skillPath, content);
    return readSkill(skillPath, location, QStringLiteral("directory"));
}

Summary Manager::findByPath(const QString &skillPath) const
{
    // The renderer echoes the path it received, but a caller may also hand over a native
    // path; comparing raw strings would then miss a skill that is right there.
    const QString requested = QDir::cleanPath(QDir::fromNativeSeparators(skillPath));
    for (const Summary &skill : list().skills) {
        if (QDir::cleanPath(QDir::fromNativeSeparators(skill.path)) == requested) return skill;
    }
    throw textenc::error(m_translate(QStringLiteral("mainSkill.notFound"), {}));
}

Summary Manager::toggle(const QString &skillPath, bool enabled) const
{
    const Summary skill = findByPath(skillPath);
    const QString raw = readAll(skill.path);
    // `enabled` is the inverse of pi's `disable-model-invocation` flag.
    writeAll(skill.path,
             setFrontmatterValue(raw, QStringLiteral("disable-model-invocation"),
                                 enabled ? QStringLiteral("false") : QStringLiteral("true"), false));
    return findByPath(skill.path);
}

DeleteTarget Manager::prepareDelete(const QString &skillPath) const
{
    const Summary skill = findByPath(skillPath);
    // A directory skill is removed as a whole; a root-level markdown skill is one file.
    return DeleteTarget{skill.type == QLatin1String("directory") ? skill.dir : skill.path,
                        QStringLiteral("skills:delete")};
}

QString Manager::folderToOpen(const QString &skillPath) const
{
    if (skillPath.isEmpty()) {
        QDir().mkpath(m_locations.first().path);
        return m_locations.first().path;
    }
    return findByPath(skillPath).dir;
}

Summary Manager::rename(const QString &skillPath, const QString &rawNewName) const
{
    const Summary skill = findByPath(skillPath);
    const QString newName = normalizeName(rawNewName);
    if (newName.isEmpty()) {
        throw textenc::error(m_translate(QStringLiteral("mainSkill.nameRequired"), {}));
    }
    const Location &location = requireLocation(skill.sourceId);

    const bool directoryType = skill.type == QLatin1String("directory");
    const QString oldEntry = directoryType ? skill.dir : skill.path;
    const QString newEntry = directoryType
        ? QDir(QFileInfo(skill.dir).absolutePath()).filePath(newName)
        : QDir(QFileInfo(skill.path).absolutePath()).filePath(newName + QStringLiteral(".md"));
    // Never move a location root itself, whatever the input.
    if (sameRenamePath(oldEntry, location.path)) {
        throw textenc::error(m_translate(QStringLiteral("mainSkill.notFound"), {}));
    }

    const QString raw = readAll(skill.path);
    const QString updated = setFrontmatterValue(raw, QStringLiteral("name"), newName, true);
    const bool sameEntry = sameRenamePath(oldEntry, newEntry);
    if (sameEntry && updated == raw) {
        throw textenc::error(m_translate(QStringLiteral("mainSkill.sameName"), {}));
    }

    if (!sameEntry) {
        // No target pre-check: the rename syscall is the authority on conflicts.
        try {
            fsops::renameEntry(oldEntry, QFileInfo(newEntry).fileName());
        } catch (const std::exception &failure) {
            const QString message = QString::fromUtf8(failure.what());
            if (message.startsWith(QLatin1String(fsops::kRenameTargetExistsCode))) {
                throw textenc::error(m_translate(QStringLiteral("mainSkill.alreadyExists"),
                                                 QJsonObject{{QStringLiteral("name"), newName}}));
            }
            throw;
        }
    }
    const QString newSkillPath =
        directoryType ? QDir(newEntry).filePath(QFileInfo(skill.path).fileName()) : newEntry;
    if (updated != raw) {
        try {
            writeAll(newSkillPath, updated);
        } catch (...) {
            // The path already moved but the content did not: put the entry back so the
            // operation is all-or-nothing instead of leaving a half-renamed skill.
            if (!sameEntry) QDir().rename(newEntry, oldEntry);
            throw;
        }
    }
    return readSkill(newSkillPath, location, skill.type);
}

} // namespace skills
