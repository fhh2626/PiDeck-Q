#pragma once

#include <QJsonObject>
#include <QString>
#include <QStringList>

struct ChannelServices;

/**
 * `pi --version` health probe and the `PiInstallStatus` result shape.
 *
 * Port of `PiLocator.check` / `validateCustomPath` / `runCheck` / `checkWslCommand`
 * (src/main/pi/PiLocator.ts). Both entry points share one runner so "the path is valid"
 * means exactly the same thing for auto-detection and for a user-typed path; only
 * `searchedDirs` differs (auto detection reports the scanned directories, a manual path
 * reports none because nothing was searched).
 *
 * Invariants:
 *  - success requires a clean `--version` exit; a `.cmd` shim is launched through
 *    `cmd.exe /s /c` exactly like a session runtime;
 *  - the user-visible `error` is the localized `mainPi.*` copy, never raw stderr
 *    (stderr is decoded for the version string only: UTF-8 first, then the Windows ANSI
 *    code page, mirroring the oracle's GBK fallback);
 *  - `searchedDirs` is always present (possibly empty) because the renderer renders it.
 */
namespace pilocator {

struct Status {
    bool installed = false;
    bool hasCommand = false;
    QString command;
    bool hasVersion = false;
    QString version;
    bool hasRuntimeKind = false;
    QString runtimeKind;
    QStringList searchedDirs;
    bool hasError = false;
    QString error;

    QJsonObject toJson() const;
};

/** Auto-detection (`pi:check`): resolve from settings, then probe the version. */
Status check(const ChannelServices &services, const QJsonObject &settings);

/** Manual path validation (`pi:check-custom`): probe the pasted path as-is. */
Status validateCustomPath(const ChannelServices &services, const QJsonObject &settings,
                          const QString &customPath);

} // namespace pilocator
