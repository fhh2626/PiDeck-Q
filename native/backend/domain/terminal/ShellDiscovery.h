#pragma once

#include <QString>
#include <QStringList>

#include <vector>

/**
 * Shell discovery for the terminal dock.
 *
 * Port of `getTerminalShellCandidates` / `normalizePosixShell` / `displayShell` from
 * src/main/terminal/TerminalSessionManager.ts. The candidate order is the spawn fallback
 * order: the first candidate that can actually be started wins, so a machine without
 * PowerShell still opens a terminal instead of failing.
 */
namespace terminal {

struct ShellCandidate {
    /** Renderer-visible shell id (`pwsh`, `cmd`, `bash`, ...). */
    QString shell;
    QString command;
    QStringList args;
};

/**
 * Candidates for the current platform, in spawn order.
 *
 * Windows: pwsh -> powershell -> cmd -> Git Bash (when installed) -> WSL (when
 * `wsl.exe` is on PATH). POSIX: `$SHELL` first, then the platform defaults.
 */
std::vector<ShellCandidate> shellCandidates();

/** Human label used for the tab title and the shell menu. */
QString displayShell(const QString &shell);

/** `terminal:shells` payload: `[{shell, label, available}]`. */
QStringList shellIds();

} // namespace terminal
