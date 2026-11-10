import assert from "node:assert/strict";
import test from "node:test";

import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { SubagentRunTracker, SUBAGENT_RUN_TRACKER_LIMITS } = loadTsCommonJs("src/main/pi/SubagentRunTracker.ts");
const { parseSubagentStatusSnapshot, sameSessionPath } = loadTsCommonJs("src/main/pi/subagentStatusSnapshot.ts");

// 交接后子代理继续工作时，扩展经状态槽持续上报；主进程必须：
// 1) 严格校验跨进程载荷；2) 让快照成为该任务的权威来源；
// 3) 回合结束不误灭灯，但心跳丢失后不能留永久黄灯。

const STALE_MS = SUBAGENT_RUN_TRACKER_LIMITS.snapshotStaleMs;
const OWNER = "C:/sessions/parent.jsonl";
const RUN_ID = "run-1";
const T0 = 1_000_000;

function snapshot(overrides = {}) {
	return {
		version: 1,
		ownerSessionId: OWNER,
		parentToolCallId: "call-workflow",
		workflowRunId: RUN_ID,
		sequence: 1,
		complete: false,
		truncated: false,
		observedAt: T0,
		children: [],
		...overrides,
	};
}

function child(sessionFile, state, extras = {}) {
	return { taskKey: "first", sessionFile, state, ...extras };
}

function toolEvent(workflowRunId, children) {
	return {
		type: "tool_execution_update",
		toolName: "subagent",
		toolCallId: "call-workflow",
		partialResult: {
			content: [],
			details: {
				mode: "workflow",
				results: [],
				workflowChildren: { workflowRunId, children },
			},
		},
	};
}

test("the parser accepts a well-formed frame", () => {
	const parsed = parseSubagentStatusSnapshot(JSON.stringify(snapshot({
		children: [child("C:/sessions/a.jsonl", "running", { agent: "worker", executionId: "run-a" })],
	})));
	assert.equal(parsed.workflowRunId, RUN_ID);
	assert.equal(parsed.children.length, 1);
	assert.equal(parsed.children[0].state, "running");
	assert.equal(parsed.children[0].agent, "worker");
	assert.equal(parsed.children[0].executionId, "run-a");
});

test("the parser rejects malformed or oversized frames", () => {
	assert.equal(parseSubagentStatusSnapshot(undefined), undefined);
	assert.equal(parseSubagentStatusSnapshot("not json"), undefined);
	assert.equal(parseSubagentStatusSnapshot(JSON.stringify(snapshot({ version: 2 }))), undefined);
	assert.equal(parseSubagentStatusSnapshot(JSON.stringify(snapshot({ sequence: -1 }))), undefined);
	assert.equal(parseSubagentStatusSnapshot(JSON.stringify(snapshot({ complete: "yes" }))), undefined);
	assert.equal(parseSubagentStatusSnapshot(JSON.stringify(snapshot({ children: "nope" }))), undefined);
	assert.equal(
		parseSubagentStatusSnapshot(JSON.stringify(snapshot({ ownerSessionId: "x".repeat(40_000) }))),
		undefined,
		"an oversized frame must be rejected before it reaches the tracker",
	);
});

test("one bad child row does not discard the rest of the frame", () => {
	const parsed = parseSubagentStatusSnapshot(JSON.stringify(snapshot({
		children: [
			child("C:/sessions/a.jsonl", "running"),
			child("C:/sessions/b.jsonl", "exploded"),
			{ taskKey: "third", state: "running" },
		],
	})));
	assert.equal(parsed.children.length, 1);
	assert.equal(parsed.children[0].sessionFile, "C:/sessions/a.jsonl");
	// 丢过行就不能再当作完整清单：否则 tracker 会删掉被丢掉那一行的灯。
	assert.equal(parsed.truncated, true);
});

test("an over-long child list is parsed as truncated even if the sender said otherwise", () => {
	const children = Array.from({ length: 65 }, (_, index) => child(`C:/sessions/${index}.jsonl`, "running"));
	const parsed = parseSubagentStatusSnapshot(JSON.stringify(snapshot({ children, truncated: false })));
	assert.equal(parsed.children.length, 64);
	assert.equal(parsed.truncated, true);
});

test("session paths compare across separators and Windows casing", () => {
	assert.equal(sameSessionPath("C:\\Sessions\\Parent.jsonl", "C:/sessions/parent.jsonl"), process.platform === "win32");
	assert.equal(sameSessionPath("C:/sessions/parent.jsonl", "C:/sessions/parent.jsonl"), true);
	assert.equal(sameSessionPath("C:/sessions/parent.jsonl", "C:/sessions/other.jsonl"), false);
});

test("a running snapshot lights the child without leaking internal fields", () => {
	const tracker = new SubagentRunTracker();
	assert.equal(
		tracker.observeStatusSnapshot("agent-1", snapshot({ children: [child("C:/sessions/a.jsonl", "running", { agent: "worker" })] }), T0),
		true,
	);
	const runs = tracker.snapshot("agent-1", T0);
	assert.equal(runs.length, 1);
	assert.equal(runs[0].status, "running");
	assert.equal(runs[0].agent, "worker");
	assert.equal("snapshotRunId" in runs[0], false);
});

test("turn end keeps a live handoff light, but a lost heartbeat does not", () => {
	const tracker = new SubagentRunTracker();
	tracker.observeStatusSnapshot("agent-1", snapshot({ children: [child("C:/sessions/a.jsonl", "running")] }), T0);
	assert.equal(tracker.clearRunning("agent-1", T0 + 5_000), false, "agent_end must not close a live handoff");
	assert.equal(tracker.snapshot("agent-1", T0 + 5_000).length, 1);
	assert.equal(tracker.clearRunning("agent-1", T0 + STALE_MS + 1), true, "a stale source must not keep a light");
	assert.equal(tracker.snapshot("agent-1", T0 + STALE_MS + 1).length, 0);
});

test("terminal and complete snapshots close the light", () => {
	const tracker = new SubagentRunTracker();
	tracker.observeStatusSnapshot("agent-1", snapshot({
		sequence: 1,
		children: [child("C:/sessions/a.jsonl", "running"), child("C:/sessions/b.jsonl", "running")],
	}), T0);
	assert.equal(tracker.snapshot("agent-1", T0).length, 2);

	// 一个子代理结束、另一个还在跑：只收结束的那盏。
	tracker.observeStatusSnapshot("agent-1", snapshot({
		sequence: 2,
		children: [child("C:/sessions/a.jsonl", "completed"), child("C:/sessions/b.jsonl", "running")],
	}), T0);
	assert.deepEqual(Array.from(tracker.snapshot("agent-1", T0), (run) => run.sessionFile), ["C:/sessions/b.jsonl"]);

	// 整个任务结束：即使帧里还写着 running，也必须全部收灯。
	tracker.observeStatusSnapshot("agent-1", snapshot({
		sequence: 3,
		complete: true,
		children: [child("C:/sessions/b.jsonl", "running")],
	}), T0);
	assert.equal(tracker.snapshot("agent-1", T0).length, 0);
});

test("a failed child turns red instead of disappearing", () => {
	const tracker = new SubagentRunTracker();
	tracker.observeStatusSnapshot("agent-1", snapshot({ children: [child("C:/sessions/a.jsonl", "failed")] }), T0);
	const runs = tracker.snapshot("agent-1", T0);
	assert.equal(runs.length, 1);
	assert.equal(runs[0].status, "error");
});

test("a finished task keeps failed rows for review", () => {
	const tracker = new SubagentRunTracker();
	tracker.observeStatusSnapshot("agent-1", snapshot({
		children: [child("C:/sessions/a.jsonl", "running"), child("C:/sessions/b.jsonl", "failed")],
	}), T0);

	tracker.observeStatusSnapshot("agent-1", snapshot({ sequence: 2, complete: true }), T0);
	assert.deepEqual(
		Array.from(tracker.snapshot("agent-1", T0), (run) => `${run.sessionFile}|${run.status}`),
		["C:/sessions/b.jsonl|error"],
		"complete must close running lights but keep the failure for review",
	);

	tracker.clearStatusTask("agent-1", RUN_ID);
	assert.deepEqual(
		Array.from(tracker.snapshot("agent-1", T0), (run) => `${run.sessionFile}|${run.status}`),
		["C:/sessions/b.jsonl|error"],
	);
});

test("a lost heartbeat drops running lights but keeps failed rows", () => {
	const tracker = new SubagentRunTracker();
	tracker.observeStatusSnapshot("agent-1", snapshot({
		children: [child("C:/sessions/a.jsonl", "running"), child("C:/sessions/b.jsonl", "failed")],
	}), T0);

	assert.equal(tracker.clearRunning("agent-1", T0 + STALE_MS + 1), true);
	assert.deepEqual(
		Array.from(tracker.snapshot("agent-1", T0 + STALE_MS + 1), (run) => `${run.sessionFile}|${run.status}`),
		["C:/sessions/b.jsonl|error"],
	);
});

test("clearing the status slot closes that task only", () => {
	const tracker = new SubagentRunTracker();
	tracker.observeStatusSnapshot("agent-1", snapshot({
		workflowRunId: "run-1",
		children: [child("C:/sessions/a.jsonl", "running")],
	}), T0);
	tracker.observeStatusSnapshot("agent-1", snapshot({
		workflowRunId: "run-2",
		sequence: 1,
		children: [child("C:/sessions/b.jsonl", "running")],
	}), T0);
	assert.equal(tracker.snapshot("agent-1", T0).length, 2);

	assert.equal(tracker.clearStatusTask("agent-1", "run-1"), true);
	assert.deepEqual(Array.from(tracker.snapshot("agent-1", T0), (run) => run.sessionFile), ["C:/sessions/b.jsonl"]);
	assert.equal(tracker.clearStatusTask("agent-1", "run-1"), false, "clearing twice is a no-op");
});

test("out-of-order frames and foreign sessions are ignored", () => {
	const tracker = new SubagentRunTracker();
	tracker.observeStatusSnapshot("agent-1", snapshot({
		sequence: 5,
		children: [child("C:/sessions/a.jsonl", "running")],
	}), T0);

	assert.equal(
		tracker.observeStatusSnapshot("agent-1", snapshot({ sequence: 4, complete: true }), T0),
		false,
		"an older frame must not close a newer one",
	);
	assert.equal(tracker.snapshot("agent-1", T0).length, 1);

	assert.equal(
		tracker.observeStatusSnapshot("agent-1", snapshot({
			sequence: 6,
			ownerSessionId: "C:/sessions/other.jsonl",
			complete: true,
		}), T0),
		false,
		"a frame from another session must not touch this one",
	);
	assert.equal(tracker.snapshot("agent-1", T0).length, 1);
});

test("a truncated frame only adds, it never deletes omitted children", () => {
	const tracker = new SubagentRunTracker();
	tracker.observeStatusSnapshot("agent-1", snapshot({
		sequence: 1,
		children: [child("C:/sessions/a.jsonl", "running"), child("C:/sessions/b.jsonl", "running")],
	}), T0);

	tracker.observeStatusSnapshot("agent-1", snapshot({
		sequence: 2,
		truncated: true,
		children: [child("C:/sessions/a.jsonl", "running")],
	}), T0);
	assert.equal(tracker.snapshot("agent-1", T0).length, 2, "omitted rows must survive a truncated frame");

	tracker.observeStatusSnapshot("agent-1", snapshot({
		sequence: 3,
		children: [child("C:/sessions/a.jsonl", "running")],
	}), T0);
	assert.equal(tracker.snapshot("agent-1", T0).length, 1, "a complete frame removes children that disappeared");
});

test("the status slot owns its task while live, then tool events resume", () => {
	const tracker = new SubagentRunTracker();
	tracker.observeStatusSnapshot("agent-1", snapshot({
		children: [child("C:/sessions/a.jsonl", "running")],
	}), T0);

	// 同一 workflow 的工具帧落后于交接后的真实状态，不能把灯改回去。
	assert.equal(
		tracker.observe("agent-1", toolEvent(RUN_ID, [{ childId: "first", state: "completed", sessionFile: "C:/sessions/a.jsonl" }]), T0),
		false,
	);
	assert.equal(tracker.snapshot("agent-1", T0).length, 1);

	// 快照没覆盖的会话（例如截断帧）仍接受工具帧，否则它们的终态永远收不回来。
	assert.equal(
		tracker.observe("agent-1", toolEvent(RUN_ID, [{ childId: "extra", state: "running", sessionFile: "C:/sessions/c.jsonl" }]), T0),
		true,
	);
	assert.equal(tracker.snapshot("agent-1", T0).length, 2);

	// 另一个 workflow 的工具帧不受影响。
	assert.equal(
		tracker.observe("agent-1", toolEvent("run-2", [{ childId: "first", state: "running", sessionFile: "C:/sessions/b.jsonl" }]), T0),
		true,
	);
	assert.equal(tracker.snapshot("agent-1", T0).length, 3);

	// 状态槽收尾后，工具事件重新成为来源。
	tracker.observeStatusSnapshot("agent-1", snapshot({ sequence: 2, complete: true }), T0);
	// complete 收掉该任务启动过的全部行（含工具帧点亮的 c）；另一个 workflow 的 b 保留。
	assert.deepEqual(
		Array.from(tracker.snapshot("agent-1", T0), (run) => run.sessionFile).sort(),
		["C:/sessions/b.jsonl"],
	);
	assert.equal(
		tracker.observe("agent-1", toolEvent(RUN_ID, [{ childId: "first", state: "running", sessionFile: "C:/sessions/a.jsonl" }]), T0),
		true,
	);
	assert.equal(tracker.snapshot("agent-1", T0).length, 2);
});

test("a single detach receipt cannot switch off a light the status slot still owns", () => {
	const tracker = new SubagentRunTracker();
	tracker.observeStatusSnapshot("agent-1", snapshot({
		children: [child("C:/sessions/a.jsonl", "running")],
	}), T0);
	// 单个子代理提问后，工具结果没有 workflowChildren，progress.status 是 detached。
	// 这会被看成「已经结束」，但不能把状态槽还在报的灯关掉。
	assert.equal(tracker.observe("agent-1", {
		toolName: "subagent",
		toolCallId: "call-1",
		result: {
			details: {
				mode: "single",
				results: [{
					sessionFile: "C:/sessions/a.jsonl",
					detached: true,
					exitCode: -2,
					progress: { status: "detached" },
				}],
			},
		},
	}, T0), false);
	assert.equal(tracker.snapshot("agent-1", T0).length, 1);
	assert.equal(tracker.clearRunning("agent-1", T0), false);
});

test("a complete frame still turns its failed child red", () => {
	const tracker = new SubagentRunTracker();
	tracker.observeStatusSnapshot("agent-1", snapshot({ children: [child("C:/sessions/a.jsonl", "running")] }), T0);
	// 单个子代理 detach 后失败时，收尾帧同时带 complete 和 failed：
	// 不能只收灯，必须留下红灯供回看。
	tracker.observeStatusSnapshot("agent-1", snapshot({
		sequence: 2,
		complete: true,
		children: [child("C:/sessions/a.jsonl", "failed")],
	}), T0);
	assert.deepEqual(
		Array.from(tracker.snapshot("agent-1", T0), (run) => `${run.sessionFile}|${run.status}`),
		["C:/sessions/a.jsonl|error"],
	);
});
