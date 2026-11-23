#include "ChannelContext.h"

#include "VisionBridge.h"
#include "ModelConfigurationChanges.h"
#include "SessionCatalogStore.h"

#include <QJsonArray>
#include <QJsonObject>

void registerVisionChannels(ChannelRegistry &registry, ChannelServices &services)
{
    registry.add(QStringLiteral("vision:get-config"), [&services](const QJsonArray &) {
        return QJsonValue(vision::state(services.agentDir));
    });

    registry.add(QStringLiteral("vision:save-config"), [&services](const QJsonArray &args) {
        const QJsonObject config = channels::argAt(args, 0).toObject();
        const modelconfig::Scope scope = modelconfig::activeScope(services);
        if (services.catalog && services.catalog->isModelRemoved(scope.environment, scope.wslDistro, scope.wslUser,
            config.value(QStringLiteral("provider")).toString().trimmed(), config.value(QStringLiteral("model")).toString().trimmed())) {
            const QString key = QStringLiteral("app.visionModelSelectionRequired");
            return QJsonValue(QJsonObject{{QStringLiteral("ok"), false}, {QStringLiteral("i18nKey"), key},
                {QStringLiteral("error"), services.translate(key, QJsonObject{})}});
        }
        // The manager whitelists every field; the renderer payload is never trusted.
        return QJsonValue(vision::saveConfig(services.agentDir, channels::argAt(args, 0),
                                             services.agentDir));
    });

    registry.add(QStringLiteral("vision:get-log"), [&services](const QJsonArray &) {
        return QJsonValue(vision::log(services.agentDir));
    });

    registry.add(QStringLiteral("vision:get-events"), [&services](const QJsonArray &) {
        return QJsonValue(vision::events(services.agentDir));
    });

    registry.add(QStringLiteral("vision:clear-events"), [&services](const QJsonArray &) {
        return QJsonValue(vision::clearEvents(services.agentDir));
    });

    registry.add(QStringLiteral("vision:clear-log"), [&services](const QJsonArray &) {
        return QJsonValue(vision::clearLog(services.agentDir));
    });
}
