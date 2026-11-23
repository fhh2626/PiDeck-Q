#pragma once

#include "PorcelainStatus.h"

#include <QJsonObject>
#include <QJsonValue>
#include <QString>
#include <QList>

/**
 * Repository status context.
 *
 * Port of GitService.getStatusContext + getWorkspaceFileDiff. The context is what
 * makes `git status` usable in a monorepo: `-- .` scopes the porcelain output to the
 * project directory, then each resource is mapped back into the project's own path
 * representation (which on Windows may be an 8.3 short path).
 */
namespace gitstatus {

struct Context {
    QJsonObject groups;
    QList<porcelain::Resource> resources;
    QString repoRoot;
    QString inputProjectRoot;
    QString projectRoot;
};

/** Read the full context. Throws when the directory is not a repository. */
Context read(const QString &cwd);

/**
 * Canonicalize an existing path like the Node oracle: on Windows the volume's final
 * path is used (junctions/symlinks resolve; missing paths keep their lexical form,
 * matching fs.realpath's failure fallback), while POSIX stays on QFileInfo's realpath.
 */
QString canonicalPath(const QString &path);

/** The channel-level status call: non-repository errors propagate, others degrade. */
QJsonObject getStatus(const QString &cwd);

/** Two-sided snapshot for one resource row; null when the resource is stale. */
QJsonValue workspaceFileDiff(const QString &cwd, const QString &group, const QString &filePath, qint64 maxBytes);

/** `git rev-parse --show-toplevel` resolved through realpath, or empty. */
QString repositoryRoot(const QString &cwd);

/** Resolve a renderer-supplied commit-ish to a full SHA, or empty when invalid. */
QString resolveCommitHash(const QString &cwd, const QString &ref);

} // namespace gitstatus
