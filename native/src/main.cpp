#include "ClipboardController.h"
#include "HostRpcServer.h"
#include "MainWindow.h"
#include "NativeApplication.h"
#include "NativePaths.h"
#include "NativeTheme.h"
#include "NodeProcessController.h"
#include "ProtocolRegistrar.h"
#include "TrayController.h"
#include "WindowsToastNotifier.h"

#include <QtWebView/QtWebView>

#include <QAbstractButton>
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
#include <QMessageBox>
#include <QProcess>
#include <QPushButton>
#include <QSettings>
#include <QStyleHints>
#include <QUrl>
#include <QUrlQuery>

#include <functional>
#include <stdexcept>
#include <utility>

namespace {
#ifdef Q_OS_WIN
bool hasWebView2Runtime()
{
    const QString fixedRuntime = qEnvironmentVariable("WEBVIEW2_BROWSER_EXECUTABLE_FOLDER").trimmed();
    if (!fixedRuntime.isEmpty() && QFileInfo::exists(QDir(fixedRuntime).filePath(QStringLiteral("msedgewebview2.exe")))) {
        return true;
    }

    // Evergreen WebView2 registers the runtime version in both per-user and
    // machine EdgeUpdate hives. Check the 32-bit machine hive too because the
    // Qt/WebView2 loader used by x64 applications can still use that entry.
    const QString clientId = QStringLiteral("{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}");
    const QStringList registryKeys = {
        QStringLiteral("HKEY_CURRENT_USER\\Software\\Microsoft\\EdgeUpdate\\Clients\\") + clientId,
        QStringLiteral("HKEY_LOCAL_MACHINE\\Software\\Microsoft\\EdgeUpdate\\Clients\\") + clientId,
        QStringLiteral("HKEY_LOCAL_MACHINE\\Software\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients\\") + clientId,
    };
    for (const QString &key : registryKeys) {
        const QSettings settings(key, QSettings::NativeFormat);
        if (!settings.value(QStringLiteral("pv")).toString().trimmed().isEmpty()) return true;
    }
    return false;
}

void showMissingWebView2Message()
{
    QMessageBox message;
    message.setIcon(QMessageBox::Critical);
    message.setWindowTitle(QStringLiteral("PiDeck-Q"));
    message.setText(QStringLiteral("Microsoft Edge WebView2 Runtime is required to run PiDeck-Q."));
    message.setInformativeText(QStringLiteral("Install the Evergreen WebView2 Runtime, then start PiDeck-Q again."));
    QAbstractButton *download = message.addButton(QStringLiteral("Download WebView2"), QMessageBox::AcceptRole);
    message.addButton(QMessageBox::Close);
    message.exec();
    if (message.clickedButton() == download) {
        QDesktopServices::openUrl(QUrl(QStringLiteral("https://developer.microsoft.com/microsoft-edge/webview2/")));
    }
}
#endif

QJsonArray stringListToJson(const QStringList &values)
{
    QJsonArray result;
    for (const QString &value : values) result.append(value);
    return result;
}

Qt::Edges resizeEdges(const QString &value)
{
    if (value == QStringLiteral("top")) return Qt::TopEdge;
    if (value == QStringLiteral("bottom")) return Qt::BottomEdge;
    if (value == QStringLiteral("left")) return Qt::LeftEdge;
    if (value == QStringLiteral("right")) return Qt::RightEdge;
    if (value == QStringLiteral("top-left")) return Qt::TopEdge | Qt::LeftEdge;
    if (value == QStringLiteral("top-right")) return Qt::TopEdge | Qt::RightEdge;
    if (value == QStringLiteral("bottom-left")) return Qt::BottomEdge | Qt::LeftEdge;
    if (value == QStringLiteral("bottom-right")) return Qt::BottomEdge | Qt::RightEdge;
    return {};
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
    bool multiple = false;
    for (const QJsonValue &property : properties) {
        const QString value = property.toString();
        openDirectory = openDirectory || value == QStringLiteral("openDirectory");
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
        QFileDialog dialog(parent);
        configure(dialog);
        dialog.setFileMode(QFileDialog::Directory);
        dialog.setOption(QFileDialog::ShowDirsOnly, true);
        return dialog.exec() == QDialog::Accepted ? dialog.selectedFiles() : QStringList{};
    };

    // Qt's native Windows dialog cannot express Electron's mixed file+folder
    // mode in one picker. A request must therefore select one kind only; never
    // open a second picker or repeat a directory picker after the user made a
    // choice/cancelled it.
    const QStringList paths = openDirectory ? selectDirectories() : selectFiles();
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

}

int main(int argc, char **argv)
{
    // Qt WebView must initialize its backend before QApplication/QGuiApplication.
    QtWebView::initialize();
    QApplication app(argc, argv);
    const bool nativeNotificationsAvailable = WindowsToastNotifier::initialize()
        && WindowsToastNotifier::registerApplication(QCoreApplication::applicationFilePath());
    const bool trayNotificationsAvailable = QSystemTrayIcon::isSystemTrayAvailable()
        && QSystemTrayIcon::supportsMessages();
    const bool nativeNotificationRouteAvailable = nativeNotificationsAvailable || trayNotificationsAvailable;
    qputenv("PIDECK_NATIVE_NOTIFICATIONS", nativeNotificationRouteAvailable
        ? QByteArrayLiteral("1")
        : QByteArrayLiteral("0"));
    QString nativeThemeSource = QStringLiteral("system");
    const auto setNativeThemeSource = [&nativeThemeSource](const QString &source) {
        nativeThemeSource = source == QStringLiteral("dark") || source == QStringLiteral("light")
            ? source
            : QStringLiteral("system");
        applyNativeThemeSource(nativeThemeSource);
    };
    QObject::connect(QGuiApplication::styleHints(), &QStyleHints::colorSchemeChanged, &app,
                     [&nativeThemeSource] {
        if (nativeThemeSource == QStringLiteral("system")) applyNativeThemeSource(nativeThemeSource);
    });
    QObject::connect(&app, &QCoreApplication::aboutToQuit, [] {
        WindowsToastNotifier::uninitialize();
    });
    app.setOrganizationName(QStringLiteral("PiDeck"));
    app.setApplicationName(QStringLiteral("PiDeck-Q"));
#ifdef PIDECK_BUILD_VERSION
    const QString nativeBuildVersion = QStringLiteral(PIDECK_BUILD_VERSION);
#else
    const QString nativeBuildVersion = QStringLiteral("0.0.0");
#endif
    app.setApplicationVersion(qEnvironmentVariable("PIDECK_VERSION", nativeBuildVersion));
    const NativePaths paths = NativePaths::fromEnvironment();
    NativeApplication::configure(paths);
    const QString iconPath = qEnvironmentVariable("PIDECK_ICON_PATH").isEmpty()
        ? QDir(paths.applicationDir).filePath("icon.png")
        : qEnvironmentVariable("PIDECK_ICON_PATH");
    app.setWindowIcon(QIcon(iconPath));
    app.setApplicationDisplayName(QStringLiteral("PiDeck-Q"));
    app.setQuitOnLastWindowClosed(false);

#ifdef Q_OS_WIN
    if (!hasWebView2Runtime()) {
        showMissingWebView2Message();
        return 1;
    }
#endif

    HostRpcServer host;
    if (!host.start()) return 1;
    NodeProcessController node(paths, &host);
    MainWindow *mainWindow = nullptr;
    TrayController *tray = nullptr;
    bool quitting = false;
    bool restartRequested = false;
    bool quitRequested = false;
    std::function<void()> requestQuit;
    requestQuit = [&] {
        if (quitRequested) return;
        quitRequested = true;
        quitting = true;
        if (mainWindow) mainWindow->setQuitting(true);
        // Keep the Qt event loop alive until the sidecar has acknowledged that
        // Backend.dispose and the version-lock cleanup are complete.
        node.stopAsync([&] { app.quit(); });
    };

    node.setNodeErrorHandler([&](const QString &) {
        if (!quitting) requestQuit();
    });
    node.setNodeExitHandler([&](int, QProcess::ExitStatus) {
        if (!quitting) requestQuit();
    });

    ClipboardController clipboard([&host](const QJsonObject &snapshot) {
        host.sendEvent(QStringLiteral("native.clipboard"), snapshot);
    });

    host.registerAsyncHandler(QStringLiteral("clipboard.snapshot"), [&clipboard](
        const QJsonObject &, HostRpcServer::AsyncResponder respond) {
        clipboard.snapshotAsync([respond = std::move(respond)](const QJsonObject &snapshot) {
            respond(snapshot, {});
        });
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
    host.registerHandler(QStringLiteral("theme.setSource"), [&setNativeThemeSource](const QJsonObject &params) {
        setNativeThemeSource(params.value(QStringLiteral("source")).toString());
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
    host.registerHandler(QStringLiteral("window.load"), [&mainWindow](const QJsonObject &params) {
        if (mainWindow) mainWindow->load(QUrl(params.value(QStringLiteral("url")).toString()));
        return QJsonValue(QJsonValue::Null);
    });
    host.registerHandler(QStringLiteral("window.showLoadError"), [&mainWindow](const QJsonObject &params) {
        if (mainWindow) {
            mainWindow->showLoadError(
                params.value(QStringLiteral("url")).toString(),
                params.value(QStringLiteral("error")).toString());
        }
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
    host.registerHandler(QStringLiteral("window.beginSystemResize"), [&mainWindow](const QJsonObject &params) {
        const Qt::Edges edges = resizeEdges(params.value(QStringLiteral("edge")).toString());
        return QJsonValue(mainWindow && mainWindow->beginSystemResize(edges));
    });
    host.registerHandler(QStringLiteral("window.toggleDevTools"), [&mainWindow](const QJsonObject &) {
        if (mainWindow) mainWindow->toggleDevTools();
        return QJsonValue(QJsonValue::Null);
    });
    host.registerHandler(QStringLiteral("application.hideMenu"), [](const QJsonObject &) {
        QApplication::setApplicationDisplayName(QStringLiteral("PiDeck-Q"));
        return QJsonValue(QJsonValue::Null);
    });
    host.registerHandler(QStringLiteral("application.exitSecondary"), [&requestQuit](const QJsonObject &) {
        requestQuit();
        return QJsonValue(QJsonValue::Null);
    });
    host.registerHandler(QStringLiteral("application.quit"), [&requestQuit](const QJsonObject &) {
        requestQuit();
        return QJsonValue(QJsonValue::Null);
    });
    host.registerHandler(QStringLiteral("application.restart"), [&requestQuit, &restartRequested](const QJsonObject &) {
        // The replacement process must start only after the sidecar releases
        // the version lock; otherwise the new sidecar can exit as secondary.
        restartRequested = true;
        requestQuit();
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
        const auto result = [](const QString &backend, bool interactive) {
            return QJsonValue(QJsonObject{
                {QStringLiteral("backend"), backend},
                {QStringLiteral("interactive"), interactive},
            });
        };
        if (WindowsToastNotifier::isSupported()) {
            WindowsToastNotifier::show(id, title, body, silent, activationUrl,
                [&host, id] {
                    QMetaObject::invokeMethod(&host, [&host, id] {
                        host.sendEvent(QStringLiteral("notification.clicked"), QJsonObject{{QStringLiteral("id"), id}});
                    }, Qt::QueuedConnection);
                },
                [&host, id] {
                    QMetaObject::invokeMethod(&host, [&host, id] {
                        host.sendEvent(QStringLiteral("notification.dismissed"), QJsonObject{{QStringLiteral("id"), id}});
                    }, Qt::QueuedConnection);
                },
                [&host, &tray, id, title, body](const QString &error) {
                    QMetaObject::invokeMethod(&host, [&host, &tray, id, title, body, error] {
                        if (tray && tray->showMessage(title, body, QSystemTrayIcon::Information, 5000)) {
                            // Tray fallback has no event carrying a stable notification
                            // id, so report it as non-interactive and release the Node
                            // callback instead of misreporting a display failure.
                            host.sendEvent(QStringLiteral("notification.fallback"), QJsonObject{{QStringLiteral("id"), id}});
                        } else {
                            host.sendEvent(QStringLiteral("notification.failed"), QJsonObject{
                                {QStringLiteral("id"), id},
                                {QStringLiteral("error"), error},
                            });
                        }
                    }, Qt::QueuedConnection);
                });
            return result(QStringLiteral("toast"), true);
        }
        if (tray && tray->showMessage(title, body, QSystemTrayIcon::Information, 5000)) {
            return result(QStringLiteral("tray"), false);
        }
        return result(QStringLiteral("none"), false);
    });

    host.setEventHandler([&](const QString &name, const QJsonValue &payload) {
        if (name == QStringLiteral("renderer.ready")) {
            const QJsonObject ready = payload.toObject();
            if (mainWindow) return;
            const QJsonObject startup = ready.value(QStringLiteral("startup")).toObject();
            setNativeThemeSource(startup.value(QStringLiteral("theme")).toString(QStringLiteral("system")));
            mainWindow = new MainWindow(&host, startup);
            mainWindow->setQuitHandler(requestQuit);
            mainWindow->setTrayAvailableHandler([&tray] {
                return tray && tray->isAvailableAndVisible();
            });
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
        [&restartRequested, &requestQuit] {
            restartRequested = true;
            requestQuit();
        },
        [&requestQuit] {
            requestQuit();
        },
        &app);
    tray->setVisible(true);

    QObject::connect(&app, &QCoreApplication::aboutToQuit, [&] {
        // All normal paths use requestQuit()/stopAsync(). This bounded fallback
        // only covers an OS-level quit event that bypassed those paths.
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
