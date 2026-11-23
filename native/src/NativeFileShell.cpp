#include "NativeFileShell.h"
#include "../common/ScopedMutation.h"
#include <QFile>
#include <QDebug>
#include <stdexcept>

#include <QDesktopServices>
#include <QDir>
#include <QFileInfo>
#include <QProcess>
#include <QUrl>

QJsonObject revealNativeFile(const QString &path, const NativeUrlOpener &openUrl)
{
    const QFileInfo info(path);
    if (path.isEmpty() || !info.exists()) {
        return {{QStringLiteral("ok"), false}, {QStringLiteral("error"), QStringLiteral("File does not exist")}};
    }
    // An injectable URL opener keeps shell target/error tests independent of a
    // running desktop. Production always uses the platform's desktop service.
    const auto openLocalUrl = [&openUrl](const QUrl &url) {
        return openUrl ? openUrl(url) : QDesktopServices::openUrl(url);
    };
    // A directory link opens that directory itself. Revealing its parent would
    // make folder links behave differently from the system file manager.
    if (info.isDir()) {
        const bool ok = openLocalUrl(QUrl::fromLocalFile(info.absoluteFilePath()));
        return {{QStringLiteral("ok"), ok},
                {QStringLiteral("error"), ok ? QString() : QStringLiteral("Unable to open the folder")}};
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
    const bool ok = openLocalUrl(QUrl::fromLocalFile(info.absolutePath()));
    const QString error = ok ? QString() : QStringLiteral("Unable to open the containing folder");
#endif
    return {{QStringLiteral("ok"), ok}, {QStringLiteral("error"), error}};
}

QJsonValue trashNativeItem(const QJsonObject &params)
{
    QFile file(params.value(QStringLiteral("path")).toString());
    const bool scoped = params.contains(QStringLiteral("scope"));
    if (scoped && !params.value(QStringLiteral("scope")).isObject())
        throw std::runtime_error("Invalid session deletion scope");
    const bool ok = scoped
        ? scopedmutation::moveToTrash(scopedmutation::Root::fromJson(params.value(QStringLiteral("scope")).toObject()), file.fileName())
        : file.moveToTrash();
    if (!ok) {
        qWarning() << "Unable to move item to trash:" << (scoped ? QStringLiteral("Scoped native trash refused") : file.errorString());
        if (params.value(QStringLiteral("typedFailure")).toBool())
            return QJsonObject{{QStringLiteral("status"), QStringLiteral("trash-failed")}};
        throw std::runtime_error("Unable to move item to trash");
    }
    return QJsonValue(QJsonValue::Null);
}
