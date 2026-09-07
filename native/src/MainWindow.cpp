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
#include <QList>
#include <QMessageBox>
#include <QShowEvent>
#include <QPushButton>
#include <QScreen>
#include <QSize>
#include <QTimer>
#include <QUrl>
#include <QWindow>

#include <utility>

#ifdef Q_OS_WIN
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#endif

namespace {
bool isNativeRefreshShortcut(const QKeyEvent &event)
{
    if (event.key() == Qt::Key_F5) return true;
    if (event.key() != Qt::Key_R) return false;

    const Qt::KeyboardModifiers modifiers = event.modifiers();
    const bool hasRefreshModifier = modifiers.testFlag(Qt::ControlModifier)
        || modifiers.testFlag(Qt::MetaModifier);
    return hasRefreshModifier && !modifiers.testFlag(Qt::AltModifier);
}

#ifdef Q_OS_WIN
bool isWebViewWindow(HWND root, HWND candidate)
{
    return root && candidate && (root == candidate || IsChild(root, candidate));
}

bool isControlKey(WPARAM key)
{
    return key == VK_CONTROL || key == VK_LCONTROL || key == VK_RCONTROL;
}

bool isAltKey(WPARAM key)
{
    return key == VK_MENU || key == VK_LMENU || key == VK_RMENU;
}
#endif
}

MainWindow::MainWindow(HostRpcServer *host, const QJsonObject &startup,
                         QWidget *parent, SystemMoveStarter systemMoveStarter)
    : QMainWindow(parent),
      m_host(host),
      m_surface(std::make_unique<MainWebSurface>(this)),
      m_fileDrop(new FileDropController([host](const QJsonObject &payload) {
          host->sendEvent(QStringLiteral("native.fileDrop"), payload);
      }, m_surface->view(), this)),
      m_closeToTray(startup.value(QStringLiteral("closeToTray")).toBool(true)),
      m_systemMoveStarter(std::move(systemMoveStarter))
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
    // Qt WebView handles browser refresh shortcuts against its current URL. The
    // renderer removes the token from that URL after bootstrap, so route F5,
    // Ctrl+R, and the macOS Command+R equivalent through authenticated reload.
    m_surface->container()->installEventFilter(this);
    m_surface->view()->installEventFilter(this);
#ifdef Q_OS_WIN
    // Capture the host window before installing the application-wide native
    // filter. Calling winId() from inside nativeEventFilter can re-enter Qt
    // while a native child window is being created.
    m_nativeWebViewWinId = static_cast<quintptr>(m_surface->view()->winId());
#endif
    if (auto *application = QCoreApplication::instance()) {
        application->installNativeEventFilter(this);
    }

    const bool useNativeTitleBar = nativeWindowUsesSystemTitleBar(
        startup.value(QStringLiteral("useNativeTitleBar")).toBool(false));
    if (!useNativeTitleBar) {
        setWindowFlag(Qt::FramelessWindowHint, true);
    }

    const QJsonObject bounds = startup.value(QStringLiteral("lastWindowBounds")).toObject();
    const QString startupMode = startup.value(QStringLiteral("startupWindowMode")).toString(QStringLiteral("last"));
    const bool hasLastBounds = !bounds.isEmpty();
    const bool hasLastPosition = startupMode == QStringLiteral("last")
        && hasLastBounds
        && bounds.value(QStringLiteral("x")).isDouble()
        && bounds.value(QStringLiteral("y")).isDouble();
    const QSize presetSize = startupWindowSize(startupMode);
    const int width = startupMode == QStringLiteral("last") && hasLastBounds
        ? bounds.value(QStringLiteral("width")).toInt(presetSize.width())
        : presetSize.width();
    const int height = startupMode == QStringLiteral("last") && hasLastBounds
        ? bounds.value(QStringLiteral("height")).toInt(presetSize.height())
        : presetSize.height();
    resize(qMax(width, minimumWidth()), qMax(height, minimumHeight()));
    // Older files contain only width/height. Restore x/y when both coordinates
    // are present, then clamp the complete normal rectangle in case the saved
    // monitor is no longer connected or its work area has changed.
    if (hasLastPosition) {
        move(bounds.value(QStringLiteral("x")).toInt(),
             bounds.value(QStringLiteral("y")).toInt());
    }
    // Persisted bounds may come from a larger monitor or from the old 1480×960
    // fallback. Clamp before maximizing so Qt's restore geometry is usable too.
    clampNormalGeometry();
    rememberNormalGeometry();
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

MainWindow::~MainWindow()
{
    if (auto *application = QCoreApplication::instance()) {
        application->removeNativeEventFilter(this);
    }
}

bool MainWindow::nativeEvent(const QByteArray &eventType, void *message, qintptr *result)
{
#ifdef Q_OS_WIN
    auto *nativeMessage = static_cast<MSG *>(message);
    if (nativeMessage && nativeMessage->message == WM_EXITSIZEMOVE && m_systemMoveActive) {
        // The nested Win32 move loop (Qt startSystemMove or the HTCAPTION
        // fallback) posts this when the user releases the mouse. Clamp only
        // after the drag ends so a restore-while-dragging gesture is not
        // pinned to the work-area rectangle mid-move.
        m_systemMoveActive = false;
        if (!isMaximized() && !isMinimized() && !isFullScreen()) {
            scheduleRestoredGeometryClamp();
        }
    }
    if ((windowFlags() & Qt::FramelessWindowHint)
        && nativeMessage
        && nativeMessage->message == WM_GETMINMAXINFO) {
        auto *minMaxInfo = reinterpret_cast<MINMAXINFO *>(nativeMessage->lParam);
        const HMONITOR monitor = MonitorFromWindow(
            nativeMessage->hwnd,
            MONITOR_DEFAULTTONEAREST);
        MONITORINFO monitorInfo{};
        monitorInfo.cbSize = sizeof(monitorInfo);
        if (minMaxInfo && monitor && GetMonitorInfoW(monitor, &monitorInfo)) {
            const RECT &work = monitorInfo.rcWork;
            const RECT &monitorRect = monitorInfo.rcMonitor;
            minMaxInfo->ptMaxPosition.x = work.left - monitorRect.left;
            minMaxInfo->ptMaxPosition.y = work.top - monitorRect.top;
            minMaxInfo->ptMaxSize.x = work.right - work.left;
            minMaxInfo->ptMaxSize.y = work.bottom - work.top;
            if (result) *result = 0;
            return true;
        }
    }
#else
    Q_UNUSED(eventType);
    Q_UNUSED(message);
    Q_UNUSED(result);
#endif
    return QMainWindow::nativeEvent(eventType, message, result);
}

bool MainWindow::nativeEventFilter(const QByteArray &eventType, void *message, qintptr *result)
{
#ifdef Q_OS_WIN
    if (eventType != QByteArrayLiteral("windows_dispatcher_MSG")
        && eventType != QByteArrayLiteral("windows_generic_MSG")) return false;

    auto *nativeMessage = static_cast<MSG *>(message);
    if (!nativeMessage) return false;
    const HWND webView = reinterpret_cast<HWND>(m_nativeWebViewWinId);
    if (!isWebViewWindow(webView, nativeMessage->hwnd)) return false;

    if (nativeMessage->message == WM_KILLFOCUS || nativeMessage->message == WM_NCDESTROY) {
        m_nativeControlDown = false;
        m_nativeAltDown = false;
        return false;
    }
    if (nativeMessage->message == WM_KEYDOWN || nativeMessage->message == WM_SYSKEYDOWN) {
        const WPARAM key = nativeMessage->wParam;
        if (isControlKey(key)) m_nativeControlDown = true;
        if (isAltKey(key)) m_nativeAltDown = true;

        const bool isRefresh = key == VK_F5
            || (key == 'R' && m_nativeControlDown && !m_nativeAltDown);
        if (isRefresh) {
            // Bit 30 marks an auto-repeated keydown. Consume repeats so
            // WebView2 never receives the refresh accelerator, but only load
            // the authenticated URL once for a held key.
            if ((nativeMessage->lParam & (1LL << 30)) == 0) reload();
            if (result) *result = 0;
            return true;
        }
    }
    if (nativeMessage->message == WM_KEYUP || nativeMessage->message == WM_SYSKEYUP) {
        const WPARAM key = nativeMessage->wParam;
        if (isControlKey(key)) m_nativeControlDown = false;
        if (isAltKey(key)) m_nativeAltDown = false;
    }
#else
    Q_UNUSED(eventType);
    Q_UNUSED(message);
    Q_UNUSED(result);
#endif
    return false;
}

bool MainWindow::eventFilter(QObject *watched, QEvent *event)
{
    const bool isWebSurface = watched == m_surface->view()
        || watched == m_surface->container();
    if (isWebSurface && event->type() == QEvent::KeyPress) {
        auto *keyEvent = static_cast<QKeyEvent *>(event);
        if (isNativeRefreshShortcut(*keyEvent)) {
            // Consume auto-repeat too, otherwise holding the key would hand
            // repeated refreshes back to WebView2 after the first event.
            if (!keyEvent->isAutoRepeat()) reload();
            keyEvent->accept();
            return true;
        }
    }
    return QMainWindow::eventFilter(watched, event);
}

void MainWindow::load(const QUrl &url)
{
    // Keep the authenticated navigation URL separately because the renderer
    // removes its token from the visible WebView history after bootstrap.
    m_reloadUrl = url;
    m_surface->load(url);
}

void MainWindow::reload()
{
    if (!m_reloadUrl.isValid() || m_reloadUrl.isEmpty()) return;
    m_surface->load(m_reloadUrl);
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
        scheduleRestoredGeometryClamp();
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
        scheduleRestoredGeometryClamp();
    } else {
        rememberNormalGeometry();
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
    if (isFullScreen()) return;

    rememberNormalGeometry();
    // Only a restore-while-dragging gesture needs the clamp suppressed. A
    // normal-window move must keep emitting bounds and must not leave this
    // flag stuck on when Windows never sends a state change.
    m_systemMoveActive = isMaximized();

    // Use Qt's platform-native move path first, matching beginSystemResize().
    // This is important for a request originating in the native WebView: Qt
    // can hand the gesture to the window manager without a synthetic caption
    // message that may be ignored by WebView2/frameless Windows hosts.
    bool systemMoveStarted = false;
    if (m_systemMoveStarter) {
        systemMoveStarted = m_systemMoveStarter();
    } else if (auto *handle = windowHandle()) {
        systemMoveStarted = handle->startSystemMove();
    }
    if (systemMoveStarted) return;

#ifdef Q_OS_WIN
    // Keep a Win32 fallback for Qt/platform-plugin combinations that cannot
    // start a system move from this RPC callback. Leave m_systemMoveActive set
    // so a restore-while-dragging gesture is not clamped to the work-area
    // rectangle before WM_EXITSIZEMOVE / WindowStateChange settles.
    const HWND hwnd = reinterpret_cast<HWND>(winId());
    if (!hwnd) {
        m_systemMoveActive = false;
        return;
    }

    POINT cursor{};
    if (!GetCursorPos(&cursor)) {
        m_systemMoveActive = false;
        return;
    }

    ReleaseCapture();
    SendMessageW(
        hwnd,
        WM_NCLBUTTONDOWN,
        HTCAPTION,
        MAKELPARAM(cursor.x, cursor.y));
    if (m_systemMoveActive) {
        m_systemMoveActive = false;
        if (!isMaximized() && !isMinimized() && !isFullScreen()) {
            scheduleRestoredGeometryClamp();
        }
    }
#else
    m_systemMoveActive = false;
#endif
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

void MainWindow::syncStateToHost()
{
    // A restarted Node sidecar has empty state caches, while the existing Qt
    // window may not emit show/state-change events again until user interaction.
    emitVisible(isVisible());
    emitMaximizedState();
    emitMinimizedState();
    emitFullScreenState();
    if (!m_host) return;
    QRect rect = currentNormalGeometry();
    rememberNormalGeometry();
    m_host->sendEvent(QStringLiteral("window.normalBoundsChanged"), QJsonObject{
        {QStringLiteral("x"), rect.x()},
        {QStringLiteral("y"), rect.y()},
        {QStringLiteral("width"), rect.width()},
        {QStringLiteral("height"), rect.height()},
    });
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
    rememberNormalGeometry();
    emitBounds();
}

void MainWindow::resizeEvent(QResizeEvent *event)
{
    QMainWindow::resizeEvent(event);
    rememberNormalGeometry();
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
        // only the custom renderer button's toggleMaximize() path. A restore-
        // while-dragging gesture on Windows keeps m_systemMoveActive until
        // WM_EXITSIZEMOVE so this path does not clamp mid-move. Other platforms
        // have no equivalent nested-loop message, so settle on the state change.
        if (!isMaximized() && !isMinimized() && !isFullScreen()) {
#ifdef Q_OS_WIN
            if (m_systemMoveActive) return;
#else
            m_systemMoveActive = false;
#endif
            scheduleRestoredGeometryClamp();
        }
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
    if (!m_host || isMaximized() || isFullScreen()
        || m_systemMoveActive || m_restoringNormalGeometry) return;
    // Minimized top-level widgets can expose a transient geometry. Persist the
    // normal restore rectangle instead, just like syncStateToHost(), so closing
    // from the tray/minimized state cannot overwrite the last usable position.
    QRect rect = currentNormalGeometry();
    rememberNormalGeometry();
    m_host->sendEvent(QStringLiteral("window.normalBoundsChanged"), QJsonObject{
        {QStringLiteral("x"), rect.x()},
        {QStringLiteral("y"), rect.y()},
        {QStringLiteral("width"), rect.width()},
        {QStringLiteral("height"), rect.height()},
    });
}

void MainWindow::emitVisible(bool visible)
{
    if (m_host) m_host->sendEvent(QStringLiteral("window.visibleChanged"), visible);
}

QRect MainWindow::currentNormalGeometry() const
{
    QRect rect = normalGeometry();
    if (!rect.isValid() || rect.isEmpty()) rect = geometry();
    return rect;
}

bool MainWindow::isUsableNormalGeometry(const QRect &rect) const
{
    if (!rect.isValid() || rect.isEmpty()) return false;
    QScreen *screen = windowHandle() ? windowHandle()->screen() : QGuiApplication::primaryScreen();
    if (!screen) return true;
    const QRect available = screen->availableGeometry();
    if (!available.isValid() || available.isEmpty()) return true;
    if (rect.width() >= available.width() - 2 && rect.height() >= available.height() - 2) {
        return false;
    }
    const QRect overlap = rect.intersected(available);
    const qint64 area = qint64(rect.width()) * qint64(rect.height());
    const qint64 overlapArea = overlap.isValid() && !overlap.isEmpty()
        ? qint64(overlap.width()) * qint64(overlap.height())
        : 0;
    return area > 0 && overlapArea * 2 >= area;
}

void MainWindow::rememberNormalGeometry()
{
    if (isMaximized() || isMinimized() || isFullScreen()
        || m_systemMoveActive || m_restoringNormalGeometry) return;
    const QRect rect = currentNormalGeometry();
    if (isUsableNormalGeometry(rect)) m_lastUsableNormalGeometry = rect;
}

void MainWindow::scheduleRestoredGeometryClamp()
{
    // Wait one event-loop turn so Qt can publish the restored rectangle after
    // WM_EXITSIZEMOVE / showNormal, instead of clamping a transient
    // maximized-sized geometry into the bottom-left corner.
    m_restoringNormalGeometry = true;
    QTimer::singleShot(0, this, [this] {
        m_restoringNormalGeometry = false;
        if (!isMaximized() && !isMinimized() && !isFullScreen()) {
            clampNormalGeometry();
            rememberNormalGeometry();
        }
    });
}

void MainWindow::clampNormalGeometry()
{
    if (isMaximized() || isMinimized() || isFullScreen() || m_systemMoveActive) return;
    // During startup the top-level handle may still report the primary screen,
    // even after a saved secondary-monitor position has been applied. Pick the
    // work area containing the largest part of the normal rectangle so a large
    // window centered in a gap between monitors is not moved to the primary
    // screen by accident.
    QRect normal = currentNormalGeometry();
    if (m_lastUsableNormalGeometry.isValid() && !isUsableNormalGeometry(normal)) {
        // showNormal() can briefly report the maximized work-area rectangle.
        // Prefer the last usable normal bounds instead of clamping that
        // transient size into the bottom-left of the work area.
        normal = m_lastUsableNormalGeometry;
    }
    const QList<QScreen *> screens = QGuiApplication::screens();
    QList<QRect> availableGeometries;
    availableGeometries.reserve(screens.size());
    for (QScreen *candidate : screens) {
        availableGeometries.append(candidate ? candidate->availableGeometry() : QRect{});
    }
    const int screenIndex = screenIndexWithLargestIntersection(normal, availableGeometries);
    QScreen *screen = screenIndex >= 0 && screenIndex < screens.size()
        ? screens.at(screenIndex)
        : QGuiApplication::primaryScreen();
    if (!screen && windowHandle()) screen = windowHandle()->screen();
    if (!screen) return;
    const QRect available = screen->availableGeometry();
    if (!available.isValid()) return;

    // A hard 880×640 minimum defeats clamping on high-DPI, RDP, VM, or small
    // displays. Lower it only as far as this screen's available work area.
    setMinimumSize(minimumWindowSizeForAvailable(available.size()));
    const QRect bounded = clampRestoredNormalGeometry(normal, available);
    if (bounded.isValid() && bounded != geometry()) setGeometry(bounded);
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
