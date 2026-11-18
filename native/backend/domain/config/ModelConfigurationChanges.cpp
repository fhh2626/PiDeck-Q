#include "ModelConfigurationChanges.h"

#include "ChannelContext.h"
#include "ConfigFiles.h"
#include "EventHub.h"
#include "JsonFile.h"
#include "ProjectStore.h"
#include "SessionCatalogStore.h"
#include "SessionIdentity.h"
#include "SettingsCatalog.h"
#include "VisionBridge.h"
#include "../../app/WslController.h"
#include "../runtime/RuntimeCoordinator.h"
#include "../wsl/WslEnvironment.h"

#include <QDir>
#include <QJsonArray>
#include <QMap>
#include <QSet>
#include <QStringList>
#include <exception>

namespace modelconfig {
namespace {

using Models = QMap<QString, QJsonObject>;

/** Match saveModels' API normalization so a default or legacy alias does not invalidate a live model. */
QJsonObject providerSettings(const QJsonValue &value)
{
    if (!value.isObject()) return {};
    QJsonObject settings = value.toObject();
    settings.remove(QStringLiteral("models"));
    settings.insert(QStringLiteral("api"),
                    configfiles::normalizeApiType(settings.value(QStringLiteral("api")).toString()));
    return settings;
}

/** Include provider fields in the fingerprint so endpoint and credential edits reach live agents. */
Models definitions(const QJsonValue &value)
{
    Models result;
    const QJsonObject providers = value.toObject().value(QStringLiteral("providers")).toObject();
    for (auto provider = providers.constBegin(); provider != providers.constEnd(); ++provider) {
        const QJsonObject settings = providerSettings(provider.value());
        const QJsonArray models = provider.value().toObject().value(QStringLiteral("models")).toArray();
        for (const QJsonValue &item : models) {
            QJsonObject model = item.toObject();
            const QJsonValue api = model.value(QStringLiteral("api"));
            if (api.isString()) model.insert(QStringLiteral("api"), configfiles::normalizeApiType(api.toString()));
            const QString id = model.value(QStringLiteral("id")).toString();
            if (id.isEmpty()) continue;
            result.insert(provider.key() + QChar(0) + id,
                          QJsonObject{{QStringLiteral("provider"), provider.key()},
                                      {QStringLiteral("modelId"), id},
                                      {QStringLiteral("definition"), model},
                                      {QStringLiteral("settings"), settings}});
        }
    }
    return result;
}

/** Wire payloads contain identity only. Model definitions can contain API credentials. */
QJsonObject identity(const QJsonObject &definition)
{
    return QJsonObject{{QStringLiteral("provider"), definition.value(QStringLiteral("provider"))},
                       {QStringLiteral("modelId"), definition.value(QStringLiteral("modelId"))}};
}

bool matches(const QString &provider, const QString &model, const QJsonArray &removed,
             const Models &remaining)
{
    if (model.isEmpty()) return false;
    for (const QJsonValue &item : removed) {
        const QJsonObject ref = item.toObject();
        const QString source = ref.value(QStringLiteral("provider")).toString();
        const QString id = ref.value(QStringLiteral("modelId")).toString();
        if (!provider.isEmpty()) {
            if (provider == source && (model == id || model == source + QLatin1Char('/') + id)) return true;
            continue;
        }
        if (model == source + QLatin1Char('/') + id) return true;
        if (model != id) continue;
        // Old hand-written defaults can omit the provider. Do not erase an ambiguous
        // bare model id while another configured provider still owns that id.
        bool ambiguous = false;
        for (const QJsonObject &candidate : remaining) {
            if (candidate.value(QStringLiteral("modelId")).toString() == id) ambiguous = true;
        }
        if (!ambiguous) return true;
    }
    return false;
}

void writeObject(const QString &path, const QJsonObject &value)
{
    QString error;
    if (!jsonfile::writeJsonAtomic(path, value, &error)) throw ChannelError(error);
}

/** Unreadable unrelated preferences must survive and must not block model cache invalidation. */
bool readObject(const QString &path, QJsonObject *value)
{
    QJsonValue parsed;
    QString error;
    const auto state = jsonfile::readJson(path, &parsed, &error);
    if (state == jsonfile::ReadState::Missing) return false;
    if (state != jsonfile::ReadState::Ok || !parsed.isObject()) return false;
    *value = parsed.toObject();
    return true;
}

bool clearDefault(QJsonObject *settings, const QJsonArray &removed, const Models &remaining)
{
    if (!matches(settings->value(QStringLiteral("defaultProvider")).toString(),
                 settings->value(QStringLiteral("defaultModel")).toString(), removed, remaining)) return false;
    // Explicit empty fields distinguish a deleted choice from a never-configured
    // default. They must not silently select a different provider on the next send.
    settings->insert(QStringLiteral("defaultProvider"), QString());
    settings->insert(QStringLiteral("defaultModel"), QString());
    return true;
}

void clearPiSettings(const QString &path, const QJsonArray &removed, const Models &remaining,
                     bool clearMainDefault = true)
{
    QJsonObject settings;
    if (!readObject(path, &settings)) return;
    bool changed = clearMainDefault && clearDefault(&settings, removed, remaining);
    QJsonObject subagents = settings.value(QStringLiteral("subagents")).toObject();
    if (clearDefault(&subagents, removed, remaining)) {
        settings.insert(QStringLiteral("subagents"), subagents);
        changed = true;
    }
    if (changed) writeObject(path, settings);
}

bool projectUsesConfigurationScope(QString path, const Scope &scope)
{
    if (scope.environment != QLatin1String("wsl")) return true;
    path.replace(QLatin1Char('\\'), QLatin1Char('/'));
    // Project defaults belong to the physical folder. A WSL share identifies its
    // distro, while ordinary host folders can be shared by multiple runtimes.
    const QStringList roots{wsl::defaultUncRoot(), QStringLiteral("//wsl.localhost"), QStringLiteral("//wsl$")};
    for (QString root : roots) {
        root.replace(QLatin1Char('\\'), QLatin1Char('/'));
        while (root.endsWith(QLatin1Char('/'))) root.chop(1);
        const QString prefix = root + QLatin1Char('/');
        if (!path.startsWith(prefix, Qt::CaseInsensitive)) continue;
        return path.mid(prefix.size()).section(QLatin1Char('/'), 0, 0)
            .compare(scope.wslDistro.trimmed(), Qt::CaseInsensitive) == 0;
    }
    return true;
}

void clearStoredReferences(ChannelServices &services, const Scope &scope, const QJsonArray &removed, const Models &remaining)
{
    if (removed.isEmpty()) return;
    QStringList failures;
    const auto attempt = [&failures](const auto &action) {
        try { action(); }
        catch (const std::exception &error) { failures.append(QString::fromUtf8(error.what())); }
    };
    const QString activeSettingsPath = QDir(services.configDir).filePath(QStringLiteral("settings.json"));
    const QString hostSettingsPath = QDir(services.agentDir).filePath(QStringLiteral("settings.json"));
    QSet<QString> settingsPaths{activeSettingsPath};
    const QJsonObject appSettings = readSettingsCatalog(
        QDir(services.userDataDir).filePath(QStringLiteral("settings.json")), services.agentDir).settings;
    if (services.projects) {
        // Settings can already request another environment while its probe is pending.
        // Preference cleanup follows the directory that was actually saved.
        QJsonObject projectVisibility = appSettings;
        projectVisibility.insert(QStringLiteral("wslEnabled"), scope.environment == QLatin1String("wsl"));
        for (const QJsonValue &value : services.projects->visibleRecords(projectVisibility)) {
            const QString path = value.toObject().value(QStringLiteral("path")).toString();
            if (!path.isEmpty() && projectUsesConfigurationScope(path, scope)) {
                settingsPaths.insert(QDir(path).filePath(QStringLiteral(".pi/settings.json")));
            }
        }
    }
    for (const QString &path : settingsPaths) attempt([&]() { clearPiSettings(path, removed, remaining); });
    // Subagent preferences are currently host-owned even in WSL mode. The host's
    // ordinary default remains independent from the active WSL configuration.
    if (hostSettingsPath != activeSettingsPath) {
        attempt([&]() { clearPiSettings(hostSettingsPath, removed, remaining, false); });
    }

    QJsonObject patch;
    if (matches(appSettings.value(QStringLiteral("gitCommitMessageProvider")).toString(),
                appSettings.value(QStringLiteral("gitCommitMessageModel")).toString(), removed, remaining)) {
        patch.insert(QStringLiteral("gitCommitMessageProvider"), QString());
        patch.insert(QStringLiteral("gitCommitMessageModel"), QString());
    }
    QJsonArray favorites;
    const QJsonArray previousFavorites = appSettings.value(QStringLiteral("favoriteModels")).toArray();
    for (const QJsonValue &value : previousFavorites) {
        if (!matches(QString(), value.toString(), removed, remaining)) favorites.append(value);
    }
    if (favorites != previousFavorites) patch.insert(QStringLiteral("favoriteModels"), favorites);
    if (!patch.isEmpty()) {
        attempt([&]() {
            const auto result = updateSettingsCatalog(
                QDir(services.userDataDir).filePath(QStringLiteral("settings.json")), patch, services.agentDir);
            if (!result.ok) throw ChannelError(result.error);
        });
    }

    const QString visionPath = QDir(vision::configDir(services.agentDir)).filePath(QStringLiteral("pi-deck-vision.json"));
    QJsonObject visionConfig;
    if (readObject(visionPath, &visionConfig)
        && matches(visionConfig.value(QStringLiteral("provider")).toString(),
                   visionConfig.value(QStringLiteral("model")).toString(), removed, remaining)) {
        visionConfig.insert(QStringLiteral("provider"), QString());
        visionConfig.insert(QStringLiteral("model"), QString());
        // Connection overrides belong to the removed provider. Keeping them would
        // send a replacement model's requests to the old endpoint with its credentials.
        visionConfig.remove(QStringLiteral("api"));
        visionConfig.remove(QStringLiteral("baseUrl"));
        visionConfig.remove(QStringLiteral("apiKey"));
        // Preserve the enabled flag so an attempted conversion reports the missing
        // choice instead of silently turning the feature off.
        attempt([&]() { writeObject(visionPath, visionConfig); });
    }

    if (!services.catalog) {
        if (!failures.isEmpty()) throw ChannelError(failures.join(QLatin1Char('\n')));
        return;
    }
    const QString namespaceKey = sessionidentity::environmentScopeKey(scope.environment, scope.wslDistro, scope.wslUser);
    QSet<QString> changedProjects;
    for (const CatalogEntry &entry : services.catalog->listEntries()) {
        if (sessionidentity::environmentScopeKey(entry.environment, entry.wslDistro, entry.wslUser) != namespaceKey || !entry.hasModel
            || !matches(entry.modelProvider, entry.modelId, removed, remaining)) continue;
        attempt([&]() {
            services.catalog->update(entry.id, QJsonObject{{QStringLiteral("model"),
                QJsonObject{{QStringLiteral("provider"), QString()}, {QStringLiteral("modelId"), QString()}}}});
        });
        changedProjects.insert(entry.projectId);
    }
    if (services.events) {
        for (const QString &project : changedProjects) {
            services.events->broadcast(QStringLiteral("sessions:catalog-refreshed"),
                QJsonArray{QJsonObject{{QStringLiteral("projectId"), project}}});
        }
    }
    if (!failures.isEmpty()) throw ChannelError(failures.join(QLatin1Char('\n')));
}

} // namespace

Scope activeScope(const ChannelServices &services)
{
    Scope scope;
    // The requested settings/context can already name a new distro while its probe
    // is pending. The published environment owns the file that this save actually changed.
    if (services.wsl && services.wsl->current().isValid()) {
        scope.environment = QStringLiteral("wsl");
        scope.wslDistro = services.wsl->current().distro;
        scope.wslUser = services.wsl->current().user;
    }
    return scope;
}

QJsonValue snapshot(const ChannelServices &services)
{
    const auto read = configfiles::read(services.configDir, QStringLiteral("models.json"), QJsonObject{});
    return read.hasDiagnostic || read.readError ? QJsonValue(QJsonObject{}) : read.parsed;
}

QJsonValue authSnapshot(const ChannelServices &services)
{
    const auto read = configfiles::read(services.configDir, QStringLiteral("auth.json"), QJsonObject{});
    return read.hasDiagnostic || read.readError ? QJsonValue(QJsonObject{}) : read.parsed;
}

void saved(ChannelServices &services, const QJsonValue &previousModels, const QJsonValue &previousAuth)
{
    const Scope scope = activeScope(services);
    const Models previous = definitions(previousModels);
    const QJsonValue currentModels = snapshot(services);
    const Models current = definitions(currentModels);
    QJsonArray removed;
    QJsonArray changed;
    QJsonArray modified;
    for (auto item = previous.constBegin(); item != previous.constEnd(); ++item) {
        if (!current.contains(item.key())) removed.append(identity(item.value()));
    }
    for (auto item = current.constBegin(); item != current.constEnd(); ++item) {
        if (!previous.contains(item.key()) || previous.value(item.key()) != item.value()) {
            changed.append(identity(item.value()));
            if (previous.contains(item.key())) modified.append(identity(item.value()));
        }
    }
    QJsonArray authProviders;
    const QJsonObject previousProviders = previousModels.toObject().value(QStringLiteral("providers")).toObject();
    const QJsonObject currentProviders = currentModels.toObject().value(QStringLiteral("providers")).toObject();
    QSet<QString> providerNames;
    for (const QString &name : previousProviders.keys()) providerNames.insert(name);
    for (const QString &name : currentProviders.keys()) providerNames.insert(name);
    for (const QString &name : providerNames) {
        const QJsonObject before = providerSettings(previousProviders.value(name));
        const QJsonObject after = providerSettings(currentProviders.value(name));
        // Provider overrides also affect built-in models not enumerated in models[].
        // Appending a model leaves these objects equal and cannot disturb other users.
        if (before != after) authProviders.append(name);
    }
    if (!previousAuth.isUndefined()) {
        const QJsonObject before = previousAuth.toObject();
        const QJsonObject after = authSnapshot(services).toObject();
        QSet<QString> providers;
        for (const QString &key : before.keys()) providers.insert(key);
        for (const QString &key : after.keys()) providers.insert(key);
        for (const QString &provider : providers) {
            if (before.value(provider) != after.value(provider) && !authProviders.contains(provider)) authProviders.append(provider);
        }
    }
    // The model file has already been saved. A failed preference write must not leave
    // a successful configuration change hidden behind the old discovery/runtime cache.
    std::exception_ptr cleanupFailure;
    if (services.catalog) {
        services.catalog->recordModelConfigurationChange(scope.environment, scope.wslDistro, scope.wslUser, removed, changed);
    }
    try { clearStoredReferences(services, scope, removed, current); }
    catch (...) { cleanupFailure = std::current_exception(); }
    if (services.runtimeCoordinator) {
        try { services.runtimeCoordinator->modelConfigurationChanged(scope, modified, removed, authProviders, changed); }
        catch (...) { if (!cleanupFailure) cleanupFailure = std::current_exception(); }
    }
    QJsonObject event{{QStringLiteral("environment"), scope.environment},
                      {QStringLiteral("removedModels"), removed}, {QStringLiteral("changedModels"), changed}};
    if (scope.environment == QLatin1String("wsl")) {
        event.insert(QStringLiteral("wslDistro"), scope.wslDistro);
        event.insert(QStringLiteral("wslUser"), scope.wslUser);
    }
    publishModelList(services, event);
    if (cleanupFailure) std::rethrow_exception(cleanupFailure);
}

} // namespace modelconfig
