#include "WebDispatch.h"

#include "ProjectStore.h"
#include "RuntimeCoordinator.h"
#include "SettingsCatalog.h"
#include "WebCopy.h"
#include "WebSessionRoutes.h"
#include "WebState.h"

#include <QDir>
#include <QJsonArray>
#include <QJsonObject>

/**
 * Route handlers.
 *
 * Every handler mirrors one branch of `WebServiceManager.handleRequest`; the comments
 * name the oracle branch where the mapping is not obvious. Validation happens here
 * (before any domain call) so an untrusted LAN body cannot reach a manager with a
 * half-valid shape.
 *
 * Session-record and runtime-action routes live in WebSessionRoutes.cpp; everything else
 * is here.
 */
namespace webdispatch {
namespace {

/** `MAX_WEB_TURN_PAGE_SIZE`: the per-page turn budget the desktop also uses. */
constexpr int kMaxTurnPageSize = 50;

QJsonObject settingsObject(const ChannelServices &services)
{
    return readSettingsCatalog(QDir(services.userDataDir).filePath(QStringLiteral("settings.json")))
        .settings;
}

} // namespace

void handle(const webroute::Match &match, const HttpRequest &request, const Context &context,
            ChannelServices &services, ChannelRegistry &registry, Callback callback)
{
    switch (match.action) {
    case webroute::Action::Health:
        return callback(Reply{200, QJsonObject{
                                       {QStringLiteral("ok"), true},
                                       {QStringLiteral("service"), QStringLiteral("PiDeck-Q")},
                                       {QStringLiteral("host"), context.host},
                                       {QStringLiteral("port"), context.port},
                                   }});

    case webroute::Action::State:
        return callback(Reply{200, webstate::build(services)});

    case webroute::Action::Models:
        return invokeInto(registry, QStringLiteral("projects:list-models"), QJsonArray{},
                          QStringLiteral("models"), callback);

    case webroute::Action::UiResponse: {
        QJsonObject body;
        if (!readJsonObject(request, &body)) return callback(internalError());
        const QString sessionId = body.value(QStringLiteral("sessionId")).toString().trimmed();
        const QString requestId = body.value(QStringLiteral("requestId")).toString().trimmed();
        const QString agentId = body.value(QStringLiteral("agentId")).toString().trimmed();
        const QJsonValue generation = body.value(QStringLiteral("runtimeGeneration"));
        if (sessionId.isEmpty() || requestId.isEmpty() || agentId.isEmpty()
            || !generation.isDouble() || !std::isfinite(generation.toDouble())) {
            return callback(badRequest(QStringLiteral("webError.requestIdRequired")));
        }
        QJsonObject input{
            {QStringLiteral("sessionId"), sessionId},
            {QStringLiteral("requestId"), requestId},
            {QStringLiteral("agentId"), agentId},
            {QStringLiteral("runtimeGeneration"), generation},
            {QStringLiteral("response"),
             body.contains(QStringLiteral("response")) ? body.value(QStringLiteral("response"))
                                                       : QJsonObject{}},
        };
        return invoke(registry, QStringLiteral("sessions:ui-response"), QJsonArray{input},
                      [callback](Reply reply) {
                          if (reply.status != 200) return callback(reply);
                          const QJsonObject result = reply.body.toObject();
                          if (result.value(QStringLiteral("ok")).toBool(true)) {
                              return callback(Reply{200, QJsonObject{{QStringLiteral("ok"), true}}});
                          }
                          // The oracle answers 409 with the domain message; the command
                          // envelope carries it as `error.debugDetails`.
                          const QJsonObject error = result.value(QStringLiteral("error")).toObject();
                          QString message = error.value(QStringLiteral("debugDetails")).toString();
                          if (message.isEmpty()) message = error.value(QStringLiteral("code")).toString();
                          callback(Reply{409, errorBody(409,
                                                        QStringLiteral("webError.runtimeTargetRequired"),
                                                        message)});
                      });
    }

    case webroute::Action::CreateProject: {
        QJsonObject body;
        if (!readJsonObject(request, &body)) return callback(internalError());
        const QString path = body.value(QStringLiteral("path")).toString().trimmed();
        if (path.isEmpty()) return callback(badRequest(QStringLiteral("webError.projectPathRequired")));
        if (!services.projects) return callback(internalError());
        try {
            // The browser names the directory directly (the oracle's `createProject(path)`);
            // the store normalises it and the project then behaves like any desktop project.
            const bool wsl = settingsObject(services).value(QStringLiteral("wslEnabled")).toBool();
            const QJsonObject project = services.projects->add(
                path, QString(), wsl ? QStringLiteral("wsl") : QStringLiteral("windows"));
            return callback(Reply{200, QJsonObject{{QStringLiteral("project"), project}}});
        } catch (const std::exception &) {
            return callback(internalError());
        }
    }

    case webroute::Action::DeleteProject: {
        if (!services.projects) return callback(internalError());
        const QJsonObject project = services.projects->get(match.projectId);
        if (project.isEmpty()) {
            return callback(Reply{404, errorBody(404, QStringLiteral("webError.projectNotFound"),
                                                 webcopy::errorEn(QStringLiteral("webError.projectNotFound")))});
        }
        if (project.value(QStringLiteral("kind")).toString() == QLatin1String("chat")) {
            return callback(badRequest(QStringLiteral("webError.chatProjectProtected")));
        }
        try {
            services.projects->remove(match.projectId);
        } catch (const std::exception &) {
            return callback(internalError());
        }
        return callback(Reply{200, QJsonObject{{QStringLiteral("deleted"), true}}});
    }

    case webroute::Action::ProjectSessions:
        return invokeInto(registry, QStringLiteral("sessions:list"), QJsonArray{match.projectId},
                          QStringLiteral("sessions"), callback);

    case webroute::Action::ProjectCatalogSessions:
        return invokeInto(registry, QStringLiteral("sessions:catalog-list"),
                          QJsonArray{match.projectId, QJsonObject{}},
                          QStringLiteral("sessions"), callback);

    case webroute::Action::SessionRuntimes:
        return invokeInto(registry, QStringLiteral("sessions:runtime-list"), QJsonArray{},
                          QStringLiteral("runtimes"), callback);

    case webroute::Action::CreateSession: {
        QJsonObject body;
        if (!readJsonObject(request, &body)) return callback(internalError());
        if (body.value(QStringLiteral("projectId")).toString().trimmed().isEmpty()) {
            return callback(badRequest(QStringLiteral("webError.projectIdRequired")));
        }
        return invokeInto(registry, QStringLiteral("sessions:catalog-create-draft"),
                          QJsonArray{body}, QStringLiteral("session"), callback);
    }

    case webroute::Action::CreateAnonymousSession: {
        QJsonObject body;
        if (!readJsonObject(request, &body)) return callback(internalError());
        if (body.value(QStringLiteral("projectId")).toString().trimmed().isEmpty()) {
            return callback(badRequest(QStringLiteral("webError.projectIdRequired")));
        }
        // The oracle forwards the whole result object (`{session, agentId?}`): the
        // anonymous bootstrap needs both halves, so it is not wrapped in `{session}`.
        return invoke(registry, QStringLiteral("sessions:create-anonymous"), QJsonArray{body},
                      callback);
    }

    case webroute::Action::ReferenceMessages:
        return invokeInto(registry, QStringLiteral("sessions:catalog-read-reference-messages"),
                          QJsonArray{match.sessionId, QJsonObject{}},
                          QStringLiteral("messages"), callback);

    case webroute::Action::Messages:
        return invokeInto(registry, QStringLiteral("sessions:catalog-read-messages"),
                          QJsonArray{match.sessionId, QJsonObject{}},
                          QStringLiteral("messages"), callback);

    case webroute::Action::MessagePage: {
        double before = 0;
        double pageSize = 0;
        const QueryState beforeState =
            optionalInteger(request, QByteArrayLiteral("before"), 0, 9007199254740991.0, &before);
        const QueryState sizeState =
            optionalInteger(request, QByteArrayLiteral("pageSize"), 0, 9007199254740991.0, &pageSize);
        // The oracle only rejects non-integers here; the pager clamps the range.
        if (beforeState == QueryState::Invalid || sizeState == QueryState::Invalid) {
            return callback(badRequest(QStringLiteral("webError.invalidMessagePage")));
        }
        return invoke(registry, QStringLiteral("sessions:catalog-read-message-page"),
                      QJsonArray{match.sessionId,
                                 beforeState == QueryState::Valid ? QJsonValue(before)
                                                                  : QJsonValue(QJsonValue::Null),
                                 sizeState == QueryState::Valid ? QJsonValue(pageSize)
                                                                : QJsonValue(QJsonValue::Null),
                                 QJsonObject{}},
                      callback);
    }

    case webroute::Action::TurnPage: {
        double turnCount = 0;
        double before = 0;
        const QueryState countState = optionalInteger(request, QByteArrayLiteral("turnCount"), 1,
                                                      kMaxTurnPageSize, &turnCount);
        const QueryState beforeState = optionalInteger(request, QByteArrayLiteral("before"), 0,
                                                       9007199254740991.0, &before);
        if (countState == QueryState::Invalid || beforeState == QueryState::Invalid) {
            return callback(badRequest(QStringLiteral("webError.invalidMessagePage")));
        }
        QString beforeEntryId;
        webroute::queryParameter(request.query, QStringLiteral("beforeEntryId"), &beforeEntryId);
        // `unit=turn` reuses the message-page channel: one pager, one cursor space.
        const QJsonObject options{
            {QStringLiteral("unit"), QStringLiteral("turn")},
            {QStringLiteral("beforeEntryId"), beforeEntryId},
        };
        return invoke(registry, QStringLiteral("sessions:catalog-read-message-page"),
                      QJsonArray{match.sessionId,
                                 beforeState == QueryState::Valid ? QJsonValue(before)
                                                                  : QJsonValue(QJsonValue::Null),
                                 countState == QueryState::Valid ? QJsonValue(turnCount)
                                                                 : QJsonValue(QJsonValue::Null),
                                 options},
                      callback);
    }

    case webroute::Action::Prompt: {
        QJsonObject body;
        if (!readJsonObject(request, &body)) return callback(internalError());
        const QString message = body.value(QStringLiteral("message")).toString().trimmed();
        if (body.value(QStringLiteral("requestId")).toString().trimmed().isEmpty()) {
            return callback(badRequest(QStringLiteral("webError.requestIdRequired")));
        }
        const QJsonArray images = body.value(QStringLiteral("images")).toArray();
        if (message.isEmpty() && images.isEmpty()) {
            return callback(badRequest(QStringLiteral("webError.messageRequired")));
        }
        body.insert(QStringLiteral("sessionId"), match.sessionId);
        body.insert(QStringLiteral("message"), message);
        return invokeInto(registry, QStringLiteral("sessions:send-prompt"), QJsonArray{body},
                          QStringLiteral("result"), callback);
    }

    case webroute::Action::SessionRecord:
        return handleSessionRecord(match, request, services, registry, callback);

    case webroute::Action::RuntimeAction:
        return handleRuntimeAction(match, request, services, registry, callback);

    // The AI-SDK UIMessageStream translator is a separate stage. Answering 501 is the only
    // honest option: a fake `data: [DONE]` would make `useChat` render an empty successful
    // reply for a prompt that never ran.
    case webroute::Action::Stream:
    case webroute::Action::Chat:
        return callback(Reply{501, errorBody(501, QStringLiteral("webError.streamUnavailable"),
                                             webcopy::errorEn(QStringLiteral("webError.streamUnavailable")))});

    case webroute::Action::ApiNotFound:
        return callback(Reply{404, errorBody(404, QStringLiteral("webError.apiNotFound"),
                                             webcopy::errorEn(QStringLiteral("webError.apiNotFound")))});

    case webroute::Action::Asset:
        break;
    }
    // Assets never reach the dispatcher; treat an accidental call as a missing document.
    callback(Reply{404, errorBody(404, QStringLiteral("webError.apiNotFound"),
                                  webcopy::errorEn(QStringLiteral("webError.apiNotFound")))});
}

} // namespace webdispatch
