import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { Script } from "node:vm";
import ts from "typescript";
import test from "node:test";

const hostRequire = createRequire(import.meta.url);
const moduleCache = new Map();

function loadTs(filePath) {
	const absolute = resolve(filePath);
	if (moduleCache.has(absolute)) return moduleCache.get(absolute).exports;
	const module = { exports: {} };
	moduleCache.set(absolute, module);
	const source = ts.transpileModule(readFileSync(absolute, "utf8"), {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
	}).outputText;
	const localRequire = (id) => {
		if (id.startsWith(".")) {
			const candidate = resolve(dirname(absolute), id).replace(/\.ts$/, "") + ".ts";
			return loadTs(candidate);
		}
		return hostRequire(id);
	};
	new Script(source, { filename: absolute }).runInNewContext({
		module,
		exports: module.exports,
		require: localRequire,
		console,
		process,
		Buffer,
		setTimeout,
		clearTimeout,
	});
	return module.exports;
}

const { createPiDesktopApi } = loadTs("src/shared/desktop/createPiDesktopApi.ts");

/**
 * 遍历真实的 desktopApi 树，逐个调用叶子方法并记录它碰到的 transport 通道。
 * 方法以空参数调用：参数缺失导致的同步异常/拒绝与本测试无关，只关心“它向 transport 发了什么”。
 */
async function exerciseApi(api) {
	const invoked = [];
	const subscribed = [];
	const unsubscribe = () => undefined;
	const transport = {
		invoke: async (channel) => { invoked.push(channel); return undefined; },
		subscribe: (channel) => { subscribed.push(channel); return unsubscribe; },
	};
	const syncHost = {
		readClipboardText: () => "", readClipboardHtml: () => "", readClipboardImage: () => "",
		getPathForFile: () => "", getClipboardPaths: () => [],
	};
	const built = api(transport, syncHost);
	const leaves = [];
	(function walk(node, path) {
		for (const [key, value] of Object.entries(node)) {
			if (typeof value === "function") leaves.push([`${path}${key}`, value]);
			else if (value && typeof value === "object") walk(value, `${path}${key}.`);
		}
	})(built, "");
	const subscribers = [];
	const silent = [];
	for (const [name, fn] of leaves) {
		const subscribedBefore = subscribed.length;
		const invokedBefore = invoked.length;
		let result;
		try {
			result = fn(() => undefined);
			if (result && typeof result.then === "function") await result.catch(() => undefined);
		} catch {
			// 缺参数导致的同步异常：不影响通道记录
		}
		if (subscribed.length > subscribedBefore) subscribers.push({ name, result });
		else if (invoked.length === invokedBefore) silent.push(name);
	}
	return { leaves, invoked, subscribed, subscribers, silent, unsubscribe };
}

test("every desktopApi method talks to a declared IPC channel, and every subscription hands back its unsubscribe", async () => {
	// 契约：桌面 API 只能经 shared/ipc.ts 里声明的通道通信（禁止散落字符串字面量），
	// 且事件订阅必须把 transport 的取消函数原样交还，否则监听会泄漏（AGENTS.md IPC 规则）。
	const { ipcChannels } = loadTsCommonJs("src/shared/ipc.ts");
	const declared = new Set(Object.values(ipcChannels));
	const { leaves, invoked, subscribed, subscribers, silent, unsubscribe } = await exerciseApi(createPiDesktopApi);

	assert.ok(leaves.length > 150, `the walk should reach the whole api surface (got ${leaves.length})`);
	// 显式名单能抓住整个订阅方法被删除的回归，数量下限不能。
	assert.deepEqual(subscribers.map(({ name }) => name).sort(), [
		"app.onFocusSessionTarget",
		"app.onWindowMaximizedChange",
		"projects.onChanged",
		"projects.onTrustRequest",
		"rpcLogs.onLog",
		"sessions.onCatalogRefreshed",
		"sessions.onRuntimeEvent",
		"settings.onApplyWindow",
		"terminal.onData",
		"terminal.onExit",
	]);
	// 逐个方法对账：除下面这些只读本机宿主（同步剪贴板/拖放路径）的方法外，每个方法都必须真正碰到 transport，
	// 否则就是“暴露了方法却没接通道”（例如被改成直接返回空值）。新增的纯宿主方法要在此显式登记。
	assert.deepEqual(silent.sort(), [
		"clipboard.readHtml",
		"clipboard.readImage",
		"clipboard.readText",
		"files.getClipboardCapability",
		"files.getClipboardPaths",
		"files.getPathForFile",
	]);
	assert.deepEqual([...new Set(invoked)].filter((channel) => !declared.has(channel)), []);
	assert.deepEqual([...new Set(subscribed)].filter((channel) => !declared.has(channel)), []);
	for (const { name, result } of subscribers) {
		assert.equal(result, unsubscribe, `${name} must return the transport's unsubscribe function`);
	}
});

test("createPiDesktopApi is a real factory over the injected transport", async () => {
	const invoked = [];
	const transport = {
		invoke: async (channel) => { invoked.push(channel); return undefined; },
		subscribe: () => () => undefined,
	};
	const api = createPiDesktopApi(transport, {
		readClipboardText: () => "", readClipboardHtml: () => "", readClipboardImage: () => "",
		getPathForFile: () => "", getClipboardPaths: () => [],
	});
	await api.usageStats.detect();
	assert.deepEqual(invoked, ["usage-stats:detect"], "api calls must go through the injected transport");
});

/** 在沙箱里跑真实的 initializeNativeDesktop：transport/syncHost/浏览器全局都是替身，工厂调用被录制。 */
function loadBootstrap() {
	const factoryCalls = [];
	class FakeTransport {
		constructor(baseUrl, token) { this.baseUrl = baseUrl; this.token = token; }
		async ready() {}
		reconnect() {}
		subscribe() { return () => undefined; }
		activateAfter() {}
		getLastEventSeq() { return 0; }
		getEventSourceGeneration() { return ""; }
		handleHeartbeat() {}
		async invoke() { return undefined; }
	}
	class FakeSyncHost { update() {} }
	const noopRequest = { run() {}, dispose() {} };
	const window = {
		location: { search: "?token=secret", href: "http://127.0.0.1:1234/?token=secret", origin: "http://127.0.0.1:1234" },
		history: { replaceState: () => undefined },
		setTimeout: () => 0,
		clearTimeout: () => undefined,
		setInterval: () => 0,
		clearInterval: () => undefined,
		addEventListener: () => undefined,
		dispatchEvent: () => true,
	};
	const loaded = loadTsCommonJs("src/renderer/src/native/initializeNativeDesktop.ts", {
		stubs: {
			// "@shared" 是打包器别名，加载器无法解析；用真实工厂包一层来录制调用
			"@shared/desktop/createPiDesktopApi": {
				createPiDesktopApi: (transport, syncHost) => {
					factoryCalls.push([transport, syncHost]);
					return createPiDesktopApi(transport, syncHost);
				},
			},
			"./NativeDesktopSyncHost": { NativeDesktopSyncHost: FakeSyncHost },
			"./NativeDesktopTransport": { NativeDesktopTransport: FakeTransport },
			"./nativeHeartbeat": { createNativeHeartbeatRequest: () => noopRequest },
			"./nativeReloadUrl": { createNativeReloadUrl: () => "" },
			"./rendererZoom": { applyRendererZoom: () => undefined },
		},
		globals: {
			window,
			document: { images: [], querySelectorAll: () => [] },
			performance: {},
			CustomEvent: class {},
			fetch: async () => ({ ok: true, json: async () => ({ eventSeq: 0 }) }),
		},
	});
	return { initializeNativeDesktop: loaded.initializeNativeDesktop, window, factoryCalls };
}

test("native bootstrap builds window.piDesktop with the shared factory over its transport", async () => {
	const { initializeNativeDesktop, window, factoryCalls } = loadBootstrap();
	const runtime = await initializeNativeDesktop();
	assert.equal(factoryCalls.length, 1, "bootstrap must build the api exactly once through the shared factory");
	assert.equal(factoryCalls[0][0], runtime.transport);
	assert.equal(factoryCalls[0][1], runtime.syncHost);
	assert.equal(window.piDesktop, runtime.api, "the renderer-visible api is the factory product");
});

test("native bootstrap stays free of Electron APIs", () => {
	// 静态分层规则：渲染层启动代码不得引入 Electron；import 关系只能靠文本检查。
	const bootstrap = readFileSync("src/renderer/src/native/initializeNativeDesktop.ts", "utf8");
	assert.doesNotMatch(bootstrap, /ipcRenderer|contextBridge|from ["']electron["']/);
});
