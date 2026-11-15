#include "SessionTreeGuard.h"

#include "SessionIdentity.h"

namespace sessiontreeguard {

bool sameEnvironment(const CatalogEntry &entry, const LiveAgent &agent)
{
    if (entry.environment != agent.environment) return false;
    if (entry.environment != QLatin1String("wsl")) return true;
    return entry.wslDistro == agent.wslDistro && entry.wslUser == agent.wslUser;
}

bool sameEnvironment(const CatalogEntry &left, const CatalogEntry &right)
{
    if (left.environment != right.environment) return false;
    if (left.environment != QLatin1String("wsl")) return true;
    return left.wslDistro == right.wslDistro && left.wslUser == right.wslUser;
}

bool isPathInSessionTree(const QString &rootFile, const QString &candidate, const QString &environment)
{
    const QString root = sessionidentity::canonicalizeSessionPath(rootFile, environment);
    const QString target = sessionidentity::canonicalizeSessionPath(candidate, environment);
    if (target == root) return true;
    if (!root.endsWith(QLatin1String(".jsonl"))) return false;
    // The trailing separator is required: without it `same-other.jsonl` would be
    // classified as a child of `same.jsonl`.
    const QString childDir = root.left(root.size() - 6) + QLatin1Char('/');
    return target.startsWith(childDir);
}

Block findBlock(const CatalogEntry &root, const QVector<CatalogEntry> &entries,
                const QVector<LiveAgent> &agents, const std::function<bool(const QString &)> &isBusy)
{
    Block block;
    // A running root is checked first so the message can name the right action
    // ("stop the session" vs "stop the child").
    if (isBusy(root.id)) {
        block.kind = Block::SessionBusy;
        block.sessionId = root.id;
        return block;
    }
    if (root.filePath.isEmpty()) return block;

    for (const CatalogEntry &entry : entries) {
        if (entry.id == root.id || entry.filePath.isEmpty()) continue;
        if (!sameEnvironment(root, entry)) continue;
        if (!isPathInSessionTree(root.filePath, entry.filePath, root.environment)) continue;
        if (!isBusy(entry.id)) continue;
        block.kind = Block::SessionBusy;
        block.sessionId = entry.id;
        return block;
    }

    for (const LiveAgent &agent : agents) {
        if (agent.sessionPath.isEmpty()) continue;
        if (!sameEnvironment(root, agent)) continue;
        if (!isPathInSessionTree(root.filePath, agent.sessionPath, root.environment)) continue;
        // A live pi process owns the file even when no catalog record covers it yet;
        // deleting the tree would pull the file out from under the running agent.
        block.kind = Block::FileInUse;
        block.agentTitle = agent.title;
        return block;
    }
    return block;
}

} // namespace sessiontreeguard
