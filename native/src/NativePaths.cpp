#include "NativePaths.h"

#include <QCoreApplication>
#include <QDir>
#include <QFileInfo>
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
    paths.resourcesDir = qEnvironmentVariable("PIDECK_RESOURCES_DIR");
    if (paths.resourcesDir.isEmpty()) {
        paths.resourcesDir = root.filePath("resources");
    }
    paths.userDataDir = qEnvironmentVariable("PIDECK_USER_DATA");
    if (paths.userDataDir.isEmpty()) {
        paths.userDataDir = QStandardPaths::writableLocation(QStandardPaths::AppDataLocation);
    }
    paths.downloadsDir = qEnvironmentVariable("PIDECK_DOWNLOADS_PATH");
    if (paths.downloadsDir.isEmpty()) {
        paths.downloadsDir = QStandardPaths::writableLocation(QStandardPaths::DownloadLocation);
    }
    paths.version = qEnvironmentVariable("PIDECK_VERSION");
    if (paths.version.isEmpty()) {
        paths.version = QCoreApplication::applicationVersion();
    }
    paths.packaged = qEnvironmentVariableIntValue("PIDECK_PACKAGED") == 1
        || QFileInfo::exists(paths.nativeNodeEntry);
    return paths;
}
