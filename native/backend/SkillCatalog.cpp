#include "SkillCatalog.h"

#include <algorithm>

#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QJsonArray>
#include <QRegularExpression>
#include <QSaveFile>

namespace {
QString frontmatterValue(const QString &raw, const QString &key)
{
    static const QRegularExpression pattern(QStringLiteral("^---\\r?\\n([\\s\\S]*?)\\r?\\n---"));
    const QRegularExpressionMatch match = pattern.match(raw);
    if (!match.hasMatch()) return {};
    const QStringList lines = match.captured(1).split(QRegularExpression(QStringLiteral("\\r?\\n")));
    for (const QString &line : lines) {
        const int index = line.indexOf(QLatin1Char(':'));
        if (index < 0) continue;
        if (line.left(index).trimmed() != key) continue;
        QString value = line.mid(index + 1).trimmed();
        if ((value.startsWith(QLatin1Char('"')) && value.endsWith(QLatin1Char('"'))) || (value.startsWith(QLatin1Char('\'')) && value.endsWith(QLatin1Char('\'')))) {
            value = value.mid(1, value.size() - 2);
        }
        return value;
    }
    return {};
}

void collectSkills(const QString &dir, const QString &sourceId, const QString &sourceLabel, QStringList &ancestors, QJsonArray &skills)
{
    const QString canonical = QFileInfo(dir).canonicalFilePath();
    if (canonical.isEmpty() || ancestors.contains(canonical)) return;
    ancestors.append(canonical);
    const QString skillFile = QDir(dir).filePath(QStringLiteral("SKILL.md"));
    if (QFileInfo::exists(skillFile)) {
        QFile file(skillFile);
        if (!file.open(QIODevice::ReadOnly)) {
            ancestors.removeLast();
            return;
        }
        const QString raw = QString::fromUtf8(file.readAll());
        const QString name = frontmatterValue(raw, QStringLiteral("name"));
        const QString description = frontmatterValue(raw, QStringLiteral("description"));
        const bool enabled = frontmatterValue(raw, QStringLiteral("disable-model-invocation")) != QStringLiteral("true");
        skills.append(QJsonObject{
            {QStringLiteral("id"), QStringLiteral("%1:%2").arg(sourceId, skillFile)},
            {QStringLiteral("name"), name.isEmpty() ? QFileInfo(dir).fileName() : name},
            {QStringLiteral("description"), description},
            {QStringLiteral("path"), skillFile},
            {QStringLiteral("dir"), dir},
            {QStringLiteral("sourceId"), sourceId},
            {QStringLiteral("sourceLabel"), sourceLabel},
            {QStringLiteral("type"), QStringLiteral("directory")},
            {QStringLiteral("enabled"), enabled},
            {QStringLiteral("valid"), !name.isEmpty() && !description.isEmpty()},
        });
        ancestors.removeLast();
        return;
    }
    const QFileInfoList entries = QDir(dir).entryInfoList(QDir::Dirs | QDir::NoDotAndDotDot);
    for (const QFileInfo &entry : entries) collectSkills(entry.absoluteFilePath(), sourceId, sourceLabel, ancestors, skills);
    ancestors.removeLast();
}
}

SkillCatalogRead listSkills(const QString &skillsDir, const QString &sourceId, const QString &sourceLabel)
{
    SkillCatalogRead result;
    if (skillsDir.trimmed().isEmpty()) {
        result.error = QStringLiteral("Skill directory is required");
        return result;
    }
    QDir directory(skillsDir);
    if (!directory.exists() && !directory.mkpath(QStringLiteral("."))) {
        result.error = QStringLiteral("Unable to open skill directory");
        return result;
    }
    QJsonArray skills;
    QStringList ancestors;
    const QString canonicalRoot = QFileInfo(directory.absolutePath()).canonicalFilePath();
    if (!canonicalRoot.isEmpty()) ancestors.append(canonicalRoot);
    const QFileInfoList entries = directory.entryInfoList(QDir::Dirs | QDir::NoDotAndDotDot);
    for (const QFileInfo &entry : entries) collectSkills(entry.absoluteFilePath(), sourceId, sourceLabel, ancestors, skills);
    QList<QJsonObject> sortable;
    for (const QJsonValue &value : skills) sortable.append(value.toObject());
    std::sort(sortable.begin(), sortable.end(), [](const QJsonObject &left, const QJsonObject &right) {
        return left.value(QStringLiteral("name")).toString().localeAwareCompare(right.value(QStringLiteral("name")).toString()) < 0;
    });
    QJsonArray sorted;
    for (const QJsonObject &item : sortable) sorted.append(item);
    result.ok = true;
    result.result = QJsonObject{
        {QStringLiteral("locations"), QJsonArray{QJsonObject{{QStringLiteral("id"), sourceId}, {QStringLiteral("path"), directory.absolutePath()}, {QStringLiteral("label"), sourceLabel}}}},
        {QStringLiteral("skills"), sorted},
    };
    return result;
}

namespace {
bool skillNameAllowed(const QString &name)
{
    static const QRegularExpression pattern(QStringLiteral("^[A-Za-z0-9._-]+$"));
    return pattern.match(name).hasMatch();
}
}

SkillCatalogRead createSkillDirectory(const QString &skillsDir, const QString &name, const QString &description)
{
    SkillCatalogRead result;
    if (!skillNameAllowed(name) || description.trimmed().isEmpty()) {
        result.error = QStringLiteral("Skill is invalid");
        return result;
    }
    QDir directory(skillsDir);
    const QString skillDir = directory.filePath(name);
    if (QFileInfo::exists(skillDir) || !directory.mkpath(name)) {
        result.error = QStringLiteral("Unable to create skill directory");
        return result;
    }
    QSaveFile file(QDir(skillDir).filePath(QStringLiteral("SKILL.md")));
    const QByteArray content = QStringLiteral("---\nname: %1\ndescription: %2\n---\n").arg(name, description.trimmed()).toUtf8();
    if (!file.open(QIODevice::WriteOnly) || file.write(content) < 0 || !file.commit()) {
        result.error = QStringLiteral("Unable to write skill file");
        return result;
    }
    return listSkills(skillsDir, QStringLiteral("pi-global"), QStringLiteral("Global"));
}

SkillCatalogRead deleteSkillDirectory(const QString &skillsDir, const QString &name)
{
    SkillCatalogRead result;
    if (!skillNameAllowed(name)) {
        result.error = QStringLiteral("Skill is invalid");
        return result;
    }
    const QString skillDir = QDir(skillsDir).filePath(name);
    if (!QFileInfo::exists(skillDir)) return listSkills(skillsDir, QStringLiteral("pi-global"), QStringLiteral("Global"));
    if (!QFile::moveToTrash(skillDir)) {
        result.error = QStringLiteral("Unable to move skill to trash");
        return result;
    }
    return listSkills(skillsDir, QStringLiteral("pi-global"), QStringLiteral("Global"));
}
