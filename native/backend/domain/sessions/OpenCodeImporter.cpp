#include "OpenCodeImporter.h"

#include <QDateTime>
#include <QFileInfo>
#include <QJsonArray>
#include <QJsonDocument>
#include <QRegularExpression>
#include <QSqlDatabase>
#include <QSqlError>
#include <QSqlQuery>
#include <QSqlRecord>
#include <QVariant>

namespace opencodeimport {
namespace {

QString isoFromMs(qint64 ms)
{
    return QDateTime::fromMSecsSinceEpoch(ms, Qt::UTC).toString(Qt::ISODateWithMs);
}

QJsonObject parseJsonValue(const QVariant &value)
{
    if (value.isNull()) return QJsonObject{};
    const QByteArray raw = value.toByteArray();
    const QJsonDocument document = QJsonDocument::fromJson(raw);
    if (document.isObject()) return document.object();
    // Some OpenCode builds store the payload as a JSON string inside the column.
    const QString text = value.toString();
    const QJsonDocument nested = QJsonDocument::fromJson(text.toUtf8());
    return nested.isObject() ? nested.object() : QJsonObject{};
}

QString extractToolOutput(const QJsonObject &part)
{
    const QJsonObject state = part.value(QStringLiteral("state")).toObject();
    QJsonValue output = state.value(QStringLiteral("output"));
    if (output.isUndefined()) output = state.value(QStringLiteral("error"));
    if (output.isUndefined()) output = part.value(QStringLiteral("output"));
    if (output.isString()) return output.toString();
    if (output.isObject()) {
        return QString::fromUtf8(QJsonDocument(output.toObject()).toJson(QJsonDocument::Indented)).trimmed();
    }
    if (output.isArray()) {
        return QString::fromUtf8(QJsonDocument(output.toArray()).toJson(QJsonDocument::Indented)).trimmed();
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

QJsonObject usageFrom(const QJsonObject &tokens)
{
    const QJsonObject cache = tokens.value(QStringLiteral("cache")).toObject();
    return QJsonObject{
        {QStringLiteral("input"), tokens.value(QStringLiteral("input")).toDouble()},
        {QStringLiteral("output"), tokens.value(QStringLiteral("output")).toDouble()},
        {QStringLiteral("cacheRead"), cache.value(QStringLiteral("read")).toDouble()},
        {QStringLiteral("cacheWrite"), cache.value(QStringLiteral("write")).toDouble()},
        {QStringLiteral("totalTokens"), tokens.value(QStringLiteral("total")).toDouble()},
        {QStringLiteral("cost"), QJsonObject{
             {QStringLiteral("input"), 0},
             {QStringLiteral("output"), 0},
             {QStringLiteral("cacheRead"), 0},
             {QStringLiteral("cacheWrite"), 0},
             {QStringLiteral("total"), 0},
         }},
    };
}

QString sanitizeId(const QString &value)
{
    QString id = value;
    static const QRegularExpression invalid(QStringLiteral("[^a-zA-Z0-9_-]"));
    id.replace(invalid, QStringLiteral("-"));
    return id;
}

QString connectionName()
{
    static int counter = 0;
    return QStringLiteral("pideck-opencode-%1").arg(++counter);
}

} // namespace

bool available(const QString &databasePath, QString *error)
{
    if (!QSqlDatabase::isDriverAvailable(QStringLiteral("QSQLITE"))) {
        if (error) {
            *error = QStringLiteral(
                "The Qt SQLite driver is not available in this build; OpenCode import is disabled.");
        }
        return false;
    }
    if (!QFileInfo::exists(databasePath)) {
        if (error) *error = QStringLiteral("OpenCode database not found");
        return false;
    }
    return true;
}

QVector<Session> readSessions(const QString &databasePath, const QString &projectPath, QString *error)
{
    QVector<Session> sessions;
    qint64 databaseMtime = 0;
    qint64 databaseSize = 0;
    {
        const QFileInfo info(databasePath);
        databaseMtime = info.lastModified().toMSecsSinceEpoch();
        databaseSize = info.size();
    }
    const QString name = connectionName();
    {
        QSqlDatabase database = QSqlDatabase::addDatabase(QStringLiteral("QSQLITE"), name);
        // Read-only: importing must never mutate OpenCode's own history store.
        database.setConnectOptions(QStringLiteral("QSQLITE_OPEN_READONLY"));
        database.setDatabaseName(databasePath);
        if (!database.open()) {
            if (error) *error = database.lastError().text();
            database = QSqlDatabase();
            QSqlDatabase::removeDatabase(name);
            return sessions;
        }
    }
    {
        QSqlDatabase database = QSqlDatabase::database(name);
        const QString normalized = sessionimport::normalizePath(projectPath);
        QSqlQuery query(database);
        query.prepare(QStringLiteral(
            "select s.*, p.worktree from session s join project p on p.id = s.project_id "
            "where lower(replace(p.worktree, '\\', '/')) = lower(?) "
            "or lower(replace(s.directory, '\\', '/')) = lower(?) "
            "or lower(replace(s.directory, '\\', '/')) like lower(? || '/%') "
            "order by s.time_updated desc"));
        query.addBindValue(normalized);
        query.addBindValue(normalized);
        query.addBindValue(normalized);
        if (!query.exec()) {
            if (error) *error = query.lastError().text();
            query.finish();
            database.close();
            database = QSqlDatabase();
            QSqlDatabase::removeDatabase(name);
            return sessions;
        }
        while (query.next()) {
            const QSqlRecord record = query.record();
            QJsonObject meta;
            for (int index = 0; index < record.count(); ++index) {
                const QString key = record.fieldName(index);
                const QVariant value = record.value(index);
                // A NULL column is `null` in JS, not an absent key: the oracle's estimate
                // and the import marker serialise the whole row, so dropping the key would
                // change the byte counts a reader compares across versions.
                if (value.isNull()) {
                    meta.insert(key, QJsonValue(QJsonValue::Null));
                    continue;
                }
                if (value.typeId() == QMetaType::LongLong || value.typeId() == QMetaType::Int) {
                    meta.insert(key, double(value.toLongLong()));
                } else {
                    meta.insert(key, value.toString());
                }
            }
            const QString sessionId = meta.value(QStringLiteral("id")).toString();

            Session session;
            session.meta = meta;
            session.sourcePath = databasePath + QLatin1Char('#') + sessionId;
            session.sourceMtime = databaseMtime;

            QSqlQuery messageQuery(database);
            messageQuery.prepare(QStringLiteral(
                "select id, time_created, time_updated, data from message where session_id = ? "
                "order by time_created asc"));
            messageQuery.addBindValue(sessionId);
            if (messageQuery.exec()) {
                while (messageQuery.next()) {
                    Message message;
                    message.id = messageQuery.value(0).toString();
                    message.timeCreated = messageQuery.value(1).toLongLong();
                    message.timeUpdated = messageQuery.value(2).toLongLong();
                    message.data = parseJsonValue(messageQuery.value(3));
                    session.messages.append(message);
                }
            }

            QSqlQuery partQuery(database);
            partQuery.prepare(QStringLiteral(
                "select id, message_id, time_created, time_updated, data from part where session_id = ? "
                "order by time_created asc"));
            partQuery.addBindValue(sessionId);
            if (partQuery.exec()) {
                QHash<QString, int> messageIndex;
                for (int index = 0; index < session.messages.size(); ++index) {
                    messageIndex.insert(session.messages.at(index).id, index);
                }
                while (partQuery.next()) {
                    Part part;
                    part.id = partQuery.value(0).toString();
                    part.messageId = partQuery.value(1).toString();
                    part.timeCreated = partQuery.value(2).toLongLong();
                    part.timeUpdated = partQuery.value(3).toLongLong();
                    part.data = parseJsonValue(partQuery.value(4));
                    const auto found = messageIndex.constFind(part.messageId);
                    if (found == messageIndex.constEnd()) continue;
                    session.messages[found.value()].parts.append(part);
                }
            }

            // OpenCode stores all history in one file, so the list shows a per-session
            // estimate instead of the whole database size.
            QJsonArray messageArray;
            for (const Message &message : session.messages) {
                QJsonArray partArray;
                for (const Part &part : message.parts) {
                    // Field-for-field the row the oracle serialises for its size estimate.
                    partArray.append(QJsonObject{{QStringLiteral("id"), part.id},
                                                 {QStringLiteral("message_id"), part.messageId},
                                                 {QStringLiteral("session_id"), sessionId},
                                                 {QStringLiteral("time_created"), double(part.timeCreated)},
                                                 {QStringLiteral("time_updated"), double(part.timeUpdated)},
                                                 {QStringLiteral("data"), part.data}});
                }
                messageArray.append(QJsonObject{{QStringLiteral("id"), message.id},
                                                {QStringLiteral("time_created"), double(message.timeCreated)},
                                                {QStringLiteral("time_updated"), double(message.timeUpdated)},
                                                {QStringLiteral("data"), message.data},
                                                {QStringLiteral("parts"), partArray}});
            }
            const QByteArray estimate = QJsonDocument(QJsonObject{
                {QStringLiteral("meta"), meta},
                {QStringLiteral("messages"), messageArray},
            }).toJson(QJsonDocument::Compact);
            session.sourceSize = estimate.size();
            sessions.append(session);
        }
        query.finish();
        database.close();
    }
    QSqlDatabase::removeDatabase(name);
    Q_UNUSED(databaseSize);
    return sessions;
}

QString targetPathFor(const QString &piRoot, const QString &projectPath, const Session &session)
{
    return sessionimport::projectSessionDir(piRoot, projectPath) + QStringLiteral("/opencode_")
        + sanitizeId(session.meta.value(QStringLiteral("id")).toString()) + QStringLiteral(".jsonl");
}

sessionimport::Converted convert(const QString &projectPath, const Session &session,
                                 const maincopy::Translator &translate)
{
    const QString sessionId = session.meta.value(QStringLiteral("id")).toString();
    qint64 createdMs = qint64(session.meta.value(QStringLiteral("time_created")).toDouble());
    if (createdMs == 0) createdMs = session.sourceMtime;
    const QJsonValue modelValue = session.meta.value(QStringLiteral("model"));
    const QJsonObject model = modelValue.isObject()
        ? modelValue.toObject()
        : QJsonDocument::fromJson(modelValue.toString().toUtf8()).object();

    QStringList lines;
    QString parentId;
    int sequence = 0;
    int messageCount = 0;
    QString title;
    QString preview;

    const auto pushMessage = [&](const QString &role, const QJsonArray &content, const QJsonObject &extra,
                                 qint64 timestampValue) {
        if (content.isEmpty()) return;
        const QString id = sessionimport::makeId(sessionId, sequence++);
        const qint64 messageTimestamp = timestampValue != 0 ? timestampValue : session.sourceMtime + sequence;
        QJsonObject message{
            {QStringLiteral("role"), role},
            {QStringLiteral("content"), content},
            {QStringLiteral("timestamp"), double(messageTimestamp)},
        };
        if (role == QLatin1String("assistant")) {
            message.insert(QStringLiteral("usage"), usageFrom(extra.value(QStringLiteral("tokens")).toObject()));
        }
        // The oracle keeps the raw OpenCode fields too (`tokens`, `api`, `provider`,
        // `model`, `stopReason`): pi ignores the unknown ones, and a reader comparing an
        // imported file with the original turn needs them.
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
        {QStringLiteral("timestamp"), isoFromMs(createdMs)},
        {QStringLiteral("cwd"), projectPath},
    }).toJson(QJsonDocument::Compact)));
    lines.append(QString::fromUtf8(QJsonDocument(QJsonObject{
        {QStringLiteral("type"), QStringLiteral("opencode_import")},
        {QStringLiteral("version"), 1},
        {QStringLiteral("openCodeSessionId"), sessionId},
        {QStringLiteral("sourcePath"), session.sourcePath},
        {QStringLiteral("sourceMtime"), double(session.sourceMtime)},
        {QStringLiteral("sourceSize"), double(session.sourceSize)},
        {QStringLiteral("importedAt"), isoFromMs(QDateTime::currentMSecsSinceEpoch())},
    }).toJson(QJsonDocument::Compact)));
    const QString modelChangeId = sessionimport::makeId(sessionId, sequence++);
    const QString provider = !model.value(QStringLiteral("providerID")).toString().isEmpty()
        ? model.value(QStringLiteral("providerID")).toString()
        : QStringLiteral("opencode");
    QString modelId = model.value(QStringLiteral("id")).toString();
    if (modelId.isEmpty()) modelId = model.value(QStringLiteral("modelID")).toString();
    if (modelId.isEmpty()) modelId = QStringLiteral("opencode");
    lines.append(QString::fromUtf8(QJsonDocument(QJsonObject{
        {QStringLiteral("type"), QStringLiteral("model_change")},
        {QStringLiteral("id"), modelChangeId},
        {QStringLiteral("parentId"), parentId.isEmpty() ? QJsonValue(QJsonValue::Null) : QJsonValue(parentId)},
        {QStringLiteral("timestamp"), isoFromMs(createdMs)},
        {QStringLiteral("provider"), provider},
        {QStringLiteral("modelId"), modelId},
    }).toJson(QJsonDocument::Compact)));
    parentId = modelChangeId;

    for (const Message &message : session.messages) {
        const QString role = message.data.value(QStringLiteral("role")).toString();
        QJsonArray content;
        for (const Part &part : message.parts) {
            const QString partType = part.data.value(QStringLiteral("type")).toString();
            const QString text = part.data.value(QStringLiteral("text")).toString();
            if (partType == QLatin1String("text") && !text.isEmpty()) {
                content.append(QJsonObject{{QStringLiteral("type"), QStringLiteral("text")},
                                           {QStringLiteral("text"), text}});
            } else if (partType == QLatin1String("reasoning") && !text.isEmpty()) {
                content.append(QJsonObject{{QStringLiteral("type"), QStringLiteral("thinking")},
                                           {QStringLiteral("thinking"), text},
                                           {QStringLiteral("thinkingSignature"), QStringLiteral("opencode_reasoning")}});
            } else if (partType == QLatin1String("tool")) {
                const QString callId = !part.data.value(QStringLiteral("callID")).toString().isEmpty()
                    ? part.data.value(QStringLiteral("callID")).toString()
                    : part.id;
                const QString toolName = !part.data.value(QStringLiteral("tool")).toString().isEmpty()
                    ? part.data.value(QStringLiteral("tool")).toString()
                    : QStringLiteral("tool");
                if (role == QLatin1String("assistant")) {
                    content.append(QJsonObject{
                        {QStringLiteral("type"), QStringLiteral("toolCall")},
                        {QStringLiteral("id"), callId},
                        {QStringLiteral("name"), toolName},
                        {QStringLiteral("arguments"),
                         part.data.value(QStringLiteral("state")).toObject().value(QStringLiteral("input"))}});
                } else {
                    pushMessage(QStringLiteral("toolResult"),
                                QJsonArray{QJsonObject{{QStringLiteral("type"), QStringLiteral("text")},
                                                       {QStringLiteral("text"), extractToolOutput(part.data)}}},
                                QJsonObject{{QStringLiteral("toolCallId"), callId},
                                            {QStringLiteral("toolName"), toolName},
                                            {QStringLiteral("isError"),
                                             part.data.value(QStringLiteral("state"))
                                                     .toObject()
                                                     .value(QStringLiteral("status"))
                                                     .toString()
                                                 == QLatin1String("error")}},
                                part.timeCreated);
                }
            }
        }
        if (role == QLatin1String("user")) {
            pushMessage(QStringLiteral("user"), content, QJsonObject{}, message.timeCreated);
        } else if (role == QLatin1String("assistant")) {
            const QString finish = message.data.value(QStringLiteral("finish")).toString();
            pushMessage(QStringLiteral("assistant"), content,
                        QJsonObject{{QStringLiteral("api"), QStringLiteral("opencode-import")},
                                    {QStringLiteral("provider"),
                                     !message.data.value(QStringLiteral("providerID")).toString().isEmpty()
                                         ? message.data.value(QStringLiteral("providerID")).toString()
                                         : provider},
                                    {QStringLiteral("model"),
                                     !message.data.value(QStringLiteral("modelID")).toString().isEmpty()
                                         ? message.data.value(QStringLiteral("modelID")).toString()
                                         : modelId},
                                    {QStringLiteral("stopReason"),
                                     finish.isEmpty() ? QStringLiteral("stop") : finish},
                                    {QStringLiteral("tokens"), message.data.value(QStringLiteral("tokens"))}},
                        message.timeCreated);
        }
    }

    sessionimport::Converted converted;
    const QString metaTitle = sessionimport::cleanTitle(session.meta.value(QStringLiteral("title")).toString());
    const QString fileTitle = sessionimport::cleanTitle(QFileInfo(session.sourcePath).fileName());
    converted.title = !metaTitle.isEmpty() ? metaTitle
        : !title.isEmpty()                ? title
        : !fileTitle.isEmpty()            ? fileTitle
                                          : sessionimport::importedTitle(translate, QStringLiteral("OpenCode"));
    converted.preview = !preview.isEmpty()
        ? preview
        : sessionimport::importedPreview(translate, QStringLiteral("OpenCode"));
    converted.messageCount = messageCount;
    lines.append(sessionimport::sessionInfoLine(converted.title, parentId, projectPath));
    converted.raw = lines.join(QLatin1Char('\n')) + QLatin1Char('\n');
    return converted;
}

} // namespace opencodeimport
