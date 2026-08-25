#include "ClipboardController.h"
#include "HostRpcServer.h"
#include "MainWindow.h"
#include "NativeApplication.h"
#include "NativePaths.h"
#include "NodeProcessController.h"
#include "ProtocolRegistrar.h"
#include "TrayController.h"
#include "WindowsToastNotifier.h"

#include <QtWebView/QtWebView>

#include <QApplication>
#include <QDesktopServices>
#include <QDialog>
#include <QDir>
#include <QFile>
#include <QFileDialog>
#include <QFileInfo>
#include <QIcon>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QMenu>
#include <QMetaObject>
#include <QPalette>
#include <QProcess>
#include <QStandardPaths>
#include <QUrl>
#include <QUrlQuery>

#include <stdexcept>

namespace {
QJsonArray stringListToJson(const QStringList &values)
{
    QJsonArray result;
    for (const QString &value : values) result.append(value);
    return result;
}

QStringList dialogFilters(const QJsonArray &rawFilters)
{
    QStringList filters;
    for (const QJsonValue &raw : rawFilters) {
        const QJsonObject filter = raw.toObject();
        const QString name = filter.value(QStringLiteral("name")).toString();
        const QJsonArray extensions = filter.value(QStringLiteral("extensions")).toArray();
        QStringList patterns;
        for (const QJsonValue &extension : extensions) {
            const QString value = extension.toString().trimmed();
            if (!value.isEmpty()) patterns.append(value.startsWith('.') ? QStringLiteral("*%1").arg(value)
                                                                         : QStringLiteral("*.%1").arg(value));
        }
        if (!patterns.isEmpty()) filters.append(QStringLiteral("%1 (%2)").arg(name, patterns.join(' ')));
    }
    return filters;
}

QJsonObject openDialog(const QJsonObject &params, QWidget *parent)
{
    const QString title = params.value(QStringLiteral("title")).toString();
    const QString defaultPath = params.value(QStringLiteral("defaultPath")).toString();
    const QStringList filters = dialogFilters(params.value(QStringLiteral("filters")).toArray());
    const QJsonArray properties = params.value(QStringLiteral("properties")).toArray();
    bool openDirectory = false;
    bool openFile = false;
    bool multiple = false;
    for (const QJsonValue &property : properties) {
        const QString value = property.toString();
        openDirectory = openDirectory || value == QStringLiteral("openDirectory");
        openFile = openFile || value == QStringLiteral("openFile");
        multiple = multiple || value == QStringLiteral("multiSelections");
    }

    const auto configure = [&](QFileDialog &dialog) {
        dialog.setWindowTitle(title);
        dialog.setAcceptMode(QFileDialog::AcceptOpen);
        if (!filters.isEmpty()) dialog.setNameFilters(filters);
        if (!defaultPath.isEmpty()) {
            const QFileInfo info(defaultPath);
            dialog.setDirectory(info.isDir() ? info.absoluteFilePath() : info.absolutePath());
            if (!info.isDir()) dialog.selectFile(info.fileName());
        }
    };
    const auto selectFiles = [&]() {
        QFileDialog dialog(parent);
        configure(dialog);
        dialog.setFileMode(multiple ? QFileDialog::ExistingFiles : QFileDialog::ExistingFile);
        return dialog.exec() == QDialog::Accepted ? dialog.selectedFiles() : QStringList{};
    };
    const auto selectDirectories = [&]() {
        QStringList selected;
        do {
            QFileDialog dialog(parent);
            configure(dialog);
            dialog.setFileMode(QFileDialog::Directory);
            dialog.setOption(QFileDialog::ShowDirsOnly, true);
            if (dialog.exec() != QDialog::Accepted) break;
            selected.append(dialog.selectedFiles());
        } while (multiple);
        return selected;
    };

    // Qt's native Windows dialog cannot express Electron's mixed file+folder
    // mode in one picker. Preserve the contract by collecting each requested
    // kind in sequence rather than silently dropping one kind; multi-directory
    // selection repeats the folder picker until the user cancels.
    QStringList paths;
    if (openFile || !openDirectory) paths.append(selectFiles());
    if (openDirectory) paths.append(selectDirectories());
    return QJsonObject{
        {QStringLiteral("canceled"), paths.isEmpty()},
        {QStringLiteral("filePaths"), stringListToJson(paths)},
    };
}

QJsonObject saveDialog(const QJsonObject &params, QWidget *parent)
{
    QFileDialog dialog(parent);
    dialog.setWindowTitle(params.value(QStringLiteral("title")).toString());
    dialog.setAcceptMode(QFileDialog::AcceptSave);
    dialog.setFileMode(QFileDialog::AnyFile);
    if (const QStringList filters = dialogFilters(params.value(QStringLiteral("filters")).toArray()); !filters.isEmpty()) {
        dialog.setNameFilters(filters);
    }
    const QString defaultPath = params.value(QStringLiteral("defaultPath")).toString();
    if (!defaultPath.isEmpty()) {
        const QFileInfo info(defaultPath);
        dialog.setDirectory(info.isDir() ? info.absoluteFilePath() : info.absolutePath());
        if (!info.isDir()) dialog.selectFile(info.fileName());
    }
    const QString path = dialog.exec() == QDialog::Accepted && !dialog.selectedFiles().isEmpty()
        ? dialog.selectedFiles().constFirst()
        : QString{};
    return QJsonObject{
        {QStringLiteral("canceled"), path.isEmpty()},
        {QStringLiteral("filePath"), path},
    };
}

void applyThemeSource(const QString &source)
{
    if (source == QStringLiteral("dark")) {
        QPalette palette;
        palette.setColor(QPalette::Window, QColor("#121212"));
        palette.setColor(QPalette::WindowText, QColor("#f4f4f5"));
        QApplication::setPalette(palette);
    } else if (source == QStringLiteral("light")) {
        QApplication::setPalette(QPalette{});
    } else {
        QApplication::setPalette(QPalette{});
    }
}
}

int main(int argc, char **argv)
{
    // Qt WebView must initialize its backend before QApplication/QGuiApplication.
    QtWebView::initialize();
    QApplication app(argc, argv);
    app.setOrganizationName(QStringLiteral("PiDeck"));
    app.setApplicationName(QStringLiteral("PiDeck-Q"));
    app.setApplicationVersion(qEnvironmentVariable("PIDECK_VERSION", QStringLiteral("0.1.5")));
    const NativePaths paths = NativePaths::fromEnvironment();
    NativeApplication::configure(paths);
    const QString iconPath = qEnvironmentVariable("PIDECK_ICON_PATH").isEmpty()
        ? QDir(paths.applicationDir).filePath("icon.png")
        : qEnvironmentVariable("PIDECK_ICON_PATH");
    app.setWindowIcon(QIcon(iconPath));
    app.setApplicationDisplayName(QStringLiteral("PiDeck-Q"));
    app.setQuitOnLastWindowClosed(false);

    HostRpcServer host;
    if (!host.start()) return 1;
    NodeProcessController node(paths, &host);
    MainWindow *mainWindow = nullptr;
    TrayController *tray = nullptr;
    bool quitting = false;
    bool restartRequested = false;

    node.setNodeErrorHandler([&](const QString &) {
        if (!quitting) app.quit();
    });
    node.setNodeExitHandler([&](int, QProcess::ExitStatus) {
        if (!quitting) app.quit();
    });

    ClipboardController clipboard([&host](const QJsonObject &snapshot) {
        host.sendEvent(QStringLiteral("native.clipboard"), snapshot);
    });

    host.registerHandler(QStringLiteral("clipboard.snapshot"), [&clipboard](const QJsonObject &) {
        return QJsonValue(clipboard.snapshot());
    });
    host.registerHandler(QStringLiteral("dialog.open"), [&mainWindow](const QJsonObject &params) {
        QWidget *parent = params.value(QStringLiteral("parent")).toString() == QStringLiteral("none")
            ? nullptr
            : mainWindow;
        return QJsonValue(openDialog(params, parent));
    });
    host.registerHandler(QStringLiteral("dialog.save"), [&mainWindow](const QJsonObject &params) {
        QWidget *parent = params.value(QStringLiteral("parent")).toString() == QStringLiteral("none")
            ? nullptr
            : mainWindow;
        return QJsonValue(saveDialog(params, parent));
    });
    host.registerHandler(QStringLiteral("shell.openExternal"), [](const QJsonObject &params) {
        const QString url = params.value(QStringLiteral("url")).toString();
        return QJsonValue(QDesktopServices::openUrl(QUrl(url)));
    });
    host.registerHandler(QStringLiteral("shell.openPath"), [](const QJsonObject &params) {
        const QString path = params.value(QStringLiteral("path")).toString();
        const bool ok = QDesktopServices::openUrl(QUrl::fromLocalFile(path));
        return QJsonValue(QJsonObject{{QStringLiteral("ok"), ok}, {QStringLiteral("error"), ok ? QString{} : QStringLiteral("Unable to open path")}});
    });
    host.registerHandler(QStringLiteral("shell.showItemInFolder"), [](const QJsonObject &params) {
        const QString path = params.value(QStringLiteral("path")).toString();
#ifdef Q_OS_WIN
        QProcess::startDetached(QStringLiteral("explorer.exe"), {
            QStringLiteral("/select,%1").arg(QDir::toNativeSeparators(path)),
        });
#else
        QDesktopServices::openUrl(QUrl::fromLocalFile(QFileInfo(path).absolutePath()));
#endif
        return QJsonValue(QJsonValue::Null);
    });
    host.registerHandler(QStringLiteral("shell.trashItem"), [](const QJsonObject &params) {
        const bool ok = QFile::moveToTrash(params.value(QStringLiteral("path")).toString());
        if (!ok) throw std::runtime_error("Unable to move item to trash");
        return QJsonValue(QJsonValue::Null);
    });
    host.registerHandler(QStringLiteral("theme.setSource"), [](const QJsonObject &params) {
        applyThemeSource(params.value(QStringLiteral("source")).toString());
        return QJsonValue(QJsonValue::Null);
    });
    host.registerHandler(QStringLiteral("window.minimize"), [&mainWindow](const QJsonObject &) {
        if (mainWindow) mainWindow->minimizeWindow();
        return QJsonValue(QJsonValue::Null);
    });
    host.registerHandler(QStringLiteral("window.maximize"), [&mainWindow](const QJsonObject &) {
        if (mainWindow) mainWindow->showMaximized();
        return QJsonValue(QJsonValue::Null);
    });
    host.registerHandler(QStringLiteral("window.unmaximize"), [&mainWindow](const QJsonObject &) {
        if (mainWindow) mainWindow->showNormal();
        return QJsonValue(QJsonValue::Null);
    });
    host.registerHandler(QStringLiteral("window.toggleMaximize"), [&mainWindow](const QJsonObject &) {
        return QJsonValue(mainWindow ? mainWindow->toggleMaximize() : false);
    });
    host.registerHandler(QStringLiteral("window.isMaximized"), [&mainWindow](const QJsonObject &) {
        return QJsonValue(mainWindow && mainWindow->isMaximizedWindow());
    });
    host.registerHandler(QStringLiteral("window.toggleAlwaysOnTop"), [&mainWindow](const QJsonObject &) {
        return QJsonValue(mainWindow ? mainWindow->toggleAlwaysOnTop() : false);
    });
    host.registerHandler(QStringLiteral("window.close"), [&mainWindow](const QJsonObject &) {
        if (mainWindow) mainWindow->closeFromHost();
        return QJsonValue(QJsonValue::Null);
    });
    host.registerHandler(QStringLiteral("window.reload"), [&mainWindow](const QJsonObject &) {
        if (mainWindow) mainWindow->reload();
        return QJsonValue(QJsonValue::Null);
    });
    host.registerHandler(QStringLiteral("window.focus"), [&mainWindow](const QJsonObject &) {
        if (mainWindow) mainWindow->focusWindow();
        return QJsonValue(QJsonValue::Null);
    });
    host.registerHandler(QStringLiteral("window.restore"), [&mainWindow](const QJsonObject &) {
        if (mainWindow) mainWindow->restoreWindow();
        return QJsonValue(QJsonValue::Null);
    });
    host.registerHandler(QStringLiteral("window.show"), [&mainWindow](const QJsonObject &) {
        if (mainWindow) mainWindow->showWindow();
        return QJsonValue(QJsonValue::Null);
    });
    host.registerHandler(QStringLiteral("window.applySettings"), [&mainWindow](const QJsonObject &params) {
        if (mainWindow) mainWindow->applySettings(params);
        return QJsonValue(QJsonValue::Null);
    });
    host.registerHandler(QStringLiteral("window.beginSystemMove"), [&mainWindow](const QJsonObject &) {
        if (mainWindow) mainWindow->beginSystemMove();
        return QJsonValue(QJsonValue::Null);
    });
    host.registerHandler(QStringLiteral("window.toggleDevTools"), [&mainWindow](const QJsonObject &) {
        if (mainWindow) mainWindow->toggleDevTools();
        return QJsonValue(QJsonValue::Null);
    });
    host.registerHandler(QStringLiteral("application.hideMenu"), [](const QJsonObject &) {
        QApplication::setApplicationDisplayName(QStringLiteral("PiDeck-Q"));
        return QJsonValue(QJsonValue::Null);
    });
    host.registerHandler(QStringLiteral("application.exitSecondary"), [&app](const QJsonObject &) {
        app.quit();
        return QJsonValue(QJsonValue::Null);
    });
    host.registerHandler(QStringLiteral("application.quit"), [&app, &quitting, &mainWindow](const QJsonObject &) {
        quitting = true;
        if (mainWindow) mainWindow->setQuitting(true);
        app.quit();
        return QJsonValue(QJsonValue::Null);
    });
    host.registerHandler(QStringLiteral("application.restart"), [&app, &quitting, &restartRequested, &mainWindow](const QJsonObject &) {
        // The replacement process must start only after the sidecar releases
        // the version lock; otherwise the new sidecar can exit as secondary.
        restartRequested = true;
        quitting = true;
        if (mainWindow) mainWindow->setQuitting(true);
        app.quit();
        return QJsonValue(QJsonValue::Null);
    });
    host.registerHandler(QStringLiteral("tray.update"), [&tray](const QJsonObject &params) {
        if (tray) tray->update(params);
        return QJsonValue(QJsonValue::Null);
    });
    host.registerHandler(QStringLiteral("notification.show"), [&host, &tray](const QJsonObject &params) {
        const QString id = params.value(QStringLiteral("id")).toString();
        const QString title = params.value(QStringLiteral("title")).toString();
        const QString body = params.value(QStringLiteral("body")).toString();
        const bool silent = params.value(QStringLiteral("silent")).toBool(false);
        const QString activationUrl = params.value(QStringLiteral("activationUrl")).toString();
        if (WindowsToastNotifier::isSupported()) {
            WindowsToastNotifier::show(id, title, body, silent, activationUrl,
                [&host, id] {
                    QMetaObject::invokeMethod(&host, [&host, id] {
                        host.sendEvent(QStringLiteral("notification.clicked"), QJsonObject{{QStringLiteral("id"), id}});
                    }, Qt::QueuedConnection);
                },
                [&host, id](const QString &error) {
                    QMetaObject::invokeMethod(&host, [&host, id, error] {
                        host.sendEvent(QStringLiteral("notification.failed"), QJsonObject{{QStringLiteral("id"), id}, {QStringLiteral("error"), error}});
                    }, Qt::QueuedConnection);
                });
        } else if (tray) {
            tray->showMessage(title, body, QSystemTrayIcon::Information, 5000);
        }
        return QJsonValue(QJsonValue::Null);
    });

    host.setEventHandler([&](const QString &name, const QJsonValue &payload) {
        if (name == QStringLiteral("renderer.ready")) {
            const QJsonObject ready = payload.toObject();
            if (mainWindow) return;
            const QJsonObject startup = ready.value(QStringLiteral("startup")).toObject();
            applyThemeSource(startup.value(QStringLiteral("theme")).toString(QStringLiteral("system")));
            mainWindow = new MainWindow(&host, startup);
            const QUrl baseUrl(ready.value(QStringLiteral("url")).toString());
            QUrlQuery query;
            query.addQueryItem(QStringLiteral("runtime"), QStringLiteral("native"));
            query.addQueryItem(QStringLiteral("token"), ready.value(QStringLiteral("token")).toString());
            QUrl pageUrl = baseUrl;
            pageUrl.setQuery(query);
            // Qt WebView2 must have its QWindow host mapped before navigation;
            // loading while the QMainWindow is hidden can complete the DOM load
            // but leave the native browser surface invisible.
            mainWindow->show();
            mainWindow->load(pageUrl);
            return;
        }
        if (name == QStringLiteral("application.readyToExit")) {
            node.markReadyToExit();
        }
    });

    // The installer owns the normal registration path; keep startup registration
    // as a repair/fallback for portable copies and upgrades.
    if (paths.packaged) ProtocolRegistrar::registerProtocol(QCoreApplication::applicationFilePath());

    if (!node.start()) return 1;
    tray = new TrayController(
        QIcon(iconPath),
        [&mainWindow] { if (mainWindow) mainWindow->showWindow(); },
        [&app, &quitting, &restartRequested, &mainWindow] {
            restartRequested = true;
            quitting = true;
            if (mainWindow) mainWindow->setQuitting(true);
            app.quit();
        },
        [&app, &quitting, &mainWindow] {
            quitting = true;
            if (mainWindow) mainWindow->setQuitting(true);
            app.quit();
        },
        &app);
    tray->setVisible(true);

    QObject::connect(&app, &QCoreApplication::aboutToQuit, [&] {
        quitting = true;
        if (mainWindow) mainWindow->setQuitting(true);
        node.stop();
    });

    const int exitCode = app.exec();
    if (mainWindow) {
        // MainWindow has no Qt delete-on-close ownership. All host callbacks
        // stop running once the event loop returns, so this is the sole owner.
        delete mainWindow;
        mainWindow = nullptr;
    }
    if (restartRequested) {
        QProcess::startDetached(QCoreApplication::applicationFilePath(),
                                 QCoreApplication::arguments().mid(1));
    }
    return exitCode;
}
