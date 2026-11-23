#include "WslFilePaths.h"

#include <QDir>
#include <QRegularExpression>

namespace wsl {
namespace {

struct FilePath {
    QString distro;
    QString linuxPath;
};

/** Both supported UNC hosts identify the same distro, without folding Linux path names. */
std::optional<FilePath> parseUncFilePath(const QString &path)
{
    static const QRegularExpression unc(
        QStringLiteral("^[\\\\/]{2}(?:wsl\\$|wsl\\.localhost)[\\\\/]([^\\\\/]+)(?:[\\\\/](.*))?$"),
        QRegularExpression::CaseInsensitiveOption);
    const QRegularExpressionMatch match = unc.match(path);
    if (!match.hasMatch() || path.contains(QChar(0))) return std::nullopt;
    QString suffix = match.captured(2);
    suffix.replace(QLatin1Char('\\'), QLatin1Char('/'));
    return FilePath{match.captured(1), QDir::cleanPath(QStringLiteral("/") + suffix)};
}

/** Use the host spelling shared by project registration and pi's WSL launch mapping. */
QString uncFilePath(const QString &linuxPath, const QString &distro)
{
    QString suffix = QDir::cleanPath(linuxPath).mid(1);
    suffix.replace(QLatin1Char('/'), QLatin1Char('\\'));
    const QString root = QStringLiteral("\\\\wsl.localhost\\") + distro;
    return suffix.isEmpty() ? root : root + QLatin1Char('\\') + suffix;
}

} // namespace

QString toWindowsFilePath(const QString &path, bool wslEnabled, const QString &distro)
{
    // Native drives and UNC paths already name the host filesystem. Markdown's
    // /C:/ convention needs its leading URL slash removed before policy checks.
    static const QRegularExpression slashDrive(QStringLiteral("^/[A-Za-z]:[/\\\\]"));
    if (slashDrive.match(path).hasMatch()) return path.mid(1);
    if (const auto unc = parseUncFilePath(path)) return uncFilePath(unc->linuxPath, unc->distro);
    if (path.startsWith(QLatin1String("\\\\")) || path.startsWith(QLatin1String("//"))) return path;
    static const QRegularExpression mountedDrive(QStringLiteral("^/mnt/([A-Za-z])(?:/(.*))?$"));
    const QRegularExpressionMatch mount = mountedDrive.match(path);
    if (mount.hasMatch()) {
        QString suffix = mount.captured(2);
        suffix.replace(QLatin1Char('/'), QLatin1Char('\\'));
        return mount.captured(1).toUpper() + QStringLiteral(":\\") + suffix;
    }
    if (wslEnabled && !distro.isEmpty() && path.startsWith(QLatin1Char('/'))) {
        return uncFilePath(path, distro);
    }
    return path;
}

std::optional<bool> isFilePathInsideRoot(const QString &target, const QString &root)
{
    const auto targetPath = parseUncFilePath(target);
    const auto rootPath = parseUncFilePath(root);
    if (!targetPath && !rootPath) return std::nullopt;
    if (!targetPath || !rootPath
        || targetPath->distro.compare(rootPath->distro, Qt::CaseInsensitive) != 0) return false;
    if (targetPath->linuxPath == rootPath->linuxPath) return true;
    QString prefix = rootPath->linuxPath;
    if (!prefix.endsWith(QLatin1Char('/'))) prefix += QLatin1Char('/');
    return targetPath->linuxPath.startsWith(prefix, Qt::CaseSensitive);
}

} // namespace wsl
