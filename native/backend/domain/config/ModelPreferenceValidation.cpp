#include "ModelPreferenceValidation.h"

#include "ChannelContext.h"
#include "ModelConfigurationChanges.h"
#include "SessionCatalogStore.h"
#include "SettingsCatalog.h"

#include <QJsonArray>
#include <QJsonDocument>

namespace modelconfig {
namespace {

bool restored(const QJsonValue &models, const QString &provider, const QString &modelId, bool allowQualifiedAlias = true)
{
    const QJsonArray definitions = models.toObject().value(QStringLiteral("providers")).toObject()
        .value(provider).toObject().value(QStringLiteral("models")).toArray();
    for (const QJsonValue &value : definitions) {
        const QString id = value.toObject().value(QStringLiteral("id")).toString();
        if (!id.isEmpty() && (modelId == id || (allowQualifiedAlias && modelId == provider + QLatin1Char('/') + id))) return true;
    }
    return false;
}

bool hasRemovedDefault(const ChannelServices &services, const QJsonObject &settings, const QJsonValue &restoredModels)
{
    const QString provider = settings.value(QStringLiteral("defaultProvider")).toString().trimmed();
    const QString modelId = settings.value(QStringLiteral("defaultModel")).toString().trimmed();
    if (provider.isEmpty()) {
        if (!services.catalog) return false;
        const Scope scope = activeScope(services);
        // A complete provider/model reference is valid without defaultProvider.
        // Resolve it only against confirmed deletions, preserving independent bare ids
        // and ids containing slashes whose prefix does not name a removed provider.
        for (qsizetype slash = modelId.indexOf(QLatin1Char('/')); slash > 0;
             slash = modelId.indexOf(QLatin1Char('/'), slash + 1)) {
            const QString source = modelId.left(slash);
            const QString id = modelId.mid(slash + 1);
            if (services.catalog->isModelRemoved(scope.environment, scope.wslDistro, scope.wslUser, source, id)
                && !restored(restoredModels, source, id, false)) return true;
        }
        return false;
    }
    return isRemoved(services, provider, modelId) && !restored(restoredModels, provider, modelId);
}

} // namespace

bool isRemoved(const ChannelServices &services, const QString &provider, const QString &modelId)
{
    if (!services.catalog) return false;
    const QString source = provider.trimmed();
    const QString id = modelId.trimmed();
    if (source.isEmpty() || id.isEmpty()) return false;
    const Scope scope = activeScope(services);
    const auto removed = [&](const QString &candidate) {
        return services.catalog->isModelRemoved(scope.environment, scope.wslDistro, scope.wslUser, source, candidate);
    };
    if (removed(id)) return true;
    const QString prefix = source + QLatin1Char('/');
    return id.startsWith(prefix) && removed(id.mid(prefix.size()));
}

configfiles::Validation validateSettingsSelection(const ChannelServices &services, const QJsonValue &settings,
                                                  const QJsonValue &restoredModels)
{
    const QJsonObject object = settings.toObject();
    if (hasRemovedDefault(services, object, restoredModels)
        || hasRemovedDefault(services, object.value(QStringLiteral("subagents")).toObject(), restoredModels)) {
        return {false, services.translate(QStringLiteral("app.modelSelectionRequired"), QJsonObject{}), {}};
    }
    return {true, {}, {}};
}

configfiles::Validation validateRawSettingsSelection(const ChannelServices &services, const QString &fileName,
                                                     const QString &rawJson)
{
    if (fileName != QLatin1String("settings.json")) return {true, {}, {}};
    // The ordinary writer owns syntax errors and non-object JSON behavior.
    return validateSettingsSelection(services, QJsonDocument::fromJson(rawJson.toUtf8()).object());
}

configfiles::Validation validateImportedSettingsSelection(const ChannelServices &services, const QString &packageJson)
{
    const QJsonObject files = QJsonDocument::fromJson(packageJson.toUtf8()).object().value(QStringLiteral("files")).toObject();
    return validateSettingsSelection(services, files.value(QStringLiteral("settings.json")),
                                      files.value(QStringLiteral("models.json")));
}

SettingsCatalogRead updateDesktopSettings(const ChannelServices &services, const QString &filePath, QJsonObject patch)
{
    const QString providerKey = QStringLiteral("gitCommitMessageProvider");
    const QString modelKey = QStringLiteral("gitCommitMessageModel");
    if (patch.contains(providerKey) || patch.contains(modelKey)) {
        const SettingsCatalogRead current = readSettingsCatalogSnapshot(filePath, services.agentDir);
        if (!current.ok) return current;
        // A partial patch can combine with the persisted half of the identity. Check
        // that effective choice before writing, then return the same cleared values to UI.
        const QJsonObject choice{{QStringLiteral("defaultProvider"), patch.contains(providerKey)
            ? patch.value(providerKey) : current.settings.value(providerKey)},
            {QStringLiteral("defaultModel"), patch.contains(modelKey)
            ? patch.value(modelKey) : current.settings.value(modelKey)}};
        if (hasRemovedDefault(services, choice, {})) {
            patch.insert(providerKey, QString());
            patch.insert(modelKey, QString());
        }
    }
    const QString favoriteKey = QStringLiteral("favoriteModels");
    if (patch.value(favoriteKey).isArray()) {
        QJsonArray favorites;
        for (const QJsonValue &value : patch.value(favoriteKey).toArray()) {
            if (!hasRemovedDefault(services, QJsonObject{{QStringLiteral("defaultModel"), value}}, {})) {
                favorites.append(value);
            }
        }
        patch.insert(favoriteKey, favorites);
    }
    return updateSettingsCatalog(filePath, patch, services.agentDir);
}

} // namespace modelconfig
