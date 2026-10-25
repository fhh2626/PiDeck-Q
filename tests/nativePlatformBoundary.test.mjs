import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

function filesUnder(dir, result = []) {
	for (const entry of readdirSync(dir)) {
		const path = join(dir, entry).replaceAll("\\", "/");
		if (statSync(path).isDirectory()) filesUnder(path, result);
		else if (/\.(ts|tsx)$/.test(path)) result.push(path);
	}
	return result;
}

test("native platform boundary keeps backend/business code free of Electron", () => {
	// 文本断言是对的工具：这是「业务/Sidecar 层不得 import Electron」的静态分层规则，没有可执行行为。
	const files = [
		...filesUnder("src/main/backend"),
		...filesUnder("src/main/ipc"),
		...filesUnder("src/main/platform"),
		...filesUnder("src/native-node"),
	];
	const allowed = (file) => file === "src/main/ipc/electronPreloadLifecycleIpc.ts" || file.startsWith("src/main/platform/electron/");
	const offending = files.filter((file) => {
		if (allowed(file)) return false;
		const source = readFileSync(file, "utf8");
		return /from\s+["']electron["']|require\(["']electron["']\)|\bBrowserWindow\b/.test(source);
	});
	assert.deepEqual(offending, []);
});

test("native sidecar uses the existing backend contracts rather than Electron entrypoints", () => {
	// 文本断言：index.ts 是 import 即启动的进程入口，无法在测试中安全加载；这里只守静态装配与禁用依赖规则。
	const source = readFileSync("src/native-node/index.ts", "utf8");
	assert.match(source, /createBackend/);
	assert.match(source, /createNativePlatformServices/);
	assert.match(source, /NativeRpcRouter/);
	assert.doesNotMatch(source, /main\/index/);
	assert.doesNotMatch(source, /ipcMain|ipcRenderer|BrowserWindow/);
});

test("detached NativeBackendHost.sendToRenderer keeps its receiver and forwards args as one array", () => {
	// 行为测试取代对箭头函数源码的正则：backend 注册时会把该回调拆出来传给延迟的目录扫描。
	const { NativeBackendHost } = loadTsCommonJs("src/native-node/host/NativeBackendHost.ts", {
		stubs: { "../../shared/ipc": { ipcChannels: {} } },
	});
	const broadcasts = [];
	const host = { on: () => () => undefined, request: async () => undefined };
	const rendererServer = { broadcast(channel, args) { broadcasts.push({ channel, args, self: this }); } };
	const backendHost = new NativeBackendHost(host, rendererServer, () => ({ showWindow: "", restart: "", quit: "" }));
	const { sendToRenderer } = backendHost;
	sendToRenderer("demo:channel", 1, { two: 2 });
	assert.equal(broadcasts.length, 1);
	assert.equal(broadcasts[0].channel, "demo:channel");
	assert.equal(Array.isArray(broadcasts[0].args), true);
	assert.equal(JSON.stringify(broadcasts[0].args), JSON.stringify([1, { two: 2 }]));
	assert.equal(broadcasts[0].self, rendererServer, "broadcast must be invoked on the renderer server, not the detached callback");
});