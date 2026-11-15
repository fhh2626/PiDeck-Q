#include "app/FocusTargets.h"

#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QJsonValue>
#include <QRegularExpression>

namespace appfocus {
namespace {

// Same UUID shape the oracle matches: lowercase/uppercase hex groups, no braces.
const QString kUuid = QStringLiteral("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}");

const QRegularExpression &sessionRegex()
{
    static const QRegularExpression expression(QStringLiteral("pideck://session/(%1)").arg(kUuid),
                                               QRegularExpression::CaseInsensitiveOption);
    return expression;
}

const QRegularExpression &agentRegex()
{
    static const QRegularExpression expression(QStringLiteral("pideck://agent/(%1)").arg(kUuid),
                                               QRegularExpression::CaseInsensitiveOption);
    return expression;
}

} // namespace

std::optional<Target> extractFocusTarget(const QStringList &argv)
{
    for (const QString &argument : argv) {
        const QRegularExpressionMatch session = sessionRegex().match(argument);
        if (session.hasMatch()) return Target{session.captured(1), QString()};
        const QRegularExpressionMatch agent = agentRegex().match(argument);
        if (agent.hasMatch()) return Target{QString(), agent.captured(1)};
    }
    return std::nullopt;
}

std::optional<Payload> parseFocusPayload(const QByteArray &raw)
{
    if (raw.isEmpty() || raw.size() > kMaxPayloadBytes) return std::nullopt;
    QJsonParseError error;
    const QJsonDocument document = QJsonDocument::fromJson(raw, &error);
    if (error.error != QJsonParseError::NoError || !document.isObject()) return std::nullopt;
    const QJsonObject object = document.object();
    const QJsonValue at = object.value(QStringLiteral("at"));
    const QJsonValue fromPid = object.value(QStringLiteral("fromPid"));
    // Both fields are required: they are what makes a forwarded envelope identifiable as
    // a focus request instead of an arbitrary JSON document on the pipe.
    if (!at.isDouble() || !fromPid.isDouble()) return std::nullopt;

    Payload payload;
    payload.at = qint64(at.toDouble());
    payload.fromPid = qint64(fromPid.toDouble());
    for (const QJsonValue &argument : object.value(QStringLiteral("argv")).toArray()) {
        if (argument.isString()) payload.argv.append(argument.toString());
    }
    return payload;
}

QByteArray encodeFocusPayload(const Payload &payload)
{
    QJsonArray argv;
    for (const QString &argument : payload.argv) argv.append(argument);
    const QJsonObject object{
        {QStringLiteral("at"), double(payload.at)},
        {QStringLiteral("fromPid"), double(payload.fromPid)},
        {QStringLiteral("argv"), argv},
    };
    return QJsonDocument(object).toJson(QJsonDocument::Compact);
}

} // namespace appfocus
