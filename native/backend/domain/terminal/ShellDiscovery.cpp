#include "ShellDiscovery.h"

#include <QFileInfo>
#include <QSet>
#include <QStandardPaths>

namespace terminal {
namespace {

/** Deduplicate by `command\0args` exactly like `dedupeShellCandidates`. */
void dedupe(std::vector<ShellCandidate> *candidates)
{
    QSet<QString> seen;
    std::vector<ShellCandidate> unique;
    unique.reserve(candidates->size());
    for (const ShellCandidate &candidate : *candidates) {
        const QString key = candidate.command + QChar(0) + candidate.args.join(QChar(0));
        if (seen.contains(key)) continue;
        seen.insert(key);
        unique.push_back(candidate);
    }
    *candidates = std::move(unique);
}

#ifndef Q_OS_WIN
/** `normalizePosixShell`: the login flag is chosen by the shell family. */
bool normalizePosixShell(const QString &shellPath, ShellCandidate *out)
{
    if (shellPath.isEmpty()) return false;
    const QString name = QFileInfo(shellPath).fileName();
    out->command = shellPath;
    if (name == QLatin1String("zsh") || name == QLatin1String("bash") || name == QLatin1String("fish")) {
        out->shell = name;
        out->args = QStringList{QStringLiteral("-l")};
        return true;
    }
    if (name == QLatin1String("sh")) {
        out->shell = QStringLiteral("sh");
        out->args = QStringList{};
        return true;
    }
    // An unknown login shell is still usable; report it as `sh` so the renderer has a
    // known id while the real binary is spawned unchanged.
    out->shell = QStringLiteral("sh");
    out->args = QStringList{};
    return true;
}
#endif

} // namespace

std::vector<ShellCandidate> shellCandidates()
{
    std::vector<ShellCandidate> candidates;
#ifdef Q_OS_WIN
    candidates.push_back({QStringLiteral("pwsh"), QStringLiteral("pwsh.exe"), {}});
    candidates.push_back({QStringLiteral("powershell"), QStringLiteral("powershell.exe"), {}});
    candidates.push_back({QStringLiteral("cmd"), QStringLiteral("cmd.exe"), {}});
    // Git Bash is not on PATH by default; only the two standard install roots are probed.
    const QStringList gitBashPaths{
        QStringLiteral("C:/Program Files/Git/bin/bash.exe"),
        QStringLiteral("C:/Program Files (x86)/Git/bin/bash.exe"),
    };
    for (const QString &path : gitBashPaths) {
        if (!QFileInfo::exists(path)) continue;
        candidates.push_back({QStringLiteral("git-bash"), path,
                              QStringList{QStringLiteral("--login"), QStringLiteral("-i")}});
        break;
    }
    // WSL is only offered when `wsl.exe` resolves on PATH (`where wsl.exe` in the oracle).
    const QString wsl = QStandardPaths::findExecutable(QStringLiteral("wsl.exe"));
    if (!wsl.isEmpty()) candidates.push_back({QStringLiteral("wsl"), QStringLiteral("wsl.exe"), {}});
#else
    ShellCandidate userShell;
    if (normalizePosixShell(qEnvironmentVariable("SHELL"), &userShell)) candidates.push_back(userShell);
#ifdef Q_OS_MACOS
    // A GUI app does not inherit the login shell environment; starting a login shell
    // lets zsh/bash initialize the TTY and the user PATH like Terminal.app does.
    candidates.push_back({QStringLiteral("zsh"), QStringLiteral("/bin/zsh"), QStringList{QStringLiteral("-l")}});
    candidates.push_back({QStringLiteral("bash"), QStringLiteral("/bin/bash"), QStringList{QStringLiteral("-l")}});
    candidates.push_back({QStringLiteral("sh"), QStringLiteral("/bin/sh"), {}});
#else
    candidates.push_back({QStringLiteral("bash"), QStringLiteral("bash"), {}});
    candidates.push_back({QStringLiteral("sh"), QStringLiteral("sh"), {}});
#endif
#endif
    dedupe(&candidates);
    return candidates;
}

QString displayShell(const QString &shell)
{
    if (shell == QLatin1String("pwsh")) return QStringLiteral("pwsh");
    if (shell == QLatin1String("powershell")) return QStringLiteral("Windows PowerShell");
    if (shell == QLatin1String("cmd")) return QStringLiteral("cmd");
    if (shell == QLatin1String("zsh")) return QStringLiteral("zsh");
    if (shell == QLatin1String("bash")) return QStringLiteral("bash");
    if (shell == QLatin1String("fish")) return QStringLiteral("fish");
    if (shell == QLatin1String("git-bash")) return QStringLiteral("Git Bash");
    if (shell == QLatin1String("wsl")) return QStringLiteral("WSL");
    return QStringLiteral("shell");
}

QStringList shellIds()
{
    QStringList ids;
    for (const ShellCandidate &candidate : shellCandidates()) ids.append(candidate.shell);
    return ids;
}

} // namespace terminal
