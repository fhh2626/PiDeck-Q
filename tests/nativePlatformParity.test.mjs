import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const mainSource = readFileSync("native/src/main.cpp", "utf8");
const rendererBootstrap = readFileSync("src/renderer/src/native/initializeNativeDesktop.ts", "utf8");
const rendererMain = readFileSync("src/renderer/src/main.tsx", "utf8");
const hostSource = readFileSync("src/native-node/host/NativeBackendHost.ts", "utf8");
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

test("native renderer server has an explicit restart-and-reload recovery path", () => {
	const server = readFileSync("src/native-node/transport/NativeRendererServer.ts", "utf8");
	const node = readFileSync("src/native-node/index.ts", "utf8");
	assert.match(server, /onServerError/);
	assert.match(server, /eventHistoryBytes = 0/);
	assert.match(node, /recoverRendererServer/);
	assert.match(node, /window\.load/);
});

test("heartbeat watchdog excludes hidden-to-tray windows", () => {
	assert.match(hostSource, /shouldWatchRendererHeartbeat/);
	assert.match(hostSource, /windowVisible/);
	assert.match(readFileSync("src/native-node/index.ts", "utf8"), /shouldWatchRendererHeartbeat\(\)/);
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

test("frameless native windows expose all renderer resize edges and Qt system resize", () => {
	const mainWindow = readFileSync("native/src/MainWindow.cpp", "utf8");
	const header = readFileSync("src/renderer/src/components/AppHeader.tsx", "utf8");
	assert.match(mainWindow, /startSystemResize\(edges\)/);
	for (const edge of ["top", "bottom", "left", "right", "top-left", "top-right", "bottom-left", "bottom-right"]) {
		assert.match(header, new RegExp(`edge: "${edge}"`));
	}
	assert.match(header, /enableNativeResize && !maximized/);
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

test("native quit waits asynchronously for the sidecar ACK", () => {
	const controller = readFileSync("native/src/NodeProcessController.cpp", "utf8");
	assert.match(controller, /stopAsync/);
	assert.match(controller, /m_gracefulStopTimer\.start/);
	assert.match(controller, /markReadyToExit/);
	assert.match(mainSource, /node\.stopAsync/);
});

test("native notifications release callback state when Windows dismisses a toast", () => {
	const toast = readFileSync("native/src/WindowsToastNotifier.cpp", "utf8");
	const main = readFileSync("native/src/main.cpp", "utf8");
	const notifications = readFileSync("src/native-node/platform/NativeNotifications.ts", "utf8");
	assert.match(toast, /notification\.Dismissed/);
	assert.match(main, /notification\.dismissed/);
	assert.match(notifications, /notification\.dismissed/);
});

test("Explorer receives one /select,<path> argument", () => {
	assert.match(mainSource, /QStringLiteral\("\/select,%1"\)/);
	assert.doesNotMatch(mainSource, /QStringLiteral\("\/select,"\),\s*QDir::toNativeSeparators/);
});
