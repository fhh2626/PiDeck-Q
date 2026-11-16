#include "PiTaskMessage.h"

#include <QDateTime>
#include <QHash>
#include <QRegularExpression>

#include <cmath>

namespace pitask {

const char *const kTodoTaskStart = "pi-deck-todo-task-start";
const char *const kTodoTaskResume = "pi-deck-todo-task-resume";

namespace {

/**
 * Shared visible-custom reader: the JSONL entry and the display message must agree on
 * the custom type, the explicit `display` flag and a non-empty trimmed text.
 * `role`/`type` are checked separately because pi writes `type: "custom_message"` to
 * the file while live events and projected messages carry `role: "custom"`.
 */
bool readVisibleCustom(const QJsonValue &value, const char *customType, QString *text)
{
    if (!value.isObject()) return false;
    const QJsonObject entry = value.toObject();
    if (entry.value(QStringLiteral("customType")).toString() != QLatin1String(customType)) return false;
    // Strict boolean: `display: "true"` must not make a hidden rule visible.
    if (!entry.value(QStringLiteral("display")).toBool(false)) return false;
    const QString role = entry.value(QStringLiteral("role")).toString();
    const QString type = entry.value(QStringLiteral("type")).toString();
    if (role != QLatin1String("custom") && type != QLatin1String("custom_message")) return false;
    const QJsonValue content = entry.value(QStringLiteral("content"));
    if (!content.isString()) return false;
    const QString trimmed = content.toString().trimmed();
    if (trimmed.isEmpty()) return false;
    if (text) *text = trimmed;
    return true;
}

} // namespace

bool readTodoTaskMessage(const QJsonValue &value, TaskMessage *message)
{
    QString text;
    if (readVisibleCustom(value, kTodoTaskStart, &text)) {
        if (message) {
            message->kind = Kind::Goal;
            message->text = text;
        }
        return true;
    }
    if (readVisibleCustom(value, kTodoTaskResume, &text)) {
        if (message) {
            message->kind = Kind::Resume;
            message->text = text;
        }
        return true;
    }
    return false;
}

bool readTodoTaskGoal(const QJsonValue &value, QString *goal)
{
    TaskMessage message;
    if (!readTodoTaskMessage(value, &message) || message.kind != Kind::Goal) return false;
    if (goal) *goal = message.text;
    return true;
}

bool readTodoTaskCommand(const QJsonValue &value, TaskCommand *command)
{
    TaskMessage task;
    if (!readTodoTaskMessage(value, &task)) return false;
    const QJsonObject details = value.toObject().value(QStringLiteral("details")).toObject();
    const QString name = details.value(QStringLiteral("commandName")).toString();
    const QJsonValue args = details.value(QStringLiteral("commandArgs"));
    if (!args.isString()) return false;
    const bool valid = task.kind == Kind::Goal
        ? name == QLatin1String("todo") || name == QLatin1String("todo-goal")
        : name == QLatin1String("todo-resume");
    if (!valid) return false;
    if (command) *command = TaskCommand{name, args.toString().trimmed()};
    return true;
}

bool acknowledgeTodoCommand(const QJsonObject &pending, const QJsonObject &card,
                            QJsonObject *acknowledged)
{
    if (pending.value(QStringLiteral("role")).toString() != QLatin1String("user")
        || !isTodoTaskCard(card)) return false;
    const QJsonObject pendingMeta = pending.value(QStringLiteral("meta")).toObject();
    const QString requestId = pendingMeta.value(QStringLiteral("optimisticRequestId")).toString();
    if (requestId.isEmpty()) return false;
    QJsonObject meta = card.value(QStringLiteral("meta")).toObject();
    const QJsonValue name = meta.value(QStringLiteral("todoTaskCommandName"));
    const QJsonValue args = meta.value(QStringLiteral("todoTaskCommandArgs"));
    if (!name.isString() || !args.isString()) return false;
    static const QRegularExpression pattern(QStringLiteral("^/(\\S+)(?:\\s+([\\s\\S]*))?$"));
    const QRegularExpressionMatch match = pattern.match(pending.value(QStringLiteral("text")).toString().trimmed());
    if (!match.hasMatch() || match.captured(1) != name.toString()
        || match.captured(2).trimmed() != args.toString()) return false;
    if (acknowledged) {
        *acknowledged = card;
        acknowledged->insert(QStringLiteral("id"), pending.value(QStringLiteral("id")));
        meta.insert(QStringLiteral("optimisticRequestId"), requestId);
        const QString behavior = pendingMeta.value(QStringLiteral("streamingBehavior")).toString();
        if (behavior == QLatin1String("steer") || behavior == QLatin1String("followUp")) {
            meta.insert(QStringLiteral("streamingBehavior"), behavior);
        }
        acknowledged->insert(QStringLiteral("meta"), meta);
    }
    return true;
}

bool readTodoTaskMessageId(const QJsonValue &value, QString *messageId)
{
    if (!value.isObject()) return false;
    const QJsonValue details = value.toObject().value(QStringLiteral("details"));
    if (!details.isObject()) return false;
    const QJsonValue id = details.toObject().value(QStringLiteral("messageId"));
    if (!id.isString()) return false;
    const QString text = id.toString();
    // The sender may pad the identity; only an all-whitespace id is treated as absent.
    // The value itself is kept verbatim so both sides compare the same string.
    if (text.trimmed().isEmpty()) return false;
    if (messageId) *messageId = text;
    return true;
}

namespace {

/**
 * RFC 2822/1123 timestamp ("Wed, 01 Jan 2026 00:00:00 GMT" / "... +0800").
 *
 * `Date.parse` accepts these, so `toEpochMs` must too; Qt's own RFC parser rejects
 * valid forms whose weekday does not match the date, and a mismatched weekday is exactly
 * what `Date.parse` ignores. Parsing the components keeps one deterministic instant.
 */
QDateTime parseRfc2822(const QString &text)
{
    static const QRegularExpression pattern(QStringLiteral(
        "^(?:[A-Za-z]{3},\\s*)?(\\d{1,2})\\s+([A-Za-z]{3})\\s+(\\d{4})\\s+"
        "(\\d{2}):(\\d{2})(?::(\\d{2}))?\\s+(GMT|UTC|UT|([+-])(\\d{2})(\\d{2}))$"));
    static const QHash<QString, int> months{
        {QStringLiteral("jan"), 1},  {QStringLiteral("feb"), 2},  {QStringLiteral("mar"), 3},
        {QStringLiteral("apr"), 4},  {QStringLiteral("may"), 5},  {QStringLiteral("jun"), 6},
        {QStringLiteral("jul"), 7},  {QStringLiteral("aug"), 8},  {QStringLiteral("sep"), 9},
        {QStringLiteral("oct"), 10}, {QStringLiteral("nov"), 11}, {QStringLiteral("dec"), 12},
    };
    const QRegularExpressionMatch match = pattern.match(text);
    if (!match.hasMatch()) return {};
    const int month = months.value(match.captured(2).left(3).toLower(), 0);
    if (month == 0) return {};
    const QDate date(match.captured(3).toInt(), month, match.captured(1).toInt());
    const QTime time(match.captured(4).toInt(), match.captured(5).toInt(),
                     match.captured(6).toInt());
    if (!date.isValid() || !time.isValid()) return {};
    if (!match.captured(8).isEmpty()) {
        const int sign = match.captured(8) == QLatin1String("-") ? -1 : 1;
        const int offsetSeconds = sign * (match.captured(9).toInt() * 3600
                                          + match.captured(10).toInt() * 60);
        return QDateTime(date, time, Qt::OffsetFromUTC, offsetSeconds);
    }
    return QDateTime(date, time, Qt::UTC);
}

} // namespace

bool toEpochMs(const QJsonValue &value, double *epochMs)
{
    if (value.isDouble()) {
        const double number = value.toDouble();
        if (!std::isfinite(number)) return false;
        if (epochMs) *epochMs = number;
        return true;
    }
    if (!value.isString()) return false;
    // `Date.parse` does not trim: whitespace-padded stamps are NaN there, so the caller's
    // Date.now() fallback must win here too.
    const QString text = value.toString();
    if (text.isEmpty()) return false;
    // Date-only `YYYY-MM-DD`: `Date.parse` reads it as UTC midnight, while Qt's ISODate
    // parser would read it as *local* midnight. Handle it before the ISO branch.
    if (text.size() == 10) {
        const QDate date = QDate::fromString(text, QStringLiteral("yyyy-MM-dd"));
        if (!date.isValid()) return false;
        if (epochMs) *epochMs = double(QDateTime(date, QTime(0, 0), Qt::UTC).toMSecsSinceEpoch());
        return true;
    }
    // ISO-8601 starts with `YYYY-MM-DDT`; a bare `contains('T')` would also match
    // RFC weekdays (`Thu, ...`) and route them into the ISO parser.
    if (text.size() > 10 && text.at(4) == QLatin1Char('-') && text.at(7) == QLatin1Char('-')
        && text.at(10) == QLatin1Char('T')) {
        // pi stores ISO-8601 timestamps (with/without ms, `Z` or an offset). A missing
        // offset means local time, exactly like `Date.parse`.
        QDateTime parsed = QDateTime::fromString(text, Qt::ISODateWithMs);
        if (!parsed.isValid()) parsed = QDateTime::fromString(text, Qt::ISODate);
        if (!parsed.isValid()) return false;
        if (epochMs) *epochMs = double(parsed.toMSecsSinceEpoch());
        return true;
    }
    // RFC 2822/1123 (`Wed, 01 Jan 2026 00:00:00 GMT`) is accepted by `Date.parse`; some
    // importers forward stamps in that shape.
    const QDateTime rfc = parseRfc2822(text);
    if (rfc.isValid()) {
        if (epochMs) *epochMs = double(rfc.toMSecsSinceEpoch());
        return true;
    }
    return false;
}

QJsonObject displayEntry(const QJsonObject &entry)
{
    QJsonObject result;
    TaskMessage task;
    if (!readTodoTaskMessage(QJsonValue(entry), &task)) {
        result.insert(QStringLiteral("type"), entry.value(QStringLiteral("type")).toString());
        result.insert(QStringLiteral("message"), entry.value(QStringLiteral("message")));
        return result;
    }
    QJsonObject message{
        {QStringLiteral("role"), QStringLiteral("custom")},
        {QStringLiteral("customType"),
         QLatin1String(task.kind == Kind::Goal ? kTodoTaskStart : kTodoTaskResume)},
        {QStringLiteral("content"), task.text},
        {QStringLiteral("display"), true},
    };
    if (entry.contains(QStringLiteral("details"))) {
        message.insert(QStringLiteral("details"), entry.value(QStringLiteral("details")));
    }
    double timestamp = 0;
    if (toEpochMs(entry.value(QStringLiteral("timestamp")), &timestamp)) {
        message.insert(QStringLiteral("timestamp"), timestamp);
    }
    result.insert(QStringLiteral("type"), QStringLiteral("message"));
    result.insert(QStringLiteral("message"), message);
    return result;
}

bool isTodoTaskCard(const QJsonValue &message)
{
    if (!message.isObject()) return false;
    const QJsonObject object = message.toObject();
    if (object.value(QStringLiteral("role")).toString() != QLatin1String("system")) return false;
    const QJsonValue meta = object.value(QStringLiteral("meta"));
    if (!meta.isObject()) return false;
    return meta.toObject().value(QStringLiteral("type")).toString() == QLatin1String("todoTask");
}

bool isPiUserTurn(const QJsonValue &message)
{
    if (!message.isObject()) return false;
    const QJsonObject object = message.toObject();
    if (object.value(QStringLiteral("role")).toString() == QLatin1String("user")) return true;
    TaskMessage task;
    if (readTodoTaskMessage(message, &task)) return true;
    return isTodoTaskCard(message);
}

} // namespace pitask
