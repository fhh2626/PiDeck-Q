#include "ClaudeImporter.h"

#include <QDateTime>

#include <limits>
#include <QFileInfo>
#include <QJsonArray>
#include <QJsonDocument>
#include <QRegularExpression>

namespace claudeimport {
namespace {

QString isoFromMs(qint64 ms)
{
    return QDateTime::fromMSecsSinceEpoch(ms, Qt::UTC).toString(Qt::ISODateWithMs);
}

/** `content` / `output` of a tool_result entry, flattened to text. */
QString extractToolOutput(const QJsonObject &payload)
{
    QJsonValue output = payload.value(QStringLiteral("content"));
    if (output.isUndefined()) output = payload.value(QStringLiteral("output"));
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
            if (text.isString() && !text.toString().isEmpty()) parts.append(text.toString());
        }
        return parts.join(QLatin1Char('\n'));
    }
    if (output.isObject()) {
        return QString::fromUtf8(QJsonDocument(output.toObject()).toJson(QJsonDocument::Indented)).trimmed();
    }
    if (output.isUndefined() || output.isNull()) return QStringLiteral("\"\"");
    if (output.isBool()) return output.toBool() ? QStringLiteral("true") : QStringLiteral("false");
    if (output.isDouble()) {
        const double number = output.toDouble();
        if (number == qint64(number)) return QString::number(qint64(number));
        return QString::number(number);
    }
    return QString();
}

bool parseTimestamp(const QJsonValue &value, qint64 *out)
{
    if (!value.isString()) return false;
    const QDateTime parsed = QDateTime::fromString(value.toString(), Qt::ISODateWithMs);
    if (parsed.isValid()) {
        *out = parsed.toMSecsSinceEpoch();
        return true;
    }
    const QDateTime fallback = QDateTime::fromString(value.toString(), Qt::ISODate);
    if (!fallback.isValid()) return false;
    *out = fallback.toMSecsSinceEpoch();
    return true;
}

QString sanitizeId(const QString &value)
{
    QString id = value;
    static const QRegularExpression invalid(QStringLiteral("[^a-zA-Z0-9_-]"));
    id.replace(invalid, QStringLiteral("-"));
    return id;
}

} // namespace

QString projectDir(const QString &claudeRoot, const QString &projectPath)
{
    QString normalized = projectPath;
    normalized.replace(QLatin1Char('\\'), QLatin1Char('/'));
    static const QRegularExpression windowsDrive(QStringLiteral("^([A-Za-z]):/(.+)$"));
    const QRegularExpressionMatch match = windowsDrive.match(normalized);
    if (match.hasMatch()) {
        QString rest = match.captured(2);
        rest.replace(QLatin1Char('/'), QLatin1Char('-'));
        return claudeRoot + QLatin1Char('/') + match.captured(1) + QStringLiteral("--") + rest;
    }
    if (normalized.startsWith(QLatin1Char('/'))) normalized.remove(0, 1);
    normalized.replace(QLatin1Char('/'), QLatin1Char('-'));
    return claudeRoot + QLatin1Char('/') + normalized;
}

QString targetPathFor(const QString &piRoot, const QString &projectPath, const Session &session)
{
    return sessionimport::projectSessionDir(piRoot, projectPath) + QStringLiteral("/claude_")
        + sanitizeId(session.sessionId) + QStringLiteral(".jsonl");
}

bool readSession(const SessionFs &fs, const QString &filePath, Session *out)
{
    qint64 mtime = 0;
    qint64 size = 0;
    if (!fs.statVersion(filePath, &mtime, &size)) return false;
    QString raw;
    QString error;
    if (!fs.readText(filePath, &raw, &error)) return false;
    const QVector<QJsonObject> entries = sessionimport::parseJsonl(raw);
    QJsonObject firstUser;
    for (const QJsonObject &entry : entries) {
        if (entry.value(QStringLiteral("type")).toString() == QLatin1String("user")) {
            firstUser = entry;
            break;
        }
    }
    const QString sessionId = firstUser.value(QStringLiteral("sessionId")).toString();
    const QString cwd = firstUser.value(QStringLiteral("cwd")).toString();
    if (sessionId.isEmpty() || cwd.isEmpty()) return false;

    // Extremes are folded in a loop: spreading a long timestamp array would overflow.
    qint64 first = std::numeric_limits<qint64>::max();
    qint64 last = std::numeric_limits<qint64>::min();
    for (const QJsonObject &entry : entries) {
        qint64 parsed = 0;
        if (!parseTimestamp(entry.value(QStringLiteral("timestamp")), &parsed)) continue;
        first = qMin(first, parsed);
        last = qMax(last, parsed);
    }
    if (first == std::numeric_limits<qint64>::max()) first = 0;
    if (last == std::numeric_limits<qint64>::min()) last = 0;

    out->sessionId = sessionId;
    out->cwd = cwd;
    out->firstTimestamp = first;
    out->lastTimestamp = last;
    out->entries = entries;
    out->sourcePath = filePath;
    out->sourceSize = size;
    out->sourceMtime = mtime;
    return true;
}

sessionimport::Converted convert(const QString &projectPath, const Session &session,
                                 const maincopy::Translator &translate)
{
    const QString sessionId = session.sessionId;
    const QString timestamp = isoFromMs(session.firstTimestamp);
    QStringList lines;
    QString parentId;
    int sequence = 0;
    int messageCount = 0;
    QString title;
    QString preview;

    const auto pushMessage = [&](const QString &role, const QJsonArray &content, const QJsonObject &extra,
                                 const QJsonValue &timestampValue) {
        if (content.isEmpty()) return;
        const QString id = sessionimport::makeId(sessionId, sequence++);
        qint64 messageTimestamp = 0;
        if (!parseTimestamp(timestampValue, &messageTimestamp)) {
            messageTimestamp = QDateTime::currentMSecsSinceEpoch();
        }
        QJsonObject message{
            {QStringLiteral("role"), role},
            {QStringLiteral("content"), content},
            {QStringLiteral("timestamp"), double(messageTimestamp)},
        };
        if (role == QLatin1String("assistant")) message.insert(QStringLiteral("usage"), sessionimport::zeroUsage());
        for (auto iterator = extra.constBegin(); iterator != extra.constEnd(); ++iterator) {
            message.insert(iterator.key(), iterator.value());
        }
        lines.append(QString::fromUtf8(QJsonDocument(QJsonObject{
            {QStringLiteral("type"), QStringLiteral("message")},
            {QStringLiteral("id"), id},
            {QStringLiteral("parentId"), parentId.isEmpty() ? QJsonValue(QJsonValue::Null) : QJsonValue(parentId)},
            {QStringLiteral("timestamp"), isoFromMs(messageTimestamp)},
            {QStringLiteral("message"), message},
        }).toJson(QJsonDocument::Compact)));
        parentId = id;
        messageCount += 1;
        const QString text = sessionimport::extractPiText(content).trimmed();
        if (!text.isEmpty() && preview.isEmpty()) preview = text.left(160);
        if (role == QLatin1String("user") && !text.isEmpty() && title.isEmpty()) {
            title = sessionimport::cleanTitle(text);
        }
    };

    lines.append(QString::fromUtf8(QJsonDocument(QJsonObject{
        {QStringLiteral("type"), QStringLiteral("session")},
        {QStringLiteral("version"), 3},
        {QStringLiteral("id"), sessionId},
        {QStringLiteral("timestamp"), timestamp},
        {QStringLiteral("cwd"), projectPath},
    }).toJson(QJsonDocument::Compact)));
    lines.append(QString::fromUtf8(QJsonDocument(QJsonObject{
        {QStringLiteral("type"), QStringLiteral("claude_import")},
        {QStringLiteral("version"), 1},
        {QStringLiteral("claudeSessionId"), sessionId},
        {QStringLiteral("sourcePath"), session.sourcePath},
        {QStringLiteral("sourceMtime"), double(session.sourceMtime)},
        {QStringLiteral("sourceSize"), double(session.sourceSize)},
        {QStringLiteral("importedAt"), isoFromMs(QDateTime::currentMSecsSinceEpoch())},
    }).toJson(QJsonDocument::Compact)));
    const QString modelChangeId = sessionimport::makeId(sessionId, sequence++);
    lines.append(QString::fromUtf8(QJsonDocument(QJsonObject{
        {QStringLiteral("type"), QStringLiteral("model_change")},
        {QStringLiteral("id"), modelChangeId},
        {QStringLiteral("parentId"), parentId.isEmpty() ? QJsonValue(QJsonValue::Null) : QJsonValue(parentId)},
        {QStringLiteral("timestamp"), timestamp},
        {QStringLiteral("provider"), QStringLiteral("anthropic")},
        {QStringLiteral("modelId"), QStringLiteral("claude-sonnet-4")},
    }).toJson(QJsonDocument::Compact)));
    parentId = modelChangeId;

    for (const QJsonObject &entry : session.entries) {
        const QString type = entry.value(QStringLiteral("type")).toString();
        const QString subtype = entry.value(QStringLiteral("subtype")).toString();
        if (type == QLatin1String("file-history-snapshot")) continue;
        if (type == QLatin1String("system")
            && (subtype == QLatin1String("turn_duration") || subtype == QLatin1String("api_error"))) {
            continue;
        }

        if (type == QLatin1String("user")) {
            const QJsonObject message = entry.value(QStringLiteral("message")).toObject();
            const QJsonValue content = message.value(QStringLiteral("content"));
            // Claude's `user` entries may carry an array of blocks; only plain text is
            // a real user turn here (tool results arrive as their own entry type).
            QString text;
            if (content.isString()) text = content.toString();
            else if (content.isArray()) {
                QStringList parts;
                for (const QJsonValue &value : content.toArray()) {
                    const QJsonObject block = value.toObject();
                    if (block.value(QStringLiteral("type")).toString() != QLatin1String("text")) continue;
                    parts.append(block.value(QStringLiteral("text")).toString());
                }
                text = parts.join(QLatin1Char('\n'));
            }
            text = text.trimmed();
            if (!text.isEmpty()) {
                pushMessage(QStringLiteral("user"),
                            QJsonArray{QJsonObject{{QStringLiteral("type"), QStringLiteral("text")},
                                                   {QStringLiteral("text"), text}}},
                            QJsonObject{}, entry.value(QStringLiteral("timestamp")));
            }
            continue;
        }

        if (type == QLatin1String("assistant")) {
            const QJsonObject message = entry.value(QStringLiteral("message")).toObject();
            if (message.isEmpty()) continue;
            QJsonArray content;
            for (const QJsonValue &value : message.value(QStringLiteral("content")).toArray()) {
                const QJsonObject item = value.toObject();
                const QString itemType = item.value(QStringLiteral("type")).toString();
                if (itemType == QLatin1String("text")) {
                    content.append(QJsonObject{{QStringLiteral("type"), QStringLiteral("text")},
                                               {QStringLiteral("text"), item.value(QStringLiteral("text"))}});
                } else if (itemType == QLatin1String("thinking")) {
                    content.append(QJsonObject{{QStringLiteral("type"), QStringLiteral("thinking")},
                                               {QStringLiteral("thinking"), item.value(QStringLiteral("thinking"))},
                                               {QStringLiteral("thinkingSignature"), QStringLiteral("claude_thinking")}});
                } else if (itemType == QLatin1String("tool_use")) {
                    content.append(QJsonObject{{QStringLiteral("type"), QStringLiteral("toolCall")},
                                               {QStringLiteral("id"), item.value(QStringLiteral("id"))},
                                               {QStringLiteral("name"), item.value(QStringLiteral("name"))},
                                               {QStringLiteral("arguments"), item.value(QStringLiteral("input"))}});
                }
            }
            if (!content.isEmpty()) {
                const QString model = message.value(QStringLiteral("model")).toString();
                const QString stopReason = message.value(QStringLiteral("stop_reason")).toString();
                pushMessage(QStringLiteral("assistant"), content,
                            QJsonObject{{QStringLiteral("api"), QStringLiteral("claude-import")},
                                        {QStringLiteral("provider"), QStringLiteral("anthropic")},
                                        {QStringLiteral("model"),
                                         model.isEmpty() ? QStringLiteral("claude-sonnet-4") : model},
                                        {QStringLiteral("stopReason"),
                                         stopReason.isEmpty() ? QStringLiteral("stop") : stopReason}},
                            entry.value(QStringLiteral("timestamp")));
            }
            continue;
        }

        if (type == QLatin1String("tool_result")) {
            pushMessage(QStringLiteral("toolResult"),
                        QJsonArray{QJsonObject{{QStringLiteral("type"), QStringLiteral("text")},
                                               {QStringLiteral("text"), extractToolOutput(entry)}}},
                        QJsonObject{{QStringLiteral("toolCallId"),
                                     entry.value(QStringLiteral("tool_use_id")).toString()},
                                    {QStringLiteral("toolName"), QStringLiteral("tool")},
                                    {QStringLiteral("isError"), entry.value(QStringLiteral("is_error")).toBool(false)}},
                        entry.value(QStringLiteral("timestamp")));
        }
    }

    sessionimport::Converted converted;
    const QString fileTitle = sessionimport::cleanTitle(QFileInfo(session.sourcePath).fileName());
    converted.title = !title.isEmpty() ? title
        : !fileTitle.isEmpty()            ? fileTitle
                                          : sessionimport::importedTitle(translate, QStringLiteral("Claude"));
    converted.preview = !preview.isEmpty() ? preview
                                           : sessionimport::importedPreview(translate, QStringLiteral("Claude"));
    converted.messageCount = messageCount;
    lines.append(sessionimport::sessionInfoLine(converted.title, parentId, projectPath));
    converted.raw = lines.join(QLatin1Char('\n')) + QLatin1Char('\n');
    return converted;
}

} // namespace claudeimport
