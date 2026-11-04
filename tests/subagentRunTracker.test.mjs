import assert from "node:assert/strict";
import test from "node:test";

import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { SubagentRunTracker, extractSubagentRunUpdates, SUBAGENT_RUN_TRACKER_LIMITS } = loadTsCommonJs(
	"src/main/pi/SubagentRunTracker.ts",
);

const RUNNING_TTL_MS = SUBAGENT_RUN_TRACKER_LIMITS.runningTtlMs;
const ERROR_TTL_MS = SUBAGENT_RUN_TRACKER_LIMITS.errorTtlMs;
const MAX_RUNS = SUBAGENT_RUN_TRACKER_LIMITS.maxRunsPerAgent;

/** 模拟 pi 的 tool_execution_update：details 挂在 partialResult 上。 */
function updateEvent(results, extras = {}) {
	return {
		type: "tool_execution_update",
		toolName: "subagent",
		toolCallId: "call-1",
		partialResult: { content: [], details: { mode: "single", results, ...extras } },
	};
}

/** 模拟 tool_execution_end：details 挂在 result 上。 */
function endEvent(results, extras = {}) {
	return {
		type: "tool_execution_end",
		toolName: "subagent",
		toolCallId: "call-1",
		result: { content: [], details: { mode: "single", results, ...extras } },
	};
}

function result(sessionFile, overrides = {}) {
	return { index: 0, agent: "readonly", task: "t", exitCode: 0, usage: {}, sessionFile, ...overrides };
}

/** 跨 realm（vm 加载）对象原型不同，deepStrictEqual 比对象会失败；统一比较原始值投影。 */
function summarize(runs) {
	// Array.from 把 vm realm 数组转成本地数组：VM 数组的原型不同，deepStrictEqual 会判不等。
	return Array.from(runs, (run) => `${run.sessionFile}|${run.status}|${run.agent ?? ""}`);
}

function summarizePaths(runs) {
	return Array.from(runs, (run) => run.sessionFile);
}

function summarizeStatuses(runs) {
	return Array.from(runs, (run) => run.status);
}

test("ignores tools and payloads that carry no subagent session details", () => {
	const tracker = new SubagentRunTracker();
	assert.equal(tracker.observe("agent-1", { toolName: "bash", partialResult: { details: { results: [result("C:/s.jsonl")] } } }), false);
	assert.equal(tracker.observe("agent-1", { toolName: "subagent" }), false);
	assert.equal(tracker.observe("agent-1", { toolName: "subagent", partialResult: { details: { mode: "management", results: [] } } }), false);
	assert.equal(tracker.observe("agent-1", "not-an-event"), false);
	assert.deepEqual(summarize(tracker.snapshot("agent-1")), []);
});

test("marks a running child from progress status and ignores identical frames", () => {
	const tracker = new SubagentRunTracker();
	const event = updateEvent([result("C:/s.jsonl", {
		progress: { index: 0, agent: "readonly", status: "running", task: "t", recentTools: [], recentOutput: [] },
	})]);

	assert.equal(tracker.observe("agent-1", event, 1_000), true);
	assert.deepEqual(summarize(tracker.snapshot("agent-1", 1_000)), ["C:/s.jsonl|running|readonly"]);
	// 同状态重复帧（流式 update）不能触发推送，否则事件通道会被刷满。
	assert.equal(tracker.observe("agent-1", event, 1_500), false);
	assert.equal(tracker.snapshot("agent-1", 1_500)[0].updatedAt, 1_500);
});

test("flips to error when the child fails, and removes the row once it succeeds", () => {
	const tracker = new SubagentRunTracker();
	const running = updateEvent([result("C:/s.jsonl", { progress: { status: "running" } })]);
	const failed = endEvent([result("C:/s.jsonl", {
		progress: { status: "failed" },
		exitCode: 1,
		error: "boom",
	})]);
	const ok = endEvent([result("C:/s.jsonl", { success: true, exitCode: 0 })]);

	tracker.observe("agent-1", running, 1_000);
	assert.equal(tracker.observe("agent-1", failed, 2_000), true);
	assert.deepEqual(summarize(tracker.snapshot("agent-1", 2_000)), ["C:/s.jsonl|error|readonly"]);
	assert.equal(tracker.observe("agent-1", ok, 3_000), true);
	// 完成不保留：黄点只表示「正在跑」，结束后必须立刻熄灭（否则看起来像停了还在跑）。
	assert.deepEqual(summarize(tracker.snapshot("agent-1", 3_000)), []);
});

test("treats terminal flags as failure and detached runs as finished", () => {
	assert.deepEqual(
		summarize(extractSubagentRunUpdates({ mode: "single", results: [result("C:/a.jsonl", { timedOut: true })] })),
		["C:/a.jsonl|error|readonly"],
	);
	assert.deepEqual(
		summarize(extractSubagentRunUpdates({ mode: "single", results: [result("C:/b.jsonl", { stopped: true })] })),
		["C:/b.jsonl|error|readonly"],
	);
	// detached: 子代理脱离父回合，后续状态由 bg_wait 投递，不据此点灯。
	assert.deepEqual(
		summarize(extractSubagentRunUpdates({ mode: "single", results: [result("C:/c.jsonl", { progress: { status: "detached" } })] })),
		["C:/c.jsonl|completed|readonly"],
	);
	// 成功优先于残留 error（模型回退链上的失败尝试会留下 error 字段）。
	assert.deepEqual(
		summarize(extractSubagentRunUpdates({ mode: "single", results: [result("C:/d.jsonl", { success: true, error: "retry failed" })] })),
		["C:/d.jsonl|completed|readonly"],
	);
});

test("clears a background child when bg_wait reports its completion", () => {
	const tracker = new SubagentRunTracker();
	tracker.observe("agent-1", updateEvent([result("C:/bg.jsonl", { progress: { status: "running" } })]), 1_000);
	assert.equal(tracker.snapshot("agent-1", 1_000).length, 1);

	const waitEvent = {
		type: "tool_execution_end",
		toolName: "bg_wait",
		result: {
			content: [],
			details: {
				mode: "single",
				results: [],
				completions: [{ runId: "run-1", results: [{ sessionFile: "C:/bg.jsonl", success: true }] }],
			},
		},
	};
	assert.equal(tracker.observe("agent-1", waitEvent, 2_000), true);
	// 后台子代理完成即移除：不再留「刚结束」的黄点。
	assert.deepEqual(summarize(tracker.snapshot("agent-1", 2_000)), []);
});

test("keeps state per agent and clears on request", () => {
	const tracker = new SubagentRunTracker();
	tracker.observe("agent-1", updateEvent([result("C:/a.jsonl", { progress: { status: "running" } })]), 1_000);
	tracker.observe("agent-2", updateEvent([result("C:/b.jsonl", { progress: { status: "running" } })]), 1_000);

	assert.deepEqual(summarizePaths(tracker.snapshot("agent-1", 1_000)), ["C:/a.jsonl"]);
	assert.deepEqual(summarizePaths(tracker.snapshot("agent-2", 1_000)), ["C:/b.jsonl"]);

	assert.equal(tracker.clearAgent("agent-1"), true);
	assert.deepEqual(summarize(tracker.snapshot("agent-1", 1_000)), []);
	assert.equal(tracker.clearAgent("agent-1"), false);
	assert.deepEqual(summarizePaths(tracker.snapshot("agent-2", 1_000)), ["C:/b.jsonl"]);
});

test("turn end drops stale running rows but keeps failures for review", () => {
	const tracker = new SubagentRunTracker();
	tracker.observe("agent-1", updateEvent([
		result("C:/running.jsonl", { progress: { status: "running" } }),
		result("C:/failed.jsonl", { progress: { status: "failed" }, exitCode: 1 }),
	]), 1_000);

	assert.equal(tracker.clearRunning("agent-1"), true);
	assert.deepEqual(summarizeStatuses(tracker.snapshot("agent-1", 1_000)), ["error"]);
	assert.equal(tracker.clearRunning("agent-1"), false);
});

test("expires running rows sooner than failures so the sidebar cannot stay yellow forever", () => {
	const tracker = new SubagentRunTracker();
	tracker.observe("agent-1", updateEvent([
		result("C:/running.jsonl", { progress: { status: "running" } }),
		result("C:/failed.jsonl", { progress: { status: "failed" }, exitCode: 1 }),
	]), 0);

	assert.deepEqual(
		summarizePaths(tracker.snapshot("agent-1", RUNNING_TTL_MS + 1)),
		["C:/failed.jsonl"],
	);
	assert.deepEqual(summarize(tracker.snapshot("agent-1", ERROR_TTL_MS + 1)), []);
});

test("caps remembered rows per agent", () => {
	const tracker = new SubagentRunTracker();
	// 分多次 observe：单帧 results 已由 extractSubagentRunUpdates 截断，淘汰逻辑要靠增量触发。
	for (let index = 0; index < MAX_RUNS + 6; index += 1) {
		tracker.observe("agent-1", updateEvent([
			result(`C:/run-${index}.jsonl`, { progress: { status: "running" } }),
		]), 1_000 + index);
	}
	const snapshot = tracker.snapshot("agent-1", 1_000);
	assert.equal(snapshot.length, MAX_RUNS);
	// 淘汰最久未更新的一端：最早 6 条被丢弃。
	assert.equal(snapshot[0].sessionFile, "C:/run-6.jsonl");
	assert.equal(snapshot[snapshot.length - 1].sessionFile, `C:/run-${MAX_RUNS + 5}.jsonl`);
});

test("drops malformed session paths instead of surfacing them", () => {
	const updates = extractSubagentRunUpdates({
		mode: "single",
		results: [
			{ sessionFile: 42 },
			{ sessionFile: "   " },
			{ sessionFile: "C:/ok.jsonl", progress: { status: "running" } },
			{ sessionFile: `C:/${"x".repeat(5000)}.jsonl`, progress: { status: "running" } },
			null,
		],
	});
	assert.deepEqual(summarize(updates), ["C:/ok.jsonl|running|"]);
});

test("terminal details win over a stale running partial result", () => {
	const tracker = new SubagentRunTracker();
	tracker.observe("agent-1", {
		toolName: "subagent",
		partialResult: {
			details: { mode: "single", results: [result("C:/s.jsonl", { progress: { status: "running" } })] },
		},
		result: { details: { mode: "single", results: [result("C:/s.jsonl", { success: true })] } },
	}, 1_000);
	// 终态优先：completed 直接收灯，迟到的 running 不会把行又点亮。
	assert.deepEqual(summarize(tracker.snapshot("agent-1", 1_000)), []);
});

test("bg_wait reports a failed background child so the row can show it", () => {
	const tracker = new SubagentRunTracker();
	tracker.observe("agent-1", {
		toolName: "bg_wait",
		result: {
			content: [],
			// 真实形状：subagent-wait.ts 的 result() 固定 mode: "management"，
			// completions 必须独立于 management 过滤，否则后台失败永远不亮红灯。
			details: {
				mode: "management",
				results: [],
				completions: [{ runId: "run-9", results: [{ sessionFile: "C:/bg-failed.jsonl", success: false, error: "boom" }] }],
			},
		},
	}, 1_000);
	assert.deepEqual(summarize(tracker.snapshot("agent-1", 1_000)), ["C:/bg-failed.jsonl|error|"]);
});

test("management results carry no run state and are ignored", () => {
	const tracker = new SubagentRunTracker();
	// action: list/status/interrupt 也会返回 results 字段，但它们不是运行态。
	assert.equal(tracker.observe("agent-1", endEvent([result("C:/x.jsonl", { progress: { status: "running" } })], { mode: "management" }), 1_000), false);
	assert.deepEqual(summarize(tracker.snapshot("agent-1", 1_000)), []);
});

test("a tool-level failure clears the rows that call registered", () => {
	const tracker = new SubagentRunTracker();
	tracker.observe("agent-1", updateEvent([result("C:/a.jsonl", { progress: { status: "running" } })]), 1_000);
	assert.deepEqual(summarize(tracker.snapshot("agent-1", 1_000)), ["C:/a.jsonl|running|readonly"]);

	// details 里没有 results 的失败帧：该次调用再也收不到终态，必须清掉它的残留行。
	assert.equal(tracker.clearToolCall("agent-1", "call-1"), true);
	assert.deepEqual(summarize(tracker.snapshot("agent-1", 1_000)), []);
	assert.equal(tracker.clearToolCall("agent-1", "call-1"), false);
	assert.equal(tracker.clearToolCall("agent-1", ""), false);
});

test("clearing one tool call leaves other calls' rows intact", () => {
	const tracker = new SubagentRunTracker();
	tracker.observe("agent-1", updateEvent([result("C:/a.jsonl", { progress: { status: "running" } })]), 1_000);
	tracker.observe("agent-1", {
		...updateEvent([result("C:/b.jsonl", { progress: { status: "running" } })]),
		toolCallId: "call-2",
	}, 1_000);
	assert.deepEqual(summarizePaths(tracker.snapshot("agent-1", 1_000)), ["C:/a.jsonl", "C:/b.jsonl"]);

	assert.equal(tracker.clearToolCall("agent-1", "call-1"), true);
	assert.deepEqual(summarizePaths(tracker.snapshot("agent-1", 1_000)), ["C:/b.jsonl"]);
});

test("snapshot never leaks internal bookkeeping fields", () => {
	const tracker = new SubagentRunTracker();
	tracker.observe("agent-1", updateEvent([result("C:/a.jsonl", { progress: { status: "running" } })]), 1_000);
	const [run] = tracker.snapshot("agent-1", 1_000);
	assert.deepEqual(Array.from(Object.keys(run)).sort(), ["agent", "sessionFile", "status", "updatedAt"]);
});

test("a failed run keeps its error row when the same call ends with isError", () => {
	const tracker = new SubagentRunTracker();
	tracker.observe("agent-1", updateEvent([result("C:/a.jsonl", { progress: { status: "running" } })]), 1_000);
	// 真实场景：任一子代理失败都会让工具结果带 isError，同时 details 里带失败终态。
	tracker.observe("agent-1", endEvent([result("C:/a.jsonl", { exitCode: 1, progress: { status: "failed" } })]), 2_000);
	assert.deepEqual(summarize(tracker.snapshot("agent-1", 2_000)), ["C:/a.jsonl|error|readonly"]);

	// isError 结束帧触发的清理只清 running，不得抹掉刚写入的 error 行。
	assert.equal(tracker.clearToolCall("agent-1", "call-1"), false);
	assert.deepEqual(summarize(tracker.snapshot("agent-1", 2_000)), ["C:/a.jsonl|error|readonly"]);
});
