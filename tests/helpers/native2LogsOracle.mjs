import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadTsCommonJs } from "./loadTsCommonJs.mjs";

/**
 * Node goldens for `logs:*` / `rpc-logs:*`.
 *
 * Everything here is the production code the native side was ported from:
 *  - `AppLogger` / `RpcLogger` are constructed with an explicit directory so the
 *    backend and the oracle can own twin directories and be compared on the same input;
 *  - the RPC summary text lives inline in `AgentManager`'s `rpc-log` handler, so the
 *    oracle drives a real `AgentManager` (fake pi process, manual 80 ms clock) and feeds
 *    it the *exact frames the backend logged* — the summary is produced by production
 *    code, never re-typed in the test;
 *  - `LiveRpcLogBuffer` is the batching golden for the 80 ms / 100-entry rules.
 */

const { AppLogger } = loadTsCommonJs(resolve("src/main/logging/AppLogger.ts"));
const { RpcLogger } = loadTsCommonJs(resolve("src/main/logging/RpcLogger.ts"));

export function createAppLogOracle(directory) {
	return new AppLogger({ directory });
}

export function createRpcLogOracle(directory) {
	return new RpcLogger({ directory });
}

/**
 * The production `logs:*` / `rpc-logs:*` handlers, exactly as the Node sidecar wires them.
 *
 * `registerSystemIpc` is the real module; only the surrounding services are minimal. The
 * runtime-target check mirrors production (`validateTarget` + a throwing
 * `sessionCommandIpcError`) so stale-target behaviour is also compared, not assumed.
 */
export function createLogsRpcOracle({ home, logDir, rpcLogDir }) {
	const { registerSystemIpc } = loadTsCommonJs(resolve("src/main/ipc/systemIpc.ts"));
	const { mainProcessT } = loadTsCommonJs(resolve("src/shared/i18n/mainProcessCopy.ts"));
	const appLogger = new AppLogger({ directory: logDir });
	const rpcLogger = new RpcLogger({ directory: rpcLogDir });
	const handlers = new Map();
	const opened = [];
	const logging = new Set();
	const openPath = async (path) => {
		opened.push(path);
		return { ok: true };
	};
	const targetError = (error) => new Error(error.code);
	const boundAgents = new Set();
	const runtime = {
		validateTarget: (target) =>
			target && typeof target.sessionId === "string" && typeof target.agentId === "string"
				&& boundAgents.has(target.agentId)
				? { ok: true, value: target }
				: { ok: false, error: { code: "SESSION_RUNTIME_UNAVAILABLE" } },
	};

	registerSystemIpc(
		{ handle: (channel, handler) => handlers.set(channel, handler) },
		{
			piLocator: {
				check: async () => ({ installed: true, version: "0.79.0" }),
				resolveCommand: () => "pi",
				createInvocation: (command, args) => ({ command, args, shell: false }),
				createProcessEnv: () => ({ ...process.env }),
			},
			settingsStore: { get: () => ({ language: "en-US" }), update: async (patch) => patch },
			configManager: { getModelsConfig: async () => ({ parsed: { providers: {} } }) },
			agentManager: {
				setRpcLogging: (agentId, enabled) => {
					if (enabled) logging.add(agentId);
					else logging.delete(agentId);
				},
				isRpcLogging: (agentId) => logging.has(agentId),
			},
			skillManager: {},
			appLogger,
			rpcLogger,
			sessionRuntimeCoordinator: runtime,
			modelSpecsStore: {},
			mainWindowControls: {},
			platformApplication: { hideApplicationMenu() {}, version: "0.4.3" },
			platformPaths: { home },
			platformShell: { openPath },
			platformTheme: { setSource() {} },
			sendToRenderer: () => undefined,
			mainCopy: (key, params) => mainProcessT("en-US", key, params ?? {}),
			openExternalUrl: async () => undefined,
			restartApplication() {},
			sessionCommandIpcError: targetError,
			webServiceManager: { stop: async () => undefined },
			terminalManager: { closeAll() {} },
		},
	);

	return {
		appLogger,
		rpcLogger,
		opened,
		/** Mark an agent as live for `validateTarget` (production checks the binding). */
		bind: (agentId) => boundAgents.add(agentId),
		invoke: (channel, args = []) => handlers.get(channel)(...args),
		channels: () => [...handlers.keys()],
	};
}

/** Deterministic timer clock: same helper the pre-existing LiveRpcLogBuffer test uses. */
function timerClock() {
	let now = 0;
	let sequence = 0;
	const jobs = new Map();
	return {
		setTimeout(callback, delay) {
			const id = ++sequence;
			jobs.set(id, { callback, at: now + delay });
			return id;
		},
		clearTimeout(id) {
			jobs.delete(id);
		},
		drain() {
			for (let guard = 0; jobs.size > 0; guard += 1) {
				if (guard > 1_000) throw new Error("timer drain is not bounded");
				const [id, job] = [...jobs].sort((left, right) => left[1].at - right[1].at)[0];
				jobs.delete(id);
				now = job.at;
				job.callback();
			}
		},
		get pending() {
			return jobs.size;
		},
	};
}

/** Batch-size golden for the real `LiveRpcLogBuffer`. */export function createLiveBatchOracle() {
	const clock = timerClock();
	const { LiveRpcLogBuffer } = loadTsCommonJs(resolve("src/main/pi/LiveRpcLogBuffer.ts"), {
		globals: { setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout },
	});
	return {
		/** Enqueue `count` frames for one agent and return the flushed batch sizes. */
		sizes(count, agentId = "golden-agent") {
			const batches = [];
			const buffer = new LiveRpcLogBuffer((batch) => batches.push(batch));
			for (let index = 0; index < count; index += 1) {
				buffer.enqueue({
					id: `entry-${index}`,
					agentId,
					direction: "send",
					summary: `→ ${index}`,
					time: index,
				});
			}
			clock.drain();
			buffer.clear();
			return batches.map((batch) => batch.entries.length);
		},
	};
}

/**
 * Real `AgentManager` producing the oracle's `agents:rpc-log` records.
 *
 * The manager is booted through its public `create()`; only the pi process class and the
 * 80 ms timer are substitutes, so the summary strings come from production code.
 */
export function createRpcLogSummaryOracle() {
	const directory = mkdtempSync(join(tmpdir(), "pideck-logs-oracle-"));
	const clock = timerClock();
	const instances = [];
	const batches = [];
	const { ipcChannels } = loadTsCommonJs(resolve("src/shared/ipc.ts"));

	class FakePiProcess extends EventEmitter {
		constructor() {
			super();
			instances.push(this);
			this.client = {
				request: async ({ type }) => ({
					success: true,
					data: type === "get_messages" ? { messages: [] } : type === "get_entries" ? { entries: [], leafId: null } : {},
				}),
			};
		}
		async start() {
			return this.client;
		}
		getDiagnostics() {
			return { cwd: directory };
		}
		stop() {
			this.emit("exit", { code: 0, signal: null });
		}
	}

	const { AgentManager } = loadTsCommonJs(resolve("src/main/pi/AgentManager.ts"), {
		stubs: {
			"./PiProcess": { PiProcess: FakePiProcess },
			"./PiProcess.ts": { PiProcess: FakePiProcess },
			"node:child_process": {
				spawn: () => {
					throw new Error("Real process forbidden in the logs oracle");
				},
				execFile: () => {
					throw new Error("Real process forbidden in the logs oracle");
				},
			},
			"node:os": {
				homedir: () => directory,
				platform: () => process.platform,
				tmpdir: () => directory,
			},
		},
		globals: { setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout },
	});

	const manager = new AgentManager(
		() => ({ id: "logs", name: "Logs", path: directory }),
		(channel, payload) => {
			if (channel === ipcChannels.agentsRpcLog) batches.push(payload);
		},
		{ get: () => ({ rpcTimeout: 60_000 }) },
		{ ensureTrustedDirectory: async () => undefined },
	);

	let agentId = null;
	return {
		/** Create the logged agent; call once before `summarize`. */
		async start() {
			const tab = await manager.create({ projectId: "logs", noSession: true });
			agentId = tab.id;
			manager.setRpcLogging(agentId, true);
			// Let the create-time history promises settle before this fixture's stream.
			await new Promise((resolvePromise) => setImmediate(resolvePromise));
			clock.drain();
			batches.length = 0;
			return agentId;
		},
		/**
		 * Feed frames exactly as the backend logged them and return the oracle records.
		 * The 80 ms timer is drained after every frame, so one input frame maps to one
		 * emitted record (batches of one) and the comparison stays positional.
		 */
		summarize(frames) {
			const records = [];
			for (const frame of frames) {
				const before = batches.length;
				instances[0].emit("rpc-log", { direction: frame.direction, data: frame.data });
				clock.drain();
				for (let index = before; index < batches.length; index += 1) {
					records.push(...batches[index].entries);
				}
			}
			return records;
		},
		dispose() {
			manager.stopAll();
			clock.drain();
			if (clock.pending !== 0) throw new Error("logs oracle leaked timers");
			rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
		},
	};
}
