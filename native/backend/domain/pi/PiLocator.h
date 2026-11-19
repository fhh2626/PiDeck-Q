#pragma once

#include "PiSearchDirs.h"

#include <QJsonObject>
#include <QProcessEnvironment>
#include <QString>
#include <QStringList>

struct ChannelServices;

/**
 * pi executable discovery, ported from `PiLocator` (src/main/pi/PiLocator.ts).
 *
 * The Node locator exists because a packaged desktop app inherits a much smaller PATH
 * than a terminal: npm global bins live in `%APPDATA%\npm`, version managers
 * (mise/fnm/volta/scoop/asdf/nvm) inject their own directories at shell start, and
 * Homebrew is absent from a Dock-launched macOS app. `searchDirs()` is therefore an
 * *observable* part of the `pi:check` result, not an implementation detail — the renderer
 * shows the list to help a user diagnose "pi not found".
 *
 * Invariants:
 *  - one resolution order for every caller (custom path → WSL → runtime preference →
 *    PATH search → bare name), so `pi:check`, `projects:list-models` and the runtime
 *    never disagree about which pi is "the" pi;
 *  - the renderer never supplies an executable that is used verbatim: the custom path
 *    must exist (auto mode only) and a `.ps1` shim is rejected;
 *  - WSL discovery shells out with an argument array (`which <name>`) and is cached for a
 *    minute, because `pi:check` may run on every settings save.
 */
namespace pilocator {

/** Strip quotes, fold doubled backslashes, and prefer an existing `.cmd`/`.exe` sibling. */
QString normalizeCustomPath(const QString &rawPath);

/** The Windows PowerShell shim is not invoked any more; such a path falls back to auto. */
bool isUnsupportedPowerShellShim(const QString &path);

/** `pi` or `pi-bolt` depending on the runtime preference. */
QString runtimeBinaryName(const QString &preference);

/**
 * Resolve the pi command for the current settings.
 *
 * Returns a plain program path/name, or the `wsl://<distro>/<user>/<piCommand>` marker
 * when WSL is enabled and the distro actually has pi.
 */
QString resolveCommand(const ChannelServices &services, const QJsonObject &settings);

/**
 * Directory holding `node` for a resolved command, when the command lives in its own
 * toolchain directory. The npm shim resolves node through PATH, so prepending its own
 * bin dir keeps the lookup on the Node version that installed pi.
 */
QString commandBinDir(const QString &command);

/**
 * Child environment for pi (and npm) invocations: the sanitized host environment with
 * PATH rebuilt from `searchDirs`, plus the pi proxy variables when the setting is on.
 *
 * `pathPrefix` goes first (the resolved command's bin dir); `viaWsl` keeps the plain
 * process PATH because `wsl.exe` must stay reachable and the proxy applies to the
 * Windows-side transport.
 */
QProcessEnvironment createProcessEnv(const ChannelServices &services, const QJsonObject &settings,
                                     const QString &pathPrefix = QString(), bool viaWsl = false);

/** `detectPiRuntimeKind`: "bolt" | "typescript" | "unknown" from `pi --version`. */
QString detectRuntimeKind(const QString &version);

/** Parse the `wsl://distro/user/piCommand` marker. Returns false when malformed. */
bool parseWslUrl(const QString &url, QString *distro, QString *user, QString *piCommand);

/** Full candidate paths for the runtime preference, in probe order. */
QStringList candidates(const ChannelServices &services, const QString &preference);

} // namespace pilocator
