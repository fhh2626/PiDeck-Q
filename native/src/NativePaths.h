#pragma once

#include <QString>

struct NativePaths {
    QString applicationDir;
    QString appDir;
    QString rendererDir;
    QString nativeNodeEntry;
    QString nodeExecutable;
    QString resourcesDir;
    QString userDataDir;
    QString downloadsDir;
    QString version;
    bool packaged = false;

    static NativePaths fromEnvironment();
};
