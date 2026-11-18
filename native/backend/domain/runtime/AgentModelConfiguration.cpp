#include "AgentSession.h"

namespace agentruntime {

void AgentSession::invalidateModelConfiguration(const QJsonArray &models, const QJsonArray &providers,
                                                const QJsonArray &removed, const QJsonArray &available)
{
    if (m_modelConfigurationEpoch != m_clientEpoch) {
        m_staleModels.clear();
        m_staleModelProviders.clear();
        m_removedModels.clear();
        m_modelConfigurationEpoch = m_clientEpoch;
    }
    for (const QJsonValue &value : models) {
        const QJsonObject model = value.toObject();
        m_staleModels.insert(model.value(QStringLiteral("provider")).toString()
            + QChar(0) + model.value(QStringLiteral("modelId")).toString());
    }
    for (const QJsonValue &value : providers) m_staleModelProviders.insert(value.toString());
    for (const QJsonValue &value : removed) {
        const QJsonObject model = value.toObject();
        m_removedModels.insert(model.value(QStringLiteral("provider")).toString()
            + QChar(0) + model.value(QStringLiteral("modelId")).toString());
    }
    for (const QJsonValue &value : available) {
        const QJsonObject model = value.toObject();
        // Re-adding an identity restores the restart flow. Its old process snapshot
        // remains stale until a restart, so this must not remove it from m_staleModels.
        m_removedModels.remove(model.value(QStringLiteral("provider")).toString()
            + QChar(0) + model.value(QStringLiteral("modelId")).toString());
    }
}

bool AgentSession::wasModelRemoved(const QString &provider, const QString &modelId) const
{
    return m_modelConfigurationEpoch == m_clientEpoch
        && m_removedModels.contains(provider + QChar(0) + modelId);
}

bool AgentSession::hasStaleModelConfiguration(const QString &provider, const QString &modelId) const
{
    return m_modelConfigurationEpoch == m_clientEpoch
        && (m_staleModelProviders.contains(provider)
            || m_staleModels.contains(provider + QChar(0) + modelId));
}

} // namespace agentruntime
