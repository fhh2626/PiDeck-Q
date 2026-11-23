#include "CodexImporter.h"

#include <QCryptographicHash>
#include <QDateTime>
#include <QJsonArray>
#include <QJsonDocument>
#include <QFileInfo>
#include <QRegularExpression>

namespace codeximport {
namespace {

QString stringValue(const QJsonValue &value)
{
    if (!value.isString()) return QString();
    const QString text = value.toString().trimmed();
    return text;
}

/** `payload.content ?? payload.summary ?? payload.text ?? payload.output`, text-joined. */
QString extractCodexText(const QJsonObject &payload)
{
    QJsonValue content = payload.value(QStringLiteral("content"));
    if (content.isUndefined()) content = payload.value(QStringLiteral("summary"));
    if (content.isUndefined()) content = payload.value(QStringLiteral("text"));
    if (content.isUndefined()) content = payload.value(QStringLiteral("output"));
    if (content.isString()) return content.toString();
    if (!content.isArray()) return QString();
    QStringList parts;
    for (const QJsonValue &value : content.toArray()) {
        if (value.isString()) {
            if (!value.toString().isEmpty()) parts.append(value.toString());
            continue;
        }
        if (!value.isObject()) continue;
        const QJsonObject item = value.toObject();
        for (const char *key : {"text", "message", "content"}) {
            const QJsonValue field = item.value(QLatin1String(key));
            if (field.isString() && !field.toString().isEmpty()) {
                parts.append(field.toString());
                break;
            }
        }
    }
    return parts.join(QLatin1Char('\n'));
}

QString extractToolOutput(const QJsonObject &payload)
{
    QJsonValue output = payload.value(QStringLiteral("output"));
    if (output.isUndefined()) output = payload.value(QStringLiteral("content"));
    if (output.isString()) return output.toString();
    if (output.isArray()) {
        QJsonObject wrapper{{QStringLiteral("content"), output}};
        return extractCodexText(wrapper);
    }
    if (output.isUndefined() || output.isNull()) return QStringLiteral("\"\"");
    if (output.isObject()) {
        return QString::fromUtf8(QJsonDocument(output.toObject()).toJson(QJsonDocument::Indented)).trimmed();
    }
    if (output.isBool()) return output.toBool() ? QStringLiteral("true") : QStringLiteral("false");
    if (output.isDouble()) {
        const double number = output.toDouble();
        if (number == qint64(number)) return QString::number(qint64(number));
        return QString::number(number);
    }
    return QString();
}

/** `arguments` is a JSON string in codex rollouts; a parse failure keeps the raw text. */
QJsonValue parseArguments(const QJsonValue &value)
{
    if (!value.isString()) {
        return value.isUndefined() || value.isNull() ? QJsonValue(QJsonObject{}) : value;
    }
    const QJsonDocument document = QJsonDocument::fromJson(value.toString().toUtf8());
    if (document.isObject()) return document.object();
    if (document.isArray()) return document.array();
    return QJsonObject{{QStringLiteral("input"), value.toString()}};
}

/** Numeric timestamps pass through; ISO strings are parsed; anything else is absent. */
bool parseTimestamp(const QJsonValue &value, qint64 *out)
{
    if (value.isDouble()) {
        *out = qint64(value.toDouble());
        return true;
    }
    if (!value.isString()) return false;
    const QDateTime parsed = QDateTime::fromString(value.toString(), Qt::ISODateWithMs);
    if (!parsed.isValid()) {
        const QDateTime fallback = QDateTime::fromString(value.toString(), Qt::ISODate);
        if (!fallback.isValid()) return false;
        *out = fallback.toMSecsSinceEpoch();
        return true;
    }
    *out = parsed.toMSecsSinceEpoch();
    return true;
}

QString isoFromMs(qint64 ms)
{
    return QDateTime::fromMSecsSinceEpoch(ms, Qt::UTC).toString(Qt::ISODateWithMs);
}

QString joinText(const QString &left, const QString &right)
{
    if (left.isEmpty()) return right;
    if (right.isEmpty()) return left;
    return left + QStringLiteral("\n\n") + right;
}

QString sha1Hex(const QString &value)
{
    return QString::fromLatin1(
        QCryptographicHash::hash(value.toUtf8(), QCryptographicHash::Sha1).toHex());
}

QString sanitizeId(const QString &value)
{
    QString id = value;
    static const QRegularExpression invalid(QStringLiteral("[^a-zA-Z0-9_-]"));
    id.replace(invalid, QStringLiteral("-"));
    return id;
}

} // namespace

ThreadInfo threadInfoOf(const QJsonObject &meta)
{
    const QJsonValue source = meta.value(QStringLiteral("source"));
    const QJsonObject subagent = source.toObject().value(QStringLiteral("subagent")).toObject();
    const QJsonObject spawn = subagent.value(QStringLiteral("thread_spawn")).toObject();
    const QString threadSource = meta.value(QStringLiteral("thread_source")).toString();
    const QString parentThreadId = stringValue(meta.value(QStringLiteral("parent_thread_id")));
    // Subagent detection: an explicit `thread_source`, a legacy `parent_thread_id`, or a
    // `source.subagent` envelope. An explicit `"user"` wins over a stray parent id.
    const bool isSubagent = threadSource == QLatin1String("subagent")
        || (threadSource != QLatin1String("user") && !parentThreadId.isEmpty()) || !subagent.isEmpty();
    ThreadInfo info;
    if (!isSubagent) {
        info.threadSource = QStringLiteral("user");
        return info;
    }
    info.threadSource = QStringLiteral("subagent");
    info.parentThreadId = !parentThreadId.isEmpty()
        ? parentThreadId
        : !stringValue(spawn.value(QStringLiteral("parent_thread_id"))).isEmpty()
        ? stringValue(spawn.value(QStringLiteral("parent_thread_id")))
        : stringValue(meta.value(QStringLiteral("session_id")));
    info.agentRole = !stringValue(meta.value(QStringLiteral("agent_role"))).isEmpty()
        ? stringValue(meta.value(QStringLiteral("agent_role")))
        : stringValue(spawn.value(QStringLiteral("agent_role")));
    info.agentNickname = !stringValue(meta.value(QStringLiteral("agent_nickname"))).isEmpty()
        ? stringValue(meta.value(QStringLiteral("agent_nickname")))
        : stringValue(spawn.value(QStringLiteral("agent_nickname")));
    return info;
}

sessionimport::Converted convert(const QString &projectPath, const Session &session,
                                 const maincopy::Translator &translate)
{
    const QString sessionId = !stringValue(session.meta.value(QStringLiteral("id"))).isEmpty()
        ? stringValue(session.meta.value(QStringLiteral("id")))
        : sha1Hex(session.sourcePath);
    const ThreadInfo threadInfo = threadInfoOf(session.meta);
    qint64 createdAt = 0;
    if (!parseTimestamp(session.meta.value(QStringLiteral("timestamp")), &createdAt)) {
        createdAt = session.sourceMtime;
    }
    const QString provider = stringValue(session.meta.value(QStringLiteral("model_provider"))).isEmpty()
        ? QStringLiteral("codex")
        : stringValue(session.meta.value(QStringLiteral("model_provider")));
    const QString model = stringValue(session.meta.value(QStringLiteral("model"))).isEmpty()
        ? QStringLiteral("codex")
        : stringValue(session.meta.value(QStringLiteral("model")));

    QStringList lines;
    QString parentId;
    int sequence = 0;
    int messageCount = 0;
    QString pendingThinking;
    QString title;
    QString preview;
    QHash<QString, QString> toolNames;
    QHash<QString, qint64> toolStartedAt;

    const auto pushMessage = [&](const QString &role, const QJsonArray &content, const QJsonObject &extra,
                                 const QJsonValue &timestampValue) {
        if (content.isEmpty()) return;
        const QString id = sessionimport::makeId(sessionId, sequence++);
        qint64 messageTimestamp = 0;
        if (!parseTimestamp(timestampValue, &messageTimestamp)) {
            messageTimestamp = session.sourceMtime + sequence;
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
        {QStringLiteral("timestamp"), isoFromMs(createdAt)},
        {QStringLiteral("cwd"), projectPath},
    }).toJson(QJsonDocument::Compact)));
    lines.append(QString::fromUtf8(QJsonDocument(QJsonObject{
        {QStringLiteral("type"), QStringLiteral("codex_import")},
        {QStringLiteral("version"), 1},
        {QStringLiteral("codexSessionId"), sessionId},
        {QStringLiteral("sourcePath"), session.sourcePath},
        {QStringLiteral("sourceMtime"), double(session.sourceMtime)},
        {QStringLiteral("sourceSize"), double(session.sourceSize)},
        {QStringLiteral("importedAt"), isoFromMs(QDateTime::currentMSecsSinceEpoch())},
        {QStringLiteral("threadSource"), threadInfo.threadSource},
        {QStringLiteral("parentThreadId"),
         threadInfo.parentThreadId.isEmpty() ? QJsonValue(QJsonValue::Null) : QJsonValue(threadInfo.parentThreadId)},
        {QStringLiteral("agentRole"),
         threadInfo.agentRole.isEmpty() ? QJsonValue(QJsonValue::Null) : QJsonValue(threadInfo.agentRole)},
        {QStringLiteral("agentNickname"),
         threadInfo.agentNickname.isEmpty() ? QJsonValue(QJsonValue::Null) : QJsonValue(threadInfo.agentNickname)},
    }).toJson(QJsonDocument::Compact)));
    const QString modelChangeId = sessionimport::makeId(sessionId, sequence++);
    lines.append(QString::fromUtf8(QJsonDocument(QJsonObject{
        {QStringLiteral("type"), QStringLiteral("model_change")},
        {QStringLiteral("id"), modelChangeId},
        {QStringLiteral("parentId"), parentId.isEmpty() ? QJsonValue(QJsonValue::Null) : QJsonValue(parentId)},
        {QStringLiteral("timestamp"), isoFromMs(createdAt)},
        {QStringLiteral("provider"), provider},
        {QStringLiteral("modelId"), model},
    }).toJson(QJsonDocument::Compact)));
    parentId = modelChangeId;

    for (const QJsonObject &entry : session.entries) {
        const QString type = entry.value(QStringLiteral("type")).toString();
        const QJsonObject payload = entry.value(QStringLiteral("payload")).toObject();
        if (type == QLatin1String("event_msg")) {
            if (payload.value(QStringLiteral("type")).toString() != QLatin1String("user_message")) continue;
            const QString text = payload.value(QStringLiteral("message")).toString().trimmed();
            if (text.isEmpty()) continue;
            pushMessage(QStringLiteral("user"),
                        QJsonArray{QJsonObject{{QStringLiteral("type"), QStringLiteral("text")},
                                               {QStringLiteral("text"), text}}},
                        QJsonObject{}, entry.value(QStringLiteral("timestamp")));
            continue;
        }
        if (type != QLatin1String("response_item")) continue;
        const QString payloadType = payload.value(QStringLiteral("type")).toString();

        if (payloadType == QLatin1String("reasoning")) {
            const QString reasoning = extractCodexText(payload).trimmed();
            if (!reasoning.isEmpty()) pendingThinking = joinText(pendingThinking, reasoning);
            continue;
        }

        if (payloadType == QLatin1String("message")
            && payload.value(QStringLiteral("role")).toString() == QLatin1String("assistant")) {
            const QString text = extractCodexText(payload).trimmed();
            QJsonArray content;
            if (!pendingThinking.isEmpty()) {
                content.append(QJsonObject{{QStringLiteral("type"), QStringLiteral("thinking")},
                                           {QStringLiteral("thinking"), pendingThinking},
                                           {QStringLiteral("thinkingSignature"), QStringLiteral("codex_reasoning")}});
            }
            if (!text.isEmpty()) {
                content.append(QJsonObject{{QStringLiteral("type"), QStringLiteral("text")},
                                           {QStringLiteral("text"), text}});
            }
            pendingThinking.clear();
            pushMessage(QStringLiteral("assistant"), content,
                        QJsonObject{{QStringLiteral("api"), QStringLiteral("codex-import")},
                                    {QStringLiteral("provider"), provider},
                                    {QStringLiteral("model"), model},
                                    {QStringLiteral("stopReason"), QStringLiteral("stop")}},
                        entry.value(QStringLiteral("timestamp")));
            continue;
        }

        if (payloadType == QLatin1String("function_call")) {
            QString callId = stringValue(payload.value(QStringLiteral("call_id")));
            if (callId.isEmpty()) callId = stringValue(payload.value(QStringLiteral("id")));
            if (callId.isEmpty()) callId = sessionimport::makeId(sessionId, sequence);
            const QString toolName = stringValue(payload.value(QStringLiteral("name"))).isEmpty()
                ? QStringLiteral("tool")
                : stringValue(payload.value(QStringLiteral("name")));
            toolNames.insert(callId, toolName);
            qint64 startedAt = 0;
            if (parseTimestamp(entry.value(QStringLiteral("timestamp")), &startedAt)) {
                toolStartedAt.insert(callId, startedAt);
            }
            QJsonArray content;
            if (!pendingThinking.isEmpty()) {
                content.append(QJsonObject{{QStringLiteral("type"), QStringLiteral("thinking")},
                                           {QStringLiteral("thinking"), pendingThinking},
                                           {QStringLiteral("thinkingSignature"), QStringLiteral("codex_reasoning")}});
            }
            content.append(QJsonObject{{QStringLiteral("type"), QStringLiteral("toolCall")},
                                       {QStringLiteral("id"), callId},
                                       {QStringLiteral("name"), toolName},
                                       {QStringLiteral("arguments"), parseArguments(payload.value(QStringLiteral("arguments")))}});
            pendingThinking.clear();
            pushMessage(QStringLiteral("assistant"), content,
                        QJsonObject{{QStringLiteral("api"), QStringLiteral("codex-import")},
                                    {QStringLiteral("provider"), provider},
                                    {QStringLiteral("model"), model},
                                    {QStringLiteral("stopReason"), QStringLiteral("toolUse")}},
                        entry.value(QStringLiteral("timestamp")));
            continue;
        }

        if (payloadType == QLatin1String("function_call_output")) {
            QString callId = stringValue(payload.value(QStringLiteral("call_id")));
            if (callId.isEmpty()) callId = stringValue(payload.value(QStringLiteral("id")));
            if (callId.isEmpty()) callId = sessionimport::makeId(sessionId, sequence);
            QJsonObject extra{
                {QStringLiteral("toolCallId"), callId},
                {QStringLiteral("toolName"), toolNames.value(callId, QStringLiteral("tool"))},
                {QStringLiteral("isError"), payload.value(QStringLiteral("is_error")).toBool(false)},
            };
            qint64 completedAt = 0;
            const bool hasCompleted = parseTimestamp(entry.value(QStringLiteral("timestamp")), &completedAt);
            const auto started = toolStartedAt.constFind(callId);
            if (started != toolStartedAt.constEnd()) {
                extra.insert(QStringLiteral("startedAt"), double(started.value()));
                // Codex only records call/output timestamps, so the derived duration is
                // what keeps the desktop tool card identical to a native pi session.
                if (hasCompleted) {
                    extra.insert(QStringLiteral("durationMs"),
                                 double(qMax<qint64>(0, completedAt - started.value())));
                }
            }
            pushMessage(QStringLiteral("toolResult"),
                        QJsonArray{QJsonObject{{QStringLiteral("type"), QStringLiteral("text")},
                                               {QStringLiteral("text"), extractToolOutput(payload)}}},
                        extra, entry.value(QStringLiteral("timestamp")));
        }
    }

    if (!pendingThinking.isEmpty()) {
        pushMessage(QStringLiteral("assistant"),
                    QJsonArray{QJsonObject{{QStringLiteral("type"), QStringLiteral("thinking")},
                                           {QStringLiteral("thinking"), pendingThinking},
                                           {QStringLiteral("thinkingSignature"), QStringLiteral("codex_reasoning")}}},
                    QJsonObject{}, QJsonValue());
    }

    sessionimport::Converted converted;
    converted.title = !title.isEmpty()
        ? title
        : !sessionimport::cleanTitle(QFileInfo(session.sourcePath).fileName()).isEmpty()
        ? sessionimport::cleanTitle(QFileInfo(session.sourcePath).fileName())
        : sessionimport::importedTitle(translate, QStringLiteral("Codex"));
    converted.preview = !preview.isEmpty() ? preview
                                           : sessionimport::importedPreview(translate, QStringLiteral("Codex"));
    converted.messageCount = messageCount;
    lines.append(sessionimport::sessionInfoLine(converted.title, parentId, projectPath));
    converted.raw = lines.join(QLatin1Char('\n')) + QLatin1Char('\n');
    return converted;
}

bool readMetaOnly(const SessionFs &fs, const QString &filePath, Session *out)
{
    QString raw;
    QString error;
    if (!fs.readHead(filePath, kMetaHeadLimit, &raw, &error)) return false;
    const QVector<QJsonObject> entries = sessionimport::parseJsonl(raw);
    const int limit = qMin(8, entries.size());
    for (int index = 0; index < limit; ++index) {
        const QJsonObject entry = entries.at(index);
        if (entry.value(QStringLiteral("type")).toString() != QLatin1String("session_meta")) continue;
        const QJsonObject payload = entry.value(QStringLiteral("payload")).toObject();
        if (payload.value(QStringLiteral("id")).toString().isEmpty()) continue;
        if (payload.value(QStringLiteral("cwd")).toString().isEmpty()) continue;
        out->meta = payload;
        out->entries.clear();
        out->sourcePath = filePath;
        qint64 mtime = 0;
        qint64 size = 0;
        if (fs.statVersion(filePath, &mtime, &size)) {
            out->sourceMtime = mtime;
            out->sourceSize = size;
        }
        return true;
    }
    return false;
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
    QJsonObject meta;
    for (const QJsonObject &entry : entries) {
        if (entry.value(QStringLiteral("type")).toString() != QLatin1String("session_meta")) continue;
        meta = entry.value(QStringLiteral("payload")).toObject();
        break;
    }
    if (meta.value(QStringLiteral("id")).toString().isEmpty()) return false;
    out->meta = meta;
    out->entries = entries;
    out->sourcePath = filePath;
    out->sourceMtime = mtime;
    out->sourceSize = size;
    return true;
}

QString targetPathFor(const QString &piRoot, const QString &projectPath, const Session &session)
{
    const QString rawId = !stringValue(session.meta.value(QStringLiteral("id"))).isEmpty()
        ? stringValue(session.meta.value(QStringLiteral("id")))
        : sha1Hex(session.sourcePath);
    return sessionimport::projectSessionDir(piRoot, projectPath) + QStringLiteral("/codex_")
        + sanitizeId(rawId) + QStringLiteral(".jsonl");
}

} // namespace codeximport
