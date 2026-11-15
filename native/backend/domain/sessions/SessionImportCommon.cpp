#include "SessionImportCommon.h"

#include <QCryptographicHash>
#include <QDateTime>
#include <QJsonDocument>
#include <QRegularExpression>
#include <QUuid>

namespace sessionimport {

QString statusOf(const ImportMeta &meta, qint64 sourceMtime, qint64 sourceSize)
{
    if (!meta.found) return QStringLiteral("new");
    if (meta.sourceMtime == sourceMtime && meta.sourceSize == sourceSize) return QStringLiteral("current");
    return QStringLiteral("outdated");
}

QString safePathToken(const QString &path)
{
    QString normalized = path;
    normalized.replace(QLatin1Char('\\'), QLatin1Char('/'));
    static const QRegularExpression windowsDrive(QStringLiteral("^([A-Za-z]):/(.+)$"));
    const QRegularExpressionMatch match = windowsDrive.match(normalized);
    if (match.hasMatch()) {
        QString rest = match.captured(2);
        rest.replace(QLatin1Char('/'), QLatin1Char('-'));
        return QStringLiteral("--%1--%2--").arg(match.captured(1), rest);
    }
    if (normalized.startsWith(QLatin1Char('/'))) normalized.remove(0, 1);
    normalized.replace(QLatin1Char('/'), QLatin1Char('-'));
    return QStringLiteral("--%1--").arg(normalized);
}

QString projectSessionDir(const QString &piRoot, const QString &projectPath)
{
    return piRoot + QLatin1Char('/') + safePathToken(projectPath);
}

QString cleanTitle(const QString &value)
{
    static const QRegularExpression whitespace(QStringLiteral("\\s+"));
    QString text = value;
    text.replace(whitespace, QStringLiteral(" "));
    text = text.trimmed();
    if (text.isEmpty()) return QString();
    static const QRegularExpression untitled(QStringLiteral("^untitled$"), QRegularExpression::CaseInsensitiveOption);
    if (untitled.match(text).hasMatch()) return QString();
    return text.size() > 40 ? text.left(40) + QStringLiteral("...") : text;
}

QString makeId(const QString &sessionId, int sequence)
{
    const QByteArray digest = QCryptographicHash::hash(
        QStringLiteral("%1:%2").arg(sessionId).arg(sequence).toUtf8(), QCryptographicHash::Sha1);
    return QString::fromLatin1(digest.toHex().left(8));
}

QString randomShortId()
{
    return QUuid::createUuid().toString(QUuid::Id128).left(8);
}

QString extractPiText(const QJsonArray &content)
{
    QStringList parts;
    for (const QJsonValue &value : content) {
        const QJsonObject item = value.toObject();
        for (const char *key : {"text", "thinking", "name"}) {
            const QJsonValue field = item.value(QLatin1String(key));
            if (field.isString() && !field.toString().isEmpty()) {
                parts.append(field.toString());
                break;
            }
        }
    }
    return parts.join(QLatin1Char(' '));
}

QJsonObject zeroUsage()
{
    return QJsonObject{
        {QStringLiteral("input"), 0},
        {QStringLiteral("output"), 0},
        {QStringLiteral("cacheRead"), 0},
        {QStringLiteral("cacheWrite"), 0},
        {QStringLiteral("totalTokens"), 0},
        {QStringLiteral("cost"), QJsonObject{
             {QStringLiteral("input"), 0},
             {QStringLiteral("output"), 0},
             {QStringLiteral("cacheRead"), 0},
             {QStringLiteral("cacheWrite"), 0},
             {QStringLiteral("total"), 0},
         }},
    };
}

QString extractToolOutput(const QJsonValue &payload)
{
    const QJsonObject object = payload.toObject();
    QJsonValue output = object.contains(QStringLiteral("content")) ? object.value(QStringLiteral("content"))
                                                                  : object.value(QStringLiteral("output"));
    if (output.isString()) return output.toString();
    if (output.isArray()) {
        QStringList parts;
        for (const QJsonValue &value : output.toArray()) {
            if (value.isString()) {
                if (!value.toString().isEmpty()) parts.append(value.toString());
                continue;
            }
            const QJsonObject item = value.toObject();
            const QJsonValue text = item.contains(QStringLiteral("text"))
                ? item.value(QStringLiteral("text"))
                : item.value(QStringLiteral("content"));
            const QString rendered = text.isString() ? text.toString() : QString();
            if (!rendered.isEmpty()) parts.append(rendered);
        }
        return parts.join(QLatin1Char('\n'));
    }
    if (output.isUndefined() || output.isNull()) return QStringLiteral("\"\"");
    // JSON.stringify(value, null, 2) semantics: objects/arrays pretty-printed, scalars
    // rendered as their literal text.
    if (output.isObject() || output.isArray()) {
        return QString::fromUtf8(QJsonDocument(output.isObject() ? QJsonDocument(output.toObject())
                                                                 : QJsonDocument(output.toArray()))
                                      .toJson(QJsonDocument::Indented))
            .trimmed();
    }
    if (output.isBool()) return output.toBool() ? QStringLiteral("true") : QStringLiteral("false");
    if (output.isDouble()) {
        const double number = output.toDouble();
        if (number == qint64(number)) return QString::number(qint64(number));
        return QString::number(number);
    }
    return QString();
}

QString normalizePath(const QString &path)
{
    QString normalized = path;
    normalized.replace(QLatin1Char('\\'), QLatin1Char('/'));
    while (normalized.endsWith(QLatin1Char('/'))) normalized.chop(1);
    return normalized.toLower();
}

QStringList collectJsonl(const SessionFs &fs, const QString &directory)
{
    QStringList files;
    for (const QString &name : fs.listNames(directory)) {
        const QString path = fs.join(directory, name);
        if (fs.isDirectory(path)) {
            files.append(collectJsonl(fs, path));
        } else if (name.endsWith(QLatin1String(".jsonl"))) {
            files.append(path);
        }
    }
    return files;
}

ImportMeta readImportMeta(const SessionFs &fs, const QString &targetPath, const QString &key)
{
    ImportMeta meta;
    QString raw;
    QString error;
    if (!fs.readText(targetPath, &raw, &error)) return meta;
    const QStringList lines = raw.split(QLatin1Char('\n'));
    const int limit = qMin(8, lines.size());
    for (int index = 0; index < limit; ++index) {
        const QString line = lines.at(index).trimmed();
        if (line.isEmpty()) continue;
        const QJsonDocument document = QJsonDocument::fromJson(line.toUtf8());
        if (!document.isObject()) continue;
        const QJsonObject entry = document.object();
        if (entry.value(QStringLiteral("type")).toString() != key + QStringLiteral("_import")) continue;
        meta.found = true;
        meta.sourceMtime = qint64(entry.value(QStringLiteral("sourceMtime")).toDouble());
        meta.sourceSize = qint64(entry.value(QStringLiteral("sourceSize")).toDouble());
        return meta;
    }
    return meta;
}

QVector<QJsonObject> parseJsonl(const QString &raw)
{
    QVector<QJsonObject> entries;
    for (const QString &line : raw.split(QLatin1Char('\n'))) {
        const QString trimmed = line.trimmed();
        if (trimmed.isEmpty()) continue;
        const QJsonDocument document = QJsonDocument::fromJson(trimmed.toUtf8());
        // A truncated or non-object line is skipped: one bad line must not make the
        // whole session unscannable (same policy as the pi session scanner).
        if (!document.isObject()) continue;
        entries.append(document.object());
    }
    return entries;
}

QString importedTitle(const maincopy::Translator &translate, const QString &source)
{
    return translate(QStringLiteral("session.importedTitle"), QJsonObject{{QStringLiteral("source"), source}});
}

QString importedPreview(const maincopy::Translator &translate, const QString &source)
{
    return translate(QStringLiteral("session.importedPreview"), QJsonObject{{QStringLiteral("source"), source}});
}

QString sessionInfoLine(const QString &title, const QString &parentId, const QString &cwd)
{
    const QJsonObject info{
        {QStringLiteral("type"), QStringLiteral("session_info")},
        {QStringLiteral("id"), randomShortId()},
        {QStringLiteral("parentId"), parentId.isEmpty() ? QJsonValue(QJsonValue::Null) : QJsonValue(parentId)},
        {QStringLiteral("timestamp"), QDateTime::currentDateTimeUtc().toString(Qt::ISODateWithMs)},
        {QStringLiteral("name"), title},
        {QStringLiteral("cwd"), cwd},
    };
    return QString::fromUtf8(QJsonDocument(info).toJson(QJsonDocument::Compact));
}

bool writeImported(const SessionFs &fs, const QString &path, const QString &raw, QString *error)
{
    if (!fs.makeDirectory(fs.dirname(path))) {
        if (error) *error = QStringLiteral("Unable to create the project session directory");
        return false;
    }
    return fs.writeAtomic(path, raw.toUtf8(), error);
}

} // namespace sessionimport
