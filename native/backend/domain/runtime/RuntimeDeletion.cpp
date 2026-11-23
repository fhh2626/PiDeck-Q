#include "RuntimeCoordinator.h"

#include "../sessions/SessionCatalogStore.h"
#include "../process/BackgroundWork.h"

#include <utility>

namespace runtime {
namespace {

/** Convert an unbound runtime into the same narrow filesystem identity as catalog rows. */
CatalogEntry liveIdentity(const sessiontreeguard::LiveAgent &agent)
{
    CatalogEntry entry;
    entry.filePath = agent.sessionPath;
    entry.environment = agent.environment;
    entry.wslDistro = agent.wslDistro;
    entry.wslUser = agent.wslUser;
    return entry;
}

/** Fileless in-memory runtimes cannot own a persisted tree. */
bool filelessInMemory(const CatalogEntry &entry)
{
    return entry.noSession && entry.filePath.isEmpty();
}

QJsonObject blocked(const QString &kind, const QString &sessionId = QString())
{
    return {{QStringLiteral("kind"), kind}, {QStringLiteral("sessionId"), sessionId}};
}

} // namespace

bool Coordinator::deletionBlocks(const QString &sessionId) const
{
    if (m_deletingTrees.contains(sessionId)) return true;
    CatalogEntry candidate;
    if (!m_deps.services || !m_deps.services->catalog
        || !m_deps.services->catalog->get(sessionId, &candidate)) {
        // A not-yet-cataloged identity is not proof of non-overlap. This fence lasts
        // only until the in-flight deletion settles, not for an active runtime's life.
        return !m_wslDeletingTrees.isEmpty();
    }
    return deletionBlocksEntry(candidate);
}

bool Coordinator::deletionBlocksEntry(const CatalogEntry &candidate) const
{
    for (const auto &lease : m_wslDeletingTrees) {
        if (lease.blocks(candidate)) return true;
    }
    for (const auto &lease : m_nativeDeletingTrees)
        if (lease.blocks(candidate)) return true;
    return false;
}

bool Coordinator::deletionBlocksLaunch(const CatalogEntry &candidate) const
{
    if (filelessInMemory(candidate)) return false;
    for (const auto &lease : m_wslDeletingTrees)
        if (deletionidentity::sameNamespace(lease.root, candidate)) return true;
    return false;
}

bool Coordinator::deletionBlocksAgent(const QString &agentId) const
{
    const AgentSession *session = agent(agentId);
    if (!session) return false;
    const Tab &tab = session->tab();
    CatalogEntry candidate;
    candidate.filePath = tab.sessionPath;
    candidate.environment = tab.sessionEnvironment;
    candidate.wslDistro = tab.wslDistro;
    candidate.wslUser = tab.wslUser;
    candidate.noSession = tab.noSession;
    return deletionBlocksEntry(candidate);
}

bool Coordinator::deletionBlocksPathChange(const QString &agentId) const
{
    const AgentSession *session = agent(agentId);
    if (!session) return false;
    const Tab &tab = session->tab();
    CatalogEntry candidate;
    candidate.environment = tab.sessionEnvironment;
    candidate.wslDistro = tab.wslDistro;
    for (const CatalogEntry &root : m_deletingTrees) {
        if (root.environment != QLatin1String("wsl")
            && deletionidentity::sameNamespace(root, candidate)) return true;
    }
    for (const auto &lease : m_wslDeletingTrees) {
        // Fork/clone cannot prove their future target before pi performs the write.
        // Refuse that transition for the short mutation lease, while unrelated bound
        // sessions may continue ordinary commands under the resolved scoped lease.
        if (deletionidentity::sameNamespace(lease.root, candidate)) return true;
    }
    return false;
}

QJsonObject Coordinator::wslTransitionBlock(const CatalogEntry &root, const QVector<CatalogEntry> &entries) const
{
    // A provisional lease fences the whole distro, so it must not interrupt an
    // earlier handshake that can still acquire or publish a different file path.
    // Once that handshake settles, ordinary live runtimes use scoped path checks.
    const auto applies = [&root](const CatalogEntry &identity) {
        return !filelessInMemory(identity) && deletionidentity::sameNamespace(root, identity);
    };
    for (const auto &entry : entries) {
        if (!deletionidentity::sameNamespace(root, entry)) continue;
        const QString agentId = m_bindings.agentForSession(entry.id);
        const AgentSession *session = agent(agentId);
        if (m_bindings.isReplacingSession(entry.id) || (applies(entry) && session && reconnectOwnsAgent(agentId, *session)))
            return blocked(QStringLiteral("session-busy"), entry.id);
    }
    for (const auto &launch : m_preparingLaunches) {
        // A draft can select a new distro and has no file to compare yet. A known
        // path still goes through scoped identity resolution before blocking deletion.
        if (launch.actual.filePath.isEmpty() && (applies(launch.entry) || applies(launch.actual)))
            return blocked(QStringLiteral("session-busy"), launch.entry.id);
    }
    // A spawned draft may already be in a different namespace from its catalog row.
    for (const auto &agentEntry : m_agents) {
        const AgentSession &session = *agentEntry.second;
        const Tab &tab = session.tab();
        CatalogEntry identity;
        identity.environment = tab.sessionEnvironment;
        identity.wslDistro = tab.wslDistro;
        identity.noSession = tab.noSession;
        identity.filePath = tab.sessionPath;
        if (!deletionidentity::sameNamespace(root, identity)) continue;
        if (m_bindings.isReplacingSession(tab.deckSessionId)
            || m_bindings.isReplacingSession(m_bindings.sessionForAgent(agentEntry.first))
            || (applies(identity) && (m_bindings.isActivating(tab.deckSessionId)
                                     || reconnectOwnsAgent(agentEntry.first, session))))
            return blocked(QStringLiteral("session-busy"), tab.deckSessionId);
    }
    return {};
}

bool Coordinator::provisionalWslDeletionBlocks(const PreparingLaunch &launch) const
{
    for (const auto &lease : m_wslDeletingTrees) {
        if (lease.provisional && (lease.blocks(launch.entry) || lease.blocks(launch.actual))) return true;
    }
    return false;
}

void Coordinator::resumePreparedLaunches()
{
    const auto preparing = m_preparingLaunches.keys();
    for (const auto &agentId : preparing) {
        auto launch = m_preparingLaunches.find(agentId);
        if (launch == m_preparingLaunches.end() || !launch->resumeAfterResolution
            || provisionalWslDeletionBlocks(*launch)) continue;
        auto resume = std::exchange(launch->resumeAfterResolution, {});
        resume();
    }
}

void Coordinator::reserveDeletionAsync(const CatalogEntry &root, const SessionFs &fs,
                                       std::function<void(const QJsonObject &)> done)
{
    postToOwner([this, root, fs, done = std::move(done)]() mutable {
        const QString sessionId = root.id;
        if (m_shutdown || deletionBlocks(sessionId)) return done(blocked(QStringLiteral("deleting")));
        CatalogEntry current;
        if (!m_deps.services || !m_deps.services->catalog
            || !m_deps.services->catalog->get(sessionId, &current)
            || !deletionidentity::sameTarget(root, current))
            return done(blocked(QStringLiteral("identity-changed")));
        const QJsonObject block = findSessionTreeBlock(sessionId);
        if (!block.isEmpty()) return done(block);
        const auto entries = m_deps.services->catalog->listEntries();
        if (root.environment != QLatin1String("wsl") || root.filePath.isEmpty()) {
            const auto lease = deletionidentity::captureNative(root);
            for (const CatalogEntry &entry : entries) {
                if ((deletionidentity::sameNamespace(root, entry)
                     && m_bindings.isReplacingSession(entry.id))
                    || (lease.blocks(entry) && isSessionBusy(entry.id)))
                    return done(blocked(QStringLiteral("session-busy"), entry.id));
            }
            // A replacement can be live before its catalog binding is published; its
            // destination remains unknown until the replacement handshake completes.
            for (const auto &agentEntry : m_agents) {
                const AgentSession &session = *agentEntry.second;
                const Tab &tab = session.tab();
                CatalogEntry identity;
                identity.filePath = tab.sessionPath;
                identity.environment = tab.sessionEnvironment;
                identity.wslDistro = tab.wslDistro;
                identity.noSession = tab.noSession;
                if (deletionidentity::sameNamespace(root, identity)
                    && (m_bindings.isReplacingSession(tab.deckSessionId)
                        || m_bindings.isReplacingSession(m_bindings.sessionForAgent(agentEntry.first))))
                    return done(blocked(QStringLiteral("session-busy"), tab.deckSessionId));
                // get_state publishes the physical runtime path before projection
                // attaches it to the catalog. Reconnects retain that identity too.
                if ((session.running() || m_reattachAttempts.contains(agentEntry.first)) && lease.blocks(identity)) {
                    QJsonObject result = blocked(QStringLiteral("file-in-use"), tab.deckSessionId);
                    result.insert(QStringLiteral("agentTitle"), tab.title);
                    return done(result);
                }
            }
            m_deletingTrees.insert(sessionId, root);
            m_nativeDeletingTrees.insert(sessionId, lease);
            return done(QJsonObject{});
        }
        if (!fs.wsl() || (!root.wslDistro.isEmpty()
                && root.wslDistro.compare(fs.config().distro, Qt::CaseInsensitive) != 0)
            || (!root.wslUser.isEmpty() && root.wslUser != fs.config().user))
            return done(blocked(QStringLiteral("identity-failed")));

        deletionidentity::Lease lease;
        lease.root = root;
        // Bind empty legacy distro metadata to the captured execution environment.
        lease.root.wslDistro = fs.config().distro;
        const QJsonObject transition = wslTransitionBlock(lease.root, entries);
        if (!transition.isEmpty()) return done(transition);
        // Resolve parents independently both for mutation-entry identity and for
        // runtime traversal links that lead outside the tree they pass through.
        const QStringList reservedPaths = deletionidentity::wslPathsFor(root.filePath);
        QStringList paths = reservedPaths;
        for (const auto &entry : entries) {
            if (deletionidentity::sameNamespace(lease.root, entry))
                paths.append(deletionidentity::wslPathsFor(entry.filePath));
        }
        for (const auto &live : liveTreeAgents()) {
            const CatalogEntry entry = liveIdentity(live);
            if (deletionidentity::sameNamespace(lease.root, entry))
                paths.append(deletionidentity::wslPathsFor(entry.filePath));
        }
        QVector<CatalogEntry> preparing;
        for (const auto &launch : m_preparingLaunches) {
            for (const auto *identity : {&launch.entry, &launch.actual}) {
                if (!deletionidentity::sameNamespace(lease.root, *identity) || filelessInMemory(*identity)) continue;
                preparing.append(*identity);
                paths.append(deletionidentity::wslPathsFor(identity->filePath));
            }
        }
        // No yield between provisional admission and taking the snapshots above. The
        // owner remains responsive while a bounded worker resolves filesystem aliases.
        m_deletingTrees.insert(sessionId, root);
        m_wslDeletingTrees.insert(sessionId, lease);
        auto identities = std::make_shared<QHash<QString, QString>>();
        background::runBlocking([fs, paths, identities]() -> QJsonValue {
            *identities = deletionidentity::resolve(fs, paths);
            return {};
        }, [this, root, identities, reservedPaths, preparing, done](background::Outcome outcome) mutable {
            if (m_shutdown || !m_wslDeletingTrees.contains(root.id)) return;
            auto refuse = [this, root, done](const QJsonObject &reason) {
                releaseDeletion(root.id);
                done(reason);
            };
            if (!outcome.ok) return refuse(blocked(QStringLiteral("identity-failed")));
            CatalogEntry current;
            if (!m_deps.services->catalog->get(root.id, &current)
                || !deletionidentity::sameTarget(root, current))
                return refuse(blocked(QStringLiteral("identity-changed")));
            auto resolved = m_wslDeletingTrees.value(root.id);
            resolved.identities = *identities;
            resolved.provisional = false;
            for (const auto &identity : preparing) {
                if (resolved.blocks(identity)) return refuse(blocked(QStringLiteral("session-busy"), identity.id));
            }
            // Missing/changed/new busy identities are unresolved and therefore blocked.
            // In-flight replacements have an unknown future destination, even when the
            // old path was unrelated. Ordinary unrelated live runtimes remain allowed.
            for (const auto &entry : m_deps.services->catalog->listEntries()) {
                if (!deletionidentity::sameNamespace(resolved.root, entry)) continue;
                if (m_bindings.isReplacingSession(entry.id)
                    || (isSessionBusy(entry.id) && resolved.blocks(entry)))
                    return refuse(blocked(QStringLiteral("session-busy"), entry.id));
            }
            for (const auto &agentEntry : m_agents) {
                const Tab &tab = agentEntry.second->tab();
                CatalogEntry identity;
                identity.environment = tab.sessionEnvironment;
                identity.wslDistro = tab.wslDistro;
                if (deletionidentity::sameNamespace(resolved.root, identity)
                    && (m_bindings.isReplacingSession(tab.deckSessionId)
                        || m_bindings.isReplacingSession(m_bindings.sessionForAgent(agentEntry.first))))
                    return refuse(blocked(QStringLiteral("session-busy"), tab.deckSessionId));
            }
            for (const auto &live : liveTreeAgents()) {
                if (resolved.blocks(liveIdentity(live)))
                    return refuse(QJsonObject{{QStringLiteral("kind"), QStringLiteral("file-in-use")},
                                               {QStringLiteral("agentTitle"), live.title}});
            }
            for (const QString &path : reservedPaths) {
                if (identities->value(path).isEmpty())
                    return refuse(blocked(QStringLiteral("identity-failed")));
            }
            // Publish and start deletion in one owner turn. No activation may enter
            // between the final busy verdict and publication of the scoped lease.
            m_wslDeletingTrees.insert(root.id, std::move(resolved));
            resumePreparedLaunches();
            done(QJsonObject{});
        });
    });
}

deletionidentity::NativeLease Coordinator::nativeDeletionLease(const QString &sessionId) const
{
    return m_nativeDeletingTrees.value(sessionId);
}

deletionidentity::Lease Coordinator::wslDeletionLease(const QString &sessionId) const
{
    return m_wslDeletingTrees.value(sessionId);
}

void Coordinator::releaseDeletion(const QString &sessionId)
{
    postToOwner([this, sessionId] {
        const bool releasedWsl = m_wslDeletingTrees.remove(sessionId);
        m_nativeDeletingTrees.remove(sessionId);
        m_deletingTrees.remove(sessionId);
        if (!releasedWsl || m_shutdown) return;
        resumePreparedLaunches();
        // Resume from current tickets, not a copied callback list: cancellation or
        // another overlapping lease can intervene before a particular ticket resumes.
        const auto reconnecting = m_reattachAttempts.keys();
        for (const auto &agentId : reconnecting) {
            auto attempt = m_reattachAttempts.find(agentId);
            if (attempt == m_reattachAttempts.end() || !attempt->resumeAfterDeletion) continue;
            auto resume = std::exchange(attempt->resumeAfterDeletion, {});
            resume();
        }
    });
}

} // namespace runtime
