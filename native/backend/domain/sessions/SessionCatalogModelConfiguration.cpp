#include "SessionCatalogStore.h"
#include "SessionIdentity.h"

#include <QMutexLocker>

namespace {

QString modelKey(const QString &provider, const QString &modelId)
{
    return provider + QChar(0) + modelId;
}

} // namespace

void SessionCatalogStore::recordModelConfigurationChange(const QString &environment, const QString &wslDistro,
                                                        const QString &wslUser, const QJsonArray &removed,
                                                        const QJsonArray &available)
{
    QMutexLocker<QRecursiveMutex> lock(&m_mutex);
    QSet<QString> &identities = m_removedModelsByEnvironment[
        sessionidentity::environmentScopeKey(environment, wslDistro, wslUser)];
    for (const QJsonValue &value : removed) {
        const QJsonObject model = value.toObject();
        identities.insert(modelKey(model.value(QStringLiteral("provider")).toString(),
                                   model.value(QStringLiteral("modelId")).toString()));
    }
    for (const QJsonValue &value : available) {
        const QJsonObject model = value.toObject();
        identities.remove(modelKey(model.value(QStringLiteral("provider")).toString(),
                                   model.value(QStringLiteral("modelId")).toString()));
    }
}

bool SessionCatalogStore::isModelRemoved(const QString &environment, const QString &wslDistro,
                                         const QString &wslUser, const QString &provider,
                                         const QString &modelId) const
{
    QMutexLocker<QRecursiveMutex> lock(&m_mutex);
    if (provider.isEmpty() || modelId.isEmpty()) return false;
    const auto found = m_removedModelsByEnvironment.constFind(
        sessionidentity::environmentScopeKey(environment, wslDistro, wslUser));
    return found != m_removedModelsByEnvironment.constEnd()
        && found->contains(modelKey(provider, modelId));
}

bool SessionCatalogStore::clearRemovedModelPreference(CatalogEntry &entry) const
{
    if (!entry.hasModel || !isModelRemoved(entry.environment, entry.wslDistro, entry.wslUser,
                                          entry.modelProvider, entry.modelId)) return false;
    // Keep the explicit empty identity: later activation must ask the user, never select pi's fallback.
    entry.modelProvider.clear();
    entry.modelId.clear();
    return true;
}
