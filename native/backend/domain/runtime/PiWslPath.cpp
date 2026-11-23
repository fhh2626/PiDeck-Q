#include "PiLaunch.h"

#include "../wsl/WslEnvironment.h"

#include <QStringList>

/**
 * WSL launch path mapping and `WSLENV` name-list helpers (declared in PiLaunch.h).
 *
 * Kept in their own translation unit: `PiLaunch.cpp` owns resolution/argv/env assembly and
 * is already close to the file-size budget, while these four helpers are pure string
 * mapping with no dependency on the launch request.
 */
namespace pilaunch {

QString appendWslEnvName(const QString &value, const QString &name)
{
    if (value.isEmpty()) return name;
    const QStringList parts = value.split(QLatin1Char(':'), Qt::SkipEmptyParts);
    if (parts.contains(name)) return value;
    return value + QLatin1Char(':') + name;
}

QString withoutWslEnvName(const QString &value, const QString &name)
{
    QStringList kept;
    for (const QString &part : value.split(QLatin1Char(':'), Qt::SkipEmptyParts)) {
        // A name may carry a `/p`-style flag (`NAME/p`); compare the bare name only.
        if (part.section(QLatin1Char('/'), 0, 0) == name) continue;
        kept.append(part);
    }
    return kept.join(QLatin1Char(':'));
}

QString toWslLinuxPath(const QString &windowsPath, const QString &distro)
{
    if (windowsPath.isEmpty()) return windowsPath;
    // `\\wsl.localhost\<distro>\home\u` (or the legacy `\\wsl$\...`): the only UNC form with a
    // Linux equivalent. Without this the path would reach pi as `//wsl.localhost/...`, which
    // the distro cannot open (oracle `toWslLinuxPath` → `parseWslUncPath`).
    static const QRegularExpression unc(
        QStringLiteral("^[\\\\/]{2}(?:wsl\\$|wsl\\.localhost)[\\\\/]([^\\\\/]+)(?:[\\\\/](.*))?$"),
        QRegularExpression::CaseInsensitiveOption);
    const QRegularExpressionMatch uncMatch = unc.match(windowsPath);
    if (uncMatch.hasMatch()) {
        // A path from another distro has no meaning inside this one; the oracle throws
        // INVALID_WSL_PATH instead of silently reading the wrong project.
        if (!distro.isEmpty()
            && uncMatch.captured(1).compare(distro, Qt::CaseInsensitive) != 0) {
            return QString();
        }
        QString rest = uncMatch.captured(2);
        rest.replace(QLatin1Char('\\'), QLatin1Char('/'));
        return wsl::normalizeLinuxPath(QStringLiteral("/") + rest);
    }
    static const QRegularExpression drive(QStringLiteral("^([A-Za-z]):[\\\\/](.*)$"));
    const QRegularExpressionMatch match = drive.match(windowsPath);
    if (!match.hasMatch()) {
        if (windowsPath.startsWith(QLatin1Char('/'))) return wsl::normalizeLinuxPath(windowsPath);
        return QString(windowsPath).replace(QLatin1Char('\\'), QLatin1Char('/'));
    }
    QString rest = match.captured(2);
    rest.replace(QLatin1Char('\\'), QLatin1Char('/'));
    return QStringLiteral("/mnt/%1/%2").arg(match.captured(1).toLower(), rest);
}

QString toWindowsHostPath(const QString &linuxPath, const QString &distro)
{
    if (linuxPath.isEmpty()) return linuxPath;
    // A WSL UNC path is already the Windows form; keep it instead of degrading it to
    // `//wsl.localhost/...` (oracle `toWindowsHostPath` → `linuxPathToWslUnc`).
    static const QRegularExpression unc(
        QStringLiteral("^[\\\\/]{2}(?:wsl\\$|wsl\\.localhost)[\\\\/]([^\\\\/]+)(?:[\\\\/](.*))?$"),
        QRegularExpression::CaseInsensitiveOption);
    const QRegularExpressionMatch uncMatch = unc.match(linuxPath);
    if (uncMatch.hasMatch()) {
        QString rest = uncMatch.captured(2);
        rest.replace(QLatin1Char('\\'), QLatin1Char('/'));
        const QString suffix = wsl::normalizeLinuxPath(QStringLiteral("/") + rest).mid(1);
        QString windowsSuffix = suffix;
        windowsSuffix.replace(QLatin1Char('/'), QLatin1Char('\\'));
        const QString root = wsl::defaultUncRoot();
        return windowsSuffix.isEmpty()
            ? root + QLatin1Char('\\') + uncMatch.captured(1)
            : root + QLatin1Char('\\') + uncMatch.captured(1) + QLatin1Char('\\') + windowsSuffix;
    }
    static const QRegularExpression drive(QStringLiteral("^([A-Za-z]):[\\\\/](.*)$"));
    const QRegularExpressionMatch driveMatch = drive.match(linuxPath);
    if (driveMatch.hasMatch()) {
        QString rest = driveMatch.captured(2);
        rest.replace(QLatin1Char('/'), QLatin1Char('\\'));
        return driveMatch.captured(1).toUpper() + QStringLiteral(":\\") + rest;
    }
    static const QRegularExpression mount(QStringLiteral("^/mnt/([A-Za-z])(?:/(.*))?$"));
    const QRegularExpressionMatch match = mount.match(linuxPath);
    if (!match.hasMatch()) {
        // Any other absolute Linux path only exists inside the distro: the Windows host
        // reaches it through the UNC share (oracle `linuxPathToWslUnc`).
        return linuxPath.startsWith(QLatin1Char('/'))
            ? wsl::linuxPathToWslUnc(linuxPath, distro)
            : linuxPath;
    }
    QString rest = match.captured(2);
    rest.replace(QLatin1Char('/'), QLatin1Char('\\'));
    return match.captured(1).toUpper() + QStringLiteral(":\\") + rest;
}

} // namespace pilaunch
