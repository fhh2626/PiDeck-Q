#include "WebStreamJson.h"

#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>

#include <cmath>

namespace webstream {

QString jsString(const QJsonValue &value)
{
    switch (value.type()) {
    case QJsonValue::Null:
    case QJsonValue::Undefined:
        return QString();
    case QJsonValue::Bool:
        return value.toBool() ? QStringLiteral("true") : QStringLiteral("false");
    case QJsonValue::Double: {
        const double number = value.toDouble();
        if (std::isnan(number)) return QStringLiteral("NaN");
        if (std::isinf(number)) return number > 0 ? QStringLiteral("Infinity")
                                                  : QStringLiteral("-Infinity");
        if (std::floor(number) == number && std::abs(number) < 1e21) {
            // Integral doubles print without a fractional part, like JS `String(1)`.
            return QString::number(static_cast<qint64>(number));
        }
        return QString::number(number, 'g', 17);
    }
    case QJsonValue::String:
        return value.toString();
    case QJsonValue::Array:
        return QString::fromUtf8(QJsonDocument(value.toArray()).toJson(QJsonDocument::Compact));
    case QJsonValue::Object:
        return QStringLiteral("[object Object]");
    }
    return QString();
}

QJsonValue coalesce(const QJsonValue &value, const QJsonValue &fallback)
{
    if (value.isUndefined() || value.isNull()) return fallback;
    return value;
}

bool jsonEqual(const QJsonValue &left, const QJsonValue &right)
{
    if (left.type() != right.type()) return false;
    if (left.isDouble()) return left.toDouble() == right.toDouble();
    return left == right;
}

} // namespace webstream
