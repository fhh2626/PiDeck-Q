#include "RuntimeCoordinator.h"

#include "../sessions/SessionCatalogStore.h"
#include "../sessions/SessionTreeGuard.h"

namespace runtime {

QVector<sessiontreeguard::LiveAgent> Coordinator::liveTreeAgents() const
{
    QVector<sessiontreeguard::LiveAgent> agents;
    agents.reserve(int(m_agents.size()));
    for (const auto &entry : m_agents) {
        const AgentSession *session = entry.second.get();
        // A reconnect has no live transport yet but still reserves its reported file,
        // which can differ from a catalog path not updated before the process exited.
        if (!session || (!session->running() && !m_reattachAttempts.contains(entry.first))) continue;
        const Tab &tab = session->tab();
        if (tab.noSession && tab.sessionPath.isEmpty()) continue;
        sessiontreeguard::LiveAgent agent;
        agent.title = tab.title;
        agent.sessionPath = tab.sessionPath;
        agent.environment = tab.sessionEnvironment;
        agent.wslDistro = tab.wslDistro;
        agent.wslUser = tab.wslUser;
        agents.append(agent);
    }
    return agents;
}

QJsonObject Coordinator::findSessionTreeBlock(const QString &sessionId) const
{
    if (deletionBlocks(sessionId)) {
        return QJsonObject{{QStringLiteral("kind"), QStringLiteral("deleting")},
                           {QStringLiteral("sessionId"), sessionId}};
    }
    if (!m_deps.services || !m_deps.services->catalog) {
        // No catalog owner: only the single-runtime guard can answer, and it can only
        // report "this session is running".
        if (!isSessionBusy(sessionId)) return QJsonObject{};
        return QJsonObject{{QStringLiteral("kind"), QStringLiteral("session-busy")},
                           {QStringLiteral("sessionId"), sessionId}};
    }
    CatalogEntry root;
    if (!m_deps.services->catalog->get(sessionId, &root)) {
        // Unknown ids are not "blocked"; the mutation handler reports its own not-found.
        return QJsonObject{};
    }
    const sessiontreeguard::Block block =
        sessiontreeguard::findBlock(root, m_deps.services->catalog->listEntries(), liveTreeAgents(),
                                    [this](const QString &id) { return isSessionBusy(id); });
    if (block.kind == sessiontreeguard::Block::SessionBusy) {
        return QJsonObject{{QStringLiteral("kind"), QStringLiteral("session-busy")},
                           {QStringLiteral("sessionId"), block.sessionId}};
    }
    if (block.kind == sessiontreeguard::Block::FileInUse) {
        return QJsonObject{{QStringLiteral("kind"), QStringLiteral("file-in-use")},
                           {QStringLiteral("agentTitle"), block.agentTitle}};
    }
    return QJsonObject{};
}

bool Coordinator::isSessionTreeBusy(const QString &sessionId) const
{
    return !findSessionTreeBlock(sessionId).isEmpty();
}

} // namespace runtime
