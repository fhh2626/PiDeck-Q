#include "ClipboardController.h"
#include "FileDropController.h"
#include "HostRpcServer.h"
#include "MainWindow.h"
#include "NativeFilePathLimits.h"
#include "NativeTheme.h"
#include "NativeWindowPolicy.h"
#include "WindowsToastNotifier.h"

#include <QtWebView/QWebView>
#include <QtWebView/QtWebView>

#ifdef Q_OS_WIN
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#endif

#include <QApplication>
#include <QClipboard>
#include <QElapsedTimer>
#include <QColor>
#include <QCoreApplication>
#include <QFileInfo>
#include <QImage>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QKeyEvent>
#include <QMimeData>
#include <QPalette>
#include <QSize>
#include <QStyleHints>
#include <QTcpSocket>
#include <QThread>
#include <QTemporaryDir>
#include <QUrl>
#include <QWindow>

#include <functional>
#include <iostream>

namespace {
QByteArray hostFrame(const QJsonObject &payload)
{
    const QByteArray body = QJsonDocument(payload).toJson(QJsonDocument::Compact);
    QByteArray packet(4, Qt::Uninitialized);
    const quint32 length = static_cast<quint32>(body.size());
    packet[0] = char(length & 0xff);
    packet[1] = char((length >> 8) & 0xff);
    packet[2] = char((length >> 16) & 0xff);
    packet[3] = char((length >> 24) & 0xff);
    packet.append(body);
    return packet;
}

bool waitForHostFrame(QTcpSocket &socket, QByteArray &buffer,
                      const std::function<bool(const QJsonObject &)> &predicate,
                      int timeoutMs = 3'000)
{
    QElapsedTimer timer;
    timer.start();
    while (timer.elapsed() < timeoutMs) {
        QCoreApplication::processEvents(QEventLoop::AllEvents, 20);
        buffer.append(socket.readAll());
        while (buffer.size() >= 4) {
            const auto *header = reinterpret_cast<const unsigned char *>(buffer.constData());
            const quint32 length = quint32(header[0])
                | (quint32(header[1]) << 8)
                | (quint32(header[2]) << 16)
                | (quint32(header[3]) << 24);
            if (buffer.size() < 4 + qsizetype(length)) break;
            const QByteArray body = buffer.mid(4, qsizetype(length));
            buffer.remove(0, 4 + qsizetype(length));
            const QJsonDocument document = QJsonDocument::fromJson(body);
            if (document.isObject() && predicate(document.object())) return true;
        }
        QThread::msleep(2);
    }
    return false;
}

bool require(bool condition, const char *message)
{
    if (condition) return true;
    std::cerr << message << std::endl;
    return false;
}

bool waitForWebViewUrl(QWebView *view, const QUrl &expected, int timeoutMs = 3'000)
{
    QElapsedTimer timer;
    timer.start();
    while (timer.elapsed() < timeoutMs) {
        QCoreApplication::processEvents(QEventLoop::AllEvents, 20);
        if (view && view->url() == expected) return true;
        QThread::msleep(2);
    }
    return view && view->url() == expected;
}

void processGuiEvents()
{
    QCoreApplication::processEvents(QEventLoop::AllEvents, 50);
    QThread::msleep(10);
    QCoreApplication::processEvents(QEventLoop::AllEvents, 50);
}
}

int main(int argc, char **argv)
{
    QtWebView::initialize();
    QApplication application(argc, argv);

    const Qt::ColorScheme systemScheme = QGuiApplication::styleHints()->colorScheme();
    applyNativeThemeSource(QStringLiteral("dark"));
    if (!require(QApplication::palette().color(QPalette::Window) == QColor("#121212"),
                 "dark native theme was not applied")) return 1;
    if (!require(QGuiApplication::styleHints()->colorScheme() == Qt::ColorScheme::Dark,
                 "dark native color-scheme hint was not applied")) return 1;
    applyNativeThemeSource(QStringLiteral("light"));
    if (!require(QApplication::palette().color(QPalette::Window) == QColor("#f8f8f5"),
                 "light native theme was not applied")) return 1;
    if (!require(QGuiApplication::styleHints()->colorScheme() == Qt::ColorScheme::Light,
                 "light native color-scheme hint was not applied")) return 1;
    QTemporaryDir toastShortcutDirectory;
    if (!require(toastShortcutDirectory.isValid(), "toast shortcut temp directory was unavailable")) return 1;
    const QString toastShortcutPath = toastShortcutDirectory.filePath(QStringLiteral("PiDeck-Q.lnk"));
    const bool firstToastInitialization = WindowsToastNotifier::initialize();
    const bool firstToastRegistration = firstToastInitialization
        && WindowsToastNotifier::registerApplication(QCoreApplication::applicationFilePath(), toastShortcutPath);
    if (!require(WindowsToastNotifier::isSupported() == firstToastRegistration,
                 "toast capability did not require application registration")) return 1;
#ifdef Q_OS_WIN
    if (!require(!firstToastRegistration || QFileInfo::exists(toastShortcutPath),
                 "toast registration did not create the Start Menu shortcut")) return 1;
#endif
    WindowsToastNotifier::uninitialize();
    const bool secondToastInitialization = WindowsToastNotifier::initialize();
    const bool secondToastRegistration = secondToastInitialization
        && WindowsToastNotifier::registerApplication(QCoreApplication::applicationFilePath(), toastShortcutPath);
    if (!require(secondToastRegistration == firstToastRegistration,
                 "toast application registration could not be repaired after cleanup")) return 1;
    WindowsToastNotifier::uninitialize();
    applyNativeThemeSource(QStringLiteral("system"));
    if (!require(QGuiApplication::styleHints()->colorScheme() == systemScheme,
                 "system native color-scheme hint did not unset the override")) return 1;
    const bool systemIsDark = QGuiApplication::styleHints()->colorScheme() == Qt::ColorScheme::Dark;
    const QColor systemWindow = QApplication::palette().color(QPalette::Window);
    if (!require(systemWindow == (systemIsDark ? QColor("#121212") : QColor("#f8f8f5")),
                 "system native theme did not follow the Qt color scheme")) return 1;

    const QJsonObject fixedBounds{
        {QStringLiteral("startupWindowMode"), QStringLiteral("normal-compact")},
        {QStringLiteral("useNativeTitleBar"), true},
        {QStringLiteral("closeToTray"), true},
        {QStringLiteral("lastWindowBounds"), QJsonObject{
            {QStringLiteral("width"), 1800},
            {QStringLiteral("height"), 1200},
        }},
    };
    MainWindow fixed(nullptr, fixedBounds);
    if (!require(fixed.size() == QSize(1100, 720),
                 "fixed startup preset was overridden by last bounds")) return 1;

    const QJsonObject lastBounds{
        {QStringLiteral("startupWindowMode"), QStringLiteral("last")},
        {QStringLiteral("useNativeTitleBar"), true},
        {QStringLiteral("lastWindowBounds"), QJsonObject{
            {QStringLiteral("width"), 1200},
            {QStringLiteral("height"), 760},
        }},
    };
    MainWindow last(nullptr, lastBounds);
    if (!require(last.size() == QSize(1200, 760),
                 "last startup mode did not use the saved bounds")) return 1;

    QScreen *primaryScreen = QGuiApplication::primaryScreen();
    if (!require(primaryScreen != nullptr, "primary screen was not available")) return 1;
    const QRect availableGeometry = primaryScreen->availableGeometry();
    if (!require(availableGeometry.isValid(), "primary screen geometry was not valid")) return 1;
    const QJsonObject oversizedBounds{
        {QStringLiteral("startupWindowMode"), QStringLiteral("last")},
        {QStringLiteral("useNativeTitleBar"), false},
        {QStringLiteral("lastWindowBounds"), QJsonObject{
            {QStringLiteral("width"), availableGeometry.width() + 200},
            {QStringLiteral("height"), availableGeometry.height() + 200},
        }},
    };
    MainWindow oversized(nullptr, oversizedBounds);
    if (!require(oversized.windowFlags().testFlag(Qt::FramelessWindowHint),
                 "custom titlebar window was not frameless")) return 1;
    if (!require(!oversized.beginSystemResize(Qt::Edges{}),
                 "empty resize edge was accepted")) return 1;
    if (!require(oversized.width() <= availableGeometry.width()
                     && oversized.height() <= availableGeometry.height(),
                 "normal window bounds exceeded the available screen")) return 1;
    oversized.show();
    processGuiEvents();
#ifdef Q_OS_WIN
    const HWND oversizedHwnd = reinterpret_cast<HWND>(oversized.winId());
    if (!require(oversizedHwnd != nullptr,
                 "frameless window HWND was unavailable")) return 1;
    const HMONITOR oversizedMonitor = MonitorFromWindow(
        oversizedHwnd,
        MONITOR_DEFAULTTONEAREST);
    MONITORINFO oversizedMonitorInfo{};
    oversizedMonitorInfo.cbSize = sizeof(oversizedMonitorInfo);
    if (!require(oversizedMonitor != nullptr
                     && GetMonitorInfoW(oversizedMonitor, &oversizedMonitorInfo),
                 "frameless window monitor work area was unavailable")) return 1;
    MINMAXINFO oversizedMinMaxInfo{};
    SendMessageW(
        oversizedHwnd,
        WM_GETMINMAXINFO,
        0,
        reinterpret_cast<LPARAM>(&oversizedMinMaxInfo));
    const RECT &oversizedWork = oversizedMonitorInfo.rcWork;
    const RECT &oversizedMonitorRect = oversizedMonitorInfo.rcMonitor;
    if (!require(
            oversizedMinMaxInfo.ptMaxPosition.x == oversizedWork.left - oversizedMonitorRect.left
                && oversizedMinMaxInfo.ptMaxPosition.y == oversizedWork.top - oversizedMonitorRect.top
                && oversizedMinMaxInfo.ptMaxSize.x == oversizedWork.right - oversizedWork.left
                && oversizedMinMaxInfo.ptMaxSize.y == oversizedWork.bottom - oversizedWork.top,
            "frameless maximize did not use the Windows monitor work area")) return 1;
#endif
    oversized.showMaximized();
    processGuiEvents();
    oversized.showNormal();
    processGuiEvents();
    const QScreen *restoredScreen = oversized.windowHandle() && oversized.windowHandle()->screen()
        ? oversized.windowHandle()->screen()
        : primaryScreen;
    const QRect restoredAvailable = restoredScreen->availableGeometry();
    const QRect restoredGeometry = oversized.geometry();
    if (!require(!oversized.isMaximized(), "window did not leave maximized state")) return 1;
    if (!require(restoredGeometry.width() <= restoredAvailable.width()
                     && restoredGeometry.height() <= restoredAvailable.height(),
                 "restored normal geometry exceeded the available screen")) return 1;
    if (!require(restoredAvailable.contains(restoredGeometry.topLeft())
                     && restoredAvailable.contains(restoredGeometry.bottomRight()),
                 "restored normal geometry was not placed on screen")) return 1;
    oversized.hide();

    fixed.show();
    processGuiEvents();
    fixed.hide();
    processGuiEvents();
    if (!require(!fixed.isVisible(), "test window did not enter hidden state")) return 1;

    fixed.applySettings(QJsonObject{{QStringLiteral("useNativeTitleBar"), false}});
    processGuiEvents();
    if (!require(!fixed.isVisible(), "titlebar change re-shown a hidden window")) return 1;

    fixed.toggleAlwaysOnTop();
    processGuiEvents();
    if (!require(!fixed.isVisible(), "always-on-top toggle re-shown a hidden window")) return 1;

    bool unavailableTrayQuitRequested = false;
    MainWindow unavailableTrayWindow(nullptr, fixedBounds);
    unavailableTrayWindow.setCloseHideAvailableHandler([] { return false; });
    unavailableTrayWindow.setQuitHandler([&unavailableTrayQuitRequested] {
        unavailableTrayQuitRequested = true;
    });
    unavailableTrayWindow.show();
    processGuiEvents();
    unavailableTrayWindow.close();
    processGuiEvents();
    if (!require(unavailableTrayQuitRequested && !unavailableTrayWindow.isVisible(),
                 "close-to-tray did not quit when the tray was unavailable")) return 1;

    bool availableTrayQuitRequested = false;
    MainWindow availableTrayWindow(nullptr, fixedBounds);
    availableTrayWindow.setCloseHideAvailableHandler([] { return true; });
    availableTrayWindow.setQuitHandler([&availableTrayQuitRequested] {
        availableTrayQuitRequested = true;
    });
    availableTrayWindow.show();
    processGuiEvents();
    availableTrayWindow.close();
    processGuiEvents();
    if (!require(!availableTrayQuitRequested && !availableTrayWindow.isVisible(),
                 "close-to-tray did not hide when the tray was available")) return 1;
    availableTrayWindow.setQuitting(true);
    availableTrayWindow.close();

#ifdef Q_OS_MACOS
    if (!require(nativeWindowUsesSystemTitleBar(false),
                 "macOS did not preserve system window decorations")) return 1;
    if (!require(!nativeWindowSupportsCustomResize(),
                 "macOS exposed unsupported frameless system resize")) return 1;
#else
    if (!require(!nativeWindowUsesSystemTitleBar(false),
                 "custom titlebar preference was ignored")) return 1;
    if (!require(nativeWindowSupportsCustomResize(),
                 "platform unexpectedly disabled custom system resize")) return 1;
#endif

    fixed.show();
    fixed.showMaximized();
    processGuiEvents();
    fixed.applySettings(QJsonObject{{QStringLiteral("useNativeTitleBar"), true}});
    processGuiEvents();
    if (!require(fixed.isMaximized(), "titlebar change lost maximized state")) return 1;
    fixed.hide();
    processGuiEvents();

    HostRpcServer lifecycleHost;
    if (!require(lifecycleHost.start(), "GUI lifecycle host failed to listen")) return 1;
    QTcpSocket lifecycleClient;
    lifecycleClient.connectToHost(QStringLiteral("127.0.0.1"), lifecycleHost.port());
    if (!require(lifecycleClient.waitForConnected(3'000), "GUI lifecycle client failed to connect")) return 1;
    lifecycleClient.write(hostFrame(QJsonObject{
        {QStringLiteral("type"), QStringLiteral("hello")},
        {QStringLiteral("token"), lifecycleHost.token()},
    }));
    lifecycleClient.flush();
    QByteArray lifecycleBuffer;
    if (!require(waitForHostFrame(lifecycleClient, lifecycleBuffer, [](const QJsonObject &frame) {
            return frame.value(QStringLiteral("type")).toString() == QStringLiteral("hello")
                && frame.value(QStringLiteral("ok")).toBool();
        }), "GUI lifecycle host handshake failed")) return 1;

    MainWindow reloadStateWindow(&lifecycleHost, fixedBounds);
    reloadStateWindow.show();
    if (!require(waitForHostFrame(lifecycleClient, lifecycleBuffer, [](const QJsonObject &frame) {
            return frame.value(QStringLiteral("name")).toString() == QStringLiteral("window.visibleChanged")
                && frame.value(QStringLiteral("payload")).toBool();
        }), "GUI show event did not report visibility")) return 1;
    reloadStateWindow.load(QUrl(QStringLiteral("data:text/html,<html><body>native</body></html>")));
    if (!require(waitForHostFrame(lifecycleClient, lifecycleBuffer, [](const QJsonObject &frame) {
            return frame.value(QStringLiteral("name")).toString() == QStringLiteral("window.ready");
        }), "GUI renderer did not report the initial load")) return 1;
    reloadStateWindow.showMinimized();
    processGuiEvents();
    if (!require(reloadStateWindow.isMinimized(),
                 "test window did not enter minimized state")) return 1;
    reloadStateWindow.reload();
    if (!require(waitForHostFrame(lifecycleClient, lifecycleBuffer, [](const QJsonObject &frame) {
            return frame.value(QStringLiteral("name")).toString() == QStringLiteral("window.ready");
        }), "GUI renderer did not report the reload")) return 1;
    if (!require(reloadStateWindow.isMinimized(),
                 "renderer reload restored a minimized window")) return 1;

    // Browser refresh shortcuts must not reload the sanitized URL that the
    // renderer keeps visible after bootstrap. Locate this window's QWebView by
    // its unique requested URL and exercise the same key events WebView2 sees.
    const QUrl authenticatedUrl(QStringLiteral(
        "https://pideck.invalid/?runtime=native&token=secret"));
    const QUrl sanitizedUrl(QStringLiteral("https://pideck.invalid/?runtime=native"));
    reloadStateWindow.load(authenticatedUrl);
    processGuiEvents();
    QWebView *reloadView = nullptr;
    for (QWindow *window : QGuiApplication::allWindows()) {
        auto *candidate = qobject_cast<QWebView *>(window);
        if (candidate && candidate->url() == authenticatedUrl) {
            reloadView = candidate;
            break;
        }
    }
    if (!require(reloadView != nullptr, "authenticated QWebView was not found")) return 1;
    reloadStateWindow.showNormal();
    reloadStateWindow.show();
    reloadStateWindow.focusWindow();
    processGuiEvents();

#ifdef Q_OS_WIN
    const HWND reloadHwnd = reinterpret_cast<HWND>(reloadView->winId());
    if (!require(reloadHwnd != nullptr, "native WebView HWND was unavailable")) return 1;

    reloadView->setUrl(sanitizedUrl);
    if (!require(waitForWebViewUrl(reloadView, sanitizedUrl),
                 "WebView did not enter the sanitized URL before F5")) return 1;
    if (!require(PostMessageW(reloadHwnd, WM_KEYDOWN, VK_F5, 0)
                     && PostMessageW(reloadHwnd, WM_KEYUP, VK_F5, 0),
                 "could not post native F5 messages")) return 1;
    if (!require(waitForWebViewUrl(reloadView, authenticatedUrl),
                 "native F5 reloaded the sanitized WebView URL")) return 1;

    reloadView->setUrl(sanitizedUrl);
    if (!require(waitForWebViewUrl(reloadView, sanitizedUrl),
                 "WebView did not enter the sanitized URL before Ctrl+R")) return 1;
    if (!require(PostMessageW(reloadHwnd, WM_KEYDOWN, VK_CONTROL, 0)
                     && PostMessageW(reloadHwnd, WM_KEYDOWN, 'R', 0)
                     && PostMessageW(reloadHwnd, WM_KEYUP, 'R', 0)
                     && PostMessageW(reloadHwnd, WM_KEYUP, VK_CONTROL, 0),
                 "could not post native Ctrl+R messages")) return 1;
    if (!require(waitForWebViewUrl(reloadView, authenticatedUrl),
                 "native Ctrl+R reloaded the sanitized WebView URL")) return 1;
#else
    reloadView->setUrl(sanitizedUrl);
    QKeyEvent f5(QEvent::KeyPress, Qt::Key_F5, Qt::NoModifier);
    QCoreApplication::sendEvent(reloadView, &f5);
    if (!require(reloadView->url() == authenticatedUrl,
                 "F5 reloaded the sanitized WebView URL")) return 1;

    reloadView->setUrl(sanitizedUrl);
    QKeyEvent ctrlR(QEvent::KeyPress, Qt::Key_R, Qt::ControlModifier);
    QCoreApplication::sendEvent(reloadView, &ctrlR);
    if (!require(reloadView->url() == authenticatedUrl,
                 "Ctrl+R reloaded the sanitized WebView URL")) return 1;
#endif

    lifecycleClient.disconnectFromHost();

    int clipboardChanges = 0;
    {
        ClipboardController clipboard([&clipboardChanges](const QJsonObject &) {
            ++clipboardChanges;
        });
        if (auto *systemClipboard = QGuiApplication::clipboard()) {
            systemClipboard->setText(QStringLiteral("native-gui-test-1"));
            processGuiEvents();
        }
    }
    const int changesAfterDestroy = clipboardChanges;
    if (auto *systemClipboard = QGuiApplication::clipboard()) {
        systemClipboard->setText(QStringLiteral("native-gui-test-2"));
        processGuiEvents();
    }
    if (!require(clipboardChanges == changesAfterDestroy,
                 "destroyed ClipboardController still received clipboard signals")) return 1;

    QMimeData pathMimeData;
    QList<QUrl> manyPaths;
    for (int index = 0; index < NativeFilePathLimits::kMaxFilePathCount + 1; ++index) {
        manyPaths.append(QUrl::fromLocalFile(QStringLiteral("C:/pideck-test/%1").arg(index)));
    }
    pathMimeData.setUrls(manyPaths);
    const QJsonArray countBoundedPaths = FileDropController::payload(&pathMimeData, {}).value(QStringLiteral("paths")).toArray();
    if (!require(countBoundedPaths.size() == NativeFilePathLimits::kMaxFilePathCount,
                 "file path count limit was not applied")) return 1;

    QMimeData byteLimitedPathMimeData;
    byteLimitedPathMimeData.setUrls({QUrl::fromLocalFile(
        QStringLiteral("C:/") + QString(NativeFilePathLimits::kMaxFilePathUtf8Bytes + 1, QLatin1Char('x')))});
    const QJsonArray byteBoundedPaths = FileDropController::payload(&byteLimitedPathMimeData, {}).value(QStringLiteral("paths")).toArray();
    if (!require(byteBoundedPaths.isEmpty(), "file path byte limit was not applied")) return 1;

    if (auto *systemClipboard = QGuiApplication::clipboard()) {
        auto *clipboardPathData = new QMimeData();
        clipboardPathData->setUrls(manyPaths);
        systemClipboard->setMimeData(clipboardPathData);
        processGuiEvents();
        ClipboardController boundedClipboard;
        if (!require(boundedClipboard.filePaths().size() == NativeFilePathLimits::kMaxFilePathCount,
                     "clipboard file path count limit was not applied")) return 1;
    }

    QJsonObject lightweightImageChange;
    ClipboardController imageClipboard([&lightweightImageChange](const QJsonObject &snapshot) {
        if (snapshot.value(QStringLiteral("hasImage")).toBool()) lightweightImageChange = snapshot;
    });
    if (auto *systemClipboard = QGuiApplication::clipboard()) {
        QImage image(32, 32, QImage::Format_ARGB32);
        image.fill(QColor("#2f855a"));
        systemClipboard->setImage(image);
        processGuiEvents();
        if (!require(lightweightImageChange.value(QStringLiteral("hasImage")).toBool()
                         && !lightweightImageChange.contains(QStringLiteral("imageDataUrl")),
                     "clipboard metadata change carried encoded image bytes")) return 1;

        QJsonObject asynchronousSnapshot;
        QJsonObject coalescedSnapshot;
        imageClipboard.snapshotAsync([&asynchronousSnapshot](const QJsonObject &snapshot) {
            asynchronousSnapshot = snapshot;
        });
        imageClipboard.snapshotAsync([&coalescedSnapshot](const QJsonObject &snapshot) {
            coalescedSnapshot = snapshot;
        });
        QElapsedTimer imageTimer;
        imageTimer.start();
        while ((asynchronousSnapshot.isEmpty() || coalescedSnapshot.isEmpty()) && imageTimer.elapsed() < 3'000) {
            processGuiEvents();
        }
        const QString imageDataUrl = asynchronousSnapshot.value(QStringLiteral("imageDataUrl")).toString();
        if (!require(imageDataUrl.startsWith(QStringLiteral("data:image/png;base64,")),
                     "clipboard image snapshot was not encoded asynchronously as PNG data")) return 1;
        if (!require(coalescedSnapshot.value(QStringLiteral("imageDataUrl")).toString() == imageDataUrl,
                     "concurrent clipboard image snapshots were not coalesced")) return 1;

        QJsonObject cachedSnapshot;
        imageClipboard.snapshotAsync([&cachedSnapshot](const QJsonObject &snapshot) {
            cachedSnapshot = snapshot;
        });
        if (!require(cachedSnapshot.value(QStringLiteral("imageDataUrl")).toString() == imageDataUrl,
                     "clipboard image snapshot cache was not reused for the same sequence")) return 1;

        // A common high-resolution phone photo can exceed 32 MP. It must be
        // bounded before the transport-budget checks, rather than rejected by
        // its original pixel count.
        QImage highResolutionImage(8000, 5000, QImage::Format_ARGB32);
        highResolutionImage.fill(QColor("#2f855a"));
        systemClipboard->setImage(highResolutionImage);
        processGuiEvents();
        QJsonObject highResolutionSnapshot;
        imageClipboard.snapshotAsync([&highResolutionSnapshot](const QJsonObject &snapshot) {
            highResolutionSnapshot = snapshot;
        });
        QElapsedTimer highResolutionTimer;
        highResolutionTimer.start();
        while (highResolutionSnapshot.isEmpty() && highResolutionTimer.elapsed() < 3'000) {
            processGuiEvents();
        }
        if (!require(highResolutionSnapshot.value(QStringLiteral("imageDataUrl")).toString()
                         .startsWith(QStringLiteral("data:image/png;base64,")),
                     "clipboard image above 32 MP was rejected before resize")) return 1;

        // A noisy photo-like image exercises the PNG budget rather than the
        // highly compressible solid-color path above. The encoder must reduce
        // the edge again when a 2000px PNG is larger than 5 MiB.
        QImage complexImage(2000, 1500, QImage::Format_RGB32);
        quint32 noise = 0x12345678u;
        for (int y = 0; y < complexImage.height(); ++y) {
            auto *line = reinterpret_cast<QRgb *>(complexImage.scanLine(y));
            for (int x = 0; x < complexImage.width(); ++x) {
                noise = noise * 1664525u + 1013904223u;
                line[x] = qRgb((noise >> 24) & 0xff, (noise >> 16) & 0xff, (noise >> 8) & 0xff);
            }
        }
        systemClipboard->setImage(complexImage);
        processGuiEvents();
        QJsonObject complexSnapshot;
        imageClipboard.snapshotAsync([&complexSnapshot](const QJsonObject &snapshot) {
            complexSnapshot = snapshot;
        });
        QElapsedTimer complexTimer;
        complexTimer.start();
        while (complexSnapshot.isEmpty() && complexTimer.elapsed() < 3'000) {
            processGuiEvents();
        }
        const QString complexDataUrl = complexSnapshot.value(QStringLiteral("imageDataUrl")).toString();
        if (!require(complexDataUrl.startsWith(QStringLiteral("data:image/png;base64,")),
                     "complex clipboard image exceeded the adaptive PNG budget")) return 1;
        const QByteArray complexPng = QByteArray::fromBase64(
            complexDataUrl.mid(QStringLiteral("data:image/png;base64,").size()).toLatin1());
        QImage encodedComplexImage;
        if (!require(encodedComplexImage.loadFromData(complexPng, "PNG"),
                     "adaptive clipboard PNG could not be decoded")) return 1;
        if (!require(encodedComplexImage.width() < 2000,
                     "complex clipboard image was not reduced after exceeding the PNG budget")) return 1;
        if (!require(complexPng.size() <= 5 * 1024 * 1024,
                     "adaptive clipboard PNG still exceeded the byte budget")) return 1;
    }

    return 0;
}
