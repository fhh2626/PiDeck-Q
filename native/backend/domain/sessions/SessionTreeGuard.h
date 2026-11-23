#pragma once

#include "CatalogTypes.h"

#include <QString>
#include <QVector>

#include <functional>

/**
 * Session-tree delete/archive/rename guard.
 *
 * Port of src/main/sessions/sessionTreeGuard.ts. Deleting or archiving `<stem>.jsonl`
 * also moves the whole `<stem>/` directory, which may contain forked or subagent
 * sessions nested at any depth. The guard therefore answers two questions:
 *  - is any session whose file lives inside that tree still running?
 *  - is any live pi agent still appending to a file inside that tree (even when that
 *    agent has no catalog entry yet, e.g. a transient anonymous runtime)?
 *
 * Path rules are deliberately structural (`<stem>.jsonl` + `<stem>/` prefix, canonical
 * comparison): a sibling such as `same-other.jsonl` must not be treated as a child of
 * `same.jsonl`, and a path that does not live under the root's stem directory is out of
 * scope even when the record's `parentSessionPath` points there.
 */
namespace sessiontreeguard {

/** Live runtime agent as seen by the guard (AgentManager.list() projection). */
struct LiveAgent {
    QString title;
    QString sessionPath;
    QString environment;
    QString wslDistro;
    QString wslUser;
};

struct Block {
    enum Kind { None, SessionBusy, FileInUse };
    Kind kind = None;
    /** SessionBusy: the busy session (root or a child). */
    QString sessionId;
    /** FileInUse: the tab title shown in the localized "in use" error. */
    QString agentTitle;
};

/** True when both sides address the same filesystem space (native / same WSL distro+user). */
bool sameEnvironment(const CatalogEntry &entry, const LiveAgent &agent);
bool sameEnvironment(const CatalogEntry &left, const CatalogEntry &right);

/** True when `candidate` is the root file or any JSONL below its companion directory. */
bool isPathInSessionTree(const QString &rootFile, const QString &candidate, const QString &environment);

/** First reason the tree cannot be mutated; `kind == None` when it is idle. */
Block findBlock(const CatalogEntry &root, const QVector<CatalogEntry> &entries,
                const QVector<LiveAgent> &agents, const std::function<bool(const QString &)> &isBusy);

} // namespace sessiontreeguard
