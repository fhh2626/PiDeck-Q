/**
 * Contract tests for the subagent recovery brief.
 *
 * A child that ends abnormally hands the parent one concise, evidence-based
 * brief so the parent can decide whether to continue or correct the SAME child
 * session. These tests pin the pieces that must stay honest:
 *   - the approved prompt text is used verbatim,
 *   - evidence spans the whole task (not just the tail) and never leaks
 *     thinking blocks,
 *   - the trigger guard never fires on success, explicit stop, detach, or
 *     parent cancellation,
 *   - a failed/timed-out/budget-blocked inference degrades to a deterministic
 *     evidence brief and never alters the original failure,
 *   - continuation advice only promises a resume when the run is resumable.
 *
 * Everything here is offline: the model call is an injected double.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const promptModule = loadTsCommonJs(
	"resources/extensions/pideck-q-subagents/src/runs/shared/recovery-brief-prompt.ts",
);
const evidenceModule = loadTsCommonJs(
	"resources/extensions/pideck-q-subagents/src/runs/shared/recovery-brief-evidence.ts",
);
const briefModule = loadTsCommonJs(
	"resources/extensions/pideck-q-subagents/src/runs/shared/recovery-brief.ts",
);

const {
	RECOVERY_BRIEF_PROMPT_TEMPLATE,
	buildRecoveryBriefPrompt,
} = promptModule;
const {
	buildRecoveryBriefEvidence,
	RECOVERY_BRIEF_RECENT_TOOL_LIMIT,
	RECOVERY_BRIEF_HISTORY_BUDGET_CHARS,
} = evidenceModule;
const {
	shouldGenerateRecoveryBrief,
	deterministicRecoveryBrief,
	applyRecoveryBrief,
	recoveryBriefRequest,
	foldRecoveryBriefUsage,
	formatRecoveryBriefBlock,
} = briefModule;

// ── fixtures ────────────────────────────────────────────────────────────────

function assistant(text, toolCalls = []) {
	return {
		role: "assistant",
		content: [
			...(text ? [{ type: "text", text }] : []),
			// Thinking blocks must never reach the brief evidence.
			{ type: "thinking", text: "SECRET_CHAIN_OF_THOUGHT" },
			...toolCalls.map((call) => ({
				type: "toolCall",
				id: call.id,
				name: call.name,
				arguments: call.arguments ?? {},
			})),
		],
	};
}

function toolResult(toolCallId, toolName, text, isError = false) {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		isError,
		content: [{ type: "text", text }],
	};
}

function baseEvidenceInput(overrides = {}) {
	return {
		task: "Fix duplicated messages after session resume.",
		agent: "worker",
		exitCode: 1,
		error: "Provider transport aborted.",
		model: "anthropic/claude-sonnet-4",
		thinking: "high",
		messages: [
			{ role: "user", content: [{ type: "text", text: "Fix duplicated messages after session resume." }] },
			assistant("EARLY_MILESTONE: reproduced the duplicate message bug.", [
				{ id: "t1", name: "read", arguments: { path: "src/sessions/resume.ts" } },
			]),
			toolResult("t1", "read", "resume.ts contents"),
			assistant("MID_MILESTONE: patched the merge guard.", [
				{ id: "t2", name: "edit", arguments: { path: "src/sessions/resume.ts" } },
			]),
			toolResult("t2", "edit", "edit applied"),
			assistant("LATE_MILESTONE: regression test still failing.", [
				{ id: "t3", name: "bash", arguments: { command: "npm test" } },
			]),
			toolResult("t3", "bash", "2 tests failed", true),
		],
		recentTools: [
			{ tool: "read", args: "src/sessions/resume.ts" },
			{ tool: "edit", args: "src/sessions/resume.ts" },
			{ tool: "bash", args: "npm test", isError: true },
		],
		progressSummary: { toolCount: 3, tokens: 1200, durationMs: 90_000 },
		sessionFile: "C:/sessions/child.jsonl",
		transcriptPath: "C:/artifacts/child-transcript.jsonl",
		artifactPaths: { outputPath: "C:/artifacts/output.txt" },
		...overrides,
	};
}

// ── prompt ──────────────────────────────────────────────────────────────────

test("the recovery brief prompt is the approved text verbatim", () => {
	const template = RECOVERY_BRIEF_PROMPT_TEMPLATE;

	assert.ok(
		template.startsWith("You are writing a recovery brief for a subagent task that ended abnormally."),
		"the approved opening sentence must be preserved",
	);
	for (const requirement of [
		"1. Summarize the entire task.",
		"2. Describe outcomes precisely.",
		"3. Describe the interruption point.",
		"4. Support continuation.",
		"5. Keep the brief focused.",
	]) {
		assert.ok(template.includes(requirement), `missing approved requirement: ${requirement}`);
	}
	assert.ok(
		template.includes("Prefer the language used in the parent agent's recent conversation."),
		"language must stay a single advisory sentence",
	);
	assert.ok(
		template.trimEnd().endsWith(
			"The host will append authoritative run IDs, session paths, log paths,\nand continuation instructions.",
		),
		"the approved closing sentence must be preserved",
	);
	assert.ok(
		template.includes("### Unconfirmed: outcomes requiring additional evidence.")
		|| template.includes("- Unconfirmed: outcomes requiring additional evidence."),
		"the approved output structure must keep the unconfirmed category",
	);

	// The rejected earlier drafts must not come back.
	assert.equal(template.includes("not just its final moments"), false);
	assert.equal(template.includes("Do not continue the original task"), false);
	assert.equal(template.includes("Do not reproduce private chain-of-thought"), false);
});

test("buildRecoveryBriefPrompt substitutes every section and leaves no placeholder", () => {
	const prompt = buildRecoveryBriefPrompt({
		originalTask: "TASK_TEXT",
		terminationInfo: "TERMINATION_TEXT",
		executionHistory: "HISTORY_TEXT",
		recentToolCalls: "RECENT_TOOLS_TEXT",
		recoveryReferences: "REFERENCES_TEXT",
	});

	for (const value of [
		"TASK_TEXT",
		"TERMINATION_TEXT",
		"HISTORY_TEXT",
		"RECENT_TOOLS_TEXT",
		"REFERENCES_TEXT",
	]) {
		assert.ok(prompt.includes(value), `prompt must embed ${value}`);
	}
	assert.equal(/\{(?:originalTask|terminationInfo|executionHistory|recentToolCalls|recoveryReferences)\}/.test(prompt), false);
	assert.ok(prompt.includes("<original_task>\nTASK_TEXT\n</original_task>"));
	assert.ok(prompt.includes("<recent_tool_calls>\nRECENT_TOOLS_TEXT\n</recent_tool_calls>"));
});

// ── trigger guard ───────────────────────────────────────────────────────────

test("the brief is generated only for abnormal terminations with real execution", () => {
	const base = {
		exitCode: 1,
		error: "boom",
		messageCount: 4,
		toolCount: 2,
		turns: 1,
	};

	assert.equal(shouldGenerateRecoveryBrief(base), true, "a runtime error after real work must qualify");
	assert.equal(
		shouldGenerateRecoveryBrief({ ...base, exitCode: 0, error: undefined, timedOut: true }),
		true,
		"a timeout must qualify even without an error string",
	);
	assert.equal(
		shouldGenerateRecoveryBrief({ ...base, exitCode: 0, error: undefined }),
		false,
		"a clean success must not qualify",
	);
	assert.equal(shouldGenerateRecoveryBrief({ ...base, stopped: true }), false, "an explicit stop must not qualify");
	assert.equal(shouldGenerateRecoveryBrief({ ...base, interrupted: true }), false, "an explicit interrupt must not qualify");
	assert.equal(shouldGenerateRecoveryBrief({ ...base, detached: true }), false, "a still-live detach receipt must not qualify");
	assert.equal(shouldGenerateRecoveryBrief({ ...base, aborted: true }), false, "parent cancellation must not qualify");
	assert.equal(
		shouldGenerateRecoveryBrief({ ...base, messageCount: 0, toolCount: 0, turns: 0 }),
		false,
		"a prelaunch/no-work failure must not qualify",
	);
});

// ── evidence ────────────────────────────────────────────────────────────────

test("evidence covers the whole task instead of only its tail", () => {
	const evidence = buildRecoveryBriefEvidence(baseEvidenceInput());
	const history = evidence.executionHistory;

	assert.ok(history.includes("EARLY_MILESTONE"), "early progress must survive");
	assert.ok(history.includes("MID_MILESTONE"), "mid progress must survive");
	assert.ok(history.includes("LATE_MILESTONE"), "late progress must survive");
	assert.ok(history.includes("2 tests failed"), "tool results must be summarized");
	assert.ok(history.includes("npm test"), "tool calls must be summarized");
	assert.equal(history.includes("SECRET_CHAIN_OF_THOUGHT"), false, "thinking blocks must never leak");
	assert.equal(evidence.originalTask, "Fix duplicated messages after session resume.");
	assert.ok(evidence.terminationInfo.includes("Provider transport aborted."));
	assert.ok(evidence.recoveryReferences.includes("C:/sessions/child.jsonl"));
	assert.ok(evidence.recoveryReferences.includes("C:/artifacts/child-transcript.jsonl"));
});

test("recent tool details use the tail while the history keeps earlier tools", () => {
	const messages = [];
	const recentTools = [];
	for (let index = 0; index < 24; index++) {
		const id = `c${index}`;
		messages.push(assistant(`STEP_${index}`, [{ id, name: `tool_${index}`, arguments: { n: index } }]));
		messages.push(toolResult(id, `tool_${index}`, `result_${index}`));
		recentTools.push({ tool: `tool_${index}`, args: `n=${index}` });
	}

	const evidence = buildRecoveryBriefEvidence(baseEvidenceInput({ messages, recentTools }));
	const recentLines = evidence.recentToolCalls.split("\n").filter(Boolean);

	assert.ok(recentLines.length <= RECOVERY_BRIEF_RECENT_TOOL_LIMIT, "recent tool section stays bounded");
	assert.ok(evidence.recentToolCalls.includes("tool_23"), "the newest tool must be present");
	assert.equal(evidence.recentToolCalls.includes("tool_0 "), false, "old tools must not flood the recent section");
	assert.ok(evidence.executionHistory.includes("STEP_0"), "the earliest step must still be summarized");
	assert.ok(evidence.executionHistory.includes("STEP_23"), "the latest step must still be summarized");
});

test("a huge transcript is bounded and marks what it dropped", () => {
	const messages = [];
	for (let index = 0; index < 400; index++) {
		messages.push(assistant(`PHASE_${index} ` + "x".repeat(400)));
	}
	const evidence = buildRecoveryBriefEvidence(baseEvidenceInput({ messages }));

	assert.ok(
		evidence.executionHistory.length <= RECOVERY_BRIEF_HISTORY_BUDGET_CHARS + 2_000,
		"history must stay within its budget",
	);
	assert.equal(evidence.truncated, true, "dropping evidence must be reported");
	assert.match(evidence.executionHistory, /omitted/i, "the omission must be visible in the evidence");
	assert.ok(evidence.executionHistory.includes("PHASE_0 "), "the first phase must be retained");
	assert.ok(evidence.executionHistory.includes("PHASE_399"), "the last phase must be retained");
	assert.ok(evidence.coveredPhases >= 2, "coverage must span multiple phases");
});

// ── deterministic fallback ──────────────────────────────────────────────────

test("recent tools carry their outcomes, including the end of long validation output", () => {
	const evidence = buildRecoveryBriefEvidence(baseEvidenceInput({
		messages: [
			assistant("Running validation.", [{ id: "check", name: "bash", arguments: { command: "npm test" } }]),
			toolResult("check", "bash", "verbose output\n".repeat(80) + "FINAL_RESULT: 2 tests failed", true),
		],
	}));
	assert.match(evidence.recentToolCalls, /npm test/);
	assert.match(evidence.recentToolCalls, /FINAL_RESULT: 2 tests failed/);
	assert.match(evidence.recentToolCalls, /tool-error/);
	assert.match(evidence.executionHistory, /FINAL_RESULT: 2 tests failed/);
});

test("the outer brief deadline preserves usage reported while aborting", async () => {
	const usage = { input: 4, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0.05 };
	const result = { exitCode: 1, error: "failed", messages: [assistant("Changed a file.")] };
	const applied = await applyRecoveryBrief({
		result,
		evidenceInput: baseEvidenceInput(),
		deadlineMs: 10,
		generator: ({ signal }) => new Promise((resolve) => {
			signal.addEventListener("abort", () => resolve({ ok: false, reason: "aborted", usage }), { once: true });
		}),
	});
	assert.equal(applied.brief.source, "fallback");
	assert.equal(applied.brief.reason, "deadline-exceeded");
	assert.deepEqual(applied.usage, usage);
});

test("the deterministic brief states only observable evidence", () => {
	const evidence = buildRecoveryBriefEvidence(baseEvidenceInput());
	const text = deterministicRecoveryBrief(evidence);

	assert.ok(text.includes("Fix duplicated messages after session resume."), "objective must be present");
	assert.ok(text.includes("Provider transport aborted."), "termination reason must be present");
	assert.ok(text.includes("npm test"), "recent tool must be present");
	assert.ok(text.includes("C:/sessions/child.jsonl"), "session reference must be present");
	assert.equal(text.includes("SECRET_CHAIN_OF_THOUGHT"), false);
});

// ── apply ───────────────────────────────────────────────────────────────────

const ABNORMAL_RESULT = {
	exitCode: 1,
	error: "Provider transport aborted.",
	model: "anthropic/claude-sonnet-4",
	thinking: "high",
	messages: [{ role: "assistant", content: [{ type: "text", text: "did work" }] }],
	usage: { turns: 1 },
	progressSummary: { toolCount: 2 },
};

test("a successful inference produces a model-sourced brief with the child's model and thinking", async () => {
	const calls = [];
	const applied = await applyRecoveryBrief({
		result: ABNORMAL_RESULT,
		evidenceInput: baseEvidenceInput(),
		generator: async (request) => {
			calls.push(request);
			return { ok: true, text: "  MODEL_BRIEF  " };
		},
	});

	assert.equal(calls.length, 1, "exactly one inference must run");
	assert.equal(calls[0].model, "anthropic/claude-sonnet-4", "the child's effective model must be used");
	assert.equal(calls[0].thinking, "high", "the child's effective thinking level must be used");
	assert.ok(calls[0].prompt.includes("<original_task>"), "the approved prompt must be sent");
	assert.equal(applied.brief.source, "model");
	assert.equal(applied.brief.text, "MODEL_BRIEF");
	assert.equal(applied.brief.model, "anthropic/claude-sonnet-4");
	assert.equal(applied.brief.thinking, "high");
	assert.equal(applied.usage, undefined, "no usage was reported by this generator");
});

test("the model brief reports the inference's actual model and thinking, not the child's declaration", async () => {
	const applied = await applyRecoveryBrief({
		result: ABNORMAL_RESULT,
		evidenceInput: baseEvidenceInput(),
		generator: async () => ({ ok: true, text: "MODEL_BRIEF", model: "openai/gpt-5", thinking: "low" }),
	});

	assert.equal(applied.brief.model, "openai/gpt-5");
	assert.equal(applied.brief.thinking, "low");
});

test("a failed, empty or timed-out inference degrades to the deterministic brief", async () => {
	for (const generator of [
		async () => ({ ok: false, reason: "model-unavailable" }),
		async () => ({ ok: true, text: "   " }),
		async () => {
			throw new Error("inference timed out");
		},
	]) {
		const applied = await applyRecoveryBrief({
			result: ABNORMAL_RESULT,
			evidenceInput: baseEvidenceInput(),
			generator,
		});
		assert.equal(applied.brief.source, "fallback");
		assert.ok(applied.brief.reason, "the fallback must record why the model brief is missing");
		assert.ok(applied.brief.text.includes("Fix duplicated messages after session resume."));
	}
});

test("a failed inference keeps the usage it already reported", async () => {
	const usage = { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, cost: 0.25 };
	const applied = await applyRecoveryBrief({
		result: ABNORMAL_RESULT,
		evidenceInput: baseEvidenceInput(),
		generator: async () => ({ ok: false, reason: "inference timed out", usage }),
	});

	assert.equal(applied.brief.source, "fallback");
	assert.equal(applied.brief.reason, "inference timed out");
	assert.deepEqual(applied.brief.usage, usage);
	assert.deepEqual(applied.usage, usage, "the application must expose usage for accounting");
});

test("a configured usage budget skips inference and keeps the deterministic brief", async () => {
	let invoked = false;
	const applied = await applyRecoveryBrief({
		result: ABNORMAL_RESULT,
		evidenceInput: baseEvidenceInput(),
		generator: async () => {
			invoked = true;
			return { ok: true, text: "MODEL_BRIEF" };
		},
		inferenceBudgetConfigured: true,
	});

	assert.equal(invoked, false, "no inference may run when a usage budget governs the run");
	assert.equal(applied.brief.source, "fallback");
	assert.equal(applied.brief.reason, "usage-budget-configured");
});

test("cancellation and non-triggering results never invoke inference", async () => {
	let invoked = 0;
	const generator = async () => {
		invoked += 1;
		return { ok: true, text: "MODEL_BRIEF" };
	};

	const aborted = await applyRecoveryBrief({
		result: ABNORMAL_RESULT,
		evidenceInput: baseEvidenceInput(),
		generator,
		aborted: true,
	});
	assert.equal(aborted.brief, undefined, "a cancelled run gets no brief");
	assert.equal(aborted.usage, undefined, "a cancelled run spends nothing");
	assert.equal(invoked, 0);

	const succeeded = await applyRecoveryBrief({
		result: { ...ABNORMAL_RESULT, exitCode: 0, error: undefined },
		evidenceInput: baseEvidenceInput(),
		generator,
	});
	assert.equal(succeeded.brief, undefined, "a successful run gets no brief");
	assert.equal(succeeded.usage, undefined, "a successful run spends nothing");
	assert.equal(invoked, 0, "no inference may run for a successful run");
});

test("a detached authoritative completion never invokes inference", async () => {
	let invoked = 0;
	const applied = await applyRecoveryBrief({
		result: ABNORMAL_RESULT,
		evidenceInput: baseEvidenceInput(),
		generator: async () => {
			invoked += 1;
			return { ok: true, text: "MODEL_BRIEF" };
		},
		detached: true,
	});

	assert.equal(applied.brief, undefined, "a detached run gets no brief");
	assert.equal(invoked, 0, "no inference may run for a detached run");
});

test("a successful run never builds evidence for the discarded brief", async () => {
	// A throwing iterator makes any O(messages) flatten fail loudly. The trigger
	// guard must reject the run before evidence is rendered.
	const messages = [{ role: "assistant", content: [] }];
	Object.defineProperty(messages, Symbol.iterator, {
		value() {
			throw new Error("evidence was built for a successful run");
		},
	});
	const applied = await applyRecoveryBrief({
		result: { exitCode: 0, messages, usage: { turns: 1 } },
		evidenceInput: { task: "TASK", exitCode: 0, messages },
	});
	assert.equal(applied.brief, undefined);
	assert.equal(applied.usage, undefined);
});

test("cancellation during inference aborts the generator and suppresses the late brief", async () => {
	const controller = new AbortController();
	const usage = { input: 7, output: 3, cacheRead: 0, cacheWrite: 0, cost: 0.1 };
	let signalStarted;
	const started = new Promise((resolve) => { signalStarted = resolve; });
	const pending = applyRecoveryBrief({
		result: ABNORMAL_RESULT,
		evidenceInput: baseEvidenceInput(),
		signal: controller.signal,
		generator: async (request) => {
			signalStarted();
			await new Promise((resolve) => request.signal.addEventListener("abort", resolve, { once: true }));
			return { ok: false, reason: "aborted", usage };
		},
	});
	await started;
	controller.abort();
	const applied = await pending;

	assert.equal(applied.brief, undefined, "a late brief must never be attached after cancellation");
	assert.deepEqual(applied.usage, usage, "usage reported before cancellation must be preserved");
});

test("the whole summary lifecycle is bounded even when the generator hangs", async () => {
	const applied = await applyRecoveryBrief({
		result: ABNORMAL_RESULT,
		evidenceInput: baseEvidenceInput(),
		deadlineMs: 20,
		generator: () => new Promise(() => {}),
	});

	assert.equal(applied.brief.source, "fallback");
	assert.equal(applied.brief.reason, "deadline-exceeded");
});

test("recoveryBriefRequest maps the production result onto the evidence request", () => {
	const controller = new AbortController();
	const generator = async () => ({ ok: true, text: "X" });
	const request = recoveryBriefRequest({
		task: "TASK",
		agent: "worker",
		exitCode: 1,
		error: "boom",
		timedOut: true,
		model: "anthropic/claude-sonnet-4",
		thinking: "high",
		messages: [{ role: "assistant", content: [] }],
		progress: { recentTools: [{ tool: "read", args: "src/a.ts" }] },
		progressSummary: { toolCount: 2, tokens: 3, durationMs: 4 },
		attemptedModels: ["a", "b"],
		sessionFile: "session.jsonl",
		transcriptPath: "transcript.jsonl",
		artifactPaths: { outputPath: "output.txt", metadataPath: "metadata.json", transcriptPath: "artifact-transcript.jsonl" },
	}, { generator, usageBudgetConfigured: true, signal: controller.signal, deadlineMs: 1234 });

	assert.equal(request.result.task, "TASK");
	assert.equal(request.evidenceInput.task, "TASK");
	assert.equal(request.evidenceInput.agent, "worker");
	assert.equal(request.evidenceInput.error, "boom");
	assert.equal(request.evidenceInput.timedOut, true);
	assert.equal(request.evidenceInput.model, "anthropic/claude-sonnet-4");
	assert.equal(request.evidenceInput.thinking, "high");
	assert.equal(request.evidenceInput.messages, request.result.messages);
	assert.equal(request.evidenceInput.recentTools, request.result.progress.recentTools);
	assert.equal(request.evidenceInput.progressSummary, request.result.progressSummary);
	assert.deepEqual(request.evidenceInput.attemptedModels, ["a", "b"]);
	assert.equal(request.evidenceInput.sessionFile, "session.jsonl");
	assert.equal(request.evidenceInput.transcriptPath, "transcript.jsonl");
	assert.deepEqual(request.evidenceInput.artifactPaths, request.result.artifactPaths);
	assert.equal(request.generator, generator);
	assert.equal(request.inferenceBudgetConfigured, true);
	assert.equal(request.signal, controller.signal);
	assert.equal(request.deadlineMs, 1234);
	assert.equal(request.aborted, undefined);

	controller.abort();
	const aborted = recoveryBriefRequest({ task: "TASK", exitCode: 1 }, { signal: controller.signal });
	assert.equal(aborted.aborted, true, "an already-aborted signal must be forwarded as cancellation");

	const detached = recoveryBriefRequest({ task: "TASK", exitCode: 1 }, { detached: true });
	assert.equal(detached.detached, true, "a detached authoritative completion must be forwarded as detached");
});

test("recovery evidence retains earlier attempts without changing the final task output", async () => {
	const earlier = [assistant("EARLIER_ATTEMPT: fixed parsing."), toolResult("t1", "bash", "parser tests passed")];
	const final = [assistant("FINAL_ATTEMPT: transport failed during UI validation.")];
	const result = {
		...baseEvidenceInput(),
		messages: final,
		usage: { turns: 2 },
	};
	let prompt = "";
	await applyRecoveryBrief(recoveryBriefRequest(result, {
		attemptMessages: [earlier, final],
		generator: async (request) => {
			prompt = request.prompt;
			return { ok: true, text: "BRIEF" };
		},
	}));
	assert.match(prompt, /EARLIER_ATTEMPT/);
	assert.match(prompt, /parser tests passed/);
	assert.match(prompt, /FINAL_ATTEMPT/);
	assert.equal(result.messages, final, "original result stays scoped to its final attempt");
});

test("foldRecoveryBriefUsage adds tokens and cost once and never adds turns", () => {
	const target = { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: 5, turns: 6 };
	assert.equal(foldRecoveryBriefUsage(target, { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, cost: 0.5 }), true);
	assert.deepEqual(target, { input: 11, output: 22, cacheRead: 33, cacheWrite: 44, cost: 5.5, turns: 6 });
	assert.equal(foldRecoveryBriefUsage(target, undefined), false);
	assert.deepEqual(target, { input: 11, output: 22, cacheRead: 33, cacheWrite: 44, cost: 5.5, turns: 6 });
});

test("applying a brief never mutates the original failure", async () => {
	const result = { ...ABNORMAL_RESULT };
	const snapshot = JSON.parse(JSON.stringify(result));
	const applied = await applyRecoveryBrief({
		result,
		evidenceInput: baseEvidenceInput(),
		generator: async () => ({ ok: true, text: "MODEL_BRIEF" }),
	});
	assert.ok(applied.brief);
	assert.deepEqual(result, snapshot, "the original error/exitCode/output must stay untouched");
});

test("the phase omission marker counts only records that are truly omitted", () => {
	const messages = (count) => Array.from({ length: count }, (_, index) => ({
		role: "assistant",
		content: [{ type: "text", text: `P${index}:` + "x".repeat(596) }],
	}));

	// 24 entries / 6 phases = 4 per phase; three fit the 2,000-char phase budget,
	// so the fourth is dropped and re-appended as the newest record. Nothing is
	// actually omitted, so neither the marker nor the truncation note may appear.
	const keepsLast = buildRecoveryBriefEvidence(baseEvidenceInput({ messages: messages(24) }));
	assert.equal(keepsLast.truncated, false);
	assert.equal(keepsLast.executionHistory.includes("omitted"), false);

	// 30 entries / 6 phases = 5 per phase; three fit, two are dropped, one of
	// those is re-appended, so exactly one record is omitted per phase.
	const omitsOne = buildRecoveryBriefEvidence(baseEvidenceInput({ messages: messages(30) }));
	assert.equal(omitsOne.truncated, true);
	assert.match(omitsOne.executionHistory, /\[\.\.\. 1 record\(s\) omitted from this phase \.\.\.\]/);
	assert.equal(omitsOne.executionHistory.includes("2 record(s) omitted"), false);
});

// ── formatting ──────────────────────────────────────────────────────────────

const BRIEF = { text: "## Subagent Recovery Brief\n\nBRIEF_BODY", source: "model" };
const REFERENCES = {
	runId: "run-123",
	sessionFile: "C:/sessions/child.jsonl",
	transcriptPath: "C:/artifacts/transcript.jsonl",
};

test("the resumable block carries authoritative references and a real resume instruction", () => {
	const block = formatRecoveryBriefBlock(BRIEF, {
		references: REFERENCES,
		resumability: { state: "resumable" },
	});

	assert.ok(block.includes("BRIEF_BODY"));
	assert.ok(block.includes("run-123"));
	assert.ok(block.includes("C:/sessions/child.jsonl"));
	assert.ok(block.includes("C:/artifacts/transcript.jsonl"));
	assert.ok(block.includes('action: "resume"'), "the parent must be told how to continue the same child");
	assert.ok(block.includes("same child session"), "resume must be described as continuing the same child session");
	assert.equal(/cannot be resumed/i.test(block), false);
});

test("the non-resumable block refuses to promise a continuation", () => {
	const block = formatRecoveryBriefBlock(BRIEF, {
		references: REFERENCES,
		resumability: { state: "not-resumable", reason: "child produced no persisted session file" },
	});

	assert.ok(block.includes("BRIEF_BODY"));
	assert.ok(block.includes("run-123"));
	assert.equal(block.includes('action: "resume"'), false, "no resume instruction without a resumable child");
	assert.match(block, /cannot be resumed/i);
	assert.ok(block.includes("child produced no persisted session file"), "the reason must be reported");
});

test("omitted references are not invented", () => {
	const block = formatRecoveryBriefBlock(BRIEF, {
		references: { runId: "run-123" },
		resumability: { state: "not-resumable", reason: "no session file" },
	});
	assert.equal(block.includes("undefined"), false);
	assert.equal(block.includes("null"), false);
});
