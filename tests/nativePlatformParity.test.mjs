import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const mainSource = readFileSync("native/src/main.cpp", "utf8");
const rendererBootstrap = readFileSync("src/renderer/src/native/initializeNativeDesktop.ts", "utf8");
const rendererMain = readFileSync("src/renderer/src/main.tsx", "utf8");
const xmake = readFileSync("xmake.lua", "utf8");

 test("native dialogs use one explicit file or directory picker", () => {
	assert.match(mainSource, /parent.*QStringLiteral\("none"\)/s);
	assert.match(mainSource, /QFileDialog::ExistingFiles/);
	assert.match(mainSource, /QFileDialog::Directory/);
	assert.match(mainSource, /const QStringList paths = openDirectory \? selectDirectories\(\) : selectFiles\(\);/);
	assert.doesNotMatch(mainSource, /selected\.append\(dialog\.selectedFiles\(\)\)/);
});

test("native renderer token is removed from history and renderer logs", () => {
	assert.match(rendererBootstrap, /history\.replaceState/);
	assert.match(rendererBootstrap, /searchParams\.delete\("token"\)/);
	assert.ok(
		rendererBootstrap.indexOf('searchParams.delete("token")') < rendererBootstrap.indexOf("await fetch(bootstrapUrl"),
		"native token must leave the URL before the first bootstrap await",
	);
	assert.match(rendererMain, /redactRendererUrl/);
	assert.doesNotMatch(rendererMain, /url: window\.location\.href/);
});

test("native memory diagnostics are enabled by bootstrap state, not a URL guess", () => {
	assert.match(rendererBootstrap, /memoryProfileEnabled/);
	assert.doesNotMatch(rendererBootstrap, /query\.get\("memoryProfile"\)/);
});

test("release and debug native binaries have explicit packaged defaults", () => {
	assert.match(xmake, /PIDECK_NATIVE_PACKAGED=1/);
	assert.match(xmake, /PIDECK_NATIVE_PACKAGED=0/);
	assert.match(xmake, /PIDECK_VERSION/);
	assert.match(xmake, /PIDECK_BUILD_VERSION/);
});

test("portable startup explains a missing WebView2 runtime", () => {
	assert.match(mainSource, /hasWebView2Runtime/);
	assert.match(mainSource, /F3017226-FE2A-4295-8BDF-00C3A9A7E4C5/);
	assert.match(mainSource, /developer\.microsoft\.com\/microsoft-edge\/webview2/);
	assert.match(mainSource, /showMissingWebView2Message/);
});

test("Windows frameless maximize uses the monitor work area and Qt system move", () => {
	const header = readFileSync("native/src/MainWindow.h", "utf8");
	const mainWindow = readFileSync("native/src/MainWindow.cpp", "utf8");
	assert.match(header, /bool nativeEvent\(const QByteArray &eventType, void \*message, qintptr \*result\) override/);
	assert.match(header, /using SystemMoveStarter = std::function<bool\(\)>;/);
	const nativeEventStart = mainWindow.indexOf("bool MainWindow::nativeEvent(");
	const nativeFilterStart = mainWindow.indexOf("bool MainWindow::nativeEventFilter(");
	assert.ok(nativeEventStart >= 0 && nativeFilterStart > nativeEventStart);
	const nativeEvent = mainWindow.slice(nativeEventStart, nativeFilterStart);
	assert.match(nativeEvent, /windowFlags\(\) & Qt::FramelessWindowHint/);
	assert.match(nativeEvent, /WM_GETMINMAXINFO/);
	assert.match(nativeEvent, /MonitorFromWindow/);
	assert.match(nativeEvent, /MONITOR_DEFAULTTONEAREST/);
	assert.match(nativeEvent, /GetMonitorInfoW/);
	assert.match(nativeEvent, /rcWork/);
	assert.match(nativeEvent, /rcMonitor/);
	assert.match(nativeEvent, /ptMaxPosition/);
	assert.match(nativeEvent, /ptMaxSize/);

	const moveStart = mainWindow.indexOf("void MainWindow::beginSystemMove()");
	const resizeStart = mainWindow.indexOf("bool MainWindow::beginSystemResize(");
	assert.ok(moveStart >= 0 && resizeStart > moveStart);
	const move = mainWindow.slice(moveStart, resizeStart);
	assert.match(move, /if \(isFullScreen\(\)\) return/);
	const qtMoveStart = move.indexOf("if (auto *handle = windowHandle())");
	const windowsFallbackStart = move.indexOf("#ifdef Q_OS_WIN");
	assert.ok(qtMoveStart >= 0 && windowsFallbackStart > qtMoveStart,
		"Qt system move must be attempted before the Windows fallback");
	assert.match(move, /m_systemMoveStarter/);
	assert.match(move, /handle->startSystemMove\(\)/);
	assert.match(move, /#ifdef Q_OS_WIN[\s\S]*POINT cursor\{\}/);
	assert.match(move, /GetCursorPos\(&cursor\)/);
	assert.match(move, /ReleaseCapture\(\)/);
	assert.match(move, /SendMessageW\([\s\S]*WM_NCLBUTTONDOWN,[\s\S]*HTCAPTION,[\s\S]*MAKELPARAM\(cursor\.x, cursor\.y\)\)/);
	assert.match(move, /Leave m_systemMoveActive set/);
	assert.doesNotMatch(move, /m_systemMoveActive = false;\s*\n#ifdef Q_OS_WIN/);
	assert.doesNotMatch(move, /#else[\s\S]*startSystemMove\(\)/);
	assert.match(nativeEvent, /WM_EXITSIZEMOVE/);
	assert.match(mainWindow, /scheduleRestoredGeometryClamp\(\)/);
});

test("window.unmaximize restores and clamps through MainWindow", () => {
	const handlerStart = mainSource.indexOf('host.registerHandler(QStringLiteral("window.unmaximize")');
	const nextHandler = mainSource.indexOf("host.registerHandler", handlerStart + 1);
	assert.ok(handlerStart >= 0 && nextHandler > handlerStart);
	const handler = mainSource.slice(handlerStart, nextHandler);
	assert.match(handler, /mainWindow->restoreWindow\(\)/);
	assert.doesNotMatch(handler, /mainWindow->showNormal\(\)/);
});

test("frameless native windows expose all renderer resize edges and Qt system resize", () => {
	const mainWindow = readFileSync("native/src/MainWindow.cpp", "utf8");
	const header = readFileSync("src/renderer/src/components/AppHeader.tsx", "utf8");
	const shell = readFileSync("src/renderer/src/components/app/AppShell.tsx", "utf8");
	assert.match(mainWindow, /startSystemResize\(edges\)/);
	const dragStart = header.indexOf('className="window-drag-layer"');
	const controlsStart = header.indexOf('className="window-controls"', dragStart);
	assert.ok(dragStart >= 0 && controlsStart > dragStart);
	const dragLayer = header.slice(dragStart, controlsStart);
	assert.doesNotMatch(dragLayer, /beginWindowDrag\(\);/);
	assert.doesNotMatch(dragLayer, /onDoubleClick/);
	assert.match(shell, /onPointerDownCapture=\{\(event\) => \{/);
	assert.match(shell, /enableNativeResize/);
	assert.match(shell, /shouldBeginWindowDrag\(event\.target\)/);
	assert.match(shell, /beginWindowDrag\(\);/);
	assert.match(shell, /onDoubleClickCapture=\{\(event\) => \{/);
	assert.match(shell, /toggleMaximizeWindow\(\);/);
	for (const edge of ["top", "bottom", "left", "right", "top-left", "top-right", "bottom-left", "bottom-right"]) {
		assert.match(header, new RegExp(`edge: "${edge}"`));
	}
	assert.match(header, /enableNativeResize && !maximized/);
});

test("native reload restores the last authenticated WebView URL", () => {
	const header = readFileSync("native/src/MainWindow.h", "utf8");
	const mainWindow = readFileSync("native/src/MainWindow.cpp", "utf8");
	assert.match(header, /#include <QUrl>/);
	assert.match(header, /QUrl m_reloadUrl;/);
	const loadStart = mainWindow.indexOf("void MainWindow::load(const QUrl &url)");
	const reloadStart = mainWindow.indexOf("void MainWindow::reload()");
	const focusStart = mainWindow.indexOf("void MainWindow::focusWindow()");
	assert.ok(loadStart >= 0 && reloadStart > loadStart && focusStart > reloadStart);
	assert.match(mainWindow.slice(loadStart, reloadStart), /m_reloadUrl = url/);
	const reload = mainWindow.slice(reloadStart, focusStart);
	assert.match(reload, /m_surface->load\(m_reloadUrl\)/);
	assert.doesNotMatch(reload, /m_surface->reload\(\)/);
});

test("native browser refresh shortcuts use Qt and Windows authenticated reload paths", () => {
	const header = readFileSync("native/src/MainWindow.h", "utf8");
	const mainWindow = readFileSync("native/src/MainWindow.cpp", "utf8");
	const webSurface = readFileSync("native/src/MainWebSurface.cpp", "utf8");
	assert.match(header, /QAbstractNativeEventFilter/);
	assert.match(header, /nativeEventFilter\(/);
	assert.match(mainWindow, /m_surface->container\(\)->installEventFilter\(this\)/);
	assert.match(mainWindow, /m_surface->view\(\)->installEventFilter\(this\)/);
	assert.match(mainWindow, /installNativeEventFilter\(this\)/);
	const shortcutStart = mainWindow.indexOf("bool isNativeRefreshShortcut");
	const nativeFilterStart = mainWindow.indexOf("bool MainWindow::nativeEventFilter");
	const filterStart = mainWindow.indexOf("bool MainWindow::eventFilter");
	const loadStart = mainWindow.indexOf("void MainWindow::load(const QUrl &url)");
	assert.ok(shortcutStart >= 0 && nativeFilterStart > shortcutStart && filterStart > nativeFilterStart && loadStart > filterStart);
	const filters = mainWindow.slice(shortcutStart, loadStart);
	assert.match(filters, /QEvent::KeyPress/);
	assert.match(filters, /Qt::Key_F5/);
	assert.match(filters, /Qt::Key_R/);
	assert.match(filters, /WM_KEYDOWN/);
	assert.match(filters, /VK_F5/);
	assert.match(filters, /reload\(\)/);
	assert.match(filters, /return true/);
	assert.match(filters, /IsChild/);
	assert.doesNotMatch(webSurface, /m_view->reload\(\)/);
});

test("native Windows GUI refresh regression uses native keyboard messages", () => {
	const guiTest = readFileSync("native/tests/NativeGuiIntegration.cpp", "utf8");
	assert.match(guiTest, /#ifdef Q_OS_WIN/);
	assert.doesNotMatch(guiTest, /SetFocus\(reloadHwnd\)/);
	assert.match(guiTest, /PostMessageW\(reloadHwnd, WM_KEYDOWN, VK_F5/);
	assert.match(guiTest, /PostMessageW\(reloadHwnd, WM_KEYDOWN, VK_CONTROL/);
	assert.match(guiTest, /PostMessageW\(reloadHwnd, WM_KEYDOWN, 'R'/);
	assert.match(guiTest, /waitForWebViewUrl\(reloadView, authenticatedUrl\)/);
});

test("macOS native chrome keeps system resize and uses the Dock reopen delegate", () => {
	const policy = readFileSync("native/src/NativeWindowPolicy.cpp", "utf8");
	const main = readFileSync("native/src/main.cpp", "utf8");
	const dockDelegate = readFileSync("native/src/MacDockReopenHandler.mm", "utf8");
	assert.match(policy, /#ifdef Q_OS_MACOS[\s\S]*return true/);
	assert.match(policy, /#ifdef Q_OS_MACOS[\s\S]*return false/);
	assert.doesNotMatch(main, /QGuiApplication::applicationStateChanged/);
	assert.match(main, /installMacDockReopenHandler/);
	assert.match(main, /uninstallMacDockReopenHandler/);
	assert.match(main, /setCloseHideAvailableHandler/);
	assert.match(main, /#ifdef Q_OS_MACOS[\s\S]*return true/);
	assert.match(dockDelegate, /applicationShouldHandleReopen/);
	assert.match(dockDelegate, /hasVisibleWindows/);
	assert.match(dockDelegate, /setDelegate/);
	assert.match(dockDelegate, /forwardingTargetForSelector/);
});

test("native clipboard image snapshots bound the edge before the PNG budget and coalesce work", () => {
	const clipboard = readFileSync("native/src/ClipboardController.cpp", "utf8");
	assert.match(clipboard, /kMaxClipboardImageEdge = 2000/);
	assert.match(clipboard, /bounded\.scaled/);
	assert.match(clipboard, /for \(const int edge : \{2000, 1800, 1600, 1400, 1200\}\)/);
	assert.match(clipboard, /state->encoding/);
	assert.match(clipboard, /state->cachedImageReady/);
});

test("macOS Dock reopen support is compiled only with the macOS Objective-C++ source", () => {
	assert.match(xmake, /is_plat\("macosx"\)[\s\S]*MacDockReopenHandler\.mm/);
	assert.match(xmake, /add_frameworks\("AppKit"\)/);
});

test("native build helpers do not force Windows runtime tools on other platforms", () => {
	const guiTest = readFileSync("scripts/test-native-gui.mjs", "utf8");
	assert.match(guiTest, /process\.platform === "win32"/);
	assert.doesNotMatch(guiTest, /QT_QPA_PLATFORM: process\.env\.QT_QPA_PLATFORM \?\? "windows"/);
	assert.match(xmake, /after_build\(function \(target\)\s+if not is_plat\("windows"\) then return end/);
});

test("native startup presets and window flags are handled by production helpers", () => {
	const startupBounds = readFileSync("native/src/StartupWindowBounds.cpp", "utf8");
	const mainWindow = readFileSync("native/src/MainWindow.cpp", "utf8");
	assert.match(startupBounds, /normal-compact/);
	assert.match(startupBounds, /QSize\(1100, 720\)/);
	assert.match(startupBounds, /normal-medium/);
	assert.match(startupBounds, /QSize\(1280, 840\)/);
	assert.match(startupBounds, /normal-large/);
	assert.match(mainWindow, /startupMode == QStringLiteral\("last"\) && hasLastBounds/);
	assert.match(mainWindow, /const bool wasVisible = isVisible\(\)/);
	assert.match(mainWindow, /setWindowState\(oldState\)/);
	assert.match(mainWindow, /if \(wasVisible\) show\(\)/);
	assert.match(mainWindow, /else hide\(\)/);
});

test("native restore picks the screen with the largest normal-bounds intersection", () => {
	const startupBounds = readFileSync("native/src/StartupWindowBounds.cpp", "utf8");
	const mainWindow = readFileSync("native/src/MainWindow.cpp", "utf8");
	const nativeMain = readFileSync("native/src/main.cpp", "utf8");
	const guiTest = readFileSync("native/tests/NativeGuiIntegration.cpp", "utf8");
	assert.match(startupBounds, /screenIndexWithLargestIntersection/);
	assert.match(startupBounds, /clampRestoredNormalGeometry/);
	assert.match(mainWindow, /QGuiApplication::screens\(\)/);
	assert.match(mainWindow, /availableGeometries/);
	assert.match(mainWindow, /screenIndexWithLargestIntersection\(normal, availableGeometries\)/);
	assert.match(mainWindow, /clampRestoredNormalGeometry\(normal, available\)/);
	assert.match(nativeMain, /window\.beginSystemMove/);
	assert.match(nativeMain, /mainWindow->beginSystemMove\(\)/);
	assert.match(guiTest, /gapCenteredWindow/);
	assert.match(guiTest, /largest screen intersection did not win/);
	assert.match(guiTest, /off-screen restore recentered instead of pinning to the bottom-left/);
	assert.match(guiTest, /frameless maximize\/restore forgot the last usable normal position/);
	assert.match(guiTest, /size-only last bounds restore forgot the last usable normal position/);
	assert.match(mainWindow, /m_lastUsableNormalGeometry/);
	assert.match(mainWindow, /QTimer::singleShot\(0, this/);
});

test("native quit waits asynchronously for the sidecar ACK", () => {
	const controller = readFileSync("native/src/BackendProcessController.cpp", "utf8");
	assert.match(controller, /stopAsync/);
	assert.match(controller, /m_gracefulStopTimer\.start/);
	assert.match(controller, /markReadyToExit/);
	assert.match(mainSource, /backendProcess\.stopAsync/);
});

test("native reveal delegates to the shell and quotes the path inside Explorer's single select option", () => {
	const shell = readFileSync("native/src/NativeFileShell.cpp", "utf8");
	assert.match(mainSource, /#include "NativeFileShell\.h"/);
	assert.match(mainSource, /registerHandler\(QStringLiteral\("shell\.showItemInFolder"\)[\s\S]*?return QJsonValue\(revealNativeFile\(params\.value\(QStringLiteral\("path"\)\)\.toString\(\)\)\)/);
	assert.match(shell, /setProgram\(QStringLiteral\("explorer\.exe"\)\)/);
	assert.ok(shell.includes(String.raw`setNativeArguments(QStringLiteral("/select,\"%1\"").arg(QDir::toNativeSeparators(info.absoluteFilePath())))`),
		"Explorer receives /select followed by one quoted absolute path, including paths containing spaces or commas");
	assert.doesNotMatch(shell, /QStringLiteral\("\/select,"\),\s*QDir::toNativeSeparators/);
	assert.doesNotMatch(shell, /cmd\.exe|powershell|setArguments\(/i,
		"the path is passed to Explorer without a command-shell layer or splitting the select option");
	assert.match(shell, /const bool ok = explorer\.startDetached\(\)/);
	assert.match(shell, /explorer\.errorString\(\)/);
	assert.match(shell, /QStringLiteral\("ok"\), ok/);
});
