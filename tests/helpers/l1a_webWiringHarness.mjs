import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTsCommonJs } from "./loadTsCommonJs.mjs";

/**
 * 在真实 createBackend 装配下运行，只捕获 WebServiceManager 的构造依赖，
 * 用来验证「pi 事件源 / agent→session 路由」是否真的接到 AgentManager 与
 * SessionRuntimeCoordinator 上（装配行为，而不是源码里出现某个标识符）。
 * 其余外部服务全部换成惰性替身；home/userData 指向临时目录，由 dispose() 清理。
 */
export async function startWebWiringHarness({ beforeCreate, afterCreate } = {}) {
	const root = await mkdtemp(join(tmpdir(), "pideck-l1a-web-wiring-"));
	let backend;
	const cleanup = async () => {
		try {
			if (backend) await backend.dispose();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	};
	try {
	await mkdir(join(root, "project"));
	class InertService {
		info() {} warn() {} error() {} onOutput() {} closeAll() {} stopAll() {} async stop() {}
	}
	const stubs = {};
	for (const [module, name] of [
		["../fs/FileSystemService", "FileSystemService"],
		["../sessions/CodexSessionImporter", "CodexSessionImporter"],
		["../sessions/ClaudeSessionImporter", "ClaudeSessionImporter"],
		["../sessions/OpenCodeSessionImporter", "OpenCodeSessionImporter"],
		["../security/SecurityStore", "SecurityStore"],
		["../git/GitService", "GitService"],
		["../git/WorktreeService", "WorktreeService"],
		["../config/ConfigManager", "ConfigManager"],
		["../terminal/TerminalSessionManager", "TerminalSessionManager"],
		["../prompts/PromptManager", "PromptManager"],
		["../prompts/XuePromptManager", "XuePromptManager"],
		["../skills/SkillManager", "SkillManager"],
		["../extensions/ExtensionManager", "ExtensionManager"],
		["../projects/ProjectResourceManager", "ProjectResourceManager"],
		["../logging/AppLogger", "AppLogger"],
		["../logging/RpcLogger", "RpcLogger"],
		["../usageStats/UsageStatsService", "UsageStatsService"],
		["../pi/PiLocator", "PiLocator"],
		["../pi/modelSpecsStore", "ModelSpecsStore"],
		["../settings/visionBridgeConfig", "VisionBridgeConfigManager"],
		["../sessions/SessionRecordService", "SessionRecordService"],
	]) stubs[module] = { [name]: InertService };

	stubs["../sessions/SessionScanner"] = {
		SessionScanner: class extends InertService {
			async repairCorruptSessionHeader() { return true; }
			dispose() {}
		},
	};

	// AgentManager 替身：只实现 Web 装配用到的 addLocalEventListener，并记录订阅/退订。
	const localListeners = new Set();
	stubs["../pi/AgentManager"] = {
		AgentManager: class extends InertService {
			addLocalEventListener(listener) {
				localListeners.add(listener);
				return () => { localListeners.delete(listener); };
			}
			list() { return []; }
		},
	};

	// SessionRuntimeCoordinator 替身：getSessionId 的映射由测试注入。
	const sessionIdByAgent = new Map();
	stubs["../sessions/SessionRuntimeCoordinator"] = {
		SessionRuntimeCoordinator: class extends InertService {
			getSessionId(agentId) { return sessionIdByAgent.get(agentId); }
		},
	};

	const webDeps = [];
	stubs["../web/WebServiceManager"] = {
		WebServiceManager: class extends InertService {
			constructor(deps) {
				super();
				webDeps.push(deps);
			}
			async applySettings() {}
		},
	};

	const logger = new InertService();
	stubs["../logging/sharedLogger"] = { setAppLogger() {}, getAppLogger: () => logger };
	stubs["../settings/DesktopProxy"] = { applyDesktopProxy: async () => {} };
	stubs["../pi/modelListCache"] = { fetchModelList: async () => [], refreshModelList: async () => {} };
	stubs["../ipc/projectsIpc"] = { listVisibleProjects: (store) => store.list() };
	stubs["./sessionRuntimeBridge"] = { createSessionRuntimeBridge: () => ({}) };
	stubs["./registerBackendRpc"] = { registerBackendRpc: () => () => {} };
	stubs["./backendStartupTasks"] = { startBackendStartupTasks() {} };

	const { createBackend } = loadTsCommonJs("src/main/backend/createBackend.ts", { stubs });
	if (beforeCreate) await beforeCreate();
	backend = await createBackend({
		router: {},
		host: { sendToRenderer() {} },
		platform: {
			paths: { home: root, userData: root, appPath: root, resourcesPath: root, downloads: root },
			application: { hideApplicationMenu() {}, getLocale: () => "en-US", name: "test", version: "0.4.0", isPackaged: false },
			shell: { trashItem: async () => {} },
		},
	});
	if (afterCreate) await afterCreate(backend);
	return {
		/** createBackend 传给 WebServiceManager 构造函数的依赖对象（每次构造一个）。 */
		webDeps,
		/** AgentManager 上当前仍然登记的本地事件监听器。 */
		localListeners,
		/** 让协调器认识某个 agent：agentId → sessionId。 */
		bindAgentToSession: (agentId, sessionId) => sessionIdByAgent.set(agentId, sessionId),
		dispose: cleanup,
	};
	} catch (error) {
		await cleanup();
		throw error;
	}
}
