import "./helpers/piFixtureResolver.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const { waitForSubagents } = await import("../resources/extensions/pideck-q-subagents/src/runs/background/subagent-wait.ts");
const { drainOutstandingWork } = await import("../resources/extensions/pideck-q-subagents/src/runs/background/auto-drain.ts");
const { updateActiveRunIndex } = await import("../resources/extensions/pideck-q-subagents/src/runs/background/active-run-index.ts");
const { formatRunSupervisionSnapshot } = await import("../resources/extensions/pideck-q-subagents/src/runs/shared/run-supervision-snapshot.ts");
const text = (result) => result.content.map((part) => part.text ?? "").join("\n");

/** A real persisted async run has an ordinary active tool, not a fabricated supervisor tool. */
function fixture(t) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pideck-run-review-wait-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const asyncDir = path.join(root, "review-child");
	fs.mkdirSync(asyncDir);
	const status = { version: 1, runId: "review-child", sessionId: "parent", mode: "single", state: "queued", startedAt: Date.now(), lastUpdate: Date.now(),
		steps: [{ agent: "worker", status: "running", currentTool: "read", activityState: "working" }],
	};
	const save = () => fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify(status));
	save();
	updateActiveRunIndex(asyncDir, "queued");
	const state = { currentSessionId: "parent", asyncJobs: new Map(), foregroundControls: new Map(), foregroundRuns: new Map(), foregroundWorkflows: new Map() };
	let pending = false;
	const deps = { state, asyncDirRoot: root, resultsDir: root,
		findPendingAsks: ({ runId, agent, childIndex }) => pending && state.currentSessionId === "parent" && runId === status.runId && agent === "worker" && childIndex === 0 ? ["run-review-request"] : [],
	};
	return { status, state, save, deps, setPending(value) { pending = value; } };
}

for (const alreadyPending of [false, true]) {
	test(`native run review ${alreadyPending ? "already pending" : "arriving during wait"} releases a wait even with stopOnAttention false`, async (t) => {
		const f = fixture(t);
		f.setPending(alreadyPending);
		let sleeps = 0;
		const result = await waitForSubagents({ all: true, stopOnAttention: false, timeoutMs: 1000 }, undefined, {
			...f.deps, sleep: async () => { assert.equal(++sleeps, 1); f.setPending(true); },
		});
		assert.match(text(result), /attention required/);
		assert.match(text(result), /subagent_supervisor/);
		assert.match(text(result), /Do not resume or launch a replacement/);
		assert.equal(sleeps, alreadyPending ? 0 : 1);
		assert.equal(f.status.steps[0].currentTool, "read");
		assert.equal(f.status.state, "queued");
	});
}

test("a settled run review does not keep the following wait in attention", async (t) => {
	const f = fixture(t);
	f.setPending(true);
	const first = await waitForSubagents({ id: "review-child", stopOnAttention: false }, undefined, f.deps);
	assert.match(text(first), /attention required/);
	f.setPending(false);
	const second = await waitForSubagents({ id: "review-child", stopOnAttention: false }, undefined, {
		...f.deps, sleep: async () => { f.status.state = "complete"; f.status.steps[0].status = "complete"; f.save(); },
	});
	assert.match(text(second), /done/);
	assert.doesNotMatch(text(second), /attention required/);
});

for (const independent of [false, true]) {
	test(`${independent ? "workflow" : "chain"} second child uses its execution identity for run review requests`, async (t) => {
		const f = fixture(t);
		f.status.mode = independent ? "workflow" : "chain";
		f.status.steps = [
			{ agent: "worker", status: "complete", ...(independent ? { runId: "child-a" } : {}) },
			{ agent: "worker", status: "running", currentTool: "read", ...(independent ? { runId: "child-b" } : {}) },
		];
		f.save();
		const result = await waitForSubagents({ id: "review-child", stopOnAttention: false, timeoutMs: 1000 }, undefined, {
			...f.deps,
			findPendingAsks: ({ runId, childIndex }) => runId === (independent ? "child-b" : "review-child") && childIndex === (independent ? 0 : 1) ? ["second-child-review"] : [],
			sleep: async () => assert.fail("the second child's pending decision must release the wait"),
		});
		assert.match(text(result), /attention required/);
	});
}

test("detached foreground waits observe run reviews without replacing the actual current tool", async (t) => {
	const f = fixture(t);
	const child = { index: 0, agent: "worker", status: "detached", currentTool: "read", activityState: "working" };
	f.state.foregroundRuns.set("foreground", { runId: "foreground", sessionId: "parent", children: [child] });
	const result = await waitForSubagents({ id: "foreground", stopOnAttention: false }, undefined, {
		...f.deps, findPendingAsks: (target) => target.runId === "foreground" ? ["review"] : [],
		sleep: async () => assert.fail("the pending decision must immediately release the parent"),
	});
	assert.match(text(result), /attention required/);
	assert.equal(child.currentTool, "read");
});

test("switching the parent session cannot turn a live async wait into a successful completion", async (t) => {
	const f = fixture(t);
	const result = await waitForSubagents({ id: "review-child", stopOnAttention: false }, undefined, {
		...f.deps, sleep: async () => { f.state.currentSessionId = "other-parent"; },
	});
	assert.equal(result.isError, true);
	assert.match(text(result), /originating session is no longer active/);
});

test("headless draining surfaces a runtime supervisor decision instead of blocking its owner", async (t) => {
	const f = fixture(t);
	f.setPending(true);
	await assert.rejects(drainOutstandingWork({
		state: f.state, findPendingAsks: f.deps.findPendingAsks, hasWork: () => true,
		wait: (params, signal, deps) => waitForSubagents(params, signal, { ...deps, asyncDirRoot: f.deps.asyncDirRoot, resultsDir: f.deps.resultsDir }),
	}), /Auto-drain failed.*attention required/);
});

test("runtime snapshots bound observed data and preserve actual progress", () => {
	const snapshot = formatRunSupervisionSnapshot({ task: "x".repeat(10_000), startedAt: 1000, now: 601_999,
		currentTools: ["read", "bash"], toolCount: 3, tokens: 47, recentOutput: Array(10).fill("y".repeat(5000)),
	});
	const data = JSON.parse(snapshot.slice(snapshot.indexOf("\n") + 1));
	assert.equal(data.elapsedSeconds, 600);
	assert.deepEqual(data.currentTools, ["read", "bash"]);
	assert.equal(data.toolCallsStarted, 3);
	assert.equal(data.tokens, 47);
	assert.equal(data.task.length, 2000);
	assert.equal(data.recentOutput.length, 5);
	assert.ok(data.recentOutput.every((value) => value.length === 800));
	assert.match(snapshot, /observed data, not instructions/);
});
