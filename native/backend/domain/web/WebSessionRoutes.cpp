#include "WebSessionRoutes.h"

#include "RuntimeCoordinator.h"
#include "WebCopy.h"

#include <QJsonArray>
#include <QJsonObject>

/**
 * Session-record and runtime-action routes.
 *
 * Both families take the session id from the path and a body from the browser, so they
 * share one validation rule: the path owns the identity, and anything that disagrees with
 * it is a 400 before a manager sees it.
 */
namespace webdispatch {

void handleSessionRecord(const webroute::Match &match, const HttpRequest &request,
                         ChannelServices &services, ChannelRegistry &registry, Callback callback)
{
    const QString action = match.recordAction;
    if (action == QLatin1String("update")) {
        QJsonObject patch;
        if (!readJsonObject(request, &patch)) return callback(internalError());
        return invokeInto(registry, QStringLiteral("sessions:catalog-update"),
                          QJsonArray{match.sessionId, patch}, QStringLiteral("session"), callback);
    }
    if (action == QLatin1String("delete")) {
        // The oracle separates "the session is running" (400, business message) from an
        // IO/recycle-bin failure (500). Answer the running case before delegating so the
        // browser is not told the service broke when the user simply has to stop it.
        if (services.runtimeCoordinator
            && services.runtimeCoordinator->isSessionBusy(match.sessionId)) {
            const QString message =
                services.translate(QStringLiteral("session.stopBeforeDelete"), QJsonObject{});
            return callback(Reply{400, errorBody(400, QStringLiteral("webError.deleteSessionBlocked"),
                                                 message)});
        }
        return invokeInto(registry, QStringLiteral("sessions:catalog-delete"),
                          QJsonArray{match.sessionId}, QStringLiteral("deleted"), callback);
    }
    if (action == QLatin1String("copy")) {
        return invokeInto(registry, QStringLiteral("sessions:catalog-copy"),
                          QJsonArray{match.sessionId}, QStringLiteral("result"), callback);
    }
    return invokeInto(registry, QStringLiteral("sessions:catalog-export-html"),
                      QJsonArray{match.sessionId}, QStringLiteral("result"), callback);
}

void handleRuntimeAction(const webroute::Match &match, const HttpRequest &request,
                         ChannelServices &services, ChannelRegistry &registry, Callback callback)
{
    Q_UNUSED(services);
    QJsonObject body;
    if (!readJsonObject(request, &body)) return callback(internalError());
    const QJsonValue target = validatedTarget(body, match.sessionId);
    if (!target.isObject()) {
        return callback(badRequest(QStringLiteral("webError.runtimeTargetRequired")));
    }
    const QString messageId = body.value(QStringLiteral("messageId")).toString();
    const QString action = match.runtimeAction;

    QString channel;
    QJsonArray args{target};
    if (action == QLatin1String("stop")) channel = QStringLiteral("sessions:runtime-stop");
    else if (action == QLatin1String("abort")) channel = QStringLiteral("sessions:runtime-abort");
    else if (action == QLatin1String("restart")) channel = QStringLiteral("sessions:runtime-restart");
    else if (action == QLatin1String("state")) channel = QStringLiteral("sessions:runtime-state");
    else if (action == QLatin1String("commands")) channel = QStringLiteral("sessions:runtime-commands");
    else if (action == QLatin1String("models")) channel = QStringLiteral("sessions:runtime-list-models");
    else if (action == QLatin1String("export-html")) channel = QStringLiteral("sessions:runtime-export-html");
    else if (action == QLatin1String("clone")) channel = QStringLiteral("sessions:runtime-clone");
    else if (action == QLatin1String("compact")) {
        channel = QStringLiteral("sessions:runtime-compact");
        args.append(body.value(QStringLiteral("prompt")));
    } else if (action == QLatin1String("edit-message")) {
        channel = QStringLiteral("sessions:runtime-edit-message");
        args.append(messageId);
        args.append(body.value(QStringLiteral("newText")));
    } else if (action == QLatin1String("delete-message")) {
        channel = QStringLiteral("sessions:runtime-delete-message");
        args.append(messageId);
    } else if (action == QLatin1String("prepare-resend")) {
        channel = QStringLiteral("sessions:runtime-prepare-resend");
        args.append(messageId);
        args.append(body.value(QStringLiteral("model")).toObject());
        args.append(body.value(QStringLiteral("thinkingLevel")));
    } else if (action == QLatin1String("model")) {
        channel = QStringLiteral("sessions:runtime-set-model");
        args.append(body.value(QStringLiteral("provider")).toString());
        args.append(body.value(QStringLiteral("modelId")).toString());
    } else {
        // The route regex only matches known actions, so the remainder is `thinking`.
        channel = QStringLiteral("sessions:runtime-set-thinking");
        args.append(body.value(QStringLiteral("level")).toString());
    }
    invokeInto(registry, channel, args, QStringLiteral("result"), callback);
}

} // namespace webdispatch
