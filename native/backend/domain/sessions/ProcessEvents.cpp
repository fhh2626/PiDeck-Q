#include "ProcessEvents.h"

#include <QDateTime>
#include <QJsonDocument>
#include <QJsonObject>

namespace processevents {
namespace {

QString asString(const QJsonValue &value)
{
    if (!value.isString()) return QString();
    const QString text = value.toString();
    return text.trimmed().isEmpty() ? QString() : text;
}

bool asNumber(const QJsonValue &value, double *out)
{
    if (!value.isDouble()) return false;
    *out = value.toDouble();
    return true;
}

qint64 parseTimestamp(const QJsonValue &value)
{
    if (value.isDouble()) return qint64(value.toDouble());
    if (value.isString()) {
        const QDateTime parsed = QDateTime::fromString(value.toString(), Qt::ISODateWithMs);
        if (parsed.isValid()) return parsed.toMSecsSinceEpoch();
    }
    return 0;
}

QString clipDetail(const QString &value)
{
    if (value.size() <= kDetailLimit) return value;
    return value.left(kDetailLimit) + QStringLiteral("\n…");
}

QString stringifyUnknown(const QJsonValue &value)
{
    if (value.isUndefined() || value.isNull()) return QString();
    if (value.isString()) {
        return value.toString().trimmed().isEmpty() ? QString() : clipDetail(value.toString());
    }
    if (value.isObject()) {
        return clipDetail(QString::fromUtf8(QJsonDocument(value.toObject()).toJson(QJsonDocument::Indented)));
    }
    if (value.isArray()) {
        return clipDetail(QString::fromUtf8(QJsonDocument(value.toArray()).toJson(QJsonDocument::Indented)));
    }
    return QString::fromUtf8(QJsonDocument(QJsonArray{value}).toJson(QJsonDocument::Compact)).mid(1).chopped(1);
}

QString kindFromType(const QString &type, const QString &customType)
{
    if (type == QLatin1String("session")) return QStringLiteral("session");
    if (type == QLatin1String("session_info")) return QStringLiteral("sessionInfo");
    if (type == QLatin1String("model_change")) return QStringLiteral("modelChange");
    if (type == QLatin1String("thinking_level_change")) return QStringLiteral("thinkingChange");
    if (type == QLatin1String("compaction")) return QStringLiteral("compaction");
    if (type == QLatin1String("custom")) return QStringLiteral("custom");
    if (type.endsWith(QLatin1String("_import")) || customType.endsWith(QLatin1String(".child-session"))) {
        return QStringLiteral("import");
    }
    return QString();
}

} // namespace

QJsonArray parse(const QString &raw)
{
    QJsonArray events;
    const QStringList lines = raw.split(QLatin1Char('\n'));
    for (int index = 0; index < lines.size(); ++index) {
        const QString line = lines.at(index).trimmed();
        if (line.isEmpty()) continue;
        QJsonParseError parseError{};
        const QJsonDocument document = QJsonDocument::fromJson(line.toUtf8(), &parseError);
        if (parseError.error != QJsonParseError::NoError || !document.isObject()) continue;
        const QJsonObject entry = document.object();
        const QString type = asString(entry.value(QStringLiteral("type")));
        if (type.isEmpty() || type == QLatin1String("message")) continue;
        const QString customType = asString(entry.value(QStringLiteral("customType")));
        const QString kind = kindFromType(type, customType);
        if (kind.isEmpty()) continue;

        const QJsonObject header = entry.value(QStringLiteral("header")).toObject();
        const QJsonObject data = entry.value(QStringLiteral("data")).toObject();
        QString cwd = asString(entry.value(QStringLiteral("cwd")));
        if (cwd.isEmpty()) cwd = asString(header.value(QStringLiteral("cwd")));
        QString parentSession = asString(entry.value(QStringLiteral("parentSession")));
        if (parentSession.isEmpty()) parentSession = asString(header.value(QStringLiteral("parentSession")));
        const QString provider = asString(entry.value(QStringLiteral("provider")));
        const QString modelId = asString(entry.value(QStringLiteral("modelId")));
        const QString thinkingLevel = asString(entry.value(QStringLiteral("thinkingLevel")));
        QString name = asString(entry.value(QStringLiteral("name")));
        if (name.isEmpty()) name = asString(data.value(QStringLiteral("name")));
        double tokensBefore = 0;
        const bool hasTokensBefore = asNumber(entry.value(QStringLiteral("tokensBefore")), &tokensBefore);
        const QString summaryText = asString(entry.value(QStringLiteral("summary")));
        QString customContent = asString(entry.value(QStringLiteral("content")));
        if (customContent.isEmpty()) customContent = stringifyUnknown(entry.value(QStringLiteral("data")));
        if (customContent.isEmpty()) customContent = stringifyUnknown(entry.value(QStringLiteral("customData")));

        QString summary = type;
        if (kind == QLatin1String("session")) {
            summary = cwd.isEmpty() ? QStringLiteral("session") : QStringLiteral("cwd %1").arg(cwd);
        } else if (kind == QLatin1String("sessionInfo")) {
            summary = name.isEmpty() ? QStringLiteral("session_info") : name;
        } else if (kind == QLatin1String("modelChange")) {
            QStringList parts;
            if (!provider.isEmpty()) parts.append(provider);
            if (!modelId.isEmpty()) parts.append(modelId);
            summary = parts.isEmpty() ? QStringLiteral("model_change") : parts.join(QLatin1Char('/'));
        } else if (kind == QLatin1String("thinkingChange")) {
            summary = thinkingLevel.isEmpty() ? QStringLiteral("thinking_level_change")
                                              : QStringLiteral("thinking %1").arg(thinkingLevel);
        } else if (kind == QLatin1String("compaction")) {
            summary = summaryText.isEmpty() ? QStringLiteral("compaction") : summaryText;
        } else if (kind == QLatin1String("custom")) {
            summary = customType.isEmpty() ? QStringLiteral("custom") : customType;
        } else if (kind == QLatin1String("import")) {
            summary = customType.isEmpty() ? type : customType;
        }

        QString id = asString(entry.value(QStringLiteral("id")));
        if (id.isEmpty()) id = QStringLiteral("process-%1-%2").arg(kind).arg(index);

        QJsonObject event{
            {QStringLiteral("id"), id},
            {QStringLiteral("kind"), kind},
            {QStringLiteral("timestamp"), double(parseTimestamp(entry.value(QStringLiteral("timestamp"))))},
            {QStringLiteral("summary"), summary},
        };
        const QString detail = customContent.isEmpty() ? summaryText : customContent;
        if (!detail.isEmpty()) event.insert(QStringLiteral("detail"), detail);
        if (!cwd.isEmpty()) event.insert(QStringLiteral("cwd"), cwd);
        if (!parentSession.isEmpty()) event.insert(QStringLiteral("parentSession"), parentSession);
        if (!provider.isEmpty()) event.insert(QStringLiteral("provider"), provider);
        if (!modelId.isEmpty()) event.insert(QStringLiteral("modelId"), modelId);
        if (!thinkingLevel.isEmpty()) event.insert(QStringLiteral("thinkingLevel"), thinkingLevel);
        if (!customType.isEmpty()) event.insert(QStringLiteral("customType"), customType);
        if (hasTokensBefore) event.insert(QStringLiteral("tokensBefore"), tokensBefore);
        events.append(event);
        if (events.size() >= kMaxEvents) break;
    }
    return events;
}

} // namespace processevents
