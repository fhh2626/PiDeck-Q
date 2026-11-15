#pragma once

#include <QJsonObject>
#include <QString>
#include <QStringList>

struct ChannelServices;

/**
 * `wsl.exe` probing shared by `wsl:*` and the pi locator's WSL discovery.
 *
 * Port of `getWslExe()` (src/main/wsl/wslExe.ts) plus the two `wsl:*` handlers from
 * systemIpc. Every call passes an argument array; a bare fallback name lets the platform
 * resolve `wsl` on PATH (the oracle's `shell: true` form) and the batch-shim wrap covers
 * the test fixture, so no code path ever builds a shell string from user data.
 *
 * `ChannelServices::wslExe` is the fixture seam: production leaves it empty and the
 * default resolution (System32, honoring a 32-bit Sysnative alias) is used.
 */
namespace wsl {

struct Result {
    bool started = false;
    bool timedOut = false;
    int exitCode = 0;
    QString stdoutText;
    QString stderrText;

    /** Clean exit; a missing wsl.exe or a timeout is a failure, like an execFile error. */
    bool ok() const { return started && !timedOut && exitCode == 0; }
};

/** Program used for every wsl invocation (override, System32 path, or bare `wsl`). */
QString executable(const ChannelServices &services);

/**
 * Same resolution with an explicit override.
 *
 * `SessionFs` (session scanning inside a distro) has no `ChannelServices`, so the
 * override is handed to it through `SessionFs::Config::executable`. Keeping one
 * resolver means the fixture seam works for both the `wsl:*` channels and the scanner.
 */
QString executableFor(const QString &override);

Result run(const ChannelServices &services, const QStringList &arguments, int timeoutMs);

/** `wsl -l -q`, filtered exactly like the oracle: no blank, no `\`, no NUL-laden lines. */
QStringList listDistros(const ChannelServices &services);

struct Validation {
    bool ok = false;
    QString whoami;
    QString piVersion;
    QString error;
    QJsonObject toJson() const;
};

/**
 * `whoami` + `pi --version` inside the distro.
 *
 * A failing `whoami` is a connection failure; a failing pi probe still reports
 * `ok:true` because the distro is reachable, with the localized "pi not installed"
 * message — the renderer uses that to offer the install hint instead of a hard error.
 */
Validation validateConnection(const ChannelServices &services, const QString &distro,
                             const QString &user);

} // namespace wsl
