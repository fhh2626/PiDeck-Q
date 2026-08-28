#include "MainWindow.h"

#include "FileDropController.h"
#include "HostRpcServer.h"
#include "MainWebSurface.h"
#include "NativeWindowPolicy.h"
#include "StartupWindowBounds.h"

#include <QtWebView/QWebView>
#include <QtWebView/QWebViewLoadingInfo>

#include <QApplication>
#include <QEvent>
#include <QHideEvent>
#include <QKeyEvent>
#include <QMessageBox>
#include <QShowEvent>
#include <QPushButton>
#include <QScreen>
#include <QSize>
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
      m_surface(std::make_unique<MainWebSurface>(this)),
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
    // The web surface is a native QWindow child; parent QWidget filters are not
    // guaranteed to observe drag/drop events intercepted by the browser.
    m_surface->view()->installEventFilter(m_fileDrop);

    const bool useNativeTitleBar = nativeWindowUsesSystemTitleBar(
        startup.value(QStringLiteral("useNativeTitleBar")).toBool(false));
    if (!useNativeTitleBar) {
        setWindowFlag(Qt::FramelessWindowHint, true);
    }

    const QJsonObject bounds = startup.value(QStringLiteral("lastWindowBounds")).toObject();
    const QString startupMode = startup.value(QStringLiteral("startupWindowMode")).toString(QStringLiteral("last"));
    const bool hasLastBounds = !bounds.isEmpty();
    const QSize presetSize = startupWindowSize(startupMode);
    const int width = startupMode == QStringLiteral("last") && hasLastBounds
        ? bounds.value(QStringLiteral("width")).toInt(presetSize.width())
        : presetSize.width();
    const int height = startupMode == QStringLiteral("last") && hasLastBounds
        ? bounds.value(QStringLiteral("height")).toInt(presetSize.height())
        : presetSize.height();
    resize(qMax(width, minimumWidth()), qMax(height, minimumHeight()));
    // Persisted bounds may come from a larger monitor or from the old 1480×960
    // fallback. Clamp before maximizing so Qt's restore geometry is usable too.
    clampNormalGeometry();
    applyStartupMode(startupMode, hasLastBounds);

    connect(m_surface->view(), &QWebView::loadingChanged, this,
            [this](const QWebViewLoadingInfo &info) {
        if (info.status() == QWebViewLoadingInfo::LoadStatus::Failed) {
            m_host->sendEvent(QStringLiteral("window.loadFailed"), QJsonObject{
                {QStringLiteral("url"), info.url().toString()},
                {QStringLiteral("error"), info.errorString()},
            });
            return;
        }
        if (info.status() != QWebViewLoadingInfo::LoadStatus::Succeeded) return;
        // Initial visibility is decided by the Qt host before the first load;
        // reloads and server recovery must preserve minimized/background state.
        m_host->sendEvent(QStringLiteral("window.ready"), QJsonObject{});
    });
}

MainWindow::~MainWindow() = default;

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
    if (isMaximized() || isMinimized() || isFullScreen()) {
        showNormal();
        clampNormalGeometry();
    }
    focusWindow();
}

void MainWindow::showWindow()
{
    show();
    focusWindow();
    emitMaximizedState();
    emitMinimizedState();
    emitFullScreenState();
}

bool MainWindow::toggleMaximize()
{
    if (isMaximized()) {
        showNormal();
        clampNormalGeometry();
    } else {
        showMaximized();
    }
    emitMaximizedState();
    return isMaximized();
}

bool MainWindow::toggleAlwaysOnTop()
{
    const bool next = !(windowFlags() & Qt::WindowStaysOnTopHint);
    const bool wasVisible = isVisible();
    const Qt::WindowStates oldState = windowState();
    setWindowFlag(Qt::WindowStaysOnTopHint, next);
    setWindowState(oldState);
    if (wasVisible) show();
    else hide();
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

void MainWindow::setCloseHideAvailableHandler(std::function<bool()> handler)
{
    m_closeHideAvailableHandler = std::move(handler);
}

void MainWindow::applySettings(const QJsonObject &settings)
{
    if (settings.contains(QStringLiteral("closeToTray"))) {
        m_closeToTray = settings.value(QStringLiteral("closeToTray")).toBool(m_closeToTray);
    }
    if (settings.contains(QStringLiteral("useNativeTitleBar"))) {
        const bool nativeTitleBar = nativeWindowUsesSystemTitleBar(
            settings.value(QStringLiteral("useNativeTitleBar")).toBool(false));
        const bool frameless = windowFlags() & Qt::FramelessWindowHint;
        const bool desiredFrameless = !nativeTitleBar;
        if (frameless != desiredFrameless) {
            const bool wasVisible = isVisible();
            const Qt::WindowStates oldState = windowState();
            setWindowFlag(Qt::FramelessWindowHint, desiredFrameless);
            setWindowState(oldState);
            if (wasVisible) show();
            else hide();
        }
    }
}

void MainWindow::beginSystemMove()
{
    if (auto *handle = windowHandle()) handle->startSystemMove();
}

bool MainWindow::beginSystemResize(Qt::Edges edges)
{
    if (!nativeWindowSupportsCustomResize()
        || edges == Qt::Edges{} || isMaximized() || isFullScreen()) return false;
    if (auto *handle = windowHandle()) return handle->startSystemResize(edges);
    return false;
}

void MainWindow::showLoadError(const QString &url, const QString &error)
{
    QMessageBox message(this);
    message.setIcon(QMessageBox::Critical);
    message.setWindowTitle(QStringLiteral("PiDeck-Q"));
    message.setText(QStringLiteral("The renderer could not be loaded."));
    message.setInformativeText(QStringLiteral("%1\n%2").arg(error, url));
    auto *retry = message.addButton(QStringLiteral("Retry"), QMessageBox::AcceptRole);
    auto *exit = message.addButton(QStringLiteral("Exit"), QMessageBox::RejectRole);
    message.setDefaultButton(retry);
    message.exec();
    if (m_host) {
        m_host->sendEvent(QStringLiteral("window.loadErrorAction"), QJsonObject{
            {QStringLiteral("action"), message.clickedButton() == retry ? QStringLiteral("retry") : QStringLiteral("exit")},
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
    // Hiding is safe only when the platform has a real restoration route: an
    // actually visible tray icon on Windows/Linux, or the macOS Dock activation
    // handler. Otherwise quit so the process cannot become unreachable.
    if (!m_quitting && m_closeToTray && m_closeHideAvailableHandler && m_closeHideAvailableHandler()) {
        event->ignore();
        hide();
        return;
    }
    if (!m_quitting) m_quitting = true;
    emitBounds();
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
        const QPoint clientPosition = FileDropController::toWebViewClientPosition(
            m_surface->view(), this, event->position().toPoint());
        m_host->sendEvent(QStringLiteral("native.fileDrop"),
                          FileDropController::payload(event->mimeData(), clientPosition));
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
        // Also cover native title-bar restore and OS-level state changes, not
        // only the custom renderer button's toggleMaximize() path.
        if (!isMaximized() && !isMinimized() && !isFullScreen()) clampNormalGeometry();
    }
}

void MainWindow::showEvent(QShowEvent *event)
{
    QMainWindow::showEvent(event);
    emitVisible(true);
}

void MainWindow::hideEvent(QHideEvent *event)
{
    QMainWindow::hideEvent(event);
    emitVisible(false);
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

void MainWindow::clampNormalGeometry()
{
    if (isMaximized() || isMinimized() || isFullScreen()) return;
    QScreen *screen = windowHandle() ? windowHandle()->screen() : QGuiApplication::primaryScreen();
    if (!screen) return;
    const QRect available = screen->availableGeometry();
    if (!available.isValid()) return;

    // A hard 880×640 minimum defeats clamping on high-DPI, RDP, VM, or small
    // displays. Lower it only as far as this screen's available work area.
    setMinimumSize(minimumWindowSizeForAvailable(available.size()));
    QRect bounded = geometry();
    bounded.setWidth(qMin(bounded.width(), available.width()));
    bounded.setHeight(qMin(bounded.height(), available.height()));
    const int maxLeft = available.right() - bounded.width() + 1;
    const int maxTop = available.bottom() - bounded.height() + 1;
    bounded.moveLeft(qBound(available.left(), bounded.left(), maxLeft));
    bounded.moveTop(qBound(available.top(), bounded.top(), maxTop));
    if (bounded != geometry()) setGeometry(bounded);
}

void MainWindow::applyStartupMode(const QString &mode, bool hasLastBounds)
{
    // Startup visibility is controlled by the host immediately before navigation;
    // only set the presentation state here so maximize/fullscreen is deterministic.
    if (mode == QStringLiteral("fullscreen")) {
        setWindowState(windowState() | Qt::WindowFullScreen);
    } else if (mode == QStringLiteral("maximized") || (mode == QStringLiteral("last") && !hasLastBounds)) {
        setWindowState(windowState() | Qt::WindowMaximized);
    }
}
