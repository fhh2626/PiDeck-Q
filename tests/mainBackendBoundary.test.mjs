import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { createBackendOptions, createRecorder, loadCreateBackend } from "./helpers/l2_createBackendHarness.mjs";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { ipcChannels } = loadTsCommonJs("src/shared/ipc.ts");

const backendFiles = [
	"src/main/backend/Backend.ts",
	"src/main/backend/createBackend.ts",
	"src/main/backend/sessionRuntimeBridge.ts",
	"src/main/backend/registerBackendRpc.ts",
	"src/main/backend/backendStartupTasks.ts",
];

for (const file of backendFiles) {
	test(`${file} remains host-neutral business code`, () => {
		// 文本断言是对的工具：这是「业务层不得 import 宿主框架」的静态分层规则，没有可执行的行为可测。
		const source = readFileSync(file, "utf8");
		assert.doesNotMatch(source, /from\s+["']electron["']/);
		assert.doesNotMatch(source, /app\.whenReady|new BrowserWindow|new Tray|app\.quit\(\)/);
	});
}

test("native sidecar creates the backend and owns host lifecycle", () => {
	// 文本断言：src/native-node/index.ts 是 import 即执行的进程入口（读取宿主 TCP 环境变量、
	// 连接 HostBridge、启动 void main()），不经生产代码重构无法在测试里行为化加载；
	// 这里只守「入口装配了哪些部件」以及「不得回指 main/index」的静态分层规则。
	const source = readFileSync("src/native-node/index.ts", "utf8");
	assert.match(source, /createBackend\(/);
	assert.match(source, /(?:backend\?\.dispose|activeBackend\.dispose)\(\)/);
	assert.match(source, /NativeRpcRouter/);
	assert.match(source, /createNativePlatformServices/);
	assert.doesNotMatch(source, /main\/index/);
});

/** 记录 handle 注册、可按通道名分发调用的假 router。 */
function createFakeRouter() {
	const handlers = new Map();
	return {
		handlers,
		handle: (channel, handler) => { handlers.set(channel, handler); },
		invoke: async (channel, args = []) => handlers.get(channel)(...args),
	};
}

/** 装载真实 registerBackendRpc；各域 register*Ipc 换成记录型假实现，只观察「装配了谁、传了哪个 router」。 */
function loadRegisterBackendRpc() {
	const recorder = createRecorder();
	const registrations = [];
	const disposed = [];
	const domainRegistrar = (name) => (router, deps) => {
		registrations.push({ name, router, deps });
		return name === "registerGitIpc" ? () => disposed.push(name) : undefined;
	};
	const ipcModule = (...names) => Object.fromEntries(names.map((name) => [name, domainRegistrar(name)]));
	const timers = [];
	const stubs = {
		"../ipc/usageStatsIpc": ipcModule("registerUsageStatsIpc"),
		"../ipc/editorsIpc": ipcModule("registerEditorsIpc"),
		"../ipc/backgroundsIpc": ipcModule("registerBackgroundsIpc"),
		"../ipc/projectsIpc": ipcModule("registerProjectsIpc"),
		"../ipc/scratchPadIpc": ipcModule("registerScratchPadIpc"),
		"../ipc/securityIpc": ipcModule("registerSecurityIpc"),
		"../ipc/visionIpc": ipcModule("registerVisionIpc"),
		"../ipc/sessionIpc": { ...ipcModule("registerSessionIpc"), scheduleCatalogBackgroundScan: () => true, disposeCatalogBackgroundScans: () => {} },
		"../ipc/gitIpc": ipcModule("registerGitIpc"),
		"../ipc/systemIpc": ipcModule("registerSystemIpc"),
		"../ipc/storeIpc": ipcModule("registerStoreIpc"),
		"../ipc/terminalIpc": ipcModule("registerTerminalIpc"),
		"../ipc/filesIpc": ipcModule("registerFilesIpc"),
		"../pi/modelListCache": { fetchModelList: async () => [], getCachedModelList: () => [] },
		"../pi/PiProxyTester": { testPiProxy: async () => ({}) },
		"../settings/DesktopProxy": { applyDesktopProxy: async () => {} },
		"../backgrounds/BackgroundPaths": { resolveBackgroundsDir: (userData) => join(userData, "backgrounds") },
		"../backgrounds/BackgroundImageService": recorder.moduleStub(),
		"../fs/trash": { createTrashPath: () => async () => {} },
	};
	const { registerBackendRpc } = loadTsCommonJs("src/main/backend/registerBackendRpc.ts", {
		stubs,
		// 预扫描/模型预取是延迟定时器；换成只记录的假定时器，既不真等也不泄漏。
		globals: { setTimeout: (callback, delay) => { timers.push({ callback, delay }); return { unref() {} }; }, clearTimeout: () => {} },
	});
	return { registerBackendRpc, registrations, disposed, timers, deep: recorder.deep };
}

test("registerBackendRpc wires every IPC domain onto the one transport-neutral router", () => {
	const harness = loadRegisterBackendRpc();
	const router = createFakeRouter();
	const service = (label) => harness.deep(label);
	const host = {
		sendToRenderer: () => {},
		mainWindowControls: { marker: "window-controls" },
		restartApplication: () => {},
		openExternalUrl: async () => {},
		peekPendingFocusTarget: () => undefined,
		acknowledgeFocusTarget: () => {},
	};
	const platform = {
		paths: { userData: join("/virtual", "ud"), home: join("/virtual", "home") },
		shell: { trashItem: async () => {} },
		application: {}, theme: {}, dialogs: {}, proxy: {},
	};
	const serviceNames = [
		"projectStore", "fileSystemService", "sessionScanner", "sessionCatalog", "sessionRecordService",
		"sessionRuntimeCoordinator", "codexSessionImporter", "claudeSessionImporter", "openCodeSessionImporter",
		"settingsStore", "securityStore", "worktreeService", "gitService", "piLocator", "agentManager",
		"configManager", "promptManager", "xuePromptManager", "skillManager", "extensionManager",
		"projectResourceManager", "webServiceManager", "terminalManager", "appLogger", "rpcLogger",
		"modelSpecsStore", "visionBridge",
	];
	const services = Object.fromEntries(serviceNames.map((name) => [name, service(name)]));
	services.usageStatsService = null;
	harness.registerBackendRpc({
		router, host, platform,
		mainCopy: (key) => key,
		getLocale: () => "en-US",
		runtimeBridge: service("runtimeBridge"),
		services,
	});

	const registered = harness.registrations.map((entry) => entry.name).sort();
	assert.deepEqual(registered, [
		"registerBackgroundsIpc", "registerEditorsIpc", "registerFilesIpc", "registerGitIpc", "registerProjectsIpc",
		"registerScratchPadIpc", "registerSecurityIpc", "registerSessionIpc", "registerStoreIpc", "registerSystemIpc",
		"registerTerminalIpc", "registerUsageStatsIpc", "registerVisionIpc",
	]);
	for (const entry of harness.registrations) {
		assert.equal(entry.router, router, `${entry.name} must register on the shared router, not its own channel`);
	}
	// 宿主能力经 deps 注入而不是被业务层直接 import：systemIpc 拿到的就是宿主给的窗口控制与重启回调
	const system = harness.registrations.find((entry) => entry.name === "registerSystemIpc");
	assert.equal(system.deps.mainWindowControls, host.mainWindowControls);
	assert.equal(system.deps.restartApplication, host.restartApplication);
	// 业务服务按身份下发（securityStore 等不能被替换/复制）
	assert.equal(harness.registrations.find((entry) => entry.name === "registerSecurityIpc").deps.securityStore, services.securityStore);
});

test("registerBackendRpc registers focus-target handlers on the router and returns a disposer for git watchers", async () => {
	const harness = loadRegisterBackendRpc();
	const router = createFakeRouter();
	const acknowledged = [];
	const host = {
		sendToRenderer: () => {},
		mainWindowControls: {},
		restartApplication: () => {},
		openExternalUrl: async () => {},
		peekPendingFocusTarget: () => ({ id: "focus-1" }),
		acknowledgeFocusTarget: (id) => acknowledged.push(id),
	};
	const platform = { paths: { userData: "/ud", home: "/home" }, shell: { trashItem: async () => {} }, application: {}, theme: {}, dialogs: {}, proxy: {} };
	const services = new Proxy({ usageStatsService: null }, { get: (target, name) => (name in target ? target[name] : harness.deep(String(name))) });
	const dispose = harness.registerBackendRpc({ router, host, platform, mainCopy: (key) => key, getLocale: () => "en-US", runtimeBridge: harness.deep("runtimeBridge"), services });

	assert.deepEqual(await router.invoke(ipcChannels.appGetFocusTargetPending), { id: "focus-1" });
	await router.invoke(ipcChannels.appAcknowledgeFocusTarget, ["focus-1"]);
	await router.invoke(ipcChannels.appAcknowledgeFocusTarget, [""]);
	await router.invoke(ipcChannels.appAcknowledgeFocusTarget, ["x".repeat(129)]);
	await router.invoke(ipcChannels.appAcknowledgeFocusTarget, [42]);
	assert.deepEqual(acknowledged, ["focus-1"], "非法 id（空/超长/非字符串）必须在边界被丢弃");

	assert.deepEqual(harness.disposed, []);
	dispose();
	assert.deepEqual(harness.disposed, ["registerGitIpc"], "返回的 disposer 必须释放 git 域资源");
});

test("createBackend assembles the backend and hands the router to registerBackendRpc", async () => {
	const harness = loadCreateBackend();
	const { options, router } = createBackendOptions();
	const backend = await harness.createBackend(options);

	assert.equal(harness.rpcRegistrations.length, 1, "backend 必须注册一次 RPC");
	const deps = harness.rpcRegistrations[0];
	assert.equal(deps.router, router, "RPC 必须注册在宿主传入的 router 上（传输中立）");
	const constructed = (name) => harness.constructed.filter((entry) => entry.name === name);
	assert.equal(deps.services.projectStore, constructed("ProjectStore")[0].instance);
	assert.equal(deps.services.agentManager, constructed("AgentManager")[0].instance);
	assert.equal(typeof backend.dispose, "function");
});

test("canonical settings, chat workspace, logs and RPC logs stay in userData", async () => {
	const harness = loadCreateBackend();
	const { options, userData } = createBackendOptions(join("/virtual", "canonical-user-data"));
	await harness.createBackend(options);
	const argsOf = (name) => harness.constructed.find((entry) => entry.name === name).args[0];

	assert.equal(argsOf("SettingsStore").desktopSettingsFile, join(userData, "settings.json"));
	assert.equal(argsOf("ProjectStore").defaultChatProjectPath, join(userData, "chat-workspace"));
	assert.equal(argsOf("ProjectStore").projectsFile, join(userData, "projects.json"));
	assert.equal(argsOf("RpcLogger").directory, join(userData, "logs", "rpc"));
	assert.equal(argsOf("AppLogger").directory, join(userData, "logs"));
	assert.equal(argsOf("SecurityStore").userDataDir, userData);
});

test("createBackend dispose releases RPC registrations and every owned service exactly once", async () => {
	const harness = loadCreateBackend();
	const { options } = createBackendOptions();
	const backend = await harness.createBackend(options);
	const callsTo = (label) => harness.calls.filter((call) => call.label === label).length;

	assert.equal(harness.rpcDisposals.length, 0);
	await backend.dispose();
	await backend.dispose();
	assert.equal(harness.rpcDisposals.length, 1, "RPC 注册只释放一次（dispose 幂等）");
	assert.equal(callsTo("SessionScanner.dispose"), 1);
	assert.equal(callsTo("TerminalSessionManager.closeAll"), 1);
	assert.equal(callsTo("AgentManager.stopAll"), 1);
	assert.equal(callsTo("WebServiceManager.stop"), 1);
});

/** 装载真实 systemIpc，process.exit 被换成会抛错的陷阱，证明重启/退出只经宿主委托。 */
function loadSystemIpc() {
	const fakeProcess = Object.create(process);
	fakeProcess.exit = () => { throw new Error("process.exit must never be called by system IPC"); };
	return loadTsCommonJs("src/main/ipc/systemIpc.ts", { globals: { process: fakeProcess } });
}

function createSystemIpcHarness() {
	const { registerSystemIpc } = loadSystemIpc();
	const router = createFakeRouter();
	const calls = [];
	const settings = { useNativeTitleBar: false, closeToTray: false };
	const deps = {
		settingsStore: {
			get: () => settings,
			update: async (patch) => ({ ...settings, ...patch }),
		},
		mainWindowControls: {
			minimize: () => calls.push("minimize"),
			toggleMaximize: () => { calls.push("toggleMaximize"); return true; },
			toggleAlwaysOnTop: () => { calls.push("toggleAlwaysOnTop"); return true; },
			close: () => calls.push("close"),
			getWindowState: () => ({ isMaximized: true }),
			notifyTitleBarChange: (next) => calls.push({ notifyTitleBarChange: next }),
			toggleDevTools: () => calls.push("toggleDevTools"),
		},
		platformApplication: { hideApplicationMenu: () => {} },
		restartApplication: () => calls.push("restartApplication"),
	};
	registerSystemIpc(router, deps);
	return { router, calls };
}

test("system IPC delegates restart to the host callback without exiting the process", async () => {
	const { router, calls } = createSystemIpcHarness();
	await router.invoke(ipcChannels.appRestart);
	assert.deepEqual(calls, ["restartApplication"]);
});

test("system IPC delegates host window controls to mainWindowControls", async () => {
	const { router, calls } = createSystemIpcHarness();
	assert.equal(await router.invoke(ipcChannels.appWindowToggleAlwaysOnTop), true);
	assert.equal(await router.invoke(ipcChannels.appWindowToggleMaximize), true);
	assert.equal(await router.invoke(ipcChannels.appWindowIsMaximized), true);
	await router.invoke(ipcChannels.appWindowMinimize);
	await router.invoke(ipcChannels.appWindowClose);
	assert.deepEqual(calls, ["toggleAlwaysOnTop", "toggleMaximize", "minimize", "close"]);
});

test("system IPC notifies the host when title bar settings change", async () => {
	const { router, calls } = createSystemIpcHarness();
	await router.invoke(ipcChannels.settingsUpdate, [{ useNativeTitleBar: true }]);
	assert.equal(calls.length, 1);
	assert.equal(calls[0].notifyTitleBarChange.useNativeTitleBar, true);
});
