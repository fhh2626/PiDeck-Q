#include "RpcLogEntry.h"

#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonValue>
#include <QUuid>

namespace rpclog {
namespace {

/**
 * JavaScript template-literal rendering of an arbitrary JSON value.
 *
 * The oracle builds summaries with `${data.type}` style interpolation, so a missing
 * field prints `undefined`, `null` prints `null`, and a numeric or boolean field prints
 * its literal text. Reproducing that (instead of `QJsonValue::toString()`, which yields
 * an empty string for non-strings) is what keeps the summaries byte-identical.
 */
QString jsText(const QJsonValue &value)
{
    switch (value.type()) {
    case QJsonValue::Undefined:
        return QStringLiteral("undefined");
    case QJsonValue::Null:
        return QStringLiteral("null");
    case QJsonValue::Bool:
        return value.toBool() ? QStringLiteral("true") : QStringLiteral("false");
    case QJsonValue::Double: {
        const double number = value.toDouble();
        // JSON numbers are doubles; print integral values the way JS does (no `.0`).
        if (number == double(qint64(number))) return QString::number(qint64(number));
        return QString::number(number, 'g', 17);
    }
    case QJsonValue::String:
        return value.toString();
    case QJsonValue::Array:
        return QString::fromUtf8(QJsonDocument(value.toArray()).toJson(QJsonDocument::Compact));
    case QJsonValue::Object:
        return QString::fromUtf8(QJsonDocument(value.toObject()).toJson(QJsonDocument::Compact));
    }
    return {};
}

/** JavaScript truthiness, used by `data.description ? ... : ""` and the `✓` mark. */
bool jsTruthy(const QJsonValue &value)
{
    switch (value.type()) {
    case QJsonValue::Bool:
        return value.toBool();
    case QJsonValue::Double:
        return value.toDouble() != 0 && !qIsNaN(value.toDouble());
    case QJsonValue::String:
        return !value.toString().isEmpty();
    case QJsonValue::Undefined:
    case QJsonValue::Null:
        return false;
    default:
        return true;
    }
}

/** `(value ?? "").slice(0, 60)`: only strings reach the preview in practice. */
QString preview(const QJsonValue &value)
{
    return value.isString() ? value.toString().left(60) : jsText(value).left(60);
}

} // namespace

QString summaryFor(const QString &direction, const QJsonObject &data)
{
    const QJsonValue typeValue = data.value(QStringLiteral("type"));
    const QString type = typeValue.isUndefined() || typeValue.isNull()
        ? QStringLiteral("?")
        : jsText(typeValue);

    if (direction == QLatin1String("send")) {
        if (type == QLatin1String("prompt")) {
            const QJsonValue description = data.value(QStringLiteral("description"));
            const QString suffix = jsTruthy(description)
                ? QStringLiteral(" [%1]").arg(jsText(description))
                : QString();
            return QStringLiteral("→ prompt%1: %2").arg(suffix, preview(data.value(QStringLiteral("message"))));
        }
        if (type == QLatin1String("set_model")) {
            return QStringLiteral("→ set_model: %1/%2")
                .arg(jsText(data.value(QStringLiteral("provider"))),
                     jsText(data.value(QStringLiteral("modelId"))));
        }
        if (type == QLatin1String("set_thinking_level")) {
            return QStringLiteral("→ set_thinking: %1").arg(jsText(data.value(QStringLiteral("level"))));
        }
        if (type == QLatin1String("bash")) {
            return QStringLiteral("→ bash: %1").arg(preview(data.value(QStringLiteral("command"))));
        }
        return QStringLiteral("→ %1").arg(type);
    }

    if (type == QLatin1String("response")) {
        const QJsonValue command = data.value(QStringLiteral("command"));
        const QString name = command.isUndefined() || command.isNull() ? QStringLiteral("?")
                                                                      : jsText(command);
        const QString mark = jsTruthy(data.value(QStringLiteral("success"))) ? QStringLiteral("✓")
                                                                            : QStringLiteral("✗");
        const QJsonValue error = data.value(QStringLiteral("error"));
        const QString suffix = jsTruthy(error) ? QStringLiteral(" %1").arg(jsText(error)) : QString();
        return QStringLiteral("← %1 %2%3").arg(name, mark, suffix);
    }
    if (type == QLatin1String("message_update")) {
        const QJsonValue event = data.value(QStringLiteral("assistantMessageEvent"));
        const QJsonValue eventType = event.toObject().value(QStringLiteral("type"));
        const QString name = eventType.isUndefined() || eventType.isNull() ? QStringLiteral("?")
                                                                          : jsText(eventType);
        return QStringLiteral("← message_update.%1").arg(name);
    }
    return QStringLiteral("← %1").arg(type);
}

QJsonObject makeEntry(const QString &agentId, const QString &direction, const QJsonObject &data,
                      qint64 timeMs, const QString &id)
{
    return QJsonObject{
        {QStringLiteral("id"), id},
        {QStringLiteral("agentId"), agentId},
        {QStringLiteral("direction"), direction},
        {QStringLiteral("summary"), summaryFor(direction, data)},
        {QStringLiteral("data"), data},
        {QStringLiteral("time"), double(timeMs)},
    };
}

QString newEntryId()
{
    return QUuid::createUuid().toString(QUuid::WithoutBraces);
}

bool isRendererEntry(const QJsonObject &entry)
{
    const QString direction = entry.value(QStringLiteral("direction")).toString();
    return entry.value(QStringLiteral("id")).isString()
        && entry.value(QStringLiteral("agentId")).isString()
        && (direction == QLatin1String("send") || direction == QLatin1String("recv"))
        && entry.value(QStringLiteral("summary")).isString()
        && entry.value(QStringLiteral("time")).isDouble();
}

} // namespace rpclog
