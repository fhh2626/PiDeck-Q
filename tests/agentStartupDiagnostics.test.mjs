import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const mainSource = readFileSync("src/main/pi/AgentManager.ts", "utf8");
const indexSource = readFileSync("src/native-node/index.ts", "utf8");
const sessionBridgeSource = readFileSync("src/main/backend/sessionRuntimeBridge.ts", "utf8");
const systemIpcSource = readFileSync("src/main/ipc/systemIpc.ts", "utf8");
const sessionIpcSource = readFileSync("src/main/ipc/sessionIpc.ts", "utf8");
const preloadSource = readFileSync("src/shared/desktop/createPiDesktopApi.ts", "utf8");
const ipcSource = readFileSync("src/shared/ipc.ts", "utf8");
const appSource = readFileSync("src/renderer/src/App.tsx", "utf8");
const rendererMainSource = readFileSync("src/renderer/src/main.tsx", "utf8");

test("agent startup writes diagnostics across renderer IPC and pi launch boundaries", () => {
	assert.match(ipcSource, /rendererLog:\s*"renderer:log"/);
	assert.match(preloadSource, /rendererLog:\s*\(\s*level: AppLogLevel,\s*scope: string,\s*message: string,\s*detail\?: unknown,/);
	assert.match(systemIpcSource, /ipcChannels\.rendererLog/);
	assert.doesNotMatch(indexSource, /Agent create IPC received|ipcChannels\.agentsCreate/);
	assert.match(mainSource, /Agent create requested/);
	assert.match(mainSource, /Agent ensure trusted directory start/);
	assert.match(mainSource, /Agent ensure trusted directory completed/);
	assert.match(mainSource, /Agent pi process start/);
	assert.match(mainSource, /Agent get_state request start/);
	// 启动/重连路径的 get_state 必须吃用户配置的 rpcTimeout（而非默认 30s 硬编码），
	// 否则慢启动场景超时后，诊断卡“调大 RPC 超时”的指引对启动无效（误导）
	assert.match(mainSource, /client\.request\(\{ type: "get_state" \}, this\.rpcTimeoutMs\)/);
	assert.match(mainSource, /get rpcTimeoutMs\(\): number/);
	assert.match(mainSource, /this\.settingsStore\.get\(\)\.rpcTimeout/);
	assert.match(mainSource, /Prompt RPC request started/);
	assert.match(mainSource, /Prompt RPC response received/);
	assert.match(mainSource, /rpcMs/);
	assert.match(mainSource, /Agent create failed/);
	assert.match(sessionIpcSource, /Session prompt IPC received/);
	assert.match(sessionIpcSource, /sessionRuntimeCoordinator\.send\(input\)/);
	assert.match(sessionIpcSource, /Session prompt IPC completed/);
	assert.match(sessionIpcSource, /Session prompt IPC failed/);
	assert.doesNotMatch(appSource, /api\.agents\.create\(/);
});

test("renderer startup reports bootstrap mount and global errors", () => {
	assert.match(rendererMainSource, /Renderer bootstrap started/);
	assert.match(rendererMainSource, /Renderer React tree mounted/);
	// main.tsx 文案已从 "Renderer startup ..." 收敛为更通用的 runtime 前缀
	assert.match(rendererMainSource, /Renderer uncaught error/);
	assert.match(rendererMainSource, /Renderer React update depth diagnostic/);
	assert.match(rendererMainSource, /Maximum update depth exceeded/);
	assert.match(rendererMainSource, /lastUpdateDepthDiagnosticAt/);
	assert.match(rendererMainSource, /Renderer root element missing/);
	assert.match(rendererMainSource, /function dismissBootOverlay\(\)/);
	assert.match(rendererMainSource, /window\.setTimeout\(dismissBootOverlay, 1500\)/);
});

test("agent create IPC and process handlers keep structured crash diagnostics", () => {
	assert.match(sessionBridgeSource, /Agent create IPC failed/);
	assert.match(indexSource, /HostBridge/);
	assert.match(indexSource, /NativeRendererServer/);
	assert.match(mainSource, /attachPiProcessLifecycle/);
	assert.match(mainSource, /buildStartupFailureMessage/);
	assert.match(mainSource, /handlePiEvent failed/);
});
