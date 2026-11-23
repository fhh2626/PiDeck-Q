#pragma once

#include <QString>
#include <optional>

namespace wsl {
/** Convert file API targets to Windows before canonical authorization. */
QString toWindowsFilePath(const QString &path, bool wslEnabled, const QString &distro);
/** WSL containment retains Linux case. Nullopt delegates non-WSL paths to host policy. */
std::optional<bool> isFilePathInsideRoot(const QString &target, const QString &root);
}
