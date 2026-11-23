#include "RuntimeCoordinator.h"
#include "SessionCatalogStore.h"
#include "EventHub.h"
#include "JsonFile.h"
#include "ModelConfigurationChanges.h"
#include "SessionIdentity.h"

#include <QDir>
#include <exception>
#include <optional>

namespace runtime {
namespace {

/** A missing default inherits from the global file; an explicit empty string blocks fallback. */
std::optional<QString> modelDefault(const QString &path)
{
    QJsonValue parsed;
    if (jsonfile::readJson(path, &parsed, nullptr) != jsonfile::ReadState::Ok || !parsed.isObject()) return {};
    const QJsonValue value = parsed.toObject().value(QStringLiteral("defaultModel"));
    if (!value.isString()) return {};
    return value.toString();
}

} // namespace

void Coordinator::modelConfigurationChanged(const modelconfig::Scope &scope, const QJsonArray &modified, const QJsonArray &removed,
                                            const QJsonArray &authProviders, const QJsonArray &available)
{
    QJsonArray affected = modified;
    for (const QJsonValue &model : removed) affected.append(model);
    if (affected.isEmpty() && authProviders.isEmpty() && available.isEmpty()) return;
    const QString namespaceKey = sessionidentity::environmentScopeKey(scope.environment, scope.wslDistro, scope.wslUser);
    std::exception_ptr persistenceFailure;
    // Pi's current RPC surface exposes startup snapshots only. Preserve an active
    // turn, but require the existing per-agent restart flow before the next model use.
    for (const auto &owned : m_agents) {
        AgentSession *current = owned.second.get();
        if (!current->running() || sessionidentity::environmentScopeKey(current->tab().sessionEnvironment,
            current->tab().wslDistro, current->tab().wslUser) != namespaceKey) continue;
        // Activation and restart spawn pi before binding it. Those startup snapshots
        // are equally old, even while get_state or history loading is still pending.
        current->invalidateModelConfiguration(affected, authProviders, removed, available);
        const QString sessionId = current->tab().deckSessionId;
        CatalogEntry entry;
        const QJsonObject observed = current->observedModel();
        if (m_deps.services && m_deps.services->catalog
            && m_deps.services->catalog->get(sessionId, &entry) && !entry.hasModel
            && current->wasModelRemoved(observed.value(QStringLiteral("provider")).toString(),
                                        observed.value(QStringLiteral("id")).toString())) {
            // Old catalog entries can have no explicit model while pi has selected
            // one. Preserve an empty choice so a restart cannot silently choose another.
            try {
                m_deps.services->catalog->update(sessionId, QJsonObject{{QStringLiteral("model"),
                    QJsonObject{{QStringLiteral("provider"), QString()}, {QStringLiteral("modelId"), QString()}}}});
                if (m_deps.services->events) {
                    m_deps.services->events->broadcast(QStringLiteral("sessions:catalog-refreshed"),
                        QJsonArray{QJsonObject{{QStringLiteral("projectId"), entry.projectId}}});
                }
            } catch (...) {
                // A failed catalog write must not stop invalidation of the remaining
                // processes. Report the I/O failure after every runtime has been fenced.
                if (!persistenceFailure) persistenceFailure = std::current_exception();
            }
        }
    }
    if (persistenceFailure) std::rethrow_exception(persistenceFailure);
}

QString Coordinator::modelSelectionError(const QString &sessionId) const
{
    CatalogEntry entry;
    const bool hasEntry = m_deps.services && m_deps.services->catalog
        && m_deps.services->catalog->get(sessionId, &entry);
    if (hasEntry && entry.hasModel && (entry.modelProvider.isEmpty() || entry.modelId.isEmpty())) {
        return QStringLiteral("app.modelSelectionRequired");
    }
    if (hasEntry && entry.hasModel && m_deps.services->catalog->isModelRemoved(
            entry.environment, entry.wslDistro, entry.wslUser, entry.modelProvider, entry.modelId)) {
        // The saved model file can change even when persisting the empty preference
        // fails. That I/O error must never authorize a cold runtime's fallback model.
        return QStringLiteral("app.modelSelectionRequired");
    }
    const AgentSession *current = agent(m_bindings.agentForSession(sessionId));
    const QJsonObject observed = current ? current->observedModel() : QJsonObject{};
    const bool hasLiveModel = current && current->running()
        && !observed.value(QStringLiteral("provider")).toString().isEmpty()
        && !observed.value(QStringLiteral("id")).toString().isEmpty();
    if (hasEntry && !entry.hasModel && !hasLiveModel) {
        const modelconfig::Scope scope = modelconfig::activeScope(*m_deps.services);
        // Old catalog entries can inherit defaults without saving a model identity.
        // Apply only the matching configuration environment and let project settings
        // override global defaults, as pi does when it starts a fresh process.
        if (sessionidentity::environmentScopeKey(entry.environment, entry.wslDistro, entry.wslUser)
            == sessionidentity::environmentScopeKey(scope.environment, scope.wslDistro, scope.wslUser)) {
            const QString projectPath = resolveProjectPath(entry.projectId);
            std::optional<QString> effectiveDefault;
            if (!projectPath.isEmpty()) effectiveDefault = modelDefault(QDir(projectPath).filePath(QStringLiteral(".pi/settings.json")));
            if (!effectiveDefault) effectiveDefault = modelDefault(QDir(m_deps.services->configDir).filePath(QStringLiteral("settings.json")));
            if (effectiveDefault && effectiveDefault->isEmpty()) return QStringLiteral("app.modelSelectionRequired");
        }
    }
    const QString provider = entry.hasModel ? entry.modelProvider
        : current ? current->observedModel().value(QStringLiteral("provider")).toString() : QString();
    const QString modelId = entry.hasModel ? entry.modelId
        : current ? current->observedModel().value(QStringLiteral("id")).toString() : QString();
    if (current && current->hasStaleModelConfiguration(provider, modelId)) {
        return QStringLiteral("app.modelConfigurationReloadRequired");
    }
    if (current) {
        const QString actualProvider = observed.value(QStringLiteral("provider")).toString();
        const QString actualModelId = observed.value(QStringLiteral("id")).toString();
        // A busy-session choice is stored before pi applies it. Both the pending
        // preference and the model that would actually receive a prompt must be valid.
        if (current->wasModelRemoved(actualProvider, actualModelId)) return QStringLiteral("app.modelSelectionRequired");
        if (current->hasStaleModelConfiguration(actualProvider, actualModelId)) return QStringLiteral("app.modelConfigurationReloadRequired");
    }
    return {};
}

} // namespace runtime
