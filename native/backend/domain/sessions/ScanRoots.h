#pragma once

#include "SessionFs.h"

#include <QString>
#include <QStringList>

/**
 * Session scan roots (port of SessionScanner.resolveScanRoots).
 *
 * The default root is `~/.pi/agent/sessions`, which pi fills with encoded-cwd
 * subdirectories. When pi's `sessionDir` setting is configured (project
 * `.pi/settings.json` wins over the global file) pi stops writing encoded-cwd
 * directories, so that path must be scanned too or those sessions disappear.
 */
namespace scanroots {

/** `~/.pi/agent/sessions` for the active environment. */
QString defaultSessionsRoot(const SessionFs &fs, const QString &hostHome);

/**
 * Resolve the roots for one project scan.
 * `projectPath` is the host path (used to read `.pi/settings.json`);
 * `runtimeProjectPath` is the path pi runs with (WSL: `/mnt/...`).
 */
QStringList resolve(const SessionFs &fs, const QString &hostHome, const QString &projectPath,
                    const QString &runtimeProjectPath, const QString &baseRoot = QString());

/** Expand a leading `~` using the environment's home. */
QString expandHomePrefix(const QString &input, const QString &home);

/** `/mnt/c/...` → `C:\...`; other paths unchanged. */
QString toHostReadablePath(const QString &path);

} // namespace scanroots
