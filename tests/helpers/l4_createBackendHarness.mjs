import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTsCommonJs } from "./loadTsCommonJs.mjs";

/**
 * 在真实 createBackend 装配下运行，但把所有外部服务换成惰性替身，
 * 并捕获 AgentManager 构造参数与 SessionScanner 实例，用于验证“装配是否接通”。
 * 不读写真实用户目录：home/userData 都指向临时目录，调用方用 `dispose()` 清理。
 */
export async function startCreateBackendHarness({
	refreshModelList = async () => {},
	beforeCreate,
	afterCreate,
} = {}) {
	const root = await mkdtemp(join(tmpdir(), "pideck-l4-backend-"));
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
		["../sessions/SessionRuntimeCoordinator", "SessionRuntimeCoordinator"],
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
		["../web/WebServiceManager", "WebServiceManager"],
		["../sessions/SessionRecordService", "SessionRecordService"],
	]) stubs[module] = { [name]: InertService };

	const scanners = [];
	stubs["../sessions/SessionScanner"] = {
		SessionScanner: class extends InertService {
			repairCalls = [];
			constructor() {
				super();
				scanners.push(this);
			}
			async repairCorruptSessionHeader(filePath) {
				this.repairCalls.push(filePath);
				return true;
			}
			dispose() {}
		},
	};
	const agentManagerArgs = [];
	stubs["../pi/AgentManager"] = {
		AgentManager: class extends InertService {
			constructor(...args) {
				super();
				agentManagerArgs.push(args);
			}
		},
	};
	const logger = new InertService();
	stubs["../logging/sharedLogger"] = { setAppLogger() {}, getAppLogger: () => logger };
	stubs["../settings/DesktopProxy"] = { applyDesktopProxy: async () => {} };
	stubs["../pi/modelListCache"] = { fetchModelList: async () => [], refreshModelList };
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
		agentManagerArgs,
		scanners,
		dispose: cleanup,
	};
	} catch (error) {
		await cleanup();
		throw error;
	}
}
