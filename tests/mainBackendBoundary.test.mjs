import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const backendFiles = [
	"src/main/backend/Backend.ts",
	"src/main/backend/createBackend.ts",
	"src/main/backend/sessionRuntimeBridge.ts",
	"src/main/backend/registerBackendRpc.ts",
	"src/main/backend/backendStartupTasks.ts",
];

for (const file of backendFiles) {
	test(`${file} remains host-neutral business code`, () => {
		const source = readFileSync(file, "utf8");
		assert.doesNotMatch(source, /from\s+["']electron["']/);
		assert.doesNotMatch(source, /app\.whenReady|new BrowserWindow|new Tray|app\.quit\(\)/);
	});
}

test("native sidecar creates the backend and owns host lifecycle", () => {
	const source = readFileSync("src/native-node/index.ts", "utf8");
	assert.match(source, /createBackend\(/);
	assert.match(source, /backend\?\.dispose\(\)/);
	assert.match(source, /NativeRpcRouter/);
	assert.match(source, /createNativePlatformServices/);
	assert.doesNotMatch(source, /main\/index/);
});

test("backend registers RPC through the transport-neutral router", () => {
	const createBackend = readFileSync("src/main/backend/createBackend.ts", "utf8");
	const registerRpc = readFileSync("src/main/backend/registerBackendRpc.ts", "utf8");
	assert.match(createBackend, /registerBackendRpc\(/);
	assert.match(registerRpc, /router\.handle/);
	assert.doesNotMatch(registerRpc, /ipcMain|ipcRenderer|BrowserWindow/);
});

test("canonical settings, chat workspace, logs and RPC logs stay in userData", () => {
	const source = readFileSync("src/main/backend/createBackend.ts", "utf8");
	assert.match(source, /desktopSettingsFile:\s*join\(paths\.userData,\s*"settings\.json"\)/);
	assert.match(source, /defaultChatProjectPath:\s*join\(paths\.userData,\s*"chat-workspace"\)/);
	assert.match(source, /directory:\s*join\(paths\.userData,\s*"logs",\s*"rpc"\)/);
});

test("system IPC delegates restart and host window controls without process.exit", () => {
	const source = readFileSync("src/main/ipc/systemIpc.ts", "utf8");
	assert.match(source, /restartApplication\(\)/);
	assert.doesNotMatch(source, /process\.exit/);
	assert.match(source, /mainWindowControls\.toggleAlwaysOnTop\(\)/);
	assert.match(source, /mainWindowControls\.notifyTitleBarChange\(/);
});
