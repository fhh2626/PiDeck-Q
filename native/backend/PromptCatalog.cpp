#include "PromptCatalog.h"

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

QJsonObject builtinTemplate(const QString &name, const QString &description)
{
    return QJsonObject{
        {QStringLiteral("name"), name},
        {QStringLiteral("path"), QStringLiteral("builtin://%1").arg(name)},
        {QStringLiteral("description"), description},
        {QStringLiteral("content"), QStringLiteral("---\ndescription: %1\n---\n").arg(description)},
        {QStringLiteral("userCreated"), false},
        {QStringLiteral("scope"), QStringLiteral("global")},
    };
}
}

PromptCatalogRead listPromptTemplates(const QString &promptsDir, const QStringList &hiddenBuiltins)
{
    PromptCatalogRead result;
    if (promptsDir.trimmed().isEmpty()) {
        result.error = QStringLiteral("Prompt directory is required");
        return result;
    }
    QDir directory(promptsDir);
    if (!directory.exists() && !directory.mkpath(QStringLiteral("."))) {
        result.error = QStringLiteral("Unable to open prompt directory");
        return result;
    }
    QJsonArray templates;
    QStringList userNames;
    const QStringList files = directory.entryList(QStringList{QStringLiteral("*.md")}, QDir::Files);
    for (const QString &fileName : files) {
        if (fileName.endsWith(QStringLiteral(".d.md"))) continue;
        QFile file(directory.filePath(fileName));
        if (!file.open(QIODevice::ReadOnly)) continue;
        const QString raw = QString::fromUtf8(file.readAll());
        if (raw.isEmpty()) continue;
        const QString name = fileName.chopped(3);
        QString description = frontmatterValue(raw, QStringLiteral("description"));
        if (description.isEmpty()) {
            const QStringList lines = raw.split(QRegularExpression(QStringLiteral("\\r?\\n")));
            for (const QString &line : lines) {
                if (!line.trimmed().isEmpty()) {
                    description = line.trimmed();
                    break;
                }
            }
        }
        userNames.append(name);
        templates.append(QJsonObject{
            {QStringLiteral("name"), name},
            {QStringLiteral("path"), directory.filePath(fileName)},
            {QStringLiteral("description"), description},
            {QStringLiteral("content"), raw},
            {QStringLiteral("userCreated"), true},
            {QStringLiteral("scope"), QStringLiteral("global")},
        });
    }
    const QList<QJsonObject> builtins = {
        builtinTemplate(QStringLiteral("review"), QStringLiteral("Review staged git changes for bugs, security issues, and logic errors")),
        builtinTemplate(QStringLiteral("test"), QStringLiteral("Write tests for a function or component covering edge cases")),
        builtinTemplate(QStringLiteral("fix"), QStringLiteral("Debug and fix issues with root cause analysis")),
    };
    for (const QJsonObject &builtin : builtins) {
        const QString name = builtin.value(QStringLiteral("name")).toString();
        if (userNames.contains(name) || hiddenBuiltins.contains(name)) continue;
        templates.append(builtin);
    }
    QList<QJsonObject> sortable;
    for (const QJsonValue &value : templates) sortable.append(value.toObject());
    std::sort(sortable.begin(), sortable.end(), [](const QJsonObject &left, const QJsonObject &right) {
        return left.value(QStringLiteral("name")).toString().localeAwareCompare(right.value(QStringLiteral("name")).toString()) < 0;
    });
    QJsonArray sorted;
    for (const QJsonObject &item : sortable) sorted.append(item);
    result.ok = true;
    result.result = QJsonObject{
        {QStringLiteral("templates"), sorted},
        {QStringLiteral("globalDir"), directory.absolutePath()},
        {QStringLiteral("hasHiddenBuiltins"), !hiddenBuiltins.isEmpty()},
    };
    return result;
}

namespace {
bool catalogNameAllowed(const QString &name)
{
    static const QRegularExpression pattern(QStringLiteral("^[A-Za-z0-9._-]+$"));
    return pattern.match(name).hasMatch();
}
}

PromptCatalogRead createPromptTemplate(const QString &promptsDir, const QString &name, const QString &content)
{
    PromptCatalogRead result;
    if (!catalogNameAllowed(name) || content.trimmed().isEmpty()) {
        result.error = QStringLiteral("Prompt template is invalid");
        return result;
    }
    QDir directory(promptsDir);
    if (!directory.exists() && !directory.mkpath(QStringLiteral("."))) {
        result.error = QStringLiteral("Unable to open prompt directory");
        return result;
    }
    const QString filePath = directory.filePath(name + QStringLiteral(".md"));
    if (QFileInfo::exists(filePath)) {
        result.error = QStringLiteral("Prompt template already exists");
        return result;
    }
    QSaveFile file(filePath);
    if (!file.open(QIODevice::WriteOnly) || file.write(content.toUtf8()) < 0 || !file.commit()) {
        result.error = QStringLiteral("Unable to create prompt template");
        return result;
    }
    return listPromptTemplates(promptsDir, {});
}

PromptCatalogRead deletePromptTemplate(const QString &promptsDir, const QString &name)
{
    PromptCatalogRead result;
    if (!catalogNameAllowed(name)) {
        result.error = QStringLiteral("Prompt template is invalid");
        return result;
    }
    const QString filePath = QDir(promptsDir).filePath(name + QStringLiteral(".md"));
    if (!QFileInfo::exists(filePath)) {
        result.ok = true;
        result.result = listPromptTemplates(promptsDir, {}).result;
        return result;
    }
    if (!QFile::moveToTrash(filePath)) {
        result.error = QStringLiteral("Unable to move prompt template to trash");
        return result;
    }
    return listPromptTemplates(promptsDir, {});
}
