import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { SubagentRunTracker, SUBAGENT_RUN_TRACKER_LIMITS } = loadTsCommonJs("src/main/pi/SubagentRunTracker.ts");
const SESSION = "/sessions/resumed.jsonl";
const OTHER = "/sessions/other.jsonl";
const T0 = 1_000;

function child(taskKey, state, executionId, sessionFile = SESSION) {
	return { taskKey, state, sessionFile, agent: taskKey, ...(executionId ? { executionId } : {}) };
}

function snapshot(workflowRunId, sequence, children, extras = {}) {
	return {
		version: 1, ownerSessionId: "/sessions/parent.jsonl", parentToolCallId: `call-${workflowRunId}`,
		workflowRunId, sequence, children, observedAt: T0, complete: false, truncated: false, ...extras,
	};
}

function lights(tracker, now = T0) {
	return Array.from(tracker.snapshot("agent", now), (row) => `${row.sessionFile}|${row.status}|${row.agent}`).sort();
}

function workflowTool(workflowRunId, taskKey, state, runId) {
	return {
		toolName: "subagent", toolCallId: `call-${workflowRunId}`,
		result: { details: { mode: "workflow", results: [], workflowChildren: {
			workflowRunId, children: [{ childId: taskKey, state, sessionFile: SESSION, agent: taskKey, ...(runId ? { runId } : {}) }],
		} } },
	};
}

function singleTool(runId, status) {
	return {
		toolName: "subagent", toolCallId: `call-${runId}`,
		result: { details: { mode: "single", runId, results: [{ sessionFile: SESSION, agent: "resume", progress: { status } }] } },
	};
}

for (const withIdentity of [true, false]) {
	for (const lateState of ["failed", "running", "completed"]) {
		test(`old ${lateState} heartbeats cannot overwrite a resumed session (${withIdentity ? "execution ids" : "legacy task keys"})`, () => {
			const tracker = new SubagentRunTracker();
			const old = (state) => [child("old", state, withIdentity ? "opaque-z" : undefined), child("other", "running", "other-run", OTHER)];
			tracker.observeStatusSnapshot("agent", snapshot("A", 1, old("failed")), T0);
			tracker.observeStatusSnapshot("agent", snapshot("B", 1, [child("resume", "running", withIdentity ? "opaque-a" : undefined)]), T0 + 1);
			tracker.observeStatusSnapshot("agent", snapshot("A", 2, old(lateState)), T0 + 2);
			assert.deepEqual(lights(tracker), [`${OTHER}|running|other`, `${SESSION}|running|resume`].sort());

			tracker.observeStatusSnapshot("agent", snapshot("B", 2, [child("resume", "completed", withIdentity ? "opaque-a" : undefined)], { complete: true }), T0 + 3);
			tracker.clearStatusTask("agent", "B");
			tracker.observeStatusSnapshot("agent", snapshot("A", 3, old("failed")), T0 + 4);
			tracker.observe("agent", workflowTool("A", "old", "failed", withIdentity ? "opaque-z" : undefined), T0 + 5);
			assert.deepEqual(lights(tracker), [`${OTHER}|running|other`], "old failure must not resurrect after resume succeeds and clears");
		});
	}
}

test("an old complete/clear frame and stale cleanup cannot remove a newer execution", () => {
	const tracker = new SubagentRunTracker();
	tracker.observeStatusSnapshot("agent", snapshot("A", 1, [child("old", "failed", "old-run")]), T0);
	tracker.observe("agent", singleTool("new-run", "running"), T0 + 1);
	assert.deepEqual(lights(tracker), [`${SESSION}|running|resume`], "a genuinely new tool execution is not blocked by the old live snapshot");
	tracker.observeStatusSnapshot("agent", snapshot("A", 2, [child("old", "failed", "old-run")], { complete: true }), T0 + 2);
	tracker.clearStatusTask("agent", "A");
	assert.deepEqual(lights(tracker), [`${SESSION}|running|resume`]);
	assert.deepEqual(lights(tracker, T0 + SUBAGENT_RUN_TRACKER_LIMITS.snapshotStaleMs + 1), [`${SESSION}|running|resume`]);
	tracker.observe("agent", singleTool("new-run", "completed"), T0 + SUBAGENT_RUN_TRACKER_LIMITS.snapshotStaleMs + 2);
	assert.deepEqual(lights(tracker), []);
});

test("a resumed terminal tool frame remains usable after its snapshot completes despite an old live source", () => {
	const tracker = new SubagentRunTracker();
	tracker.observeStatusSnapshot("agent", snapshot("A", 1, [child("old", "failed", "old-run"), child("other", "running", "other-run", OTHER)]), T0);
	tracker.observeStatusSnapshot("agent", snapshot("new-run", 1, [child("single", "running", "new-run")]), T0 + 1);
	tracker.observeStatusSnapshot("agent", snapshot("new-run", 2, [child("single", "failed", "new-run")], { complete: true }), T0 + 2);
	tracker.observe("agent", singleTool("new-run", "completed"), T0 + 3);
	assert.deepEqual(lights(tracker), [`${OTHER}|running|other`], "the old task's inventory must not block the current owner's terminal result");
	tracker.observeStatusSnapshot("agent", snapshot("A", 2, [child("old", "failed", "old-run"), child("other", "running", "other-run", OTHER)]), T0 + 4);
	assert.deepEqual(lights(tracker), [`${OTHER}|running|other`]);
});

for (const sameKey of [false, true]) {
	test(`same-workflow resume accepts a new opaque execution (${sameKey ? "same key" : "new key"})`, () => {
		const tracker = new SubagentRunTracker();
		const newKey = sameKey ? "old" : "resume";
		tracker.observeStatusSnapshot("agent", snapshot("A", 1, [child("old", "failed", "z-id")]), T0);
		tracker.observeStatusSnapshot("agent", snapshot("A", 2, [child(newKey, "running", "a-id")]), T0 + 1);
		tracker.observe("agent", workflowTool("A", newKey, "completed", "a-id"), T0 + 2);
		assert.deepEqual(lights(tracker), [`${SESSION}|running|${newKey}`], "same-owner tool receipts do not extinguish a live status slot");
		tracker.observeStatusSnapshot("agent", snapshot("A", 3, [child(newKey, "completed", "a-id")]), T0 + 3);
		tracker.observeStatusSnapshot("agent", snapshot("A", 4, [child("old", "failed", "z-id")]), T0 + 4);
		assert.deepEqual(lights(tracker), [], "a known older execution cannot reclaim the path");
	});
}

test("late runId enrichment of an old task is not a new execution", () => {
	const tracker = new SubagentRunTracker();
	tracker.observeStatusSnapshot("agent", snapshot("A", 1, [child("old", "failed")]), T0);
	tracker.observeStatusSnapshot("agent", snapshot("B", 1, [child("resume", "running", "new-id")]), T0 + 1);
	tracker.observeStatusSnapshot("agent", snapshot("A", 2, [child("old", "failed", "late-old-id")]), T0 + 2);
	assert.deepEqual(lights(tracker), [`${SESSION}|running|resume`]);
	tracker.observeStatusSnapshot("agent", snapshot("B", 2, [child("resume", "completed", "new-id")], { complete: true }), T0 + 3);
	tracker.observeStatusSnapshot("agent", snapshot("A", 3, [child("old", "failed", "late-old-id")]), T0 + 4);
	assert.deepEqual(lights(tracker), []);
});

test("same-workflow metadata enrichment cannot revive its superseded task key", () => {
	const tracker = new SubagentRunTracker();
	tracker.observeStatusSnapshot("agent", snapshot("A", 1, [child("first", "failed")]), T0);
	tracker.observeStatusSnapshot("agent", snapshot("A", 2, [child("second", "running", "new-id")]), T0 + 1);
	tracker.observeStatusSnapshot("agent", snapshot("A", 3, [child("first", "failed", "old-late-id")]), T0 + 2);
	assert.deepEqual(lights(tracker), [`${SESSION}|running|second`]);
});

test("closed status tasks reject repeated and higher-sequence final snapshots", () => {
	const tracker = new SubagentRunTracker();
	tracker.observeStatusSnapshot("agent", snapshot("A", 1, [child("first", "running", "id")]), T0);
	tracker.observeStatusSnapshot("agent", snapshot("A", 2, [child("first", "completed", "id")], { complete: true }), T0 + 1);
	tracker.observeStatusSnapshot("agent", snapshot("A", 3, [child("first", "failed", "id")]), T0 + 2);
	assert.deepEqual(lights(tracker), []);
});

test("stale old tasks cannot delete a newer tool-owned row", () => {
	const tracker = new SubagentRunTracker();
	tracker.observeStatusSnapshot("agent", snapshot("A", 1, [child("old", "running", "old-id")]), T0);
	tracker.observe("agent", singleTool("new-id", "running"), T0 + 1);
	assert.deepEqual(lights(tracker, T0 + SUBAGENT_RUN_TRACKER_LIMITS.snapshotStaleMs + 1), [`${SESSION}|running|resume`]);
});

test("a current failed tool terminal is accepted after an empty complete snapshot", () => {
	const tracker = new SubagentRunTracker();
	tracker.observeStatusSnapshot("agent", snapshot("A", 1, [child("old", "failed", "old-run"), child("other", "running", "other-run", OTHER)]), T0);
	tracker.observeStatusSnapshot("agent", snapshot("new-run", 1, [child("single", "running", "new-run")]), T0 + 1);
	tracker.observeStatusSnapshot("agent", snapshot("new-run", 2, [], { complete: true }), T0 + 2);
	tracker.observe("agent", singleTool("new-run", "failed"), T0 + 3);
	assert.deepEqual(lights(tracker), [`${OTHER}|running|other`, `${SESSION}|error|resume`].sort());
});

test("a legacy old result cannot settle a newer identified workflow row in the same frame", () => {
	const tracker = new SubagentRunTracker();
	tracker.observe("agent", {
		toolName: "subagent", toolCallId: "call-A",
		partialResult: { details: {
			mode: "workflow", results: [{ sessionFile: SESSION, exitCode: 1, error: "old failure" }],
			workflowChildren: { workflowRunId: "A", children: [
				{ childId: "first", state: "failed", sessionFile: SESSION, runId: "z-old" },
				{ childId: "second", state: "running", sessionFile: SESSION, runId: "a-new", agent: "resume" },
			] },
		} },
	}, T0);
	assert.deepEqual(lights(tracker), [`${SESSION}|running|resume`]);
});

test("same-workflow legacy task keys distinguish a resumed execution without any executionId", () => {
	const tracker = new SubagentRunTracker();
	tracker.observeStatusSnapshot("agent", snapshot("A", 1, [child("first", "failed")]), T0);
	tracker.observeStatusSnapshot("agent", snapshot("A", 2, [child("second", "running")]), T0 + 1);
	tracker.observe("agent", workflowTool("A", "first", "failed"), T0 + 2);
	assert.deepEqual(lights(tracker), [`${SESSION}|running|second`]);
	tracker.observeStatusSnapshot("agent", snapshot("A", 3, [child("second", "completed")]), T0 + 3);
	tracker.observeStatusSnapshot("agent", snapshot("A", 4, [child("first", "failed")]), T0 + 4);
	assert.deepEqual(lights(tracker), []);
});

for (const withIdentity of [true, false]) {
	test(`clear alone preserves the newer ownership fence (${withIdentity ? "identified" : "legacy"})`, () => {
		const tracker = new SubagentRunTracker();
		const old = [child("old", "failed", withIdentity ? "old-id" : undefined)];
		tracker.observeStatusSnapshot("agent", snapshot("A", 1, old), T0);
		tracker.observeStatusSnapshot("agent", snapshot("B", 1, [child("resume", "running", withIdentity ? "new-id" : undefined)]), T0 + 1);
		tracker.clearStatusTask("agent", "B");
		tracker.observeStatusSnapshot("agent", snapshot("A", 2, old), T0 + 2);
		tracker.observe("agent", workflowTool("A", "old", "failed", withIdentity ? "old-id" : undefined), T0 + 3);
		assert.deepEqual(lights(tracker), []);
	});
}

test("ongoing old heartbeats preserve the newer success fence without renewing any failure", () => {
	const tracker = new SubagentRunTracker();
	tracker.observeStatusSnapshot("agent", snapshot("A", 1, [child("old", "failed", "old-id")]), T0);
	tracker.observeStatusSnapshot("agent", snapshot("B", 1, [child("resume", "running", "new-id")]), T0 + 1);
	tracker.observeStatusSnapshot("agent", snapshot("B", 2, [child("resume", "completed", "new-id")], { complete: true }), T0 + 2);
	for (let sequence = 2; sequence < 190; sequence += 1) {
		const now = T0 + sequence * 10_000;
		tracker.observeStatusSnapshot("agent", snapshot("A", sequence, [child("old", "failed", "old-id")]), now);
		assert.deepEqual(lights(tracker, now), []);
	}
});
