import assert from "node:assert/strict";
import test from "node:test";

import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const {
	SUBAGENT_STATUS_KEY_PREFIX,
	SUBAGENT_STATUS_SNAPSHOT_VERSION,
	createSubagentStatusPublisher,
	normalizeSubagentStatusChildren,
	workflowChildToStatusChild,
} = loadTsCommonJs("resources/extensions/pideck-q-subagents/src/runs/foreground/subagent-status-publisher.ts");
const desktopContract = loadTsCommonJs("src/shared/types/subagents.ts");

// 扩展把子代理运行态写进 pi 的扩展状态槽（ctx.ui.setStatus），主进程按 key 前缀消费。
// 这些用例固定住两侧的协议契约与发布节奏：重复帧不刷屏、心跳保活、收尾清槽。

const RUN_ID = "workflow-run-1";
const OWNER = "C:/sessions/parent.jsonl";
const PARENT_CALL = "call-workflow";

function child(sessionFile, state, extras = {}) {
	return { taskKey: "first", sessionFile, state, ...extras };
}

function createRecorder() {
	const calls = [];
	return {
		calls,
		ui: {
			setStatus(key, text) {
				calls.push({ key, text });
			},
		},
	};
}

function publisher(recorder, overrides = {}) {
	return createSubagentStatusPublisher({
		ui: recorder.ui,
		ownerSessionId: OWNER,
		parentToolCallId: PARENT_CALL,
		workflowRunId: RUN_ID,
		env: { PIDECK_DESKTOP: "1" },
		...overrides,
	});
}

function payload(call) {
	return JSON.parse(call.text);
}

test("the extension and the desktop share one status key contract", () => {
	assert.equal(SUBAGENT_STATUS_KEY_PREFIX, desktopContract.SUBAGENT_STATUS_KEY_PREFIX);
	assert.equal(SUBAGENT_STATUS_SNAPSHOT_VERSION, desktopContract.SUBAGENT_STATUS_SNAPSHOT_VERSION);
});

test("no desktop marker means no status traffic", () => {
	const recorder = createRecorder();
	const status = publisher(recorder, { env: {} });
	assert.equal(status.enabled, false, "callers can skip building a projection");
	status.publish([child("C:/sessions/a.jsonl", "running")]);
	status.dispose();
	assert.equal(recorder.calls.length, 0);
});

test("publishes a bounded snapshot and skips identical frames", () => {
	const recorder = createRecorder();
	const status = publisher(recorder);
	assert.equal(status.enabled, true);
	status.publish([child("C:/sessions/a.jsonl", "running", { agent: "worker" })]);
	status.publish([child("C:/sessions/a.jsonl", "running", { agent: "worker" })]);
	assert.equal(recorder.calls.length, 1, "an unchanged frame must not be resent");

	const first = payload(recorder.calls[0]);
	assert.equal(recorder.calls[0].key, `${SUBAGENT_STATUS_KEY_PREFIX}${RUN_ID}`);
	assert.equal(first.version, 1);
	assert.equal(first.ownerSessionId, OWNER);
	assert.equal(first.parentToolCallId, PARENT_CALL);
	assert.equal(first.workflowRunId, RUN_ID);
	assert.equal(first.complete, false);
	assert.equal(first.truncated, false);
	assert.equal(first.children.length, 1);
	assert.equal(first.children[0].sessionFile, "C:/sessions/a.jsonl");
	assert.equal(first.children[0].state, "running");
	assert.equal(first.children[0].agent, "worker");

	status.publish([child("C:/sessions/a.jsonl", "completed", { agent: "worker" })]);
	assert.equal(recorder.calls.length, 2, "a state change must be published");
	assert.equal(payload(recorder.calls[1]).sequence, first.sequence + 1);
	status.dispose();
});

test("the latest execution of one session file wins", () => {
	const normalized = normalizeSubagentStatusChildren([
		child("C:/sessions/a.jsonl", "completed"),
		child("C:/sessions/a.jsonl", "running"),
	]);
	assert.equal(normalized.children.length, 1);
	assert.equal(normalized.children[0].state, "running");
	assert.equal(normalized.truncated, false);
});

test("pending and path-less rows never light a child", () => {
	assert.equal(workflowChildToStatusChild({ childId: "first", state: "pending", sessionFile: "C:/a.jsonl" }), undefined);
	assert.equal(workflowChildToStatusChild({ childId: "first", state: "running" }), undefined);
	const mapped = workflowChildToStatusChild({ childId: "first", state: "rejected", sessionFile: "C:/a.jsonl", runId: "run-1" });
	assert.equal(mapped.state, "failed");
	assert.equal(mapped.executionId, "run-1");
});

test("an oversized inventory is truncated instead of silently dropped", () => {
	const children = Array.from({ length: 65 }, (_, index) => child(`C:/sessions/${index}.jsonl`, "running"));
	const normalized = normalizeSubagentStatusChildren(children);
	assert.equal(normalized.children.length, 64);
	assert.equal(normalized.truncated, true);
});

test("a dropped row marks the frame as truncated", () => {
	const normalized = normalizeSubagentStatusChildren([
		child("C:/sessions/a.jsonl", "running"),
		child("C:/sessions/b.jsonl", "exploded"),
	]);
	assert.equal(normalized.children.length, 1);
	assert.equal(normalized.truncated, true, "a dropped row means the frame is no longer a complete inventory");
});

test("heartbeat keeps the task alive, completion stops it, dispose clears the slot", async () => {
	const recorder = createRecorder();
	const status = publisher(recorder);
	status.publish([child("C:/sessions/a.jsonl", "running")]);
	const first = payload(recorder.calls[0]);

	await new Promise((resolve) => setTimeout(resolve, 1_150));
	assert.ok(recorder.calls.length >= 2, "the heartbeat must refresh liveness");
	const beat = payload(recorder.calls[1]);
	assert.equal(beat.complete, false);
	assert.equal(beat.sequence > first.sequence, true);
	assert.deepEqual(beat.children, first.children);

	status.publish([child("C:/sessions/a.jsonl", "completed")], true);
	const complete = payload(recorder.calls.at(-1));
	assert.equal(complete.complete, true);
	const callsAfterComplete = recorder.calls.length;
	await new Promise((resolve) => setTimeout(resolve, 1_150));
	assert.equal(recorder.calls.length, callsAfterComplete, "a finished task must stop heartbeating");

	status.dispose();
	assert.equal(recorder.calls.at(-1).text, undefined, "dispose must clear the status slot");
	assert.equal(recorder.calls.at(-1).key, `${SUBAGENT_STATUS_KEY_PREFIX}${RUN_ID}`);
});

test("a throwing host never breaks the caller", () => {
	const status = createSubagentStatusPublisher({
		ui: {
			setStatus() {
				throw new Error("host update failed");
			},
		},
		ownerSessionId: OWNER,
		parentToolCallId: PARENT_CALL,
		workflowRunId: RUN_ID,
		env: { PIDECK_DESKTOP: "1" },
	});
	assert.doesNotThrow(() => status.publish([child("C:/sessions/a.jsonl", "running")]));
	assert.doesNotThrow(() => status.dispose());
});

test("a disposed publisher stops publishing", () => {
	const recorder = createRecorder();
	const status = publisher(recorder);
	status.publish([child("C:/sessions/a.jsonl", "running")]);
	status.dispose();
	status.publish([child("C:/sessions/a.jsonl", "completed")]);
	assert.equal(recorder.calls.length, 2, "only the initial frame and the slot clear");
	assert.equal(recorder.calls.at(-1).text, undefined);
});
