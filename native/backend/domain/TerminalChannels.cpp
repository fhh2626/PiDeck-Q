#include "ChannelContext.h"

#include "terminal/TerminalManager.h"

#include <QJsonArray>

namespace {

terminal::Manager *requireManager(const ChannelServices &services)
{
    if (!services.terminals) throw ChannelError(QStringLiteral("terminal manager is unavailable"));
    return services.terminals;
}

/** A target must be an object; a bare string is not a fallback to a default shell. */
QJsonObject requireTarget(const QJsonArray &args)
{
    const QJsonValue value = channels::argAt(args, 0);
    if (!value.isObject()) throw ChannelError(QStringLiteral("Terminal target is required"));
    return value.toObject();
}

} // namespace

/**
 * `terminal:*` channels.
 *
 * Signatures follow src/main/ipc/terminalIpc.ts: every target-taking channel receives a
 * `TerminalTarget`, and the renderer never supplies an executable or argv. `terminal:data`
 * and `terminal:exit` are events owned by terminal::Manager, not channels.
 */
void registerTerminalChannels(ChannelRegistry &registry, ChannelServices &services)
{
    registry.add(QStringLiteral("terminal:list"), [&services](const QJsonArray &args) {
        return requireManager(services)->list(requireTarget(args));
    });

    registry.add(QStringLiteral("terminal:ensure"), [&services](const QJsonArray &args) {
        return requireManager(services)->ensure(requireTarget(args));
    });

    registry.add(QStringLiteral("terminal:create"), [&services](const QJsonArray &args) {
        // The optional second argument is the shell id from the dock's shell menu; it is
        // validated against the discovered candidate list, never used as a command.
        return requireManager(services)->create(requireTarget(args), channels::stringArg(args, 1));
    });

    registry.add(QStringLiteral("terminal:input"), [&services](const QJsonArray &args) {
        requireManager(services)->input(channels::stringArg(args, 0), channels::stringArg(args, 1));
        return QJsonValue(QJsonValue::Null);
    });

    registry.add(QStringLiteral("terminal:resize"), [&services](const QJsonArray &args) {
        requireManager(services)->resize(channels::stringArg(args, 0), channels::intArg(args, 1),
                                         channels::intArg(args, 2));
        return QJsonValue(QJsonValue::Null);
    });

    registry.add(QStringLiteral("terminal:close"), [&services](const QJsonArray &args) {
        requireManager(services)->close(channels::stringArg(args, 0));
        return QJsonValue(QJsonValue::Null);
    });

    registry.add(QStringLiteral("terminal:shells"), [&services](const QJsonArray &) {
        return requireManager(services)->shells();
    });
}
