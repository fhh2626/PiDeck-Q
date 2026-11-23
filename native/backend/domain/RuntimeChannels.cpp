#include "ChannelContext.h"
#include "RuntimeCoordinator.h"

#include <QJsonArray>
#include <QJsonObject>

/**
 * `sessions:*` runtime channels.
 *
 * Every argument is validated here (the renderer is untrusted) and then handed to the
 * coordinator. Commands answer `{ok:true,value:{target,value}}` or
 * `{ok:false,error:{code,...}}`, matching SessionCommandResult in the Node oracle, so
 * the renderer's error handling is unchanged.
 */
namespace {

runtime::Coordinator &coordinatorOf(const ChannelServices &services)
{
    if (!services.runtimeCoordinator) {
        throw ChannelError(QStringLiteral("Session runtime is not available"));
    }
    return *services.runtimeCoordinator;
}

QJsonObject targetArg(const QJsonArray &args, int index)
{
    const QJsonObject target = channels::objectArg(args, index);
    if (!target.value(QStringLiteral("sessionId")).isString()
        || target.value(QStringLiteral("sessionId")).toString().trimmed().isEmpty()) {
        throw ChannelError(QStringLiteral("Invalid session runtime target: sessionId is required"));
    }
    if (!target.value(QStringLiteral("agentId")).isString()
        || target.value(QStringLiteral("agentId")).toString().trimmed().isEmpty()) {
        throw ChannelError(QStringLiteral("Invalid session runtime target: agentId is required"));
    }
    if (!target.value(QStringLiteral("runtimeGeneration")).isDouble()) {
        throw ChannelError(QStringLiteral("Invalid session runtime target: runtimeGeneration is required"));
    }
    return target;
}

QString requiredString(const QJsonArray &args, int index, const QString &name)
{
    const QString value = channels::stringArg(args, index);
    if (value.trimmed().isEmpty()) throw ChannelError(QStringLiteral("Invalid %1").arg(name));
    return value;
}

/** Async channel whose handler resolves with a coordinator result object. */
template <typename Handler>
void addCommand(ChannelRegistry &registry, const QString &channel, Handler handler)
{
    registry.addAsync(channel, [handler](const QJsonArray &args, ChannelResponder responder) {
        handler(args, [responder](QJsonObject result) mutable { responder.resolve(result); });
    });
}

} // namespace

void registerRuntimeChannels(ChannelRegistry &registry, ChannelServices &services)
{
    ChannelServices *servicesPtr = &services;

    registry.add(QStringLiteral("sessions:runtime-list"), [servicesPtr](const QJsonArray &) {
        return coordinatorOf(*servicesPtr).listRuntimes();
    });

    registry.add(QStringLiteral("sessions:set-focused-session"), [servicesPtr](const QJsonArray &args) {
        const QString sessionId = channels::stringArg(args, 0).trimmed();
        coordinatorOf(*servicesPtr).setFocusedSession(sessionId);
        return QJsonValue(QJsonValue::Null);
    });

    addCommand(registry, QStringLiteral("sessions:runtime-activate"),
               [servicesPtr](const QJsonArray &args, std::function<void(QJsonObject)> done) {
                   const QString sessionId = requiredString(args, 0, QStringLiteral("sessionId"));
                   coordinatorOf(*servicesPtr).activate(sessionId, std::move(done));
               });

    addCommand(registry, QStringLiteral("sessions:send-prompt"),
               [servicesPtr](const QJsonArray &args, std::function<void(QJsonObject)> done) {
                   const QJsonObject input = channels::objectArg(args, 0);
                   if (!input.value(QStringLiteral("sessionId")).isString()
                       || !input.value(QStringLiteral("requestId")).isString()) {
                       throw ChannelError(QStringLiteral("Invalid session prompt input"));
                   }
                   coordinatorOf(*servicesPtr).send(input, std::move(done));
               });

    addCommand(registry, QStringLiteral("sessions:runtime-stop"),
               [servicesPtr](const QJsonArray &args, std::function<void(QJsonObject)> done) {
                   coordinatorOf(*servicesPtr).stop(targetArg(args, 0), std::move(done));
               });

    addCommand(registry, QStringLiteral("sessions:runtime-abort"),
               [servicesPtr](const QJsonArray &args, std::function<void(QJsonObject)> done) {
                   coordinatorOf(*servicesPtr).abort(targetArg(args, 0), std::move(done));
               });

    addCommand(registry, QStringLiteral("sessions:runtime-flush-messages"),
               [servicesPtr](const QJsonArray &args, std::function<void(QJsonObject)> done) {
                   coordinatorOf(*servicesPtr).flushMessages(targetArg(args, 0), std::move(done));
               });

    addCommand(registry, QStringLiteral("sessions:runtime-restart"),
               [servicesPtr](const QJsonArray &args, std::function<void(QJsonObject)> done) {
                   coordinatorOf(*servicesPtr).restart(targetArg(args, 0), std::move(done));
               });

    addCommand(registry, QStringLiteral("sessions:runtime-compact"),
               [servicesPtr](const QJsonArray &args, std::function<void(QJsonObject)> done) {
                   const QJsonObject target = targetArg(args, 0);
                   coordinatorOf(*servicesPtr).compact(target, channels::stringArg(args, 1),
                                                      std::move(done));
               });

    addCommand(registry, QStringLiteral("sessions:runtime-state"),
               [servicesPtr](const QJsonArray &args, std::function<void(QJsonObject)> done) {
                   coordinatorOf(*servicesPtr).state(targetArg(args, 0), std::move(done));
               });

    addCommand(registry, QStringLiteral("sessions:runtime-commands"),
               [servicesPtr](const QJsonArray &args, std::function<void(QJsonObject)> done) {
                   coordinatorOf(*servicesPtr).commands(targetArg(args, 0), std::move(done));
               });

    addCommand(registry, QStringLiteral("sessions:runtime-list-models"),
               [servicesPtr](const QJsonArray &args, std::function<void(QJsonObject)> done) {
                   coordinatorOf(*servicesPtr).models(targetArg(args, 0), std::move(done));
               });

    addCommand(registry, QStringLiteral("sessions:runtime-export-html"),
               [servicesPtr](const QJsonArray &args, std::function<void(QJsonObject)> done) {
                   coordinatorOf(*servicesPtr).exportHtml(targetArg(args, 0), std::move(done));
               });

    addCommand(registry, QStringLiteral("sessions:runtime-edit-message"),
               [servicesPtr](const QJsonArray &args, std::function<void(QJsonObject)> done) {
                   const QJsonObject target = targetArg(args, 0);
                   const QString messageId = requiredString(args, 1, QStringLiteral("messageId"));
                   const QString newText = channels::stringArg(args, 2);
                   coordinatorOf(*servicesPtr).editMessage(target, messageId, newText, std::move(done));
               });

    addCommand(registry, QStringLiteral("sessions:runtime-delete-message"),
               [servicesPtr](const QJsonArray &args, std::function<void(QJsonObject)> done) {
                   const QJsonObject target = targetArg(args, 0);
                   const QString messageId = requiredString(args, 1, QStringLiteral("messageId"));
                   coordinatorOf(*servicesPtr).deleteMessage(target, messageId, std::move(done));
               });

    addCommand(registry, QStringLiteral("sessions:runtime-prepare-resend"),
               [servicesPtr](const QJsonArray &args, std::function<void(QJsonObject)> done) {
                   const QJsonObject target = targetArg(args, 0);
                   const QString messageId = requiredString(args, 1, QStringLiteral("messageId"));
                   const QJsonObject model = channels::objectArg(args, 2);
                   const QString thinkingLevel = channels::stringArg(args, 3);
                   coordinatorOf(*servicesPtr).prepareResend(target, messageId, model, thinkingLevel,
                                                             std::move(done));
               });

    addCommand(registry, QStringLiteral("sessions:runtime-set-model"),
               [servicesPtr](const QJsonArray &args, std::function<void(QJsonObject)> done) {
                   const QJsonObject target = targetArg(args, 0);
                   const QString provider = requiredString(args, 1, QStringLiteral("provider"));
                   const QString modelId = requiredString(args, 2, QStringLiteral("modelId"));
                   coordinatorOf(*servicesPtr).setModel(target, provider, modelId, std::move(done));
               });

    addCommand(registry, QStringLiteral("sessions:runtime-set-thinking"),
               [servicesPtr](const QJsonArray &args, std::function<void(QJsonObject)> done) {
                   const QJsonObject target = targetArg(args, 0);
                   const QString level = requiredString(args, 1, QStringLiteral("thinkingLevel"));
                   coordinatorOf(*servicesPtr).setThinking(target, level, std::move(done));
               });

    addCommand(registry, QStringLiteral("sessions:runtime-clone"),
               [servicesPtr](const QJsonArray &args, std::function<void(QJsonObject)> done) {
                   coordinatorOf(*servicesPtr).clone(targetArg(args, 0), std::move(done));
               });

    addCommand(registry, QStringLiteral("sessions:runtime-get-fork-messages"),
               [servicesPtr](const QJsonArray &args, std::function<void(QJsonObject)> done) {
                   coordinatorOf(*servicesPtr).getForkMessages(targetArg(args, 0), std::move(done));
               });

    addCommand(registry, QStringLiteral("sessions:runtime-fork"),
               [servicesPtr](const QJsonArray &args, std::function<void(QJsonObject)> done) {
                   const QJsonObject target = targetArg(args, 0);
                   const QString entryId = requiredString(args, 1, QStringLiteral("entryId"));
                   coordinatorOf(*servicesPtr).fork(target, entryId, std::move(done));
               });

    addCommand(registry, QStringLiteral("sessions:ui-response"),
               [servicesPtr](const QJsonArray &args, std::function<void(QJsonObject)> done) {
                   const QJsonObject input = channels::objectArg(args, 0);
                   if (!input.value(QStringLiteral("sessionId")).isString()
                       || !input.value(QStringLiteral("requestId")).isString()
                       || !input.value(QStringLiteral("agentId")).isString()
                       || !input.value(QStringLiteral("runtimeGeneration")).isDouble()) {
                       throw ChannelError(QStringLiteral("Invalid session UI response"));
                   }
                   coordinatorOf(*servicesPtr).uiResponse(input, std::move(done));
               });
}
