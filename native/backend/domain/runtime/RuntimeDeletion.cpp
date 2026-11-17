#include "RuntimeCoordinator.h"

#include "../sessions/SessionCatalogStore.h"
#include "../fs/PathPolicy.h"
#include "../process/BackgroundWork.h"

#include <QDir>

namespace runtime {
namespace {

/** Overlap is symmetric: a parent mutation must also respect a reserved child tree. */
bool overlaps(const CatalogEntry &left, const CatalogEntry &right)
{
    if (left.id == right.id) return true;
    if (left.filePath.isEmpty() || right.filePath.isEmpty()
        || !deletionidentity::sameNamespace(left, right)) return false;
    QString leftPath = left.filePath;
    QString rightPath = right.filePath;
    if (left.environment != QLatin1String("wsl")) {
        const QString realLeft = pathpolicy::realpathWithMissingSuffix(leftPath);
        const QString realRight = pathpolicy::realpathWithMissingSuffix(rightPath);
        if (!realLeft.isEmpty()) leftPath = realLeft;
        if (!realRight.isEmpty()) rightPath = realRight;
    }
    return sessiontreeguard::isPathInSessionTree(leftPath, rightPath, left.environment)
        || sessiontreeguard::isPathInSessionTree(rightPath, leftPath, left.environment);
}

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
    for (const CatalogEntry &root : m_deletingTrees) {
        if (root.environment != QLatin1String("wsl") && overlaps(root, candidate)) return true;
    }
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
    for (const auto &lease : m_wslDeletingTrees) {
        if (lease.blocks(candidate)) return true;
    }
    for (const CatalogEntry &root : m_deletingTrees) {
        if (root.environment != QLatin1String("wsl") && overlaps(root, candidate)) return true;
    }
    return false;
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
            for (const CatalogEntry &entry : entries) {
                if ((deletionidentity::sameNamespace(root, entry)
                     && m_bindings.isReplacingSession(entry.id))
                    || (overlaps(root, entry) && isSessionBusy(entry.id)))
                    return done(blocked(QStringLiteral("session-busy"), entry.id));
            }
            // A replacement can be live before its catalog binding is published; its
            // destination remains unknown until the replacement handshake completes.
            for (const auto &agentEntry : m_agents) {
                const Tab &tab = agentEntry.second->tab();
                CatalogEntry identity;
                identity.environment = tab.sessionEnvironment;
                identity.wslDistro = tab.wslDistro;
                if (deletionidentity::sameNamespace(root, identity)
                    && (m_bindings.isReplacingSession(tab.deckSessionId)
                        || m_bindings.isReplacingSession(m_bindings.sessionForAgent(agentEntry.first))))
                    return done(blocked(QStringLiteral("session-busy"), tab.deckSessionId));
            }
            m_deletingTrees.insert(sessionId, root);
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
        QStringList paths = deletionidentity::pathsFor(root.filePath);
        for (const auto &entry : entries) {
            if (deletionidentity::sameNamespace(lease.root, entry))
                paths.append(deletionidentity::pathsFor(entry.filePath));
        }
        for (const auto &live : liveTreeAgents()) {
            const CatalogEntry entry = liveIdentity(live);
            if (deletionidentity::sameNamespace(lease.root, entry))
                paths.append(deletionidentity::pathsFor(entry.filePath));
        }
        // No yield between provisional admission and taking the snapshots above. The
        // owner remains responsive while a bounded worker resolves filesystem aliases.
        m_deletingTrees.insert(sessionId, root);
        m_wslDeletingTrees.insert(sessionId, lease);
        auto identities = std::make_shared<QHash<QString, QString>>();
        background::runBlocking([fs, paths, identities]() -> QJsonValue {
            *identities = deletionidentity::resolve(fs, paths);
            return {};
        }, [this, root, identities, done](background::Outcome outcome) mutable {
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
            for (const QString &path : deletionidentity::pathsFor(root.filePath)) {
                if (identities->value(path).isEmpty())
                    return refuse(blocked(QStringLiteral("identity-failed")));
            }
            // Publish and start deletion in one owner turn. No activation may enter
            // between the final busy verdict and publication of the scoped lease.
            m_wslDeletingTrees.insert(root.id, std::move(resolved));
            done(QJsonObject{});
        });
    });
}

void Coordinator::releaseDeletion(const QString &sessionId)
{
    postToOwner([this, sessionId] {
        m_wslDeletingTrees.remove(sessionId);
        m_deletingTrees.remove(sessionId);
    });
}

} // namespace runtime
