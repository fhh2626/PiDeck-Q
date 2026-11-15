#include "WebSupport.h"

#include "WebCopy.h"

#include <QJsonDocument>

#include <cmath>

namespace webdispatch {

QJsonValue errorBody(int status, const QString &code, const QString &error)
{
    Q_UNUSED(status);
    return QJsonObject{{QStringLiteral("code"), code}, {QStringLiteral("error"), error}};
}

Reply internalError()
{
    return Reply{500, errorBody(500, QStringLiteral("webError.internal"),
                                webcopy::errorEn(QStringLiteral("webError.internal")))};
}

Reply badRequest(const QString &code)
{
    return Reply{400, errorBody(400, code, webcopy::errorEn(code))};
}

bool readJsonObject(const HttpRequest &request, QJsonObject *out)
{
    *out = QJsonObject{};
    if (request.body.isEmpty()) return true;
    QJsonParseError error;
    const QJsonDocument document = QJsonDocument::fromJson(request.body, &error);
    if (error.error != QJsonParseError::NoError || !document.isObject()) return false;
    *out = document.object();
    return true;
}

void invoke(ChannelRegistry &registry, const QString &channel, const QJsonArray &args,
            Callback callback)
{
    registry.invoke(channel, args,
                    ChannelResponder(
                        [callback](const QJsonValue &value) { callback(Reply{200, value}); },
                        [callback](const QString &) { callback(internalError()); }));
}

void invokeInto(ChannelRegistry &registry, const QString &channel, const QJsonArray &args,
                const QString &key, Callback callback)
{
    invoke(registry, channel, args,
           [callback, key](Reply reply) {
               if (reply.status != 200) return callback(reply);
               callback(Reply{200, QJsonObject{{key, reply.body}}});
           });
}

bool isSafeInteger(double value)
{
    if (!std::isfinite(value)) return false;
    if (std::floor(value) != value) return false;
    return std::abs(value) <= 9007199254740991.0;
}

QueryState optionalInteger(const HttpRequest &request, const QByteArray &name, double minimum,
                           double maximum, double *out)
{
    QString raw;
    if (!webroute::queryParameter(request.query, QString::fromUtf8(name), &raw)) {
        return QueryState::Absent;
    }
    const QString trimmed = raw.trimmed();
    if (trimmed.isEmpty()) return QueryState::Invalid;
    bool ok = false;
    const double parsed = trimmed.toDouble(&ok);
    if (!ok || !isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
        return QueryState::Invalid;
    }
    *out = parsed;
    return QueryState::Valid;
}

QJsonValue validatedTarget(const QJsonObject &body, const QString &sessionId)
{
    const QJsonValue target = body.value(QStringLiteral("target"));
    if (!target.isObject()) return QJsonValue(QJsonValue::Undefined);
    const QJsonObject object = target.toObject();
    // The path owns the session identity: a target for another session is a client bug
    // and must never reach the coordinator's generation check.
    if (object.value(QStringLiteral("sessionId")).toString() != sessionId) {
        return QJsonValue(QJsonValue::Undefined);
    }
    return object;
}

} // namespace webdispatch
