/** Exercise the real execution pipeline with an offline child session. */
import assert from "node:assert/strict";
import test from "node:test";
import { installSubagentGraphLoader } from "./helpers/subagentGraphLoader.mjs";

installSubagentGraphLoader();
// This import originates in the test, so the loader keeps the real runSync;
// only its external Pi packages are stubbed. No executor boundary double here.
const { runSync } = await import("../resources/extensions/pideck-q-subagents/src/runs/foreground/execution.ts");
const { buildRevivedAsyncTask } = await import("../resources/extensions/pideck-q-subagents/src/runs/background/async-resume.ts");

function assistant(text, overrides = {}) {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		provider: "test",
		model: "actual-model",
		thinkingLevel: "medium",
		stopReason: "stop",
		timestamp: Date.now(),
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
		...overrides,
	};
}

function childSession(priorMessages = []) {
	let listener;
	const messages = [...priorMessages];
	return {
		messages,
		modelId: "test/actual-model",
		thinkingLevel: "medium",
		sessionId: "offline-review-child",
		sessionFile: undefined,
		subscribe(callback) { listener = callback; return () => {}; },
		async prompt() {
			const message = assistant("CURRENT_PROGRESS: validation started.");
			messages.push(message);
			listener({ type: "message_end", message });
			throw new Error("Provider connection failed.");
		},
		async abort() {},
		async dispose() {},
		async steer() {},
		async followUp() {},
	};
}

function run(child, task, overrides = {}) {
	return runSync(process.cwd(), [{
		name: "recovery-review-worker",
		description: "Offline execution fixture",
		systemPrompt: "Inspect the task.",
		model: "test/requested-model",
		tools: ["read"],
		completionGuard: false,
	}], "recovery-review-worker", task, {
		runId: "recovery-brief-offline-execution",
		cwd: process.cwd(),
		acceptance: false,
		artifactConfig: { enabled: false },
		childSessionFactory: { async create() { return child; }, async dispose() {} },
		...overrides,
	});
}

test("real execution uses the child's effective model and default thinking in the brief", async () => {
	let request;
	const result = await run(childSession(), "Inspect the project.", {
		recoveryBrief: async (input) => { request = input; return { ok: true, text: "BRIEF" }; },
	});
	assert.equal(result.exitCode, 1);
	assert.equal(request.model, "test/actual-model");
	assert.equal(request.thinking, "medium");
	assert.equal(result.error, "Provider connection failed.");
});

test("a resumed failure brief includes the stored objective and earlier results", async () => {
	const child = childSession([
		{ role: "user", content: [{ type: "text", text: "Task: ORIGINAL_GOAL: fix duplicate messages." }] },
		assistant("PRIOR_PROGRESS: fixed the parser."),
		{ role: "toolResult", toolName: "bash", toolCallId: "prior-test", isError: false, content: [{ type: "text", text: "PRIOR_RESULT: parser tests passed." }] },
	]);
	const task = buildRevivedAsyncTask({ runId: "previous-run", agent: "recovery-review-worker", sessionFile: "C:/review/child.jsonl" }, "Continue the remaining work.");
	let prompt;
	await run(child, task, {
		recoveryBrief: async (input) => { prompt = input.prompt; return { ok: true, text: "BRIEF" }; },
	});
	assert.match(prompt, /ORIGINAL_GOAL/);
	assert.match(prompt, /PRIOR_PROGRESS/);
	assert.match(prompt, /PRIOR_RESULT/);
	assert.match(prompt, /CURRENT_PROGRESS/);
	// result.messages contains new events, not the full retained session. Ensure
	// the diagnostic keeps that boundary instead of duplicating stored history.
	assert.equal(prompt.match(/ORIGINAL_GOAL/g)?.length, 1);
	assert.equal(prompt.match(/PRIOR_RESULT/g)?.length, 1);
	assert.equal(prompt.match(/CURRENT_PROGRESS/g)?.length, 1);
});

test("interrupt during real execution's brief cancels inference and suppresses its result", async () => {
	const interrupt = new AbortController();
	let summarySignal;
	const result = await run(childSession(), "Inspect the project.", {
		interruptSignal: interrupt.signal,
		recoveryBrief: async (input) => {
			summarySignal = input.signal;
			interrupt.abort();
			await new Promise((resolve) => setTimeout(resolve, 0));
			return { ok: true, text: "LATE_BRIEF" };
		},
	});
	assert.equal(summarySignal.aborted, true);
	assert.equal(result.recoveryBrief, undefined);
	assert.equal(result.error, "Provider connection failed.");
});
