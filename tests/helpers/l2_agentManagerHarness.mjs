import { EventEmitter } from "node:events";
import { join } from "node:path";
import { loadTsCommonJs } from "./loadTsCommonJs.mjs";
import { createSecurityStoreFixture } from "./securityStoreFixture.mjs";

/**
 * 装配真实 AgentManager + 假 PiProcess + 真实 SecurityStore（内存持久化）。
 * 只记录「AgentManager 交给 PiProcess 的构造参数」，用来断言安全门注入契约，
 * 不启动任何 pi 进程。
 */
export function createAgentManagerHarness(options = {}) {
	const fixture = createSecurityStoreFixture(options.security);
	const processes = [];
	const sessionPath = join(process.cwd(), "l2-test-session.jsonl");
	class MockPiProcess extends EventEmitter {
		constructor(_cwd, _settings, _locator, processOptions) {
			super();
			this.options = processOptions;
			this.started = false;
			this.client = {
				request: async ({ type }) => ({
					success: true,
					data: type === "get_state"
						? { sessionId: "pi-session", sessionFile: sessionPath }
						: { messages: [] },
				}),
			};
			processes.push(this);
		}
		async start() { this.started = true; return this.client; }
		getDiagnostics() { return undefined; }
		stop() { this.started = false; this.removeAllListeners(); }
	}
	const { AgentManager } = loadTsCommonJs("src/main/pi/AgentManager.ts", { stubs: {
		"./PiProcess": { PiProcess: MockPiProcess },
		"node:fs": { existsSync: () => false, statSync: () => ({ size: 0 }) },
		"node:fs/promises": { stat: async () => ({ size: 0, mtimeMs: 1 }) },
		"./SessionHistoryReader": { SessionHistoryReader: class {
			async getActiveEntryCount() { return 0; }
			async scanCompactions() { return { compactions: [] }; }
		} },
	} });
	const project = { id: "project", path: process.cwd(), name: "Test" };
	const manager = new AgentManager(
		() => project,
		() => {},
		{ get: () => ({ rpcTimeout: 100, removedBuiltInExtensions: [] }) },
		{ ensureTrustedDirectory: async () => {} },
		options.rpcLogger, undefined, undefined, () => "", undefined,
		options.noSecurityStore ? undefined : fixture.store,
	);
	return { manager, processes, project, sessionPath, ...fixture };
}
