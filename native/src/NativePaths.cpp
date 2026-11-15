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
    paths.nativeNodeEntry = qEnvironmentVariable("PIDECK_NATIVE_NODE_ENTRY");
    if (paths.nativeNodeEntry.isEmpty()) {
        paths.nativeNodeEntry = QDir(paths.appDir).filePath("native-node/index.cjs");
    }
    paths.nodeExecutable = qEnvironmentVariable("PIDECK_NODE_EXECUTABLE");
    if (paths.nodeExecutable.isEmpty()) {
#ifdef Q_OS_WIN
        paths.nodeExecutable = root.filePath("node/node.exe");
#else
        paths.nodeExecutable = root.filePath("node/bin/node");
#endif
    }
    paths.sidecarKind = qEnvironmentVariable("PIDECK_SIDECAR_KIND").trimmed().toLower();
    // The build that produced this executable also staged the sidecar beside it, so the
    // compile-time kind is the default: a packaged release must not need an environment
    // opt-in, and it must never look for node.exe that the C++ package does not ship.
    // PIDECK_SIDECAR_KIND still overrides the choice (tests, compatibility runs).
    if (paths.sidecarKind.isEmpty()) {
#ifdef PIDECK_DEFAULT_SIDECAR_KIND
        paths.sidecarKind = QString::fromLatin1(PIDECK_DEFAULT_SIDECAR_KIND);
#else
        paths.sidecarKind = QStringLiteral("cpp");
#endif
    }
    if (paths.sidecarKind == QStringLiteral("node")) {
        paths.sidecarExecutable = paths.nodeExecutable;
        paths.sidecarArguments = QStringList{paths.nativeNodeEntry};
    } else if (paths.sidecarKind == QStringLiteral("cpp")) {
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
    } else {
        // Neither known sidecar may be substituted for an unknown kind: report the value
        // (bounded, it is an input string) and leave the process without a sidecar so
        // main() can refuse to start instead of silently launching the wrong backend.
        paths.sidecarKindError = QStringLiteral("Unsupported PIDECK_SIDECAR_KIND \"%1\": expected \"cpp\" or \"node\"")
                                     .arg(qEnvironmentVariable("PIDECK_SIDECAR_KIND").trimmed().left(32));
        paths.sidecarKind.clear();
        paths.sidecarExecutable.clear();
        paths.sidecarArguments.clear();
    }
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
