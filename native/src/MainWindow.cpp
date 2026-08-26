#include "MainWindow.h"

#include "FileDropController.h"
#include "HostRpcServer.h"
#include "MainWebSurface.h"

#include <QtWebView/QWebView>
#include <QtWebView/QWebViewLoadingInfo>

#include <QApplication>
#include <QEvent>
#include <QKeyEvent>
#include <QMessageBox>
#include <QPushButton>
#include <QScreen>
#include <QUrl>
#include <QWindow>

#include <utility>

#ifdef Q_OS_WIN
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#endif

MainWindow::MainWindow(HostRpcServer *host, const QJsonObject &startup, QWidget *parent)
    : QMainWindow(parent),
      m_host(host),
      m_surface(new MainWebSurface(this)),
      m_fileDrop(new FileDropController([host](const QJsonObject &payload) {
          host->sendEvent(QStringLiteral("native.fileDrop"), payload);
      }, m_surface->view(), this)),
      m_closeToTray(startup.value(QStringLiteral("closeToTray")).toBool(true))
{
    setWindowTitle(QStringLiteral("PiDeck-Q"));
    setWindowIcon(QApplication::windowIcon());
    setAcceptDrops(true);
    setMinimumSize(880, 640);
    setCentralWidget(m_surface->container());
    m_surface->container()->setAcceptDrops(true);
    installEventFilter(m_fileDrop);
    m_surface->container()->installEventFilter(m_fileDrop);
    // WebView2 is a native QWindow child; parent QWidget filters are not
    // guaranteed to observe drag/drop events intercepted by the browser.
    m_surface->view()->installEventFilter(m_fileDrop);

    const bool useNativeTitleBar = startup.value(QStringLiteral("useNativeTitleBar")).toBool(false);
    if (!useNativeTitleBar) {
        setWindowFlag(Qt::FramelessWindowHint, true);
    }

    const QJsonObject bounds = startup.value(QStringLiteral("lastWindowBounds")).toObject();
    const int width = bounds.value(QStringLiteral("width")).toInt(1480);
    const int height = bounds.value(QStringLiteral("height")).toInt(960);
    resize(qMax(width, minimumWidth()), qMax(height, minimumHeight()));
    applyStartupMode(
        startup.value(QStringLiteral("startupWindowMode")).toString(QStringLiteral("last")),
        !bounds.isEmpty());

    connect(m_surface->view(), &QWebView::loadingChanged, this,
            [this](const QWebViewLoadingInfo &info) {
        if (info.status() == QWebViewLoadingInfo::LoadStatus::Failed) {
            m_loadFinished = false;
            m_host->sendEvent(QStringLiteral("window.loadFailed"), QJsonObject{
                {QStringLiteral("url"), info.url().toString()},
                {QStringLiteral("error"), info.errorString()},
            });
            return;
        }
        if (info.status() != QWebViewLoadingInfo::LoadStatus::Succeeded) return;
        m_loadFinished = true;
        showWindow();
        m_host->sendEvent(QStringLiteral("window.ready"), QJsonObject{});
    });
}

void MainWindow::load(const QUrl &url)
{
    m_surface->load(url);
}

void MainWindow::reload()
{
    m_surface->reload();
}

void MainWindow::focusWindow()
{
    if (isMinimized()) showNormal();
    if (!isVisible()) show();
    raise();
    activateWindow();
    m_surface->focus();
}

void MainWindow::minimizeWindow()
{
    showMinimized();
}

void MainWindow::restoreWindow()
{
    if (isMaximized()) showNormal();
    if (isMinimized()) showNormal();
    focusWindow();
}

void MainWindow::showWindow()
{
    show();
    focusWindow();
    emitVisible(true);
    emitMaximizedState();
    emitMinimizedState();
    emitFullScreenState();
}

bool MainWindow::toggleMaximize()
{
    if (isMaximized()) showNormal();
    else showMaximized();
    emitMaximizedState();
    return isMaximized();
}

bool MainWindow::toggleAlwaysOnTop()
{
    const bool next = !(windowFlags() & Qt::WindowStaysOnTopHint);
    setWindowFlag(Qt::WindowStaysOnTopHint, next);
    show();
    emitVisible(true);
    return next;
}

bool MainWindow::isMaximizedWindow() const
{
    return isMaximized();
}

void MainWindow::closeFromHost()
{
    // Match Electron BrowserWindow.close(): closeEvent decides whether this is
    // a tray hide or a real application quit based on closeToTray.
    close();
}

void MainWindow::setQuitting(bool quitting)
{
    m_quitting = quitting;
}

void MainWindow::setQuitHandler(std::function<void()> handler)
{
    m_quitHandler = std::move(handler);
}

void MainWindow::applySettings(const QJsonObject &settings)
{
    if (settings.contains(QStringLiteral("closeToTray"))) {
        m_closeToTray = settings.value(QStringLiteral("closeToTray")).toBool(m_closeToTray);
    }
    if (settings.contains(QStringLiteral("useNativeTitleBar"))) {
        const bool nativeTitleBar = settings.value(QStringLiteral("useNativeTitleBar")).toBool(false);
        setWindowFlag(Qt::FramelessWindowHint, !nativeTitleBar);
        show();
    }
}

void MainWindow::beginSystemMove()
{
    if (auto *handle = windowHandle()) handle->startSystemMove();
}

void MainWindow::showLoadError(const QString &url, const QString &error)
{
    QMessageBox message(this);
    message.setIcon(QMessageBox::Critical);
    message.setWindowTitle(QStringLiteral("PiDeck-Q"));
    message.setText(QStringLiteral("The renderer could not be loaded."));
    message.setInformativeText(QStringLiteral("%1\n%2").arg(error, url));
    auto *restart = message.addButton(QStringLiteral("Restart"), QMessageBox::AcceptRole);
    auto *exit = message.addButton(QStringLiteral("Exit"), QMessageBox::RejectRole);
    message.setDefaultButton(restart);
    message.exec();
    if (m_host) {
        m_host->sendEvent(QStringLiteral("window.loadErrorAction"), QJsonObject{
            {QStringLiteral("action"), message.clickedButton() == restart ? QStringLiteral("restart") : QStringLiteral("exit")},
        });
    } else if (message.clickedButton() == exit) {
        QCoreApplication::quit();
    }
}

void MainWindow::toggleDevTools()
{
    // QWebView intentionally has no private devtools API. On WebView2 the public
    // browser shortcuts F12, Ctrl+Shift+I and Ctrl+Shift+J are handled by the
    // backend; synthesize F12 for the IPC toggle and keep this path replaceable
    // by a direct WebView2 surface if the backend ignores it.
    auto *view = m_surface->view();
    m_surface->focus();
#ifdef Q_OS_WIN
    // QWebView is a native QWindow on Windows. Deliver the shortcut to that
    // HWND as well as posting a Qt event; the latter alone can stop at the Qt
    // wrapper instead of reaching WebView2's browser controller.
    const HWND hwnd = reinterpret_cast<HWND>(view->winId());
    if (hwnd) {
        SetFocus(hwnd);
        PostMessageW(hwnd, WM_KEYDOWN, VK_F12, 0);
        PostMessageW(hwnd, WM_KEYUP, VK_F12, 0);
    }
#endif
    QCoreApplication::postEvent(view, new QKeyEvent(QEvent::KeyPress, Qt::Key_F12, Qt::NoModifier));
    QCoreApplication::postEvent(view, new QKeyEvent(QEvent::KeyRelease, Qt::Key_F12, Qt::NoModifier));
}

void MainWindow::closeEvent(QCloseEvent *event)
{
    if (!m_quitting && m_closeToTray) {
        event->ignore();
        hide();
        emitVisible(false);
        return;
    }
    if (!m_quitting) m_quitting = true;
    emitBounds();
    emitVisible(false);
    // The host owns the asynchronous sidecar shutdown gate. Sending the event
    // instead of calling QCoreApplication::quit() keeps the event loop alive
    // until Node acknowledges Backend.dispose and lock cleanup.
    if (m_host) m_host->sendEvent(QStringLiteral("window.closed"), QJsonObject{});
    event->accept();
    if (m_quitHandler) m_quitHandler();
    else QCoreApplication::quit();
}

void MainWindow::dragEnterEvent(QDragEnterEvent *event)
{
    if (FileDropController::hasLocalFiles(event->mimeData())) event->acceptProposedAction();
    else event->ignore();
}

void MainWindow::dropEvent(QDropEvent *event)
{
    if (!FileDropController::hasLocalFiles(event->mimeData())) {
        event->ignore();
        return;
    }
    if (m_host) {
        const QPoint screenPosition = mapToGlobal(event->position().toPoint());
        m_host->sendEvent(QStringLiteral("native.fileDrop"),
                          FileDropController::payload(event->mimeData(), screenPosition));
    }
    event->acceptProposedAction();
}

void MainWindow::moveEvent(QMoveEvent *event)
{
    QMainWindow::moveEvent(event);
    emitBounds();
}

void MainWindow::resizeEvent(QResizeEvent *event)
{
    QMainWindow::resizeEvent(event);
    emitBounds();
}

void MainWindow::changeEvent(QEvent *event)
{
    QMainWindow::changeEvent(event);
    if (event->type() == QEvent::WindowStateChange) {
        emitMaximizedState();
        emitMinimizedState();
        emitFullScreenState();
    }
}

void MainWindow::emitMaximizedState()
{
    if (m_host) m_host->sendEvent(QStringLiteral("window.maximizedChanged"), isMaximized());
}

void MainWindow::emitMinimizedState()
{
    if (m_host) m_host->sendEvent(QStringLiteral("window.minimizedChanged"), isMinimized());
}

void MainWindow::emitFullScreenState()
{
    if (m_host) m_host->sendEvent(QStringLiteral("window.fullscreenChanged"), isFullScreen());
}

void MainWindow::emitBounds()
{
    if (!m_host || isMaximized() || isFullScreen()) return;
    const QRect rect = geometry();
    m_host->sendEvent(QStringLiteral("window.normalBoundsChanged"), QJsonObject{
        {QStringLiteral("width"), rect.width()},
        {QStringLiteral("height"), rect.height()},
    });
}

void MainWindow::emitVisible(bool visible)
{
    if (m_host) m_host->sendEvent(QStringLiteral("window.visibleChanged"), visible);
}

void MainWindow::applyStartupMode(const QString &mode, bool hasLastBounds)
{
    // Keep the first frame hidden until QWebView reports a successful load; only
    // set the state here so maximize/fullscreen never causes a visible layout jump.
    if (mode == QStringLiteral("fullscreen")) {
        setWindowState(windowState() | Qt::WindowFullScreen);
    } else if (mode == QStringLiteral("maximized") || (mode == QStringLiteral("last") && !hasLastBounds)) {
        setWindowState(windowState() | Qt::WindowMaximized);
    }
}
