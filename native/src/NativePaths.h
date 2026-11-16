#pragma once

#include <QString>
#include <QStringList>

struct NativePaths {
    QString applicationDir;
    QString appDir;
    QString rendererDir;
    // The Qt host supervises the native business backend as a separate process.
    QString sidecarExecutable;
    QStringList sidecarArguments;
    QString resourcesDir;
    QString userDataDir;
    QString downloadsDir;
    QString version;
    bool packaged = false;

    static NativePaths fromEnvironment();
};
