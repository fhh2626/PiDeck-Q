#pragma once

#include <QJsonObject>
#include <QString>

/**
 * Terminal ownership target.
 *
 * Port of `TerminalTarget` / `terminalOwnerKeyFor` / `normalizeTerminalCwd` from
 * src/main/terminal/TerminalSessionManager.ts. A terminal belongs either to a live
 * agent runtime or to a project directory, and the PTY instances plus their replay
 * buffers are isolated per ownership key so switching project or agent never shows
 * another owner's terminal.
 */
namespace terminal {

struct Target {
    enum class Kind { Agent, Project };

    Kind kind = Kind::Project;
    QString sessionId;
    QString agentId;
    int runtimeGeneration = 0;
    QString projectId;
    /** Project targets carry the cwd; agent targets resolve it from the runtime. */
    QString cwd;

    QJsonObject toJson() const;
};

/**
 * Parse a renderer-supplied target.
 *
 * Anything that is not `kind: "project"` is treated as an agent target, exactly like
 * the oracle: the coordinator then rejects it when session/agent/generation do not
 * match a live runtime, so a malformed target can never fall back to a project
 * terminal.
 */
Target targetFromJson(const QJsonObject &value);

/**
 * `agent:<agentId>` or `cwd:<normalized cwd>`.
 *
 * Windows local paths fold case; POSIX paths and the Linux part of a WSL UNC path keep
 * their case, otherwise `/repo/Foo` and `/repo/foo` would share one terminal.
 */
QString ownerKeyFor(const Target &target, const QString &resolvedCwd);

/** Normalize a cwd for ownership comparison. `isWindows` selects the Windows rules. */
QString normalizeCwd(const QString &cwd, bool isWindows);

/** True when the process platform uses Windows path rules. */
bool platformIsWindows();

} // namespace terminal
