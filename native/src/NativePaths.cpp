#include "NativePaths.h"

#include <QCoreApplication>
#include <QDir>
#include <QProcess>
#include <QStandardPaths>

NativePaths NativePaths::fromEnvironment()
{
    NativePaths paths;
    paths.applicationDir = QCoreApplication::applicationDirPath();
    const QDir root(paths.applicationDir);

    paths.appDir = qEnvironmentVariable("PIDECK_APP_DIR");
    if (paths.appDir.isEmpty()) {
        paths.appDir = root.filePath("app");
    }
    paths.rendererDir = qEnvironmentVariable("PIDECK_RENDERER_DIR");
    if (paths.rendererDir.isEmpty()) {
        paths.rendererDir = QDir(paths.appDir).filePath("renderer");
    }
    paths.sidecarExecutable = qEnvironmentVariable("PIDECK_SIDECAR_EXECUTABLE").trimmed();
    if (paths.sidecarExecutable.isEmpty()) {
#ifdef Q_OS_WIN
        paths.sidecarExecutable = root.filePath("PiDeckBackend.exe");
#else
        paths.sidecarExecutable = root.filePath("PiDeckBackend");
#endif
    }
    const QString arguments = qEnvironmentVariable("PIDECK_SIDECAR_ARGS");
    if (!arguments.trimmed().isEmpty()) paths.sidecarArguments = QProcess::splitCommand(arguments);
    paths.resourcesDir = qEnvironmentVariable("PIDECK_RESOURCES_DIR");
    if (paths.resourcesDir.isEmpty()) {
        paths.resourcesDir = root.filePath("resources");
    }
    const QString packagedOverride = qEnvironmentVariable("PIDECK_PACKAGED");
#ifdef PIDECK_NATIVE_PACKAGED
    const bool compiledPackaged = PIDECK_NATIVE_PACKAGED != 0;
#else
    const bool compiledPackaged = false;
#endif
    paths.packaged = packagedOverride.isEmpty()
        ? compiledPackaged
        : packagedOverride == QStringLiteral("1");

    // Window-station isolation does not isolate HKCU or the user's Start Menu.
    // Keep normal registration, but let unattended fixtures opt out of global
    // shell integration; its implementations are tested against private targets.
    paths.registerDesktopIntegration = qEnvironmentVariable("PIDECK_REGISTER_DESKTOP_INTEGRATION") != QStringLiteral("0");
    paths.userDataDir = qEnvironmentVariable("PIDECK_USER_DATA");
    if (paths.userDataDir.isEmpty()) {
        paths.userDataDir = QStandardPaths::writableLocation(QStandardPaths::AppDataLocation);
        if (!paths.packaged) paths.userDataDir += QStringLiteral("-dev");
    }
    paths.downloadsDir = qEnvironmentVariable("PIDECK_DOWNLOADS_PATH").trimmed();
    if (paths.downloadsDir.isEmpty()) {
        paths.downloadsDir = QStandardPaths::writableLocation(QStandardPaths::DownloadLocation);
    }
    if (paths.downloadsDir.isEmpty()) {
        paths.downloadsDir = QDir(paths.userDataDir).filePath(QStringLiteral("Downloads"));
    }
    paths.version = qEnvironmentVariable("PIDECK_VERSION");
    if (paths.version.isEmpty()) {
        paths.version = QCoreApplication::applicationVersion();
    }
    return paths;
}
