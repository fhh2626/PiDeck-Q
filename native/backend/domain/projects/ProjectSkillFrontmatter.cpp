#include "ProjectResourcesInternal.h"

#include <QJsonArray>
#include <QRegularExpression>

namespace projectresources {
namespace internal {
namespace {

QString frontmatterPattern()
{
    return QStringLiteral("^---\\r?\\n([\\s\\S]*?)\\r?\\n---");
}

/**
 * Rewrite the first frontmatter block.
 *
 * The oracle uses `String.replace(matchedText, replacement)`, i.e. the first
 * occurrence; the block is anchored at the start of the file, so replacing that span is
 * equivalent. Returns an empty string when the file has no frontmatter.
 */
QString replaceFrontmatter(const QString &raw, const std::function<void(QStringList &, bool &)> &mutate)
{
    const QRegularExpression pattern(frontmatterPattern());
    const QRegularExpressionMatch match = pattern.match(raw);
    if (!match.hasMatch()) return {};
    QStringList lines = match.captured(1).split(QRegularExpression(QStringLiteral("\\r?\\n")));
    bool changed = false;
    mutate(lines, changed);
    const QString replacement = QStringLiteral("---\n") + lines.join(QLatin1Char('\n'))
        + QStringLiteral("\n---");
    QString result = raw;
    result.replace(match.capturedStart(), match.capturedLength(), replacement);
    return result;
}

} // namespace

const QString kSkillFile = QStringLiteral("SKILL.md");

QHash<QString, QString> parseFrontmatter(const QString &raw)
{
    QHash<QString, QString> result;
    const QRegularExpressionMatch match = QRegularExpression(frontmatterPattern()).match(raw);
    if (!match.hasMatch()) return result;
    const QStringList lines = match.captured(1).split(QRegularExpression(QStringLiteral("\\r?\\n")));
    for (const QString &line : lines) {
        const int index = line.indexOf(QLatin1Char(':'));
        if (index < 0) continue;
        const QString key = line.left(index).trimmed();
        QString value = line.mid(index + 1).trimmed();
        // Strip one leading and one trailing quote, mirroring /^['"]|['"]$/g.
        if (value.startsWith(QLatin1Char('\'')) || value.startsWith(QLatin1Char('"'))) {
            value.remove(0, 1);
        }
        if (value.endsWith(QLatin1Char('\'')) || value.endsWith(QLatin1Char('"'))) {
            value.chop(1);
        }
        if (!key.isEmpty()) result.insert(key, value);
    }
    return result;
}

QString setFrontmatterBoolean(const QString &raw, const QString &key, bool value)
{
    const QString rendered = value ? QStringLiteral("true") : QStringLiteral("false");
    if (!QRegularExpression(frontmatterPattern()).match(raw).hasMatch()) {
        return QStringLiteral("---\n%1: %2\n---\n\n%3").arg(key, rendered, raw);
    }
    return replaceFrontmatter(raw, [&key, &rendered](QStringList &lines, bool &changed) {
        for (QString &line : lines) {
            if (!line.trimmed().startsWith(key + QLatin1Char(':'))) continue;
            changed = true;
            line = key + QStringLiteral(": ") + rendered;
        }
        if (!changed) lines.append(key + QStringLiteral(": ") + rendered);
    });
}

QString setFrontmatterName(const QString &raw, const QString &name)
{
    if (!QRegularExpression(frontmatterPattern()).match(raw).hasMatch()) {
        return QStringLiteral("---\nname: %1\n---\n\n%2").arg(name, raw);
    }
    return replaceFrontmatter(raw, [&name](QStringList &lines, bool &) {
        for (QString &line : lines) {
            if (!line.trimmed().startsWith(QStringLiteral("name:"))) continue;
            line = QStringLiteral("name: ") + name;
        }
    });
}

QString normalizeSkillName(const QString &value)
{
    QString name = value.trimmed().toLower();
    name.replace(QRegularExpression(QStringLiteral("[^a-z0-9-]+")), QStringLiteral("-"));
    name.replace(QRegularExpression(QStringLiteral("-+")), QStringLiteral("-"));
    while (name.startsWith(QLatin1Char('-'))) name.remove(0, 1);
    while (name.endsWith(QLatin1Char('-'))) name.chop(1);
    return name;
}

QStringList validateSkill(const QString &name, const QString &description,
                          const maincopy::Translator &translate)
{
    QStringList warnings;
    if (name.isEmpty()) warnings.append(translate(QStringLiteral("mainSkill.warningNameRequired"), {}));
    static const QRegularExpression kebab(QStringLiteral("^[a-z0-9]+(?:-[a-z0-9]+)*$"));
    if (!name.isEmpty() && !kebab.match(name).hasMatch()) {
        warnings.append(translate(QStringLiteral("mainProjectResource.warningNameCharacters"), {}));
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

QJsonArray toJsonArray(const QStringList &values)
{
    QJsonArray array;
    for (const QString &value : values) array.append(value);
    return array;
}

} // namespace internal
} // namespace projectresources
