#pragma once

#include <QString>
#include <QStringList>

struct NativePaths {
    QString applicationDir;
    QString appDir;
    QString rendererDir;
    QString nativeNodeEntry;
    QString nodeExecutable;
    // "cpp" (packaged default) starts PiDeckBackend.exe; "node" is the documented
    // compatibility build of the legacy Node sidecar. Anything else is rejected.
    QString sidecarKind;
    QString sidecarExecutable;
    QStringList sidecarArguments;
    // Non-empty only for an unsupported sidecar kind. The host refuses to start rather
    // than substituting the other sidecar for a typo in the configuration.
    QString sidecarKindError;
    QString resourcesDir;
    QString userDataDir;
    QString downloadsDir;
    QString version;
    bool packaged = false;

    static NativePaths fromEnvironment();
};
