import { loadTsCommonJs } from "./loadTsCommonJs.mjs";

/**
 * 用真实 NativeBackendHost（真实 NativeMainWindowControls、真实 ipcChannels），
 * 把 HostBridge 与 NativeRendererServer 换成可记录的替身。
 * - bridge.requests：发给 Qt 宿主的请求（window.show / window.focus ...）
 * - bridge.emit(name, payload)：模拟 Qt 宿主事件
 * - renderer.broadcasts：经 SSE 广播给渲染层的事件
 */
export function createNativeBackendHostHarness() {
	const { NativeBackendHost } = loadTsCommonJs("src/native-node/host/NativeBackendHost.ts", {
		// 外链策略与本测试无关
		stubs: { "../../main/browser/externalLinks": { openExternalLink: async () => undefined } },
	});
	const { ipcChannels } = loadTsCommonJs("src/shared/ipc.ts");
	const listeners = new Map();
	const requests = [];
	const bridge = {
		requests,
		on(name, listener) {
			listeners.set(name, listener);
			return () => listeners.delete(name);
		},
		request: async (method, params) => {
			requests.push({ method, params });
			return undefined;
		},
		emit(name, payload) {
			listeners.get(name)?.(payload);
		},
	};
	const broadcasts = [];
	const renderer = {
		broadcasts,
		broadcast: (channel, args) => broadcasts.push({ channel, args }),
	};
	const nativeHost = new NativeBackendHost(
		bridge,
		renderer,
		() => ({ showWindow: "show", restart: "restart", quit: "quit" }),
	);
	return { nativeHost, bridge, renderer, channels: ipcChannels };
}

/**
 * 加载真实 registerBackendRpc：各域 register*Ipc 换成空实现，只保留装配层自己注册的
 * app:get-focus-target-pending / app:ack-focus-target，host 是可记录的替身。
 */
export function runBackendRpcFocusWiring() {
	const noopRegistrar = (exportName) => ({ [exportName]: () => () => undefined, scheduleCatalogBackgroundScan: () => true });
	const stubs = {
		"../ipc/usageStatsIpc": noopRegistrar("registerUsageStatsIpc"),
		"../ipc/editorsIpc": noopRegistrar("registerEditorsIpc"),
		"../ipc/backgroundsIpc": noopRegistrar("registerBackgroundsIpc"),
		"../ipc/projectsIpc": noopRegistrar("registerProjectsIpc"),
		"../ipc/scratchPadIpc": noopRegistrar("registerScratchPadIpc"),
		"../ipc/securityIpc": noopRegistrar("registerSecurityIpc"),
		"../ipc/visionIpc": noopRegistrar("registerVisionIpc"),
		"../ipc/sessionIpc": noopRegistrar("registerSessionIpc"),
		"../ipc/gitIpc": noopRegistrar("registerGitIpc"),
		"../ipc/systemIpc": noopRegistrar("registerSystemIpc"),
		"../ipc/storeIpc": noopRegistrar("registerStoreIpc"),
		"../ipc/terminalIpc": noopRegistrar("registerTerminalIpc"),
		"../ipc/filesIpc": noopRegistrar("registerFilesIpc"),
		"../pi/modelListCache": { fetchModelList: async () => [], getCachedModelList: () => [] },
		"../pi/PiProxyTester": { testPiProxy: async () => ({}) },
		"../settings/DesktopProxy": { applyDesktopProxy: () => {} },
		"../backgrounds/BackgroundPaths": { resolveBackgroundsDir: (dir) => `${dir}/backgrounds` },
		"../backgrounds/BackgroundImageService": { BackgroundImageService: class {} },
		"../fs/trash": { createTrashPath: () => () => {} },
	};
	const inertTimer = () => ({ unref() {} });
	const { registerBackendRpc } = loadTsCommonJs("src/main/backend/registerBackendRpc.ts", {
		stubs,
		globals: { setTimeout: inertTimer, clearTimeout: () => {} },
	});
	const { ipcChannels } = loadTsCommonJs("src/shared/ipc.ts");
	const handlers = new Map();
	const host = {
		pending: null,
		acked: [],
		sendToRenderer: () => {},
		peekPendingFocusTarget() {
			return this.pending;
		},
		acknowledgeFocusTarget(id) {
			this.acked.push(id);
		},
	};
	// 装配层注册期只读取少量服务字段；任何属性都给出可调用/可读取的空替身
	const permissive = () => new Proxy(function () {}, {
		get: (_t, key) => (key === "then" ? undefined : permissive()),
		apply: () => [],
	});
	registerBackendRpc({
		router: { handle: (channel, handler) => handlers.set(channel, handler) },
		host,
		platform: {
			paths: { home: "/home/u", userData: "/data" },
			shell: { trashItem: async () => {}, openPath: async () => "" },
			dialogs: permissive(),
			application: permissive(),
			theme: permissive(),
			proxy: permissive(),
		},
		mainCopy: (key) => key,
		getLocale: () => "en-US",
		runtimeBridge: permissive(),
		services: permissive(),
	});
	return {
		host,
		channels: ipcChannels,
		invoke: (channel, ...args) => handlers.get(channel)(...args),
	};
}