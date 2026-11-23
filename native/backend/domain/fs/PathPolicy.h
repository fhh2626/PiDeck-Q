#pragma once

#include <QString>
#include <QStringList>

#include <functional>

/**
 * Desktop path authorization.
 *
 * Port of src/main/fs/authorizedPaths.ts + isPathInsideRoot from
 * src/main/security/policy.ts. Every renderer-supplied path must pass through here
 * before a file operation, because lexical containment alone lets a junction or
 * symlink inside a project redirect a read or write outside it.
 *
 * Modes mirror the Node oracle:
 *  - Read/Write resolve the target (and its nearest existing ancestor for paths that
 *    do not exist yet) and refuse a symlinked leaf outright;
 *  - Link validates the real *parent* chain and returns the lexical target, so
 *    deleting or renaming a link operates on the link itself, never its referent.
 */
namespace pathpolicy {

enum class Mode {
    Read,
    Write,
    Link,
};

struct Result {
    bool ok = false;
    QString path;
    QString error;
};

/** Error code used by the Node oracle for rejected paths. */
QString unauthorizedCode();

/**
 * Normalize one absolute path. Returns an empty string for forms the policy rejects
 * outright: NUL bytes, Windows device namespaces (`\\?\`, `\\.\`), bare drives (`C:`),
 * drive-relative paths (`C:foo`) and root-relative paths that are not real UNC shares.
 */
QString resolvePolicyPath(const QString &input);

/** True when `target` is `root` itself or lives below it. */
bool isPathInsideRoot(const QString &target, const QString &root);

/**
 * Filesystem-aware authorization. `roots` may contain paths that do not exist; those
 * entries are ignored (the Node oracle behaves the same way).
 * `resolveRoot` allows a controlled root probe in filesystem regression tests; the
 * production default always resolves roots with the operating system.
 */
using RootResolver = std::function<QString(const QString &)>;
Result assertAuthorized(const QString &target, const QStringList &roots, const QString &operation, Mode mode,
                        const RootResolver &resolveRoot = {});

/**
 * The desktop authorization scope, matching registerBackendRpc.getAuthorizedRoots():
 * project paths, the prompt directory, skill directories, ~/.pi/agent and user data.
 */
QStringList authorizedRoots(const QString &userDataDir, const QString &promptsDir,
                            const QString &skillsDir, const QString &agentDir);

/** Expand a path that may not exist yet by resolving its nearest existing ancestor. */
QString realpathWithMissingSuffix(const QString &target);

/**
 * Real path of a path that must already exist; an empty string when it does not.
 *
 * Node's `fs.realpath` rejects ENOENT, and several authorization rules depend on that
 * distinction (a missing root must fail closed instead of authorizing a future path).
 */
QString existingRealPath(const QString &target);

} // namespace pathpolicy
