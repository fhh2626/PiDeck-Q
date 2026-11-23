#include "PathPolicy.h"
#include "WslFilePaths.h"
#include "../../../common/NativeCanonicalPath.h"

#include <QDir>
#include <QFileInfo>
#include <QStringList>

#ifdef Q_OS_WIN
#include <windows.h>

#include <string>
#endif

namespace pathpolicy {
namespace {

#ifdef Q_OS_WIN
constexpr Qt::CaseSensitivity kPathCase = Qt::CaseInsensitive;
#else
constexpr Qt::CaseSensitivity kPathCase = Qt::CaseSensitive;
#endif

QString withForwardSlashes(const QString &path)
{
    return QDir::fromNativeSeparators(path);
}

bool isUncShare(const QString &slashPath)
{
    // A real UNC path is exactly //server/share[/...]. Multiple leading separators
    // must not be able to masquerade as one.
    if (!slashPath.startsWith(QLatin1String("//"))) return false;
    const QString rest = slashPath.mid(2);
    const int serverEnd = rest.indexOf(QLatin1Char('/'));
    if (serverEnd <= 0) return false;
    const int shareEnd = rest.indexOf(QLatin1Char('/'), serverEnd + 1);
    return shareEnd != serverEnd + 1;
}

QString canonicalIfPresent(const QString &path)
{
#ifdef Q_OS_WIN
    // `QFileInfo::canonicalFilePath()` normalizes case and long names but does not
    // follow directory junctions, which would let an in-project junction redirect a
    // read/write outside the authorized roots. The final path of an open handle is
    // the only API that resolves reparse points.
    const HANDLE handle = CreateFileW(
        reinterpret_cast<LPCWSTR>(QDir::toNativeSeparators(path).utf16()), FILE_READ_ATTRIBUTES,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING,
        FILE_FLAG_BACKUP_SEMANTICS, nullptr);
    if (handle != INVALID_HANDLE_VALUE) {
        QString resolved;
        const DWORD required =
            GetFinalPathNameByHandleW(handle, nullptr, 0, FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
        if (required > 0) {
            std::wstring buffer(size_t(required), L'\0');
            const DWORD written = GetFinalPathNameByHandleW(handle, buffer.data(), required,
                                                            FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
            if (written > 0 && written < required) {
                resolved = QString::fromWCharArray(buffer.data(), int(written));
            }
        }
        CloseHandle(handle);
        if (!resolved.isEmpty()) {
            // Drop the extended-length prefix so the result matches the project
            // representation that projects.json stores.
            if (resolved.startsWith(QLatin1String("\\\\?\\UNC\\"))) {
                resolved = QStringLiteral("\\\\") + resolved.mid(8);
            } else if (resolved.startsWith(QLatin1String("\\\\?\\"))) {
                resolved = resolved.mid(4);
            }
            return QDir::cleanPath(QDir::fromNativeSeparators(resolved));
        }
    }
    const QFileInfo info(path);
    if (!info.exists()) return QString();
    return info.canonicalFilePath();
#else
    return nativecanonical::existing(path).path;
#endif
}

} // namespace

QString unauthorizedCode()
{
    return QStringLiteral("FILE_PATH_NOT_AUTHORIZED");
}

QString resolvePolicyPath(const QString &input)
{
    if (input.isEmpty() || input.contains(QChar(0))) return QString();
    const QString slashPath = withForwardSlashes(input);
#ifdef Q_OS_WIN
    if (slashPath.startsWith(QLatin1String("//?/")) || slashPath.startsWith(QLatin1String("//./"))) return QString();
    const bool hasDrive = slashPath.size() >= 2 && slashPath.at(0).isLetter() && slashPath.at(1) == QLatin1Char(':');
    if (hasDrive) {
        // Reject a bare drive and drive-relative paths; only "C:/..." is absolute.
        if (slashPath.size() < 3 || slashPath.at(2) != QLatin1Char('/')) return QString();
    } else if (slashPath.startsWith(QLatin1Char('/')) && !isUncShare(slashPath)) {
        return QString();
    }
#endif
    if (!QDir::isAbsolutePath(slashPath)) return QString();
    return QDir::cleanPath(slashPath);
}

bool isPathInsideRoot(const QString &target, const QString &root)
{
    const QString normalizedTarget = resolvePolicyPath(target);
    const QString normalizedRoot = resolvePolicyPath(root);
    if (normalizedTarget.isEmpty() || normalizedRoot.isEmpty()) return false;
    // WSL is a case-sensitive Linux filesystem behind case-insensitive UNC host
    // and distro names. Compare its identity before ordinary Windows folding.
    if (const auto insideWsl = wsl::isFilePathInsideRoot(target, root)) return *insideWsl;
    if (normalizedTarget.compare(normalizedRoot, kPathCase) == 0) return true;
    QString prefix = normalizedRoot;
    if (!prefix.endsWith(QLatin1Char('/'))) prefix += QLatin1Char('/');
    return normalizedTarget.startsWith(prefix, kPathCase);
}

QString realpathWithMissingSuffix(const QString &target)
{
#ifndef Q_OS_WIN
    // Preserve raw traversal order, and never treat a lossy existing entry as
    // a missing suffix whose lexical spelling would authorize another target.
    return nativecanonical::withMissingSuffix(target).path;
#else
    QStringList missing;
    QString current = resolvePolicyPath(target);
    if (current.isEmpty()) current = QDir::cleanPath(withForwardSlashes(target));
    while (true) {
        const QString existing = canonicalIfPresent(current);
        if (!existing.isEmpty()) {
            QString resolved = existing;
            for (int index = missing.size() - 1; index >= 0; --index) {
                resolved = QDir(resolved).filePath(missing.at(index));
            }
            return QDir::cleanPath(resolved);
        }
        const QFileInfo info(current);
        const QString parent = info.path();
        const QString name = info.fileName();
        // A filesystem root has no file name; reaching it without an existing
        // ancestor means the path cannot be resolved at all.
        if (name.isEmpty() || parent.isEmpty() || parent == current) return QString();
        missing.append(name);
        current = parent;
    }
#endif
}

QString existingRealPath(const QString &target)
{
    const QString normalized = resolvePolicyPath(target);
    if (normalized.isEmpty()) return QString();
    return canonicalIfPresent(normalized);
}

QStringList authorizedRoots(const QString &userDataDir, const QString &promptsDir,
                            const QString &skillsDir, const QString &agentDir){
    QStringList roots;
    // Project paths are appended by the caller (they come from projects.json and may
    // change at any time); this helper covers the static scope only.
    if (!promptsDir.isEmpty()) roots.append(promptsDir);
    if (!skillsDir.isEmpty()) roots.append(skillsDir);
    if (!agentDir.isEmpty()) roots.append(agentDir);
    if (!userDataDir.isEmpty()) roots.append(userDataDir);
    return roots;
}

Result assertAuthorized(const QString &target, const QStringList &roots, const QString &operation, Mode mode,
                        const RootResolver &resolveRoot)
{
    Result result;
    const QString normalizedTarget = resolvePolicyPath(target);
    if (normalizedTarget.isEmpty()) {
        result.error = QStringLiteral("File path is not authorized for %1.").arg(operation);
        return result;
    }
    QStringList normalizedRoots;
    for (const QString &root : roots) {
        if (root.isEmpty()) continue;
        const QString normalizedRoot = resolvePolicyPath(root);
        if (normalizedRoot.isEmpty()) continue;
        normalizedRoots.append(normalizedRoot);
    }
    if (normalizedRoots.isEmpty()) {
        result.error = QStringLiteral("File path is not authorized for %1.").arg(operation);
        return result;
    }

    const auto insideAnyRoot = [&normalizedRoots, &normalizedTarget, &resolveRoot](const QString &candidate) {
        QStringList preferred;
        QStringList remaining;
        for (const QString &root : normalizedRoots) {
            if (isPathInsideRoot(normalizedTarget, root) || isPathInsideRoot(candidate, root)) preferred.append(root);
            else remaining.append(root);
        }
        // Lexical containment only prioritizes probes. Both the target/parent and
        // the granting root must still be canonical, so junction escapes stay denied.
        // Keep the fallback for roots whose own junction aliases the target's tree.
        for (const QString &root : preferred + remaining) {
            const QString realRoot = resolveRoot ? resolveRoot(root) : canonicalIfPresent(root);
            if (!realRoot.isEmpty() && isPathInsideRoot(candidate, realRoot)) return true;
        }
        return false;
    };

    if (mode == Mode::Link) {
        const QFileInfo info(normalizedTarget);
        const QString realParent = realpathWithMissingSuffix(info.path());
        if (realParent.isEmpty() || !insideAnyRoot(realParent)) {
            result.error = QStringLiteral("File path is not authorized for %1.").arg(operation);
            return result;
        }
        result.ok = true;
        result.path = normalizedTarget;
        return result;
    }

    const QFileInfo targetInfo(normalizedTarget);
    // Read/write never follow a link, even when its current referent happens to be
    // inside a root; this also closes the dangling-link TOCTOU case.
    if (targetInfo.isSymLink()) {
        result.error = QStringLiteral("File path is not authorized for %1.").arg(operation);
        return result;
    }
    const QString existing = canonicalIfPresent(normalizedTarget);
    const QString containment = existing.isEmpty() ? realpathWithMissingSuffix(normalizedTarget) : existing;
    if (containment.isEmpty() || !insideAnyRoot(containment)) {
        result.error = QStringLiteral("File path is not authorized for %1.").arg(operation);
        return result;
    }
    result.ok = true;
    result.path = existing.isEmpty() ? normalizedTarget : existing;
    return result;
}

} // namespace pathpolicy
