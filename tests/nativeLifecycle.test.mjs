import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const mainSource = readFileSync("native/src/main.cpp", "utf8");
const nodeController = readFileSync("native/src/NodeProcessController.cpp", "utf8");
const nodeIndex = readFileSync("src/native-node/index.ts", "utf8");
const pathsSource = readFileSync("native/src/NativePaths.cpp", "utf8");
const applicationSource = readFileSync("native/src/NativeApplication.cpp", "utf8");
const devScript = readFileSync("scripts/dev-native.mjs", "utf8");
const installer = readFileSync("installer/PiDeck-Q.nsi", "utf8");
const toast = readFileSync("native/src/WindowsToastNotifier.cpp", "utf8");

 test("native window has one explicit owner and restart waits for sidecar shutdown", () => {
	assert.doesNotMatch(mainSource, /WA_DeleteOnClose/);
	assert.match(mainSource, /const int exitCode = app\.exec\(\);[\s\S]*startDetached/);
	assert.doesNotMatch(mainSource, /application\.restart[\s\S]{0,800}startDetached/);
});

test("Qt handles sidecar lifecycle locally and uses the graceful ACK event", () => {
	assert.match(nodeController, /setNodeExitHandler/);
	assert.match(nodeController, /setNodeErrorHandler/);
	assert.match(nodeController, /application\.prepareQuit/);
	assert.doesNotMatch(nodeController, /sendEvent\(QStringLiteral\("application\.node(?:Error|Exit)"/);
	assert.match(nodeIndex, /application\.readyToExit/);
	assert.match(nodeIndex, /closeGracefully/);
	assert.match(nodeController, /m_readyToExit/);
	assert.match(nodeController, /postAckExitTimeoutMs/);
	assert.match(nodeController, /gracefulTimer/);
});

test("native dev mode explicitly isolates packaged state, user data and toast identity", () => {
	assert.match(pathsSource, /PIDECK_PACKAGED/);
	assert.doesNotMatch(pathsSource, /exists\(paths\.nativeNodeEntry\)/);
	assert.match(devScript, /PIDECK_PACKAGED:\s*"0"/);
	assert.match(devScript, /pi-desktop-dev/);
	assert.match(devScript, /com\.ayuayue\.pi-desktop-dev/);
	assert.match(devScript, /PIDECK_TOAST_SHORTCUT_NAME:\s*"PiDeck-Q Dev\.lnk"/);
	assert.match(applicationSource, /PiDeck-Q Dev\.lnk/);
	assert.match(applicationSource, /PIDECK_TOAST_SHORTCUT_NAME/);
	assert.match(toast, /PIDECK_TOAST_SHORTCUT_NAME/);
	assert.ok(
		mainSource.indexOf("NativeApplication::configure(paths)") < mainSource.indexOf("registerApplication"),
		"toast registration must use the configured packaged/dev identity",
	);
});

test("native GUI integration target covers window, theme, clipboard and toast lifecycles", () => {
	const xmakeSource = readFileSync("xmake.lua", "utf8");
	const guiTest = readFileSync("native/tests/NativeGuiIntegration.cpp", "utf8");
	assert.match(xmakeSource, /PiDeck-NativeGuiTest/);
	assert.match(guiTest, /applyNativeThemeSource/);
	assert.match(guiTest, /toggleAlwaysOnTop/);
	assert.match(guiTest, /ClipboardController/);
	assert.match(guiTest, /WindowsToastNotifier::initialize/);
});

test("installer owns protocol cleanup and the toast shortcut AppUserModelID", () => {
	assert.match(installer, /!include\s+"LogicLib\.nsh"/);
	assert.match(installer, /Software\\Classes\\pideck\\shell\\open\\command/);
	assert.match(installer, /DeleteRegKey HKCU "Software\\Classes\\pideck"/);
	assert.match(installer, /SetShortcutAppId\.ps1/);
	assert.match(installer, /com\.ayuayue\.pi-desktop/);
	assert.match(toast, /PIDECK_APP_USER_MODEL_ID/);
	assert.doesNotMatch(toast, /CreateToastNotifier\(\s*L"com\.ayuayue\.pi-desktop"/);
	assert.match(mainSource, /QMetaObject::invokeMethod\(&host/);
});
