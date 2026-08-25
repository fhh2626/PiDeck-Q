#include "NativeApplication.h"

#include <QCoreApplication>
#include <QDir>
#include <QStandardPaths>

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
    SetCurrentProcessExplicitAppUserModelID(L"com.ayuayue.pi-desktop");
#endif
}
