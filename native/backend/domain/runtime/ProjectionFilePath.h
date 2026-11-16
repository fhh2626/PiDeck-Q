#pragma once

#include "../wsl/WslFilePaths.h"

namespace runtime {

#ifdef Q_OS_WIN
inline constexpr bool kProjectionWindowsHost = true;
#else
inline constexpr bool kProjectionWindowsHost = false;
#endif

/** Select the host read path without changing pi's persisted session identity. */
inline QString projectionFilePath(const QString &sessionPath, const QString &environment,
                                  const QString &distro,
                                  bool windowsHost = kProjectionWindowsHost)
{
    // A Linux backend already sees POSIX paths directly. On Windows the fallback
    // QFile read needs the owning runtime's drive/UNC path, even if global WSL
    // settings have changed since this session was activated.
    if (!windowsHost) return sessionPath;
    return wsl::toWindowsFilePath(sessionPath, environment == QLatin1String("wsl"), distro);
}

} // namespace runtime
