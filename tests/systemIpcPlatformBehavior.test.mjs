import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve, join } from "node:path";
import ts from "typescript";
import vm from "node:vm";

const require = createRequire(import.meta.url);

/**
 * registerSystemIpc 行为测试。
 *
 * 目标：不再用源码 regex 证明「字符串存在」，而是把真实的 handler 注册到
 * 一个记录式 router 上，invoke 各通道并断言它调用了正确的注入端口、
 * 返回了正确的值。
 *
 * 说明：systemIpc.ts 用「无扩展名」的相对 import，Node 原生 strip-types 无法
 * 直接解析（与 AppUpdateService 不同）。这里用 ts.transpileModule 在 vm 沙箱里
 * 编译，并用一个递归的 .ts 解析 require 加载其传递依赖（全部是 node 内置/纯模块）。
 */

function transpile(source) {
	return ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
	}).outputText;
}

const moduleCache = new Map();

function buildRequire(importerDir, overrides) {
	return (id) => {
		// 1) 显式 override
		for (const key of Object.keys(overrides)) {
			if (id.includes(key)) return overrides[key];
		}
		// 2) 相对路径：解析到真实 .ts 文件并递归加载
		if (id.startsWith("./") || id.startsWith("../")) {
			let base = resolve(importerDir, id);
			if (existsSync(`${base}.ts`)) base = `${base}.ts`;
			else if (existsSync(join(base, "index.ts"))) base = join(base, "index.ts");
			else if (existsSync(`${base}.js`)) base = `${base}.js`;
			return loadTs(base, overrides);
		}
		// 3) node: 内置 / npm 包
		return require(id);
	};
}

function loadTs(filePath, overrides = {}) {
	if (moduleCache.has(filePath)) return moduleCache.get(filePath);
	const source = readFileSync(filePath, "utf8");
	const outputText = transpile(source);
	const sandbox = {
		clearTimeout,
		setTimeout,
		process,
		AbortController,
		Buffer,
		exports: {},
		require: buildRequire(dirname(filePath), overrides),
	};
	moduleCache.set(filePath, sandbox.exports);
	vm.runInNewContext(outputText, sandbox, { filename: filePath });
	return sandbox.exports;
}

// 加载真实的 registerSystemIpc 与 ipcChannels（同源，保证 channel 字符串一致）。
// piExecInstall 内部动态 import node:child_process；保留真实 spawn 等导出，
// 仅替换 execFile，避免测试启动真实安装命令并记录 cwd/options。
const installExecCalls = [];
const realChildProcess = require("node:child_process");
const childProcessOverride = {
	...realChildProcess,
	execFile: (file, args, options, callback) => {
		installExecCalls.push({ file, args, options });
		callback(null, "ok", "");
		return { pid: 1 };
	},
};
const ipcMod = loadTs("src/shared/ipc.ts");
const { ipcChannels } = ipcMod;
const { registerSystemIpc } = loadTs("src/main/ipc/systemIpc.ts", {
	"node:child_process": childProcessOverride,
});

function createRouterHarness() {
	const handlers = new Map();
	const router = {
		handle: (channel, handler) => {
			if (handlers.has(channel)) throw new Error(`duplicate handler: ${channel}`);
			handlers.set(channel, handler);
		},
	};
	const invoke = (channel, ...args) => {
		const handler = handlers.get(channel);
		if (!handler) throw new Error(`no handler registered for: ${channel}`);
		// RpcRouter 的 handler 是 (...args: TArgs) => TResult，没有 event 前缀
		return handler(...args);
	};
	return { router, invoke, handlers };
}

/** 构造 SystemIpcDeps 的全量 mock：只给目标 handler 用到的端口记调用，其余给无害默认值。 */
function createDeps(overrides = {}) {
	const calls = {
		minimize: 0,
		toggleMaximize: 0,
		close: 0,
		setZoomFactor: [],
		toggleAlwaysOnTop: 0,
		notifyTitleBarChange: 0,
		toggleDevTools: 0,
		restartApplication: 0,
		themeSetSource: [],
		hideApplicationMenu: 0,
		openExternalUrl: [],
	};
	const toggleMaximizeResult = { value: true };
	const toggleAlwaysOnTopResult = { value: true };
	const getWindowStateResult = { value: { isMaximized: true } };

	const mainWindowControls = {
		minimize: () => {
			calls.minimize += 1;
		},
		toggleMaximize: () => {
			calls.toggleMaximize += 1;
			return toggleMaximizeResult.value;
		},
		getWindowState: () => getWindowStateResult.value,
		toggleAlwaysOnTop: () => toggleAlwaysOnTopResult.value,
		close: () => {
			calls.close += 1;
		},
		setZoomFactor: (v) => calls.setZoomFactor.push(v),
		notifyTitleBarChange: () => {
			calls.notifyTitleBarChange += 1;
		},
		toggleDevTools: () => {
			calls.toggleDevTools += 1;
		},
	};

	const platformTheme = {
		setSource: (s) => calls.themeSetSource.push(s),
	};

	const platformApplication = {
		version: "9.8.7",
		name: "PiDeck",
		isPackaged: false,
		hideApplicationMenu: () => {
			calls.hideApplicationMenu += 1;
		},
		getLocale: () => "zh-CN",
		getPreferredSystemLanguages: () => ["zh-CN", "en-US"],
	};

	const platformPaths = {
		home: "/injected/home",
		userData: "/injected/userData",
		appPath: "/app",
		resourcesPath: "/resources",
	};

	const deps = {
		piLocator: {
			check: async () => ({ installed: true, version: "1.0.0", command: "pi" }),
			validateCustomPath: async () => ({ installed: true, command: "pi" }),
			createProcessEnv: () => ({ PATH: "test-path" }),
		},
		settingsStore: {
			get: () => ({
				theme: "dark",
				zoomFactor: 1.1,
				enableNotifications: true,
				removedBuiltInExtensions: [],
				customPiPath: "",
				wslEnabled: false,
				wslDistro: "Ubuntu",
				wslUser: "u",
				piRuntimePreference: "auto",
			}),
			update: async (patch) => ({ ...patch, theme: "dark", zoomFactor: 1.1 }),
		},
		configManager: {},
		agentManager: {},
		skillManager: {},
		appLogger: {
			info: () => {},
			warn: () => {},
			error: () => {},
			debug: () => {},
		},
		rpcLogger: { push: () => {} },
		sessionRuntimeCoordinator: {},
		stopAgentFromMonitor: async () => ({ ok: true }),
		modelSpecsStore: { lookup: async () => null },
		mainWindowControls,
		platformApplication,
		platformPaths,
		platformShell: { openPath: async () => ({ ok: true }), openExternal: async () => {} },
		platformTheme,
		toggleDevTools: () => {
			calls.toggleDevTools += 1;
		},
		sendToRenderer: () => {},
		mainCopy: (key) => key,
		checkForAppUpdate: async () => null,
		downloadUpdateAsset: async (asset) => ({ filePath: `/updates/${asset.name}` }),
		openDownloadedUpdate: async () => {},
		openExternalUrl: async (url, forceSystem) => {
			calls.openExternalUrl.push({ url, forceSystem });
		},
		restartApplication: () => {
			calls.restartApplication += 1;
		},
		__results: {
			toggleMaximize: toggleMaximizeResult,
			toggleAlwaysOnTop: toggleAlwaysOnTopResult,
			getWindowState: getWindowStateResult,
		},
		...overrides,
	};
	return { deps, calls, controls: mainWindowControls, results: deps.__results };
}

test("systemIpc appInfo returns platform application version and platform", async () => {
	const { router, invoke } = createRouterHarness();
	const { deps } = createDeps();
	registerSystemIpc(router, deps);

	const info = await invoke(ipcChannels.appInfo);
	assert.equal(info.version, "9.8.7");
	assert.equal(info.platform, process.platform);
	assert.equal(typeof info.releasesUrl, "string");
});

test("systemIpc preferred system languages come from the platform adapter", async () => {
	const { router, invoke } = createRouterHarness();
	const { deps } = createDeps();
	registerSystemIpc(router, deps);

	const langs = await invoke(ipcChannels.appPreferredSystemLanguages);
	assert.deepEqual(langs, ["zh-CN", "en-US"]);
});

test("systemIpc appRestart delegates to restartApplication exactly once", async () => {
	const { router, invoke } = createRouterHarness();
	const { deps, calls } = createDeps();
	registerSystemIpc(router, deps);

	await invoke(ipcChannels.appRestart);
	assert.equal(calls.restartApplication, 1);
});

test("systemIpc window minimize/close delegate to MainWindowControls", async () => {
	const { router, invoke } = createRouterHarness();
	const { deps, calls } = createDeps();
	registerSystemIpc(router, deps);

	await invoke(ipcChannels.appWindowMinimize);
	await invoke(ipcChannels.appWindowClose);
	assert.equal(calls.minimize, 1);
	assert.equal(calls.close, 1);
});

test("systemIpc window toggle maximize returns the control result and reports maximized state", async () => {
	const { router, invoke } = createRouterHarness();
	const { deps, calls, results } = createDeps();
	registerSystemIpc(router, deps);

	results.toggleMaximize.value = true;
	assert.equal(await invoke(ipcChannels.appWindowToggleMaximize), true);
	assert.equal(calls.toggleMaximize, 1);

	results.toggleMaximize.value = false;
	assert.equal(await invoke(ipcChannels.appWindowToggleMaximize), false);

	results.getWindowState.value = { isMaximized: true };
	assert.equal(await invoke(ipcChannels.appWindowIsMaximized), true);
});

test("systemIpc always-on-top returns the control result", async () => {
	const { router, invoke } = createRouterHarness();
	const { deps, results } = createDeps();
	registerSystemIpc(router, deps);

	results.toggleAlwaysOnTop.value = false;
	assert.equal(await invoke(ipcChannels.appWindowToggleAlwaysOnTop), false);
});

test("systemIpc appToggleDevTools prefers MainWindowControls over fallback", async () => {
	const { router, invoke } = createRouterHarness();
	const fallbackCalls = [];
	const { deps, calls } = createDeps({
		// 同时提供 controls 与 fallback：controls 存在时 fallback 不应被调用
		toggleDevTools: () => fallbackCalls.push(1),
	});
	registerSystemIpc(router, deps);

	await invoke(ipcChannels.appToggleDevTools);
	assert.equal(calls.toggleDevTools, 1, "MainWindowControls.toggleDevTools must be called");
	assert.equal(fallbackCalls.length, 0, "fallback toggleDevTools must not run when controls exist");
});

test("systemIpc theme patch calls PlatformTheme.setSource", async () => {
	const { router, invoke } = createRouterHarness();
	const { deps, calls } = createDeps();
	registerSystemIpc(router, deps);

	await invoke(ipcChannels.settingsUpdate, { theme: "light" });
	assert.deepEqual(calls.themeSetSource, ["light"]);
	assert.ok(calls.hideApplicationMenu >= 1);
});

test("systemIpc zoomFactor patch notifies the renderer CSS zoom adapter", async () => {
	const { router, invoke } = createRouterHarness();
	const { deps, calls } = createDeps();
	registerSystemIpc(router, deps);

	await invoke(ipcChannels.settingsUpdate, { zoomFactor: 1.1 });
	assert.equal(calls.notifyTitleBarChange, 1);
});

test("systemIpc useNativeTitleBar patch calls notifyTitleBarChange", async () => {
	const { router, invoke } = createRouterHarness();
	const { deps, calls } = createDeps();
	registerSystemIpc(router, deps);

	await invoke(ipcChannels.settingsUpdate, { useNativeTitleBar: true });
	assert.equal(calls.notifyTitleBarChange, 1);
});

test("systemIpc appOpenExternal delegates to openExternalUrl (not raw shell)", async () => {
	const { router, invoke } = createRouterHarness();
	const { deps, calls } = createDeps();
	registerSystemIpc(router, deps);

	await invoke(ipcChannels.appOpenExternal, "https://example.com", true);
	assert.deepEqual(calls.openExternalUrl, [{ url: "https://example.com", forceSystem: true }]);
});

test("systemIpc Pi check uses injected piLocator", async () => {
	const { router, invoke } = createRouterHarness();
	const checkArgs = [];
	const { deps } = createDeps({
		piLocator: {
			check: async (...args) => {
				checkArgs.push(args);
				return { installed: true, version: "2.2.2", command: "pi" };
			},
			validateCustomPath: async () => ({ installed: true, command: "pi" }),
			createProcessEnv: () => ({ PATH: "test-path" }),
		},
	});
	registerSystemIpc(router, deps);

	const status = await invoke(ipcChannels.piCheck);
	assert.equal(status.version, "2.2.2");
	assert.equal(checkArgs.length, 1, "piLocator.check must be called once");
});

test("systemIpc piExecInstall uses platformPaths.home as child cwd", async () => {
	installExecCalls.length = 0;
	const { router, invoke } = createRouterHarness();
	const { deps } = createDeps({
		platformPaths: {
			home: "/injected/install-home",
			userData: "/injected/userData",
			appPath: "/app",
			resourcesPath: "/resources",
		},
	});
	registerSystemIpc(router, deps);

	const result = await invoke(ipcChannels.piExecInstall, "npm install -g test-pi");
	assert.equal(result.success, true);
	assert.equal(installExecCalls.length, 1, "install handler must execute exactly one child process");
	assert.equal(
		installExecCalls[0].options.cwd,
		"/injected/install-home",
		"Pi install cwd must come from injected platformPaths.home",
	);
	assert.notEqual(installExecCalls[0].options.cwd, process.cwd());
});
