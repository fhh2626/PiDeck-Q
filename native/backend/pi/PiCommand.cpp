#include "PiCommand.h"

#include "ChildEnvironment.h"

#include <QDir>
#include <QFileInfo>
#include <QStandardPaths>

namespace picommand {
namespace {

QString settingString(const QJsonObject &settings, const QString &key)
{
    return settings.value(key).toString().trimmed();
}

bool settingBool(const QJsonObject &settings, const QString &key)
{
    return settings.value(key).toBool(false);
}

QString runtimeBinaryName(const QString &preference)
{
    if (preference == QLatin1String("bolt")) return QStringLiteral("pi-bolt");
    return QStringLiteral("pi");
}

QStringList candidateNames()
{
#ifdef Q_OS_WIN
    return {QStringLiteral("pi.cmd"), QStringLiteral("pi.exe"), QStringLiteral("pi")};
#else
    return {QStringLiteral("pi")};
#endif
}

/** PATH search only; the full locator additionally scans package-manager dirs. */
QString searchPath(const QString &name)
{
    const QStringList names = name == QLatin1String("pi") ? candidateNames() : QStringList{name};
    const QStringList dirs = QProcessEnvironment::systemEnvironment().value(QStringLiteral("PATH"))
                                 .split(QDir::listSeparator(), Qt::SkipEmptyParts);
    for (const QString &dir : dirs) {
        for (const QString &candidate : names) {
            const QString full = QDir(dir).filePath(candidate);
            if (QFileInfo(full).isFile()) return full;
        }
    }
    return QString();
}

bool isUnsupportedPowerShellShim(const QString &path)
{
    // The Windows PowerShell shim is no longer invoked; a stored pi.ps1 falls back to
    // automatic detection.
    return path.endsWith(QLatin1String(".ps1"), Qt::CaseInsensitive);
}

} // namespace

Invocation resolve(const QJsonObject &settings)
{
    const QString preference = settingString(settings, QStringLiteral("piRuntimePreference"));
    const QString customPath = settingString(settings, QStringLiteral("customPiPath"));
    const QString selectedPath = preference == QLatin1String("typescript")
        ? settingString(settings, QStringLiteral("piTypescriptPath"))
        : preference == QLatin1String("bolt")   ? settingString(settings, QStringLiteral("piBoltPath"))
                                                : QString();

    Invocation invocation;
    // An explicit user path wins, but only in automatic mode and only when it exists.
    if ((preference.isEmpty() || preference == QLatin1String("auto")) && !customPath.isEmpty()
        && !isUnsupportedPowerShellShim(customPath) && !customPath.startsWith(QLatin1String("wsl://"))
        && QFileInfo::exists(customPath)) {
        invocation.program = customPath;
        return invocation;
    }
#ifdef Q_OS_WIN
    const QString distro = settingString(settings, QStringLiteral("wslDistro"));
    const QString user = settingString(settings, QStringLiteral("wslUser"));
    if (settingBool(settings, QStringLiteral("wslEnabled")) && !distro.isEmpty() && !user.isEmpty()) {
        // WSL is a different runtime; a Windows-side path must not shadow it.
        invocation.program = QStringLiteral("wsl.exe");
        // No `--` separator and no `--cd`: identical to the oracle's CLI invocation
        // (`PiLocator.createInvocation(command, args)` without a wslCwd).
        invocation.arguments = QStringList{QStringLiteral("-d"), distro, QStringLiteral("-u"), user,
                                          runtimeBinaryName(preference)};
        invocation.viaWsl = true;
        return invocation;
    }
#endif
    if (!selectedPath.isEmpty() && !isUnsupportedPowerShellShim(selectedPath)) {
        invocation.program = selectedPath;
        return invocation;
    }
    const QString name = runtimeBinaryName(preference);
    const QString found = searchPath(name);
    invocation.program = found.isEmpty() ? name : found;
    return invocation;
}

QProcessEnvironment environment(const QJsonObject &settings, const Invocation &invocation)
{
    QProcessEnvironment env = childenv::sanitized();
    if (invocation.viaWsl) return env;
    // The resolved pi may be a .cmd shim that needs node from the same directory, so
    // its own directory goes first on PATH.
    const QString programDir = QFileInfo(invocation.program).absolutePath();
    QString path = env.value(QStringLiteral("PATH"));
    if (!programDir.isEmpty()) path = programDir + QDir::listSeparator() + path;
    env.insert(QStringLiteral("PATH"), path);
#ifdef Q_OS_WIN
    env.insert(QStringLiteral("Path"), path);
#endif
    Q_UNUSED(settings);
    return env;
}

} // namespace picommand
