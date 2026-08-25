#include "NativeApplication.h"

#include <QCoreApplication>
#include <QDir>
#include <QStandardPaths>

#include <string>

#ifdef Q_OS_WIN
#include <windows.h>
#include <shobjidl.h>
#endif

void NativeApplication::configure(const NativePaths &paths)
{
    QCoreApplication::setApplicationName(QStringLiteral("PiDeck-Q"));
    QCoreApplication::setApplicationVersion(paths.version);
    QCoreApplication::setOrganizationName(QStringLiteral("PiDeck"));
    QDir().mkpath(paths.userDataDir);
#ifdef Q_OS_WIN
    const QString defaultAppUserModelId = paths.packaged
        ? QStringLiteral("com.ayuayue.pi-desktop")
        : QStringLiteral("com.ayuayue.pi-desktop-dev");
    const QString appUserModelId = qEnvironmentVariable("PIDECK_APP_USER_MODEL_ID", defaultAppUserModelId);
    qputenv("PIDECK_APP_USER_MODEL_ID", appUserModelId.toUtf8());
    const std::wstring appUserModelIdWide = appUserModelId.toStdWString();
    SetCurrentProcessExplicitAppUserModelID(appUserModelIdWide.c_str());
#endif
}
