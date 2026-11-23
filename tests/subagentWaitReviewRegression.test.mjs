import "./helpers/piFixtureResolver.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pideck-wait-review-"));
process.env.PI_SUBAGENTS_TEMP_ROOT = tempRoot;
after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
const { waitForSubagents } = await import("../resources/extensions/pideck-q-subagents/src/runs/background/subagent-wait.ts");
const { drainOutstandingWork } = await import("../resources/extensions/pideck-q-subagents/src/runs/background/auto-drain.ts");
const { updateActiveRunIndex } = await import("../resources/extensions/pideck-q-subagents/src/runs/background/active-run-index.ts");
const text = (result) => result.content.map((part) => part.text ?? "").join("\n");

/** Exercise real wait boundaries with isolated persisted async work and live foreground records. */
function fixture(t) {
	const root = fs.mkdtempSync(path.join(tempRoot, "case-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const child = { index: 0, agent: "worker", status: "detached", currentTool: "read", activityState: "working" };
	const run = { runId: "foreground", sessionId: "parent", mode: "single", cwd: root, updatedAt: 0, children: [child] };
	const state = { currentSessionId: "parent", asyncJobs: new Map(), foregroundControls: new Map(), foregroundRuns: new Map([[run.runId, run]]), foregroundWorkflows: new Map() };
	const deps = { state, asyncDirRoot: root, resultsDir: root, pollIntervalMs: 250 };
	return { root, child, run, state, deps };
}

function asyncRun(f) {
	const dir = path.join(f.root, "async-child");
	fs.mkdirSync(dir);
	const status = { version: 1, runId: "async-child", sessionId: "parent", mode: "single", state: "queued", startedAt: Date.now(), lastUpdate: Date.now(), steps: [{ agent: "worker", status: "pending" }] };
	const save = () => fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify(status));
	save();
	updateActiveRunIndex(dir, "queued");
	return { status, save };
}

function workflow(f) {
	const run = { runId: "workflow", sessionId: "parent", requests: new Map(), result: undefined,
		snapshot() { return this.result ?? { content: [{ type: "text", text: "WORKFLOW NEEDS A DECISION" }], details: { mode: "workflow", results: [] } }; },
	};
	f.state.foregroundWorkflows.set(run.runId, run);
	return run;
}

for (const all of [false, true]) {
	test(`${all ? "all" : "default"} wait includes detached foreground work without requiring an id`, async (t) => {
		const f = fixture(t);
		let sleeps = 0;
		const result = await waitForSubagents({ all }, undefined, { ...f.deps, sleep: async () => { sleeps++; f.child.status = "completed"; } });
		assert.equal(sleeps, 1);
		assert.notEqual(result.isError, true);
		assert.match(text(result), /foreground/);
		assert.doesNotMatch(text(result), /Nothing to wait for/);
	});
}

test("wait-all observes initially active async, provider, workflow and detached foreground work", async (t) => {
	const f = fixture(t);
	const async = asyncRun(f);
	const retained = workflow(f);
	let providerActive = true;
	let sleeps = 0;
	const result = await waitForSubagents({ all: true }, undefined, { ...f.deps,
		backgroundWork: { snapshot: () => ({ providers: ["provider"], items: providerActive ? [{ provider: "provider", id: "job", sessionId: "parent" }] : [] }), wakeChannels: () => [] },
		sleep: async () => {
			sleeps++;
			if (sleeps === 1) { async.status.state = "complete"; async.status.steps[0].status = "complete"; async.save(); }
			if (sleeps === 2) providerActive = false;
			if (sleeps === 3) retained.result = { content: [{ type: "text", text: "WORKFLOW FINISHED" }], details: { mode: "workflow", results: [] } };
			if (sleeps === 4) f.child.status = "completed";
			assert.ok(sleeps <= 4, "all four initial identities must settle");
		},
	});
	assert.equal(sleeps, 4);
	assert.match(text(result), /WORKFLOW FINISHED/);
	assert.match(text(result), /1 provider item\(s\) finished/);
	assert.match(text(result), /foreground/);
});

test("a rolling mixed wait returns on foreground completion while preserving active async work", async (t) => {
	const f = fixture(t);
	asyncRun(f);
	let sleeps = 0;
	const result = await waitForSubagents({}, undefined, { ...f.deps, sleep: async () => {
		assert.equal(++sleeps, 1, "the foreground completion must release this rolling wait");
		f.child.status = "completed";
	} });
	assert.match(text(result), /1 of 2 run\(s\) finished/);
	assert.match(text(result), /1 run\(s\) still in flight/);
});

for (const failed of [false, true]) {
	test(`mixed wait-all retains an observed ${failed ? "failed" : "successful"} foreground result after history eviction`, async (t) => {
		const f = fixture(t);
		const async = asyncRun(f);
		let sleeps = 0;
		const result = await waitForSubagents({ all: true }, undefined, { ...f.deps, failOnFailedRuns: true, sleep: async () => {
			if (++sleeps === 1) f.child.status = failed ? "failed" : "completed";
			else {
				f.state.foregroundRuns.delete(f.run.runId);
				async.status.state = "complete";
				async.status.steps[0].status = "complete";
				async.save();
			}
		} });
		assert.equal(sleeps, 2);
		assert.equal(result.isError === true, failed);
		assert.match(text(result), failed ? /foreground: 1 failed/ : /foreground: 1 completed/);
		assert.doesNotMatch(text(result), /disappeared/);
	});
}

test("a rolling fleet wait counts a workflow root once and continues through its child's completion", async (t) => {
	const f = fixture(t);
	const retained = workflow(f);
	f.state.foregroundControls.set(f.run.runId, { parentWorkflowRunId: retained.runId });
	let sleeps = 0;
	const result = await waitForSubagents({}, undefined, { ...f.deps, sleep: async () => {
		if (++sleeps === 1) f.child.status = "completed";
		else retained.result = { content: [{ type: "text", text: "LATER WORKFLOW STAGE FINISHED" }], details: { mode: "workflow", results: [] } };
	} });
	assert.equal(sleeps, 2);
	assert.match(text(result), /LATER WORKFLOW STAGE FINISHED/);
});

test("non-blocking detached subscriptions still resolve a prefix to one exact run without waiting", async (t) => {
	const f = fixture(t);
	const subscriptions = [];
	const result = await waitForSubagents({ id: "fore", nonBlocking: true, timeoutMs: 500 }, undefined, { ...f.deps,
		subscribe: (input) => { subscriptions.push(input); return { token: "subscription", expiresAt: 500 }; },
		sleep: async () => assert.fail("a durable subscription must return immediately"),
	});
	assert.deepEqual(subscriptions, [{ targetKind: "foreground", runId: f.run.runId, requestedId: "fore", timeoutMs: 500 }]);
	assert.match(text(result), /Armed wait subscription/);
});

test("aborting a fleet wait leaves detached children running", async (t) => {
	const f = fixture(t);
	const abort = new AbortController();
	const result = await waitForSubagents({ all: true }, abort.signal, { ...f.deps, sleep: async () => abort.abort() });
	assert.equal(result.isError, true);
	assert.match(text(result), /Wait aborted/);
	assert.equal(f.child.status, "detached");
});

for (const initiallyPending of [true, false]) {
	test(`a detached foreground supervisor request ${initiallyPending ? "already pending" : "arriving during wait"} releases wait-all`, async (t) => {
		const f = fixture(t);
		let pending = initiallyPending;
		let sleeps = 0;
		const result = await waitForSubagents({ all: true, stopOnAttention: false }, undefined, { ...f.deps,
			findPendingAsks: (target) => pending && target.runId === f.run.runId ? ["review"] : [],
			failOnAttention: true,
			sleep: async () => { assert.equal(++sleeps, 1); pending = true; },
		});
		assert.equal(sleeps, initiallyPending ? 0 : 1);
		assert.match(text(result), /attention required/);
		assert.equal(result.isError, true);
		assert.equal(f.child.status, "detached");
	});
}

test("a detached wait window reports exact active identities without stopping live children", async (t) => {
	const f = fixture(t);
	let now = 0;
	const result = await waitForSubagents({ all: true, timeoutMs: 250 }, undefined, { ...f.deps, now: () => now, sleep: async () => { now += 250; } });
	assert.equal(result.details.wait.reason, "window_elapsed");
	assert.deepEqual(result.details.wait.activeRunIds, [f.run.runId]);
	assert.notEqual(result.isError, true);
	assert.equal(f.child.status, "detached");
});

test("a rolling wait ignores detached work from other sessions and work started after the wait", async (t) => {
	const f = fixture(t);
	f.state.foregroundRuns.set("foreign", { ...f.run, runId: "foreign", sessionId: "other", children: [{ ...f.child }] });
	const result = await waitForSubagents({ all: true }, undefined, { ...f.deps, sleep: async () => {
		f.state.foregroundRuns.set("later", { ...f.run, runId: "later", children: [{ ...f.child }] });
		f.child.status = "completed";
	} });
	assert.match(text(result), /foreground/);
	assert.doesNotMatch(text(result), /foreign|later/);
	assert.equal(f.state.foregroundRuns.get("foreign").children[0].status, "detached");
});

for (const change of ["session", "run", "child"]) {
	test(`detached waiting fails safely when its originating ${change} disappears`, async (t) => {
		const f = fixture(t);
		const result = await waitForSubagents({ all: true }, undefined, { ...f.deps, sleep: async () => {
			if (change === "session") f.state.currentSessionId = "other";
			else if (change === "run") f.state.foregroundRuns.delete(f.run.runId);
			else f.run.children = [];
		} });
		assert.equal(result.isError, true);
		assert.match(text(result), change === "session" ? /originating session|active session changed/ : /Completion cannot be confirmed|completion cannot be confirmed/);
	});
}

for (const targeted of [false, true]) {
	test(`${targeted ? "targeted" : "all"} detached waiting honors the terminal failure policy`, async (t) => {
		const f = fixture(t);
		const result = await waitForSubagents(targeted ? { id: f.run.runId } : { all: true }, undefined, { ...f.deps, failOnFailedRuns: true,
			sleep: async () => { f.child.status = "failed"; f.child.error = "TOOL DEADLINE EXPIRED"; },
		});
		assert.equal(result.isError, true);
		assert.match(text(result), /failed/);
	});
}

test("headless auto-drain waits for detached foreground work before ending the turn", async (t) => {
	const f = fixture(t);
	let waits = 0;
	await drainOutstandingWork({ state: f.state, wait: (params, signal, deps) => {
		waits++;
		return waitForSubagents(params, signal, { ...f.deps, ...deps, sleep: async () => { f.child.status = "completed"; } });
	} });
	assert.equal(waits, 1);
	assert.equal(f.child.status, "completed");
});

test("headless auto-drain reports a detached foreground failure", async (t) => {
	const f = fixture(t);
	await assert.rejects(drainOutstandingWork({ state: f.state, wait: (params, signal, deps) => waitForSubagents(params, signal, {
		...f.deps, ...deps, sleep: async () => { f.child.status = "failed"; },
	}) }), /Auto-drain failed.*failed/);
});

test("headless auto-drain keeps a retained foreground workflow and surfaces its supervisor request", async (t) => {
	const f = fixture(t);
	f.state.foregroundRuns.clear();
	const retained = workflow(f);
	retained.requests.set("decision", { requestId: "decision" });
	await assert.rejects(drainOutstandingWork({ state: f.state, wait: (params, signal, deps) => waitForSubagents(params, signal, { ...f.deps, ...deps }) }), /Auto-drain failed.*WORKFLOW NEEDS A DECISION/);
});
