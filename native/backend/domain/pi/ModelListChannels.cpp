#include "ChannelContext.h"

#include "BackgroundWork.h"
#include "EventHub.h"
#include "ModelListCache.h"

#include <QJsonArray>

void registerModelListChannels(ChannelRegistry &registry, ChannelServices &services)
{
    // `projects:list-models` forks pi when the cache is cold, so the body runs on the
    // serial executor. The oracle wraps everything in try/catch and returns []: a broken
    // pi must leave the composer usable instead of rejecting the picker.
    registry.addAsync(QStringLiteral("projects:list-models"),
                      [&services](const QJsonArray &, ChannelResponder responder) {
        // Snapshot the owner-thread state the body needs before it leaves this thread: the
        // WSL switch rewrites `configDir` on the owner, and the decoration reads models.json
        // from it.
        const QString configDir = services.configDir;
        background::runBlocking(
            [&services, configDir]() -> QJsonValue {
                return QJsonValue(modellist::listModels(services, configDir));
            },
            [responder](const background::Outcome &outcome) mutable {
                if (!outcome.ok) return responder.resolve(QJsonValue(QJsonArray{}));
                responder.resolve(outcome.value);
            });
    });
}

void publishModelList(ChannelServices &services)
{
    // Fire-and-forget, exactly like `publishModelList()`: invalidate, re-probe off the
    // main thread, and only then tell the renderer to re-read. The signal carries no
    // payload because a large model table would bloat the event frame; the renderer
    // calls `projects:list-models` again and hits the fresh cache.
    background::runBlocking(
        [&services]() -> QJsonValue {
            modellist::refresh(services);
            return QJsonValue(QJsonValue::Null);
        },
        [&services](const background::Outcome &outcome) {
            // A failed refresh sends no signal (oracle: `.catch(() => undefined)`).
            if (!outcome.ok) return;
            if (services.events) {
                services.events->broadcast(QStringLiteral("models:changed"), QJsonArray{});
            }
        });
}
