import assert from "node:assert/strict";
import test from "node:test";
import { createStore } from "jotai/vanilla";

import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

// 子代理运行态 atom 契约：整表替换、同值不唤醒订阅者、跨进程数据一律收窄、
// agent 级清理与空快照等价（侧栏据此熄灭状态点）。
const atoms = loadTsCommonJs("src/renderer/src/atoms/index.ts");

function run(sessionFile, status = "running") {
	return { sessionFile, status, agent: "readonly", updatedAt: 1 };
}

function summarize(runs) {
	return Array.from(runs, (entry) => `${entry.sessionFile}|${entry.status}`);
}

test("live runs are exposed as one flat list for the sidebar", () => {
	const store = createStore();
	store.set(atoms.applySubagentLiveSnapshotAtom, { agentId: "agent-a", runs: [run("C:/a.jsonl")] });
	store.set(atoms.applySubagentLiveSnapshotAtom, { agentId: "agent-b", runs: [run("C:/b.jsonl", "error")] });

	assert.deepEqual(summarize(store.get(atoms.subagentLiveRunsAtom)), [
		"C:/a.jsonl|running",
		"C:/b.jsonl|error",
	]);
});

test("identical snapshots do not wake sidebar subscribers", () => {
	const store = createStore();
	store.set(atoms.applySubagentLiveSnapshotAtom, { agentId: "agent-a", runs: [run("C:/a.jsonl")] });

	let notifications = 0;
	const unsubscribe = store.sub(atoms.subagentLiveRunsAtom, () => { notifications += 1; });

	// 主进程已按同值跳过推送，这里双保险：updatedAt 变化也不重写 atom。
	store.set(atoms.applySubagentLiveSnapshotAtom, {
		agentId: "agent-a",
		runs: [{ ...run("C:/a.jsonl"), updatedAt: 99 }],
	});
	assert.equal(notifications, 0);

	store.set(atoms.applySubagentLiveSnapshotAtom, { agentId: "agent-a", runs: [run("C:/a.jsonl", "error")] });
	assert.equal(notifications, 1);
	unsubscribe();
});

test("sanitizes cross-process entries and drops an agent when its snapshot empties", () => {
	const store = createStore();
	store.set(atoms.applySubagentLiveSnapshotAtom, {
		agentId: "agent-a",
		runs: [
			run("C:/ok.jsonl"),
			{ sessionFile: "", status: "running", updatedAt: 1 },
			{ sessionFile: "C:/bad.jsonl", status: "idle", updatedAt: 1 },
			// completed 不进投影：黄点只表示「正在跑」，否则停下来的子代理会一直亮着。
			{ sessionFile: "C:/done.jsonl", status: "completed", updatedAt: 1 },
			{ status: "running", updatedAt: 1 },
			null,
		],
	});
	assert.deepEqual(summarize(store.get(atoms.subagentLiveRunsAtom)), ["C:/ok.jsonl|running"]);

	store.set(atoms.applySubagentLiveSnapshotAtom, { agentId: "agent-a", runs: [] });
	assert.equal(store.get(atoms.subagentLiveRunsByAgentAtom)["agent-a"], undefined);
	assert.deepEqual(summarize(store.get(atoms.subagentLiveRunsAtom)), []);

	// 非有限 updatedAt 归零，避免「最新优先」被 NaN 永久卡住。
	store.set(atoms.applySubagentLiveSnapshotAtom, {
		agentId: "agent-b",
		runs: [{ sessionFile: "C:/nan.jsonl", status: "running", updatedAt: Number.NaN }],
	});
	assert.equal(store.get(atoms.subagentLiveRunsAtom)[0].updatedAt, 0);
});

test("dedupes repeated session paths to the newest observation", () => {
	const store = createStore();
	store.set(atoms.applySubagentLiveSnapshotAtom, {
		agentId: "agent-a",
		runs: [
			{ sessionFile: "C:/dup.jsonl", status: "error", updatedAt: 5 },
			{ sessionFile: "C:/dup.jsonl", status: "running", updatedAt: 9 },
		],
	});
	assert.deepEqual(summarize(store.get(atoms.subagentLiveRunsAtom)), ["C:/dup.jsonl|running"]);
});

test("clearing one agent keeps other agents' rows", () => {
	const store = createStore();
	store.set(atoms.applySubagentLiveSnapshotAtom, { agentId: "agent-a", runs: [run("C:/a.jsonl")] });
	store.set(atoms.applySubagentLiveSnapshotAtom, { agentId: "agent-b", runs: [run("C:/b.jsonl")] });

	store.set(atoms.clearSubagentLiveRunsAtom, "agent-a");

	assert.deepEqual(summarize(store.get(atoms.subagentLiveRunsAtom)), ["C:/b.jsonl|running"]);
	// 已清理的 agent 再清一次不产生 atom 写入。
	const before = store.get(atoms.subagentLiveRunsByAgentAtom);
	store.set(atoms.clearSubagentLiveRunsAtom, "agent-a");
	assert.equal(store.get(atoms.subagentLiveRunsByAgentAtom), before);
});
