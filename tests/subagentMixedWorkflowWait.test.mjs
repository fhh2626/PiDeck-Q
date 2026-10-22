import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { waitForSubagents } from "../resources/extensions/pideck-q-subagents/src/runs/background/subagent-wait.ts";
import { updateActiveRunIndex } from "../resources/extensions/pideck-q-subagents/src/runs/background/active-run-index.ts";
import { recordWaitCompletion } from "../resources/extensions/pideck-q-subagents/src/runs/background/wait-completions.ts";
import { registerBackgroundWorkProvider } from "../resources/extensions/pideck-q-subagents/src/api/background-work.ts";

/** Isolated persisted async status plus a retained foreground VM in the same session. */
function fixture(t) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pideck-mixed-wait-test-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const asyncDir = path.join(root, "async-child");
	fs.mkdirSync(asyncDir);
	const status = { version: 1, runId: "async-child", sessionId: "parent", mode: "single", state: "queued", startedAt: Date.now(), lastUpdate: Date.now(), steps: [{ agent: "readonly", status: "pending" }] };
	const save = () => fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify(status));
	save();
	updateActiveRunIndex(asyncDir, "queued");
	const workflow = { runId: "foreground", sessionId: "parent", requests: new Map(), result: undefined, snapshot() { return this.result ?? { content: [{ type: "text", text: "CURRENT SUPERVISOR QUESTION" }], details: { mode: "workflow", results: [] } }; } };
	const state = { currentSessionId: "parent", asyncJobs: new Map(), foregroundControls: new Map(), foregroundRuns: new Map(), foregroundWorkflows: new Map([[workflow.runId, workflow]]) };
	return { root, status, save, workflow, state };
}

for (const failed of [false, true]) {
	test(`wait-all preserves the ${failed ? "failed" : "successful"} async completion alongside foreground output`, async (t) => {
		const f = fixture(t);
		const result = await waitForSubagents({ all: true, timeoutMs: 1000 }, undefined, {
			state: f.state, asyncDirRoot: f.root, resultsDir: f.root, failOnFailedRuns: true,
			sleep: async () => {
				f.status.state = failed ? "failed" : "complete";
				f.status.steps[0].status = failed ? "failed" : "complete";
				if (failed) f.status.error = "ASYNC FAILURE";
				f.save();
				recordWaitCompletion(f.state, "async-child", { mode: "single", success: !failed, results: [{ agent: "readonly", success: !failed, usage: { input: 11, output: 7, cacheRead: 0, cacheWrite: 0, cost: 0.01, turns: 1 } }] }, Date.now(), 60_000);
				f.workflow.result = { content: [{ type: "text", text: "FOREGROUND OUTPUT" }], details: { mode: "workflow", results: [] } };
			},
		});
		assert.equal(result.isError === true, failed);
		assert.equal(result.details.completions.length, 1);
		assert.equal(result.details.completions[0].runId, "async-child");
		assert.equal(result.details.completions[0].success, !failed);
		assert.equal(result.usage.input, 11);
		assert.equal(result.usage.output, 7);
		const text = result.content.map((part) => part.text ?? "").join("\n");
		assert.match(text, /FOREGROUND OUTPUT/);
		assert.match(text, failed ? /1 failed/ : /1 complete/);
	});
}

test("mixed rolling wait reports foreground output without claiming an async task has finished", async (t) => {
	const f = fixture(t);
	const result = await waitForSubagents({ timeoutMs: 1000 }, undefined, {
		state: f.state, asyncDirRoot: f.root, resultsDir: f.root,
		sleep: async () => { f.workflow.result = { content: [{ type: "text", text: "FOREGROUND FIRST" }], details: { mode: "workflow", results: [] } }; },
	});
	const text = result.content.map((part) => part.text ?? "").join("\n");
	assert.match(text, /FOREGROUND FIRST/);
	assert.match(text, /1 of 2 run\(s\) finished/);
	assert.match(text, /1 run\(s\) still in flight/);
});

test("a mixed wait retains terminal failure evidence when a foreground decision also needs attention", async (t) => {
	const f = fixture(t);
	const result = await waitForSubagents({ all: true, stopOnAttention: false, timeoutMs: 1000 }, undefined, {
		state: f.state, asyncDirRoot: f.root, resultsDir: f.root, failOnFailedRuns: true,
		sleep: async () => {
			f.status.state = "failed";
			f.status.steps[0].status = "failed";
			f.save();
			recordWaitCompletion(f.state, "async-child", { mode: "single", success: false }, Date.now(), 60_000);
			f.workflow.requests.set("decision", { requestId: "decision" });
		},
	});
	assert.equal(result.isError, true);
	assert.equal(result.details.completions[0].success, false);
	assert.match(result.content.map((part) => part.text ?? "").join("\n"), /CURRENT SUPERVISOR QUESTION/);
});

test("mixed wait-all preserves a provider completion alongside the retained foreground VM", async (t) => {
	let active = true;
	const release = registerBackgroundWorkProvider({ name: "mixed-wait-fixture", listActiveWork: () => active ? [{ id: "provider-job", sessionId: "parent" }] : [] });
	t.after(release);
	const workflow = { runId: "foreground", sessionId: "parent", requests: new Map(), result: undefined, snapshot() { return this.result; } };
	const state = { currentSessionId: "parent", asyncJobs: new Map(), foregroundControls: new Map(), foregroundRuns: new Map(), foregroundWorkflows: new Map([[workflow.runId, workflow]]) };
	const result = await waitForSubagents({ all: true, timeoutMs: 1000 }, undefined, {
		state, sleep: async () => {
			active = false;
			workflow.result = { content: [{ type: "text", text: "PROVIDER MIXED FOREGROUND OUTPUT" }], details: { mode: "workflow", results: [] } };
		},
	});
	const text = result.content.map((part) => part.text ?? "").join("\n");
	assert.match(text, /1 provider item\(s\) finished/);
	assert.equal(result.isError, undefined);
	assert.match(text, /PROVIDER MIXED FOREGROUND OUTPUT/);
});
