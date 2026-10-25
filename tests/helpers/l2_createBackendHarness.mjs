import { join } from "node:path";
import { loadTsCommonJs } from "./loadTsCommonJs.mjs";

/**
 * 万能记录型替身：任何属性读取都得到可调用/可构造的替身，调用被记入 calls。
 * 目的是只观察 createBackend 的「装配行为」（给各服务传了什么路径/依赖、dispose 做了什么），
 * 而不启动任何真实服务。then 返回 undefined，保证 await 替身不会死锁。
 */
export function createRecorder() {
	const calls = [];
	const constructed = [];

	function deep(label) {
		const target = function stub() {};
		return new Proxy(target, {
			get(_t, prop) {
				if (prop === "then" || prop === "__esModule") return undefined;
				if (prop === Symbol.toPrimitive) return () => label;
				if (typeof prop === "symbol") return undefined;
				return deep(`${label}.${prop}`);
			},
			apply(_t, _this, args) {
				calls.push({ label, args });
				return deep(`${label}()`);
			},
			construct(_t, args) {
				calls.push({ label, args });
				return deep(`${label}#instance`);
			},
		});
	}

	/** 某模块的所有具名导出都是「会记录构造参数」的类/函数。 */
	function moduleStub() {
		return new Proxy({}, {
			get(_t, name) {
				if (name === "__esModule" || name === "then" || typeof name === "symbol") return undefined;
				const recordedClass = function RecordedService(...args) {
					const instance = deep(String(name));
					constructed.push({ name: String(name), args, instance });
					calls.push({ label: String(name), args });
					return instance;
				};
				return recordedClass;
			},
		});
	}

	return { calls, constructed, deep, moduleStub };
}

const STUBBED_MODULES = [
	"../projects/ProjectStore",
	"../fs/FileSystemService",
	"../sessions/SessionScanner",
	"../sessions/SessionCatalog",
	"../sessions/SessionRuntimeCoordinator",
	"../sessions/CodexSessionImporter",
	"../sessions/ClaudeSessionImporter",
	"../sessions/OpenCodeSessionImporter",
	"../settings/SettingsStore",
	"../security/SecurityStore",
	"../settings/DesktopProxy",
	"../git/GitService",
	"../git/WorktreeService",
	"../config/ConfigManager",
	"../terminal/TerminalSessionManager",
	"../prompts/PromptManager",
	"../prompts/XuePromptManager",
	"../skills/SkillManager",
	"../extensions/ExtensionManager",
	"../projects/ProjectResourceManager",
	"../ipc/projectsIpc",
	"../logging/AppLogger",
	"../logging/sharedLogger",
	"../logging/RpcLogger",
	"../usageStats/UsageStatsService",
	"../pi/PiLocator",
	"../pi/AgentManager",
	"../pi/modelListCache",
	"../pi/modelSpecsStore",
	"../settings/visionBridgeConfig",
	"../web/WebServiceManager",
	"./sessionRuntimeBridge",
	"./backendStartupTasks",
	"../fs/trash",
	"../sessions/SessionRecordService",
];

/**
 * 装载真实 createBackend，所有业务服务替换为记录型替身，
 * registerBackendRpc 替换为可观察的假实现（记录依赖并返回 dispose）。
 */
export function loadCreateBackend() {
	const recorder = createRecorder();
	const stubs = Object.fromEntries(STUBBED_MODULES.map((id) => [id, recorder.moduleStub()]));
	const rpcRegistrations = [];
	const rpcDisposals = [];
	stubs["./registerBackendRpc"] = {
		registerBackendRpc: (deps) => {
			rpcRegistrations.push(deps);
			return () => rpcDisposals.push(deps);
		},
	};
	const { createBackend } = loadTsCommonJs("src/main/backend/createBackend.ts", { stubs });
	return { createBackend, rpcRegistrations, rpcDisposals, ...recorder };
}

/** 最小可用的 CreateBackendOptions；userData 为虚拟路径，不会触碰磁盘。 */
export function createBackendOptions(userData = join("/virtual", "user-data")) {
	const router = { handle: () => {}, invoke: async () => undefined };
	return {
		userData,
		router,
		options: {
			router,
			host: { sendToRenderer: () => {} },
			platform: {
				paths: {
					userData,
					home: join("/virtual", "home"),
					appPath: join("/virtual", "app"),
					resourcesPath: join("/virtual", "resources"),
					downloads: join("/virtual", "downloads"),
				},
				application: {
					name: "PiDeck-Q",
					version: "0.0.0-test",
					isPackaged: false,
					getLocale: () => "en-US",
					hideApplicationMenu: () => {},
				},
				shell: { trashItem: async () => {}, openPath: async () => "" },
				proxy: {},
			},
		},
	};
}
