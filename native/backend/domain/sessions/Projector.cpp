#include "Projector.h"

#include "AskQuestion.h"
#include "ImageContent.h"
#include "MessageContent.h"
#include "PiTaskMessage.h"
#include "SessionEntryIds.h"
#include "ToolOutcome.h"

#include <QDateTime>
#include <QJsonDocument>
#include <QJsonObject>
#include <QRegularExpression>

#include <algorithm>

namespace projector {
namespace {

QJsonValue sanitizeForJson(const QJsonValue &value);

QJsonObject sanitizeObject(const QJsonObject &object)
{
    QJsonObject copy;
    for (auto iterator = object.constBegin(); iterator != object.constEnd(); ++iterator) {
        copy.insert(iterator.key(), sanitizeForJson(iterator.value()));
    }
    return copy;
}

/** Replace base64 payloads with a length marker so meta stays small and readable. */
QJsonValue sanitizeForJson(const QJsonValue &value)
{
    if (value.isArray()) {
        QJsonArray array;
        for (const QJsonValue &item : value.toArray()) array.append(sanitizeForJson(item));
        return array;
    }
    if (!value.isObject()) return value;
    const QJsonObject object = value.toObject();
    const QString type = object.value(QStringLiteral("type")).toString();
    if (type == QLatin1String("image") && object.value(QStringLiteral("data")).isString()) {
        QJsonObject sanitized;
        for (auto iterator = object.constBegin(); iterator != object.constEnd(); ++iterator) {
            if (iterator.key() == QLatin1String("data")) {
                sanitized.insert(iterator.key(), QStringLiteral("[base64 image (%1 chars)]")
                                                     .arg(iterator.value().toString().size()));
            } else {
                sanitized.insert(iterator.key(), sanitizeForJson(iterator.value()));
            }
        }
        return sanitized;
    }
    if (type == QLatin1String("image") && object.value(QStringLiteral("source")).isObject()) {
        const QJsonObject source = object.value(QStringLiteral("source")).toObject();
        if (source.value(QStringLiteral("type")).toString() == QLatin1String("base64")
            && source.value(QStringLiteral("data")).isString()) {
            QJsonObject sanitizedSource;
            for (auto iterator = source.constBegin(); iterator != source.constEnd(); ++iterator) {
                if (iterator.key() == QLatin1String("data")) {
                    sanitizedSource.insert(iterator.key(), QStringLiteral("[base64 image (%1 chars)]")
                                                                .arg(iterator.value().toString().size()));
                } else {
                    sanitizedSource.insert(iterator.key(), sanitizeForJson(iterator.value()));
                }
            }
            QJsonObject sanitized;
            for (auto iterator = object.constBegin(); iterator != object.constEnd(); ++iterator) {
                if (iterator.key() == QLatin1String("source")) {
                    sanitized.insert(iterator.key(), sanitizedSource);
                } else {
                    sanitized.insert(iterator.key(), sanitizeForJson(iterator.value()));
                }
            }
            return sanitized;
        }
    }
    if (type == QLatin1String("base64") && object.value(QStringLiteral("data")).isString()) {
        QJsonObject sanitized;
        for (auto iterator = object.constBegin(); iterator != object.constEnd(); ++iterator) {
            if (iterator.key() == QLatin1String("data")) {
                sanitized.insert(iterator.key(), QStringLiteral("[base64 image (%1 chars)]")
                                                     .arg(iterator.value().toString().size()));
            } else {
                sanitized.insert(iterator.key(), sanitizeForJson(iterator.value()));
            }
        }
        return sanitized;
    }
    return sanitizeObject(object);
}

QString stripAnsi(const QString &text)
{
    static const QRegularExpression ansi(QStringLiteral("\x1b\\[[0-9;]*[a-zA-Z]"));
    QString result = text;
    result.remove(ansi);
    return result;
}

QString extractThinking(const QJsonValue &content)
{
    if (!content.isArray()) return QString();
    QStringList parts;
    for (const QJsonValue &value : content.toArray()) {
        if (!value.isObject()) continue;
        const QJsonObject block = value.toObject();
        if (block.value(QStringLiteral("type")).toString() != QLatin1String("thinking")) continue;
        QString text = block.value(QStringLiteral("thinking")).toString();
        if (text.isEmpty()) text = block.value(QStringLiteral("text")).toString();
        if (!text.isEmpty()) parts.append(text);
    }
    return stripAnsi(parts.join(QLatin1Char('\n')));
}

QString extractToolResultText(const QJsonValue &result, const maincopy::Translator &translate)
{
    if (!result.isObject() && !result.isArray()) return QString();
    QJsonValue content = result.isArray() ? result : result.toObject().value(QStringLiteral("content"));
    if (!content.isArray()) return QString();
    QStringList parts;
    for (const QJsonValue &item : content.toArray()) {
        if (!item.isObject()) continue;
        const QJsonObject block = item.toObject();
        const QJsonValue text = block.value(QStringLiteral("text"));
        if (text.isString()) {
            parts.append(text.toString());
            continue;
        }
        if (block.value(QStringLiteral("type")).toString() == QLatin1String("image")) {
            parts.append(translate(QStringLiteral("session.imagePlaceholder"), QJsonObject{}));
        }
    }
    return parts.join(QLatin1Char('\n'));
}

QString toolPathFromArgs(const QJsonValue &args)
{
    if (!args.isObject()) return QString();
    const QJsonObject object = args.toObject();
    const char *const keys[] = {"path", "filePath", "file", "target_file", "targetFile"};
    for (const char *key : keys) {
        const QJsonValue value = object.value(QLatin1String(key));
        if (value.isString() && !value.toString().isEmpty()) return value.toString();
    }
    return QString();
}

QString formatToolDetail(const QString &toolName, const QJsonValue &args, const QJsonValue &result,
                         bool isError, bool missingResult, const maincopy::Translator &translate)
{
    QJsonValue details;
    if (result.isObject()) details = result.toObject().value(QStringLiteral("details"));
    QJsonValue argsValue = args;
    if (args.isString() && !args.toString().trimmed().isEmpty()) {
        const QJsonDocument document = QJsonDocument::fromJson(args.toString().toUtf8());
        if (document.isObject() || document.isArray()) argsValue = document.isObject()
            ? QJsonValue(document.object())
            : QJsonValue(document.array());
    }
    const QString argsText = argsValue.isUndefined() || argsValue.isNull()
        ? QString()
        : truncateForDetail(safeJson(argsValue), translate);
    const QString resultText = result.isUndefined() || result.isNull()
        ? QString()
        : truncateForDetail(extractToolResultText(result, translate).isEmpty()
                                ? safeJson(result)
                                : extractToolResultText(result, translate),
                            translate);
    const QString detailsText = details.isUndefined() || details.isNull()
        ? QString()
        : truncateForDetail(safeJson(details), translate);
    const QString status = translate(
        missingResult ? QStringLiteral("mainTool.unknown")
                      : (isError ? QStringLiteral("mainTool.failed") : QStringLiteral("mainTool.done")),
        QJsonObject{});
    QStringList sections;
    sections.append(translate(QStringLiteral("mainTool.name"),
                              QJsonObject{{QStringLiteral("name"), toolName.isEmpty() ? QStringLiteral("tool") : toolName}}));
    sections.append(translate(QStringLiteral("mainTool.status"), QJsonObject{{QStringLiteral("status"), status}}));
    if (!argsValue.isUndefined() && !argsValue.isNull()) {
        sections.append(translate(QStringLiteral("mainTool.arguments"), QJsonObject{{QStringLiteral("value"), argsText}}));
    }
    if (!result.isUndefined() && !result.isNull()) {
        sections.append(translate(QStringLiteral("mainTool.result"), QJsonObject{{QStringLiteral("value"), resultText}}));
    }
    if (!details.isUndefined() && !details.isNull()) {
        sections.append(translate(QStringLiteral("mainTool.details"), QJsonObject{{QStringLiteral("value"), detailsText}}));
    }
    sections.removeAll(QString());
    return sections.join(QStringLiteral("\n\n"));
}

QJsonObject imageNoticeObject(const imagebudget::Result &budget)
{
    if (!budget.hasNotice) return QJsonObject{};
    return QJsonObject{
        {QStringLiteral("kind"), budget.noticeKind},
        {QStringLiteral("count"), budget.noticeCount},
        {QStringLiteral("omitted"), budget.noticeOmitted},
    };
}

} // namespace

QString truncateForDetail(const QString &text, const maincopy::Translator &translate)
{
    if (text.size() <= kMaxToolResultChars) return text;
    const int keep = kMaxToolResultChars / 2;
    const int omitted = text.size() - keep * 2;
    const QString marker = translate(QStringLiteral("mainTool.truncated"),
                                     QJsonObject{{QStringLiteral("omitted"), omitted},
                                                 {QStringLiteral("total"), text.size()}});
    return text.left(keep) + QLatin1Char('\n') + marker + QLatin1Char('\n') + text.right(keep);
}

QString safeJson(const QJsonValue &value)
{
    const QJsonValue sanitized = sanitizeForJson(value);
    if (sanitized.isUndefined()) return QString();
    if (sanitized.isObject()) return QString::fromUtf8(QJsonDocument(sanitized.toObject()).toJson(QJsonDocument::Indented));
    if (sanitized.isArray()) return QString::fromUtf8(QJsonDocument(sanitized.toArray()).toJson(QJsonDocument::Indented));
    return QString::fromUtf8(QJsonDocument(QJsonArray{sanitized}).toJson(QJsonDocument::Compact)).mid(1).chopped(1);
}

QJsonObject compactionCard(const QString &agentId, const QString &summary, qint64 timestamp,
                           const QString &compactionId, const QString &firstKeptEntryId, bool hasTokensBefore,
                           qint64 tokensBefore, int compactionCount)
{
    QJsonObject meta{
        {QStringLiteral("type"), QStringLiteral("compaction")},
    };
    if (hasTokensBefore) meta.insert(QStringLiteral("tokensBefore"), double(tokensBefore));
    if (!compactionId.isEmpty()) meta.insert(QStringLiteral("compactionId"), compactionId);
    if (!firstKeptEntryId.isEmpty()) meta.insert(QStringLiteral("firstKeptEntryId"), firstKeptEntryId);
    if (compactionCount > 0) meta.insert(QStringLiteral("compactionCount"), compactionCount);
    return QJsonObject{
        {QStringLiteral("id"), QStringLiteral("%1-meta-1").arg(agentId)},
        {QStringLiteral("agentId"), agentId},
        {QStringLiteral("role"), QStringLiteral("system")},
        {QStringLiteral("text"), summary},
        {QStringLiteral("timestamp"), double(timestamp)},
        {QStringLiteral("meta"), meta},
    };
}

QJsonArray convert(const QString &agentId, const QVector<QJsonValue> &rawMessages,
                   const QStringList &activeEntryIds, const QSet<QString> &knownToolResultIds,
                   const Deps &deps, EntryIdLayout layout)
{
    const maincopy::Translator &translate = deps.translate;

    // toolCallId -> declared name/args/timestamp, so a toolResult can render the call
    // details that only exist on the assistant block.
    struct CallInfo {
        QString name;
        QJsonValue args;
        bool hasTimestamp = false;
        qint64 timestamp = 0;
    };
    QHash<QString, CallInfo> historicalCalls;
    QHash<QString, QString> originalContentByPath;
    for (const QJsonValue &value : rawMessages) {
        if (!value.isObject()) continue;
        const QJsonObject message = value.toObject();
        if (message.value(QStringLiteral("role")).toString() != QLatin1String("assistant")) continue;
        const QJsonValue content = message.value(QStringLiteral("content"));
        if (!content.isArray()) continue;
        for (const QJsonValue &blockValue : content.toArray()) {
            if (!blockValue.isObject()) continue;
            const QJsonObject block = blockValue.toObject();
            if (block.value(QStringLiteral("type")).toString() != QLatin1String("toolCall")) continue;
            const QString id = block.value(QStringLiteral("id")).toString();
            if (id.isEmpty()) continue;
            CallInfo info;
            const QString name = block.value(QStringLiteral("name")).toString();
            info.name = name.isEmpty() ? QStringLiteral("tool") : name;
            info.args = block.value(QStringLiteral("arguments"));
            const QJsonValue timestamp = message.value(QStringLiteral("timestamp"));
            if (timestamp.isDouble()) {
                info.hasTimestamp = true;
                info.timestamp = qint64(timestamp.toDouble());
            }
            historicalCalls.insert(id, info);
        }
    }
    // Old sessions never stored originalContent; a preceding `read` of the same path is
    // the best available diff baseline for later write/edit calls.
    for (const QJsonValue &value : rawMessages) {
        if (!value.isObject()) continue;
        const QJsonObject message = value.toObject();
        if (message.value(QStringLiteral("role")).toString() != QLatin1String("toolResult")) continue;
        const QString toolCallId = message.value(QStringLiteral("toolCallId")).toString();
        const auto found = historicalCalls.constFind(toolCallId);
        if (found == historicalCalls.constEnd() || found->name != QLatin1String("read")) continue;
        const QString path = toolPathFromArgs(found->args);
        if (path.isEmpty()) continue;
        const QString content = messagecontent::extractMessageText(message.value(QStringLiteral("content")));
        if (!content.isEmpty()) originalContentByPath.insert(path, content);
    }

    const QSet<QString> sliceResultIds = missingtoolcalls::collectToolResultIds(rawMessages);
    const QHash<int, QVector<missingtoolcalls::DeclaredCall>> missingCalls =
        missingtoolcalls::collect(rawMessages, sliceResultIds, knownToolResultIds);

    const bool askAborted = deps.isAskAborted ? deps.isAskAborted(agentId) : false;
    int metaSeq = 0;
    int entryIndex = 0;
    qint64 turnImageBytes = 0;
    QJsonArray result;

    for (int index = 0; index < rawMessages.size(); ++index) {
        const QJsonValue &raw = rawMessages.at(index);
        // Identity is independent of whether a row is rendered. Verified RPC
        // and file readers provide one slot per raw value, including synthetic rows.
        sessionentryids::TakeResult taken;
        if (layout == EntryIdLayout::Matched || sessionentryids::consumesMessageEntry(raw)) {
            taken = sessionentryids::take(activeEntryIds, entryIndex);
            entryIndex = taken.nextIndex;
        }
        if (!raw.isObject()) continue;
        const QJsonObject message = raw.toObject();

        pitask::TaskMessage task;
        if (pitask::readTodoTaskMessage(raw, &task)) {
            pitask::TaskCommand command;
            const bool hasCommand = pitask::readTodoTaskCommand(message, &command);
            const QJsonValue details = message.value(QStringLiteral("details"));
            const QJsonValue taskIdValue =
                details.isObject() ? details.toObject().value(QStringLiteral("taskId")) : QJsonValue();
            QString messageId;
            const bool hasMessageId = pitask::readTodoTaskMessageId(QJsonValue(message), &messageId);
            // Same conversion the live path uses, so a replay after a history reload dedupes.
            double timestamp = 0;
            if (!pitask::toEpochMs(message.value(QStringLiteral("timestamp")), &timestamp)) {
                timestamp = double(QDateTime::currentMSecsSinceEpoch());
            }
            turnImageBytes = 0;
            QJsonObject meta{
                {QStringLiteral("type"), QStringLiteral("todoTask")},
                // Goal and resume share the card; the kind is what labels it (Task/Guidance).
                {QStringLiteral("todoTaskKind"),
                 QLatin1String(task.kind == pitask::Kind::Goal ? "goal" : "resume")},
                {QStringLiteral("todoTaskAt"), timestamp},
                {QStringLiteral("_piDeckMsgSeq"), index},
            };
            if (taskIdValue.isString()) meta.insert(QStringLiteral("todoTaskId"), taskIdValue);
            if (hasMessageId) meta.insert(QStringLiteral("todoTaskMessageId"), messageId);
            if (hasCommand) {
                meta.insert(QStringLiteral("todoTaskCommandName"), command.name);
                meta.insert(QStringLiteral("todoTaskCommandArgs"), command.args);
            }
            if (!taken.entryId.isEmpty()) meta.insert(QStringLiteral("entryId"), taken.entryId);
            result.append(QJsonObject{
                {QStringLiteral("id"),
                 QStringLiteral("%1-history-%2").arg(agentId, taken.entryId.isEmpty() ? QString::number(index)
                                                                                     : taken.entryId)},
                {QStringLiteral("agentId"), agentId},
                {QStringLiteral("role"), QStringLiteral("system")},
                {QStringLiteral("text"), hasCommand ? QStringLiteral("/%1 %2").arg(command.name, task.text) : task.text},
                {QStringLiteral("timestamp"), timestamp},
                {QStringLiteral("meta"), meta},
            });
            continue;
        }

        const QString role = message.value(QStringLiteral("role")).toString();
        const QJsonValue content = message.value(QStringLiteral("content"));

        if (role == QLatin1String("user")) {
            turnImageBytes = 0;
            const imagecontent::Extraction extraction = imagecontent::extract(content);
            QString text = messagecontent::extractMessageText(content);
            if (text.isEmpty() && !extraction.images.isEmpty()) {
                text = translate(QStringLiteral("session.imagePlaceholder"), QJsonObject{});
            }
            if (text.trimmed().isEmpty()) continue;
            QJsonObject meta{{QStringLiteral("_piDeckMsgSeq"), index}};
            if (!taken.entryId.isEmpty()) meta.insert(QStringLiteral("entryId"), taken.entryId);
            QJsonObject row{
                {QStringLiteral("id"),
                 QStringLiteral("%1-history-%2").arg(agentId, taken.entryId.isEmpty() ? QString::number(index)
                                                                                     : taken.entryId)},
                {QStringLiteral("agentId"), agentId},
                {QStringLiteral("role"), QStringLiteral("user")},
                {QStringLiteral("text"), text},
                {QStringLiteral("timestamp"), message.value(QStringLiteral("timestamp")).isDouble()
                     ? message.value(QStringLiteral("timestamp"))
                     : QJsonValue(double(QDateTime::currentMSecsSinceEpoch()))},
                {QStringLiteral("meta"), meta},
            };
            if (!extraction.images.isEmpty()) row.insert(QStringLiteral("images"), extraction.images);
            result.append(row);
            continue;
        }

        if (role == QLatin1String("assistant")) {
            const imagecontent::Extraction extraction = imagecontent::extract(content);
            const imagebudget::Result budget = imagebudget::apply(extraction.images, turnImageBytes);
            for (const QJsonValue &image : budget.images) {
                turnImageBytes += image.toObject().value(QStringLiteral("data")).toString().size();
            }
            const QString text = messagecontent::extractMessageText(content);
            const QString thinking = extractThinking(content);
            const bool hasVisible = !text.trimmed().isEmpty() || !thinking.trimmed().isEmpty()
                || !budget.images.isEmpty() || budget.hasNotice;
            const QVector<missingtoolcalls::DeclaredCall> calls = missingCalls.value(index);
            if (!hasVisible && calls.isEmpty()) continue;
            QJsonObject meta{{QStringLiteral("_piDeckMsgSeq"), index}};
            if (!taken.entryId.isEmpty()) meta.insert(QStringLiteral("entryId"), taken.entryId);
            if (hasVisible) {
                QJsonObject row{
                    {QStringLiteral("id"),
                     QStringLiteral("%1-history-%2").arg(agentId, taken.entryId.isEmpty()
                                                                     ? QString::number(index)
                                                                     : taken.entryId)},
                    {QStringLiteral("agentId"), agentId},
                    {QStringLiteral("role"), QStringLiteral("assistant")},
                    {QStringLiteral("text"), text},
                    {QStringLiteral("timestamp"), message.value(QStringLiteral("timestamp")).isDouble()
                         ? message.value(QStringLiteral("timestamp"))
                         : QJsonValue(double(QDateTime::currentMSecsSinceEpoch()))},
                    {QStringLiteral("meta"), meta},
                };
                if (!thinking.isEmpty()) row.insert(QStringLiteral("thinking"), thinking);
                const QString stopReason = message.value(QStringLiteral("stopReason")).toString();
                if (!stopReason.isEmpty()) row.insert(QStringLiteral("stopReason"), stopReason);
                if (!budget.images.isEmpty()) row.insert(QStringLiteral("images"), budget.images);
                if (budget.hasNotice) row.insert(QStringLiteral("imageDisplayNotice"), imageNoticeObject(budget));
                result.append(row);
            }
            for (const missingtoolcalls::DeclaredCall &call : calls) {
                const QString argsText = call.args.isUndefined() || call.args.isNull()
                    ? QString()
                    : truncateForDetail(safeJson(call.args), translate);
                const QString detailText =
                    formatToolDetail(call.toolName, call.args, QJsonValue(), false, true, translate);
                QJsonObject callMeta{
                    {QStringLiteral("status"), QLatin1String(tooloutcome::kUnknown)},
                    {QStringLiteral("toolName"), call.toolName},
                    {QStringLiteral("toolCallId"), call.toolCallId},
                    {QStringLiteral("_piDeckMsgSeq"), index},
                };
                if (!argsText.isEmpty()) callMeta.insert(QStringLiteral("args"), argsText);
                callMeta.insert(QStringLiteral("detailText"), truncateForDetail(detailText, translate));
                // No entryId: this row has no JSONL entry, and claiming the assistant's
                // entryId would make two messages share one identity.
                if (!taken.entryId.isEmpty()) callMeta.insert(QStringLiteral("sourceEntryId"), taken.entryId);
                result.append(QJsonObject{
                    {QStringLiteral("id"), QStringLiteral("%1-toolcall-%2").arg(agentId, call.toolCallId)},
                    {QStringLiteral("agentId"), agentId},
                    {QStringLiteral("role"), QStringLiteral("tool")},
                    {QStringLiteral("text"), QStringLiteral("? %1").arg(call.toolName)},
                    {QStringLiteral("timestamp"), call.hasTimestamp ? QJsonValue(double(call.timestamp))
                                                                   : QJsonValue(double(QDateTime::currentMSecsSinceEpoch()))},
                    {QStringLiteral("meta"), callMeta},
                });
            }
            continue;
        }

        if (role == QLatin1String("toolResult")) {
            const QString toolCallId = message.value(QStringLiteral("toolCallId")).toString();
            const auto found = historicalCalls.constFind(toolCallId);
            const QString toolName = !message.value(QStringLiteral("toolName")).toString().isEmpty()
                ? message.value(QStringLiteral("toolName")).toString()
                : (found != historicalCalls.constEnd() ? found->name : QStringLiteral("tool"));
            const bool isError = message.value(QStringLiteral("isError")).toBool(false);
            bool hasStartedAt = message.value(QStringLiteral("startedAt")).isDouble();
            qint64 startedAt = hasStartedAt ? qint64(message.value(QStringLiteral("startedAt")).toDouble()) : 0;
            if (!hasStartedAt && found != historicalCalls.constEnd() && found->hasTimestamp) {
                hasStartedAt = true;
                startedAt = found->timestamp;
            }
            const QJsonValue timestampValue = message.value(QStringLiteral("timestamp"));
            const qint64 timestamp = timestampValue.isDouble() ? qint64(timestampValue.toDouble())
                                                               : QDateTime::currentMSecsSinceEpoch();
            bool hasDuration = message.value(QStringLiteral("durationMs")).isDouble();
            qint64 durationMs = hasDuration ? qint64(message.value(QStringLiteral("durationMs")).toDouble()) : 0;
            if (!hasDuration && hasStartedAt && timestampValue.isDouble()) {
                hasDuration = true;
                durationMs = qMax<qint64>(0, timestamp - startedAt);
            }
            QJsonObject resultObject{
                {QStringLiteral("content"), content},
                {QStringLiteral("details"), message.value(QStringLiteral("details"))},
            };
            const QJsonValue args = found != historicalCalls.constEnd() ? found->args : QJsonValue();
            const QString filePath = toolPathFromArgs(args);
            QString originalContent = message.value(QStringLiteral("details")).isObject()
                ? message.value(QStringLiteral("details")).toObject().value(QStringLiteral("_piDeckOriginalContent")).toString()
                : QString();
            if (originalContent.isEmpty() && !filePath.isEmpty()) {
                originalContent = originalContentByPath.value(filePath);
            }
            const imagecontent::Extraction extraction = imagecontent::extract(content);
            const imagebudget::Result budget = imagebudget::apply(extraction.images, turnImageBytes);
            for (const QJsonValue &image : budget.images) {
                turnImageBytes += image.toObject().value(QStringLiteral("data")).toString().size();
            }
            const QString detailText = formatToolDetail(toolName, args, resultObject, isError, false, translate);
            const QString deliveredDetail = truncateForDetail(detailText, translate);
            const bool truncated = detailText.size() > kMaxToolResultChars;
            const askquestion::Summary ask = askquestion::build(toolName, args, resultObject, askAborted, isError);
            const QString resultText = extractToolResultText(resultObject, translate);

            QJsonObject meta{
                {QStringLiteral("_piDeckMsgSeq"), index},
                {QStringLiteral("status"), isError ? QLatin1String(tooloutcome::kError)
                                                   : QLatin1String(tooloutcome::kDone)},
                {QStringLiteral("toolName"), toolName},
                {QStringLiteral("toolCallId"), toolCallId},
                {QStringLiteral("args"), truncateForDetail(safeJson(args), translate)},
                {QStringLiteral("result"), truncateForDetail(resultText.isEmpty() ? safeJson(resultObject) : resultText,
                                                             translate)},
                {QStringLiteral("isError"), isError},
                {QStringLiteral("detailText"), deliveredDetail},
            };
            if (!taken.entryId.isEmpty()) meta.insert(QStringLiteral("entryId"), taken.entryId);
            if (hasStartedAt) meta.insert(QStringLiteral("startedAt"), double(startedAt));
            if (hasDuration) meta.insert(QStringLiteral("durationMs"), double(durationMs));
            if (truncated) {
                meta.insert(QStringLiteral("truncated"), true);
                meta.insert(QStringLiteral("fullLength"), detailText.size());
            }
            if (!originalContent.isEmpty()) meta.insert(QStringLiteral("originalContent"), originalContent);
            if (ask.valid) meta.insert(QStringLiteral("_askCard"), askquestion::toJson(ask));

            QJsonObject row{
                {QStringLiteral("id"),
                 QStringLiteral("%1-history-%2").arg(agentId, taken.entryId.isEmpty() ? QString::number(index)
                                                                                     : taken.entryId)},
                {QStringLiteral("agentId"), agentId},
                {QStringLiteral("role"), QStringLiteral("tool")},
                {QStringLiteral("text"), QStringLiteral("%1 %2").arg(isError ? QStringLiteral("✗")
                                                                             : QStringLiteral("✓"),
                                                                     toolName)},
                {QStringLiteral("timestamp"), double(timestamp)},
                {QStringLiteral("meta"), meta},
            };
            if (!budget.images.isEmpty()) row.insert(QStringLiteral("images"), budget.images);
            if (budget.hasNotice) row.insert(QStringLiteral("imageDisplayNotice"), imageNoticeObject(budget));
            result.append(row);
            continue;
        }

        if (role == QLatin1String("compactionSummary") || role == QLatin1String("branchSummary")) {
            const bool isCompaction = role == QLatin1String("compactionSummary");
            ++metaSeq;
            const QJsonValue metaValue = message.value(QStringLiteral("meta"));
            const QJsonObject sourceMeta = metaValue.isObject() ? metaValue.toObject() : QJsonObject{};
            QJsonObject meta{
                {QStringLiteral("type"), isCompaction ? QStringLiteral("compaction")
                                                      : QStringLiteral("branchSummary")},
            };
            const QJsonValue tokensBefore = message.value(QStringLiteral("tokensBefore"));
            if (tokensBefore.isDouble()) meta.insert(QStringLiteral("tokensBefore"), tokensBefore);
            else if (sourceMeta.value(QStringLiteral("tokensBefore")).isDouble()) {
                meta.insert(QStringLiteral("tokensBefore"), sourceMeta.value(QStringLiteral("tokensBefore")));
            }
            if (isCompaction && sourceMeta.value(QStringLiteral("compactionId")).isString()) {
                meta.insert(QStringLiteral("compactionId"), sourceMeta.value(QStringLiteral("compactionId")));
            }
            if (isCompaction && sourceMeta.value(QStringLiteral("firstKeptEntryId")).isString()) {
                meta.insert(QStringLiteral("firstKeptEntryId"), sourceMeta.value(QStringLiteral("firstKeptEntryId")));
            }
            if (!isCompaction && message.value(QStringLiteral("fromId")).isString()) {
                meta.insert(QStringLiteral("fromId"), message.value(QStringLiteral("fromId")));
            }
            if (isCompaction && sourceMeta.contains(QStringLiteral("compactionCount"))) {
                meta.insert(QStringLiteral("compactionCount"), sourceMeta.value(QStringLiteral("compactionCount")));
            }
            const QJsonValue summary = message.value(QStringLiteral("summary"));
            const QJsonValue timestamp = message.value(QStringLiteral("timestamp"));
            result.append(QJsonObject{
                {QStringLiteral("id"), QStringLiteral("%1-meta-%2").arg(agentId).arg(metaSeq)},
                {QStringLiteral("agentId"), agentId},
                {QStringLiteral("role"), QStringLiteral("system")},
                {QStringLiteral("text"), summary.isString() && !summary.toString().isEmpty()
                     ? summary
                     : (isCompaction ? QStringLiteral("Session compacted")
                                     : QStringLiteral("Branch summarized"))},
                {QStringLiteral("timestamp"), timestamp.isDouble() ? timestamp
                                                                   : QJsonValue(double(QDateTime::currentMSecsSinceEpoch()))},
                {QStringLiteral("meta"), meta},
            });
            continue;
        }
    }

    // thinking-only or image/notice-bearing assistant turns stay visible.
    QJsonArray filtered;
    for (const QJsonValue &value : result) {
        const QJsonObject row = value.toObject();
        const bool hasText = !row.value(QStringLiteral("text")).toString().trimmed().isEmpty();
        const bool hasThinking = !row.value(QStringLiteral("thinking")).toString().trimmed().isEmpty();
        const bool hasImages = row.value(QStringLiteral("images")).toArray().size() > 0;
        const bool hasNotice = row.contains(QStringLiteral("imageDisplayNotice"));
        if (hasText || hasThinking || hasImages || hasNotice) filtered.append(value);
    }
    return filtered;
}

QString messageThinking(const QJsonValue &content)
{
    return extractThinking(content);
}

QString toolResultText(const QJsonValue &result, const maincopy::Translator &translate)
{
    return extractToolResultText(result, translate);
}

QString toolDetail(const QString &toolName, const QJsonValue &args, const QJsonValue &result,
                   bool isError, bool missingResult, const maincopy::Translator &translate)
{
    return formatToolDetail(toolName, args, result, isError, missingResult, translate);
}

} // namespace projector
