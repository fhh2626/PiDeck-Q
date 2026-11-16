#include "NativeFileShell.h"

#include <QDesktopServices>
#include <QDir>
#include <QFileInfo>
#include <QProcess>
#include <QUrl>

QJsonObject revealNativeFile(const QString &path)
{
    const QFileInfo info(path);
    if (path.isEmpty() || !info.exists()) {
        return {{QStringLiteral("ok"), false}, {QStringLiteral("error"), QStringLiteral("File does not exist")}};
    }
#ifdef Q_OS_WIN
    QProcess explorer;
    explorer.setProgram(QStringLiteral("explorer.exe"));
    // Explorer parses /select itself. Quote the path after the comma, rather
    // than asking QProcess to quote the whole option when it contains spaces.
    explorer.setNativeArguments(QStringLiteral("/select,\"%1\"").arg(QDir::toNativeSeparators(info.absoluteFilePath())));
    const bool ok = explorer.startDetached();
    const QString error = ok ? QString() : explorer.errorString();
#else
    const bool ok = QDesktopServices::openUrl(QUrl::fromLocalFile(info.absolutePath()));
    const QString error = ok ? QString() : QStringLiteral("Unable to open the containing folder");
#endif
    return {{QStringLiteral("ok"), ok}, {QStringLiteral("error"), error}};
}
