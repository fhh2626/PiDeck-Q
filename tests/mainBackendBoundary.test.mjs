import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("TEST 1: index.ts 不直接创建 backend services", () => {
	const source = readFileSync("src/main/index.ts", "utf8");
	assert.doesNotMatch(source, /new ProjectStore/);
	assert.doesNotMatch(source, /new AgentManager/);
	assert.doesNotMatch(source, /new SessionCatalog/);
	assert.doesNotMatch(source, /new SessionRuntimeCoordinator/);
	assert.doesNotMatch(source, /new GitService/);
	assert.doesNotMatch(source, /new WebServiceManager/);
	assert.doesNotMatch(source, /new TerminalSessionManager/);
	assert.doesNotMatch(source, /new ConfigManager/);
	assert.doesNotMatch(source, /new SkillManager/);
});

test("TEST 2: index.ts 不直接注册业务 IPC/RPC", () => {
	const source = readFileSync("src/main/index.ts", "utf8");
	assert.doesNotMatch(source, /registerProjectsIpc/);
	assert.doesNotMatch(source, /registerSessionIpc/);
	assert.doesNotMatch(source, /registerGitIpc/);
	assert.doesNotMatch(source, /registerSystemIpc/);
	assert.doesNotMatch(source, /registerFilesIpc/);
	assert.doesNotMatch(source, /registerTerminalIpc/);
	assert.doesNotMatch(source, /registerStoreIpc/);
	assert.doesNotMatch(source, /registerScratchPadIpc/);
	assert.doesNotMatch(source, /registerSecurityIpc/);
	assert.doesNotMatch(source, /registerVisionIpc/);
});

test("TEST 3: index.ts 不包含 Session runtime 胶水代码", () => {
	const source = readFileSync("src/main/index.ts", "utf8");
	assert.doesNotMatch(source, /function createAnonymousSession/);
	assert.doesNotMatch(source, /function stopSessionRuntime/);
	assert.doesNotMatch(source, /function replaceAgentSession/);
	assert.doesNotMatch(source, /function emitSessionRuntimeEvent/);
	assert.doesNotMatch(source, /function sendSessionRuntimeEnvelope/);
});

test("TEST 4: createBackend 与 backend 模块不拥有 Electron lifecycle 与 UI", () => {
	const backendFiles = [
		"src/main/backend/Backend.ts",
		"src/main/backend/createBackend.ts",
		"src/main/backend/sessionRuntimeBridge.ts",
		"src/main/backend/registerBackendRpc.ts",
		"src/main/backend/backendStartupTasks.ts",
	];
	for (const file of backendFiles) {
		const source = readFileSync(file, "utf8");
		assert.doesNotMatch(source, /app\.whenReady/, `${file} 不应包含 app.whenReady`);
		assert.doesNotMatch(source, /app\.on\(/, `${file} 不应包含 app.on(`);
		assert.doesNotMatch(source, /new BrowserWindow/, `${file} 不应包含 new BrowserWindow`);
		assert.doesNotMatch(source, /new Tray/, `${file} 不应包含 new Tray`);
		assert.doesNotMatch(source, /protocol\.registerSchemesAsPrivileged/, `${file} 不应包含 protocol.registerSchemesAsPrivileged`);
		assert.doesNotMatch(source, /app\.quit\(\)/, `${file} 不应包含 app.quit()`);
		assert.doesNotMatch(source, /app\.relaunch\(\)/, `${file} 不应包含 app.relaunch()`);
	}
});

test("TEST 5: createBackend 必须注册 backend RPC", () => {
	const source = readFileSync("src/main/backend/createBackend.ts", "utf8");
	assert.match(source, /registerBackendRpc\(/);
});

test("TEST 6: 首窗后的 tasks 不在 createBackend 关键路径中被 await", () => {
	const source = readFileSync("src/main/backend/createBackend.ts", "utf8");
	assert.doesNotMatch(source, /await startBackendStartupTasks/);
	assert.match(source, /startAfterWindowCreated/);
});

test("TEST 7: Backend 公开接口不暴露底层 managers", () => {
	const source = readFileSync("src/main/backend/Backend.ts", "utf8");
	assert.doesNotMatch(source, /readonly agentManager:/);
	assert.doesNotMatch(source, /readonly projectStore:/);
	assert.doesNotMatch(source, /readonly sessionRuntimeCoordinator:/);
	assert.doesNotMatch(source, /readonly gitService:/);
	assert.doesNotMatch(source, /readonly webServiceManager:/);
	assert.doesNotMatch(source, /readonly terminalManager:/);
});

test("TEST 8: app.activate 不重建 Backend", () => {
	const source = readFileSync("src/main/index.ts", "utf8");
	const activateMatch = source.match(/app\.on\("activate",\s*\(\)\s*=>\s*\{([\s\S]*?)\}\);/);
	assert.ok(activateMatch, "app.activate listener 必须存在");
	assert.match(activateMatch[1], /createWindow/);
	assert.doesNotMatch(activateMatch[1], /createBackend/);
});

test("TEST 9: before-quit 调用 Backend.dispose", () => {
	const source = readFileSync("src/main/index.ts", "utf8");
	const beforeQuitMatch = source.match(/app\.on\("before-quit",\s*\(\)\s*=>\s*\{([\s\S]*?)\}\);/);
	assert.ok(beforeQuitMatch, "before-quit listener 必须存在");
	assert.match(beforeQuitMatch[1], /backend\?\.dispose\(\)/);
});

test("TEST 10: 全局未捕获异常通过 getAppLogger 兜底（覆盖 Backend 异步初始化失败）", () => {
	const source = readFileSync("src/main/index.ts", "utf8");
	assert.match(source, /const logger = backend\?\.appLogger \?\? getAppLogger\(\);/);
	assert.match(source, /void logger\?\.error\("process", "Uncaught exception", error\);/);
	assert.match(source, /void logger\?\.error\("process", "Unhandled rejection", reason\);/);
});

test("TEST 11: Backend 暴露 resolveSessionIdForAgent，Shell 支持旧 agentId 协议跳转", () => {
	const backendSource = readFileSync("src/main/backend/Backend.ts", "utf8");
	const createBackendSource = readFileSync("src/main/backend/createBackend.ts", "utf8");
	const indexSource = readFileSync("src/main/index.ts", "utf8");
	assert.match(backendSource, /resolveSessionIdForAgent\(agentId: string\): string \| undefined;/);
	assert.match(createBackendSource, /resolveSessionIdForAgent:\s*\(agentId: string\)\s*=>\s*sessionRuntimeCoordinator\.getSessionId\(agentId\)/);
	assert.match(indexSource, /!sessionId && target\.agentId && backend/);
	assert.match(indexSource, /sessionId = backend\.resolveSessionIdForAgent\(target\.agentId\);/);
});

test("TEST 12: settings.json, chat-workspace, and logs/rpc remain canonical paths", () => {
	const indexSource = readFileSync("src/main/index.ts", "utf8");
	const createBackendSource = readFileSync("src/main/backend/createBackend.ts", "utf8");
	assert.match(indexSource, /readElectronChromiumSandboxPreference\([\s\S]*?"settings\.json"\)/);
	assert.match(indexSource, /readSingleInstancePreference\([\s\S]*?"settings\.json"\)/);
	assert.match(createBackendSource, /desktopSettingsFile:\s*join\(paths\.userData,\s*"settings\.json"\)/);
	assert.match(createBackendSource, /defaultChatProjectPath:\s*join\(paths\.userData,\s*"chat-workspace"\)/);
	assert.match(createBackendSource, /directory:\s*join\(paths\.userData,\s*"logs",\s*"rpc"\)/);
});

test("TEST 13: systemIpc delegates restart and window controls to host without process.exit bypass", () => {
	const systemIpcSource = readFileSync("src/main/ipc/systemIpc.ts", "utf8");
	assert.match(systemIpcSource, /restartApplication\(\)/);
	assert.doesNotMatch(systemIpcSource, /process\.exit/);
	assert.match(systemIpcSource, /mainWindowControls\.toggleAlwaysOnTop\(\)/);
	assert.match(systemIpcSource, /mainWindowControls\.setZoomFactor\(/);
	assert.match(systemIpcSource, /mainWindowControls\.notifyTitleBarChange\(/);
});

test("TEST 14: createTrashPath rejects when trash capability is unavailable", async () => {
	const { createTrashPath } = await import("../src/main/fs/trash.ts");
	const trashPath = createTrashPath({ trashItem: undefined });
	await assert.rejects(() => trashPath("/some/path"), /Trash service unavailable/);
});
