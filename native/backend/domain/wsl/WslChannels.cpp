#include "ChannelContext.h"

#include "BackgroundWork.h"
#include "WslExec.h"

#include <QJsonArray>

void registerWslChannels(ChannelRegistry &registry, ChannelServices &services)
{
    // Every `wsl.exe` call blocks (10 s timeout per probe), so both channels answer from
    // the serial executor and the renderer keeps a responsive event loop.
    registry.addAsync(QStringLiteral("wsl:list-distros"),
                      [&services](const QJsonArray &, ChannelResponder responder) {
        background::runBlocking(
            [&services]() -> QJsonValue {
                return QJsonValue(QJsonArray::fromStringList(wsl::listDistros(services)));
            },
            [responder](const background::Outcome &outcome) mutable {
                // The oracle swallows every wsl failure into an empty list.
                if (!outcome.ok) return responder.resolve(QJsonValue(QJsonArray{}));
                responder.resolve(outcome.value);
            });
    });

    registry.addAsync(QStringLiteral("wsl:validate-connection"),
                      [&services](const QJsonArray &args, ChannelResponder responder) {
        const QString distro = channels::stringArg(args, 0);
        const QString user = channels::stringArg(args, 1);
        background::runBlocking(
            [&services, distro, user]() -> QJsonValue {
                return QJsonValue(wsl::validateConnection(services, distro, user).toJson());
            },
            [responder](const background::Outcome &outcome) mutable {
                if (!outcome.ok) return responder.reject(outcome.error);
                responder.resolve(outcome.value);
            });
    });
}
