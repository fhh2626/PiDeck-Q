import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { withHookHost } from "./helpers/l5_hookHost.mjs";

// useSessionRuntimeBridge 负责把主进程的 `agents:subagent-status` 投影写进侧栏 atom。
// 这里真实挂载 hook（真实 React + jotai store），只替身化桌面 API 与事件订阅。
const nodeRequire = createRequire(import.meta.url);
const { Provider, createStore } = nodeRequire("jotai");

const atoms = loadTsCommonJs("src/renderer/src/atoms/index.ts");

/** 可手动推事件的桌面 API 替身：记录订阅数，验证登记与清理成对。 */
function createDesktopApi() {
	const subscribers = new Set();
	const api = {
		sessions: {
			listRuntimes: async () => [],
			onRuntimeEvent: (callback) => {
				subscribers.add(callback);
				return () => { subscribers.delete(callback); };
			},
		},
	};
	return {
		api,
		get subscriberCount() {
			return subscribers.size;
		},
		emit(event) {
			for (const subscriber of [...subscribers]) subscriber(event);
		},
	};
}

function runtimeEvent(sessionId, agentId, generation, sourceChannel, payload) {
	return { kind: "event", sessionId, agentId, runtimeGeneration: generation, sourceChannel, payload };
}

function loadHook(desktopApi) {
	return loadTsCommonJs("src/renderer/src/hooks/useSessionRuntimeBridge.ts", {
		stubs: {
			"../atoms": atoms,
			// hook 还直接从 runtime-atoms 取 agentExitedAtom；指向同一份实例，避免双 atom 图。
			"../atoms/runtime-atoms": atoms,
			"../desktopApi": { desktopApi },
			"../utils/notice": { showNotice: () => undefined },
		},
	}).useSessionRuntimeBridge;
}

function summarize(runs) {
	return Array.from(runs, (entry) => `${entry.sessionFile}|${entry.status}`);
}

test("runtime bridge routes subagent snapshots into the sidebar projection", async () => {
	const desktop = createDesktopApi();
	const useSessionRuntimeBridge = loadHook(desktop.api);
	const store = createStore();

	await withHookHost(async (host) => {
		const mounted = await host.mount(useSessionRuntimeBridge, undefined, (node) => host.React.createElement(Provider, { store }, node));
		assert.equal(desktop.subscriberCount, 1);

		desktop.emit(runtimeEvent("session-parent", "agent-parent", 1, "agents:subagent-status", {
			agentId: "agent-parent",
			runs: [{ sessionFile: "C:/child/session.jsonl", status: "running", agent: "readonly", updatedAt: 1 }],
		}));
		assert.deepEqual(summarize(store.get(atoms.subagentLiveRunsAtom)), ["C:/child/session.jsonl|running"]);

		// 子代理事件不得写进父会话 runtime 快照（否则父行状态被改）。
		assert.equal(store.get(atoms.sessionRuntimeByIdAtom)["session-parent"], undefined);

		// 空快照 = 子代理结束：投影清空，侧栏熄灭状态点。
		desktop.emit(runtimeEvent("session-parent", "agent-parent", 1, "agents:subagent-status", {
			agentId: "agent-parent",
			runs: [],
		}));
		assert.deepEqual(summarize(store.get(atoms.subagentLiveRunsAtom)), []);

		await mounted.unmount();
		assert.equal(desktop.subscriberCount, 0);
	});
});

test("runtime detach drops the agent's subagent rows", async () => {
	const desktop = createDesktopApi();
	const useSessionRuntimeBridge = loadHook(desktop.api);
	const store = createStore();

	await withHookHost(async (host) => {
		const mounted = await host.mount(useSessionRuntimeBridge, undefined, (node) => host.React.createElement(Provider, { store }, node));

		desktop.emit(runtimeEvent("session-parent", "agent-parent", 1, "agents:subagent-status", {
			agentId: "agent-parent",
			runs: [{ sessionFile: "C:/child/session.jsonl", status: "error", agent: "readonly", updatedAt: 1 }],
		}));
		desktop.emit(runtimeEvent("session-other", "agent-other", 1, "agents:subagent-status", {
			agentId: "agent-other",
			runs: [{ sessionFile: "C:/other.jsonl", status: "running", updatedAt: 1 }],
		}));

		desktop.emit({
			kind: "detach",
			sessionId: "session-parent",
			agentId: "agent-parent",
			runtimeGeneration: 2,
			sourceChannel: "sessions:runtime-detach",
			payload: null,
		});

		assert.deepEqual(summarize(store.get(atoms.subagentLiveRunsAtom)), ["C:/other.jsonl|running"]);
		await mounted.unmount();
	});
});

test("stale runtime generations cannot repopulate the subagent projection", async () => {
	const desktop = createDesktopApi();
	const useSessionRuntimeBridge = loadHook(desktop.api);
	const store = createStore();

	await withHookHost(async (host) => {
		const mounted = await host.mount(useSessionRuntimeBridge, undefined, (node) =>
			host.React.createElement(Provider, { store }, node));
		store.set(atoms.replaceSessionRuntimesAtom, [{
			sessionId: "session-parent",
			agentId: "agent-new",
			runtimeGeneration: 5,
			projectId: "project-a",
			cwd: "C:/project-a",
			status: "idle",
			createdAt: 1,
		}]);

		// 旧代（generation 4）迟到帧：detach 之后没人再清，必须直接丢弃。
		desktop.emit(runtimeEvent("session-parent", "agent-old", 4, "agents:subagent-status", {
			agentId: "agent-old",
			runs: [{ sessionFile: "C:/child/session.jsonl", status: "running", updatedAt: 1 }],
		}));
		assert.deepEqual(summarize(store.get(atoms.subagentLiveRunsAtom)), []);

		// 同代但换了 agent：同样丢弃。
		desktop.emit(runtimeEvent("session-parent", "agent-other", 5, "agents:subagent-status", {
			agentId: "agent-other",
			runs: [{ sessionFile: "C:/child/session.jsonl", status: "running", updatedAt: 1 }],
		}));
		assert.deepEqual(summarize(store.get(atoms.subagentLiveRunsAtom)), []);

		// 当代事件正常写入。
		desktop.emit(runtimeEvent("session-parent", "agent-new", 5, "agents:subagent-status", {
			agentId: "agent-new",
			runs: [{ sessionFile: "C:/child/session.jsonl", status: "running", updatedAt: 1 }],
		}));
		assert.deepEqual(summarize(store.get(atoms.subagentLiveRunsAtom)), ["C:/child/session.jsonl|running"]);

		await mounted.unmount();
	});
});

test("a later event from the same agent restores the snapshot cleared by detach", async () => {
	const desktop = createDesktopApi();
	const useSessionRuntimeBridge = loadHook(desktop.api);
	const store = createStore();

	await withHookHost(async (host) => {
		const mounted = await host.mount(useSessionRuntimeBridge, undefined, (node) =>
			host.React.createElement(Provider, { store }, node));

		desktop.emit(runtimeEvent("session-parent", "agent-parent", 1, "agents:subagent-status", {
			agentId: "agent-parent",
			runs: [{ sessionFile: "C:/child/session.jsonl", status: "running", updatedAt: 1 }],
		}));

		// 克隆/切换会话会发 detach 清投影，但同一个 pi 进程还活着。
		desktop.emit({
			kind: "detach",
			sessionId: "session-parent",
			agentId: "agent-parent",
			runtimeGeneration: 2,
			sourceChannel: "sessions:runtime-detach",
			payload: null,
		});
		assert.deepEqual(summarize(store.get(atoms.subagentLiveRunsAtom)), []);

		// 该 agent 再来任何事件（替换后的 state/message），必须回放最后一帧，
		// 否则还在跑的子代理黄点要等下一次工具更新帧才回来。
		desktop.emit(runtimeEvent("session-clone", "agent-parent", 3, "agents:state", null));
		assert.deepEqual(summarize(store.get(atoms.subagentLiveRunsAtom)), ["C:/child/session.jsonl|running"]);

		// detach 之前的事件不能消耗缓存帧：替换开始时 binding 已解绑，
		// state/message 可能先于 detach 到达，提前回放会把帧用掉。
		desktop.emit(runtimeEvent("session-clone", "agent-parent", 3, "agents:subagent-status", {
			agentId: "agent-parent",
			runs: [{ sessionFile: "C:/child/session.jsonl", status: "running", updatedAt: 2 }],
		}));
		desktop.emit(runtimeEvent("session-clone", "agent-parent", 3, "agents:state", null));
		desktop.emit({
			kind: "detach",
			sessionId: "session-clone",
			agentId: "agent-parent",
			runtimeGeneration: 4,
			sourceChannel: "sessions:runtime-detach",
			payload: null,
		});
		assert.deepEqual(summarize(store.get(atoms.subagentLiveRunsAtom)), []);
		desktop.emit(runtimeEvent("session-clone", "agent-parent", 4, "agents:state", null));
		assert.deepEqual(summarize(store.get(atoms.subagentLiveRunsAtom)), ["C:/child/session.jsonl|running"]);

		// 空快照是清理信号：之后再来事件也不该复活。
		desktop.emit(runtimeEvent("session-clone", "agent-parent", 3, "agents:subagent-status", {
			agentId: "agent-parent",
			runs: [],
		}));
		desktop.emit({
			kind: "detach",
			sessionId: "session-clone",
			agentId: "agent-parent",
			runtimeGeneration: 4,
			sourceChannel: "sessions:runtime-detach",
			payload: null,
		});
		desktop.emit(runtimeEvent("session-clone", "agent-parent", 4, "agents:state", null));
		assert.deepEqual(summarize(store.get(atoms.subagentLiveRunsAtom)), []);

		await mounted.unmount();
	});
});
