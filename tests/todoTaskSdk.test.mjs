import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { findPackageJSON } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { piFixtureFileUrl } from "../scripts/pi-compatibility-fixture.mjs";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { loadPiCompatibilityModules } from "./helpers/piCompatibilityModules.mjs";

const piEntry = piFixtureFileUrl("dist/index.js");
const pi = await import(piEntry);
const { AuthStorage } = await import(piFixtureFileUrl("dist/core/auth-storage.js"));
const ai = await import(new URL("dist/index.js", pathToFileURL(findPackageJSON("@earendil-works/pi-ai", piEntry))).href);
const { loadExtensions } = await loadPiCompatibilityModules();

/** Real SDK loader/session and an in-memory faux provider: no network, credentials or pi process. */
async function createSession(t, { withPlan = false, planFirst = false, withAsk = false, withChangePrompt = false, realSystemPrompt = false, compaction = { enabled: false }, retry = { enabled: false }, inputHook, beforeStart, planChoice } = {}) {
	const cwd = await mkdtemp(join(tmpdir(), "pideck-todo-sdk-"));
	t.after(() => rm(cwd, { recursive: true, force: true }));
	const paths = [resolve("resources/extensions/pi-deck-todo.ts")];
	// Production loads extensions alphabetically, so plan mode registers its hooks first.
	if (withPlan) planFirst ? paths.unshift(resolve("resources/extensions/pi-deck-plan-mode.ts")) : paths.push(resolve("resources/extensions/pi-deck-plan-mode.ts"));
	if (withAsk) paths.push(resolve("resources/extensions/pideck-q-ask-question.ts"));
	if (withChangePrompt) {
		const wrapper = join(cwd, "change-prompt-test.ts");
		const runtimeUrl = pathToFileURL(resolve("resources/extensions/pideck-q-change-pi-prompt/runtime.ts")).href;
		await writeFile(wrapper, `import { registerPromptExtension } from ${JSON.stringify(runtimeUrl)};\nexport default (pi) => registerPromptExtension(pi, ${JSON.stringify(cwd)}, { isStandalone: () => false });\n`);
		await mkdir(join(cwd, "change-pi-prompt"), { recursive: true });
		await writeFile(join(cwd, "change-pi-prompt", "config.json"), JSON.stringify({ subagent: false, pruneUnavailableShells: false, pruneUnavailableSearchTools: false }));
		paths.push(wrapper);
	}
	const extensions = await loadExtensions(paths, cwd);
	assert.deepEqual(extensions.errors, []);
	if (inputHook) extensions.extensions[0].handlers.get("input").push(inputHook);
	if (beforeStart) extensions.extensions[0].handlers.get("before_agent_start").push(beforeStart);
	const resourceLoader = {
		getExtensions: () => extensions,
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => realSystemPrompt ? undefined : "Test assistant",
		getSystemPromptSource: () => undefined,
		getAppendSystemPrompt: () => [],
		getAppendSystemPromptSources: () => [],
		extendResources() {}, async reload() {},
	};
	const faux = ai.fauxProvider({ provider: "pideck-todo-test", models: [{ id: "test", contextWindow: 200000 }] });
	const modelRuntime = await pi.ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: null, refreshOnCreate: false });
	modelRuntime.registerNativeProvider(faux.provider);
	const { session } = await pi.createAgentSession({
		cwd, agentDir: cwd, modelRuntime, model: faux.getModel(), resourceLoader,
		settingsManager: pi.SettingsManager.inMemory({ compaction, retry, cacheWarming: { mode: "off" } }),
		sessionManager: pi.SessionManager.inMemory(cwd),
		noTools: "builtin",
	});
	t.after(() => session.dispose());
	const errors = [];
	const notifications = [];
	const widgets = [];
	const dialogs = [];
	await session.bindExtensions({ mode: "rpc", onError: (error) => errors.push(error), uiContext: {
		setWidget: (_key, lines) => widgets.push(lines), notify: (text) => notifications.push(text),
		select: async (title, options) => {
		dialogs.push(title);
		if (planChoice === "pause") return options.find((option) => option.startsWith("先不执行"));
		if (planChoice === "close") return undefined;
		return options[0];
	},
	} });
	return { session, faux, errors, notifications, widgets, dialogs };
}

/** sendUserMessage has async input/auth preflight before isIdle becomes false. */
async function submitTask(session, command) {
	const settled = Promise.withResolvers();
	const unsubscribe = session.subscribe((event) => {
		if (event.type === "agent_settled") settled.resolve();
	});
	try {
		await Promise.all([session.prompt(command), settled.promise]);
		await session.waitForIdle();
	} finally {
		unsubscribe();
	}
}
/** Rejected commands start no run, so settlement must not be awaited. */
async function commandOnly(session, command) {
	await session.prompt(command);
	await session.waitForIdle();
}
const call = (name, args) => ai.fauxToolCall(name, args);
const response = (content, options) => ai.fauxAssistantMessage(content, options);

test("real SDK dispatches /todo-goal, executes tools, continues an early stop and finishes", { timeout: 20000 }, async (t) => {
	const { session, faux, errors, widgets } = await createSession(t);
	faux.setResponses([
		response([call("todo", { action: "add", text: "Implement" })]),
		response("Stopped before completing the work"),
		(context) => {
			assert.match(JSON.stringify(context), /CONTINUE UNFINISHED TODO GOAL/);
			return response([call("todo", { action: "toggle", id: 1 })]);
		},
		response("Implemented and verified"),
	]);
	await submitTask(session, "/todo-goal Implement and verify the endpoint");
	assert.equal(faux.state.callCount, 4);
	assert.deepEqual(errors, []);
	assert.match(widgets.at(-1).join("\n"), /☑ #1 Implement/);
	const continuations = session.sessionManager.getBranch().filter((entry) => entry.type === "custom_message" && entry.customType === "pi-deck-todo-task-continue");
	assert.equal(continuations.length, 1);
});

test("real SDK context and blocked tools pause and resume with change-pi-prompt loaded", { timeout: 20000 }, async (t) => {
	const { session, faux, errors, notifications } = await createSession(t, { withChangePrompt: true });
	faux.setResponses([
		response([call("todo", { action: "add", text: "Implement" })]),
		response("Work remains"),
		(context) => {
			assert.match(JSON.stringify(context), /todo_goal_context/);
			return response([call("todo_goal_context", {})]);
		},
		(context) => {
			assert.match(JSON.stringify(context.messages.at(-1)), /Implement the endpoint/);
			return response([call("todo_goal_blocked", { reason: "Missing access", needs: "Grant access" })]);
		},
		response("Blocked: please grant access."),
	]);
	await submitTask(session, "/todo-goal Implement the endpoint");
	assert.ok(notifications.some((text) => text.includes("Missing access")));
	const before = session.sessionManager.getBranch();
	const continuation = before.find((entry) => entry.type === "custom_message" && entry.customType === "pi-deck-todo-task-continue");
	assert.ok(continuation);
	assert.doesNotMatch(continuation.content, /Implement the endpoint/);
	faux.setResponses([
		(context) => {
			assert.match(JSON.stringify(context), /Access granted/);
			return response([call("todo_goal_context", {})]);
		},
		(context) => {
			assert.match(JSON.stringify(context.messages.at(-1)), /Implement the endpoint/);
			return response([call("todo", { action: "toggle", id: 1 })]);
		},
		response("Done"),
	]);
	await submitTask(session, "/todo-resume Access granted");
	assert.deepEqual(errors, []);
	// The guidance is a real persisted custom message the desktop can project.
	const resumeEntry = session.sessionManager.getBranch().find((entry) => entry.type === "custom_message"
		&& entry.customType === "pi-deck-todo-task-resume");
	assert.ok(resumeEntry, "resume guidance is persisted, not only streamed");
	assert.equal(resumeEntry.display, true);
	assert.match(String(resumeEntry.content), /Access granted/);
});

test("real SDK applies change-pi-prompt and retrieves the goal after actual compaction", { timeout: 30000 }, async (t) => {
	const { session, faux, errors, widgets } = await createSession(t, {
		withChangePrompt: true, realSystemPrompt: true,
		compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 1 },
	});
	let phase = "add";
	let resumedContext;
	const systemText = (context) => context.messages.filter((message) => message.role === "system")
		.map((message) => typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? message.sections ?? "")).join("\n");
	const handler = (context) => {
		const system = systemText(context);
		if (system.includes("context summarization assistant")) return response("SUMMARY: use todo_goal_context to refresh the goal.");
		assert.match(system, /<!-- change-pi-prompt:v1 -->/);
		assert.match(system, /todo_goal_context/);
		assert.match(system, /todo_goal_blocked/);
		if (phase === "add") { phase = "block"; return response([call("todo", { action: "add", text: "Implement" })]); }
		if (phase === "block") { phase = "explain"; return response([call("todo_goal_blocked", { reason: "Need access", needs: "Grant access" })]); }
		if (phase === "explain") { phase = "resume"; return response("Blocked: please grant access."); }
		if (phase === "resume") { resumedContext = context; phase = "toggle"; return response([call("todo_goal_context", {})]); }
		if (phase === "toggle") { phase = "done"; return response([call("todo", { action: "toggle", id: 1 })]); }
		return response("Done");
	};
	faux.setResponses(Array.from({ length: 12 }, () => handler));
	await submitTask(session, "/todo-goal Implement the endpoint");
	const result = await session.compact();
	assert.match(result.summary, /SUMMARY/);
	assert.ok(session.messages.some((message) => message.role === "compactionSummary"));
	assert.equal(session.messages.some((message) => message.role === "custom" && message.customType === "pi-deck-todo-task-start"), false);
	await submitTask(session, "/todo-resume Access granted");
	assert.doesNotMatch(JSON.stringify(resumedContext.messages.filter((message) => message.role !== "system")), /Implement the endpoint/);
	const goal = session.messages.findLast((message) => message.role === "toolResult" && message.toolName === "todo_goal_context");
	assert.match(goal.content[0].text, /Original goal:\nImplement the endpoint/);
	assert.match(goal.content[0].text, /\[ \] #1 Implement/);
	assert.match(widgets.at(-1).join("\n"), /☑ #1 Implement/);
	assert.deepEqual(errors, []);
});

test("real SDK ordinary /todo does not auto-continue an unfinished checklist", { timeout: 20000 }, async (t) => {
	const { session, faux, errors } = await createSession(t);
	faux.setResponses([
		response([call("todo", { action: "add", text: "Implement" })]),
		response("Paused for clarification"),
	]);
	await submitTask(session, "/todo Implement the endpoint");
	assert.equal(faux.state.callCount, 2);
	assert.deepEqual(errors, []);
});

test("real SDK abort at agent_end cancels goal recovery, including the pre-settle race", { timeout: 20000 }, async (t) => {
	const { session, faux, errors } = await createSession(t);
	faux.setResponses([
		response([call("todo", { action: "add", text: "Implement" })]),
		response("Early stop"),
	]);
	const unsubscribe = session.subscribe((event) => {
		// abort() waits for settlement: do not await it from an awaited lifecycle listener.
		if (event.type === "agent_end") void session.abort().catch((error) => errors.push(error));
	});
	t.after(unsubscribe);
	await submitTask(session, "/todo-goal Implement the endpoint");
	assert.equal(faux.state.callCount, 2);
	assert.deepEqual(errors, []);
	assert.equal(session.sessionManager.getBranch().some((entry) => entry.type === "custom_message" && entry.customType === "pi-deck-todo-task-continue"), false);
});

test("real SDK continues repeated normal replies without progress until the checklist is complete", { timeout: 20000 }, async (t) => {
	const { session, faux, errors } = await createSession(t);
	faux.setResponses([
		response([call("todo", { action: "add", text: "Implement" })]),
		...Array.from({ length: 5 }, () => response("Work remains")),
		(context) => {
			assert.match(JSON.stringify(context), /CONTINUE UNFINISHED TODO GOAL/);
			return response([call("todo", { action: "toggle", id: 1 })]);
		},
		response("Done"),
	]);
	await submitTask(session, "/todo-goal Implement the endpoint");
	assert.equal(faux.state.callCount, 8);
	assert.equal(session.sessionManager.getBranch().filter((entry) => entry.type === "custom_message" && entry.customType === "pi-deck-todo-task-continue").length, 5);
	faux.setResponses([(context) => {
		assert.doesNotMatch(JSON.stringify(context), /CONTINUE UNFINISHED TODO GOAL|\[TODO TASK:/);
		return response("New task complete");
	}]);
	await session.prompt("An unrelated task");
	assert.deepEqual(errors, []);
});

test("real SDK resumes a blocked goal from the user's natural reply and keeps the checklist", { timeout: 20000 }, async (t) => {
	const { session, faux, errors, notifications, widgets } = await createSession(t);
	faux.setResponses([
		response([call("todo", { action: "add", text: "Implement" })]),
		response([call("todo_goal_blocked", { reason: "Missing access", needs: "Grant access" })]),
		response("Blocked: please grant access."),
		(context) => {
			assert.match(JSON.stringify(context), /Access granted/, "the reply itself is the guidance");
			assert.match(JSON.stringify(context), /\[TODO TASK: todo-goal\]/, "the same goal keeps its rules");
			return response([call("todo", { action: "toggle", id: 1 })]);
		},
		response("Done"),
	]);
	await submitTask(session, "/todo-goal Implement the endpoint");
	assert.ok(notifications.some((text) => text.includes("Missing access")));
	assert.equal(faux.state.callCount, 3, "a blocked goal stops instead of continuing");
	await submitTask(session, "Access granted");
	assert.equal(faux.state.callCount, 5, "the natural reply resumes the same goal");
	assert.deepEqual(errors, []);
	assert.match(widgets.at(-1).join("\n"), /☑ #1 Implement/);
});

test("real SDK clears a paused goal's checklist when another run replaces the task", { timeout: 20000 }, async (t) => {
	const { session, faux, errors, widgets } = await createSession(t);
	faux.setResponses([
		response([call("todo", { action: "add", text: "Implement" })]),
		response([call("todo_goal_blocked", { reason: "Missing access", needs: "Grant access" })]),
		response("Blocked: please grant access."),
		(context) => {
			assert.doesNotMatch(JSON.stringify(context), /\[TODO TASK:|CONTINUE UNFINISHED TODO GOAL/,
				"a different run must not inherit the paused goal's rules");
			return response("Unrelated work done");
		},
	]);
	await submitTask(session, "/todo-goal Implement the endpoint");
	assert.ok(widgets.at(-1).join("\n").includes("Implement"));
	// A custom run from another extension replaces the task; before_agent_start must clear the list.
	await session.sendCustomMessage({ customType: "other-extension", content: "Unrelated work", display: false }, { triggerTurn: true });
	await session.waitForIdle();
	assert.deepEqual(errors, []);
	assert.equal(session.sessionManager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === "pi-deck-todo")
		.at(-1)?.data.todos.length, 0, "the paused checklist does not leak into the next task");
});

test("real SDK task commands do not implicitly disable plan mode", { timeout: 20000 }, async (t) => {
	const { session, faux, errors } = await createSession(t, { withPlan: true });
	await session.prompt("/plan on");
	faux.setResponses([(context) => {
		assert.match(JSON.stringify(context), /PLAN MODE ACTIVE/);
		assert.match(JSON.stringify(context), /TODO TASK: todo\]/);
		return response("Read-only exploration complete");
	}]);
	await submitTask(session, "/todo Inspect the parser without editing");
	assert.deepEqual(errors, []);
	assert.equal(session.getActiveToolNames().includes("write"), false);
	assert.equal(faux.state.callCount, 1);
});

test("real SDK suspends a blocked goal inside plan mode and resumes it after /plan off", { timeout: 30000 }, async (t) => {
	const { session, faux, errors } = await createSession(t, { withPlan: true, planChoice: "pause" });
	faux.setResponses([
		response([call("todo", { action: "add", text: "Implement" })]),
		response([call("todo_goal_blocked", { reason: "Need access", needs: "Grant access" })]),
		response("Blocked: grant access."),
		(context) => {
			// Plan mode owns this turn, so the suspended goal must not inject its rules.
			assert.doesNotMatch(JSON.stringify(context), /TODO TASK: todo-goal/);
			return response("Plan:\n1. Inspect the parser");
		},
		(context) => {
			assert.match(JSON.stringify(context), /TODO TASK: todo-goal/);
			assert.match(JSON.stringify(context), /Continue the existing checklist/);
			return response([call("todo", { action: "toggle", id: 1 })]);
		},
		response("Done"),
	]);
	await submitTask(session, "/todo-goal Implement the endpoint");
	// The composer marker keeps plan mode enabled, which is the path that used to resume the goal.
	await submitTask(session, "__PI_DECK_PLAN_MODE__Plan the change");
	const planTurn = session.sessionManager.getBranch().filter((entry) => entry.type === "custom_message"
		&& entry.customType === "pi-deck-todo-task-continue");
	assert.equal(planTurn.length, 0, "a suspended goal must not append continuations during plan mode");
	await session.prompt("/plan off");
	await submitTask(session, "Continue the goal");
	assert.equal(faux.state.callCount, 6, "the resumed goal continues until its checklist is complete");
	assert.deepEqual(errors, []);
});

test("real SDK rejects /todo-goal inside plan mode in production load order", { timeout: 30000 }, async (t) => {
	const { session, faux, errors, notifications } = await createSession(t, { withPlan: true, planFirst: true });
	await session.prompt("/plan on");
	await commandOnly(session, "/todo-goal Implement the endpoint");
	assert.equal(faux.state.callCount, 0, "a read-only plan turn must not start a goal run");
	// The SDK runs with the host-selected locale, so match both language variants.
	assert.ok(notifications.some((text) => /todo-goal/.test(text) && /plan|计划/i.test(text)), "the rejection names plan mode");
	assert.equal(session.sessionManager.getBranch().some((entry) => entry.type === "custom_message"
		&& entry.customType === "pi-deck-todo-task-start"), false, "no goal task was created");
	await session.prompt("/plan off");
	faux.setResponses([
		response([call("todo", { action: "add", text: "Implement" })]),
		response([call("todo", { action: "toggle", id: 1 })]),
		response("Done"),
	]);
	await submitTask(session, "/todo-goal Implement the endpoint");
	assert.ok(faux.state.callCount >= 3, "the goal runs once plan mode is off");
	assert.deepEqual(errors, []);
});

test("real SDK rejects /todo-goal inside plan mode in reverse load order", { timeout: 30000 }, async (t) => {
	const { session, faux, errors, notifications } = await createSession(t, { withPlan: true });
	await session.prompt("/plan on");
	await commandOnly(session, "/todo-goal Implement the endpoint");
	assert.equal(faux.state.callCount, 0, "load order must not change the rejection");
	assert.ok(notifications.some((text) => /todo-goal/.test(text) && /plan|计划/i.test(text)));
	assert.deepEqual(errors, []);
});

test("real SDK keeps an error-fused checklist through plan mode in production load order", { timeout: 40000 }, async (t) => {
	const { session, faux, errors } = await createSession(t, { withPlan: true, planFirst: true, planChoice: "pause" });
	faux.setResponses([
		response([call("todo", { action: "add", text: "Implement" })]),
		response("", { stopReason: "error", errorMessage: "First failure" }),
		response("", { stopReason: "error", errorMessage: "Second failure" }),
		response("", { stopReason: "error", errorMessage: "Third failure" }),
	]);
	await submitTask(session, "/todo-goal Implement the endpoint");
	assert.equal(faux.state.callCount, 4, "the error fuse stops automatic continuation");
	faux.setResponses([
		(context) => {
			assert.doesNotMatch(JSON.stringify(context), /TODO TASK: todo-goal/);
			return response("Plan:\n1. Inspect the parser");
		},
		(context) => {
			assert.match(JSON.stringify(context), /Continue the existing checklist/);
			return response([call("todo", { action: "toggle", id: 1 })]);
		},
		response("Done"),
	]);
	// The composer marker enters plan mode; the fused goal must survive it.
	await submitTask(session, "__PI_DECK_PLAN_MODE__Plan the change");
	await session.prompt("/plan off");
	await submitTask(session, "/todo-resume Provider is back");
	assert.ok(faux.state.callCount >= 7, "the preserved goal resumes explicitly");
	assert.deepEqual(errors, []);
});

test("real SDK plan approval resumes the blocked goal for queued execution", { timeout: 30000 }, async (t) => {
	const { session, faux, errors } = await createSession(t, { withPlan: true });
	faux.setResponses([
		response([call("todo", { action: "add", text: "Implement" })]),
		response([call("todo_goal_blocked", { reason: "Need approval", needs: "Approve the plan" })]),
		response("Blocked: please approve."),
		response("Plan:\n1. Implement the endpoint"),
		(context) => {
			assert.match(JSON.stringify(context), /Execute the approved plan/);
			return response([call("todo_goal_context", {})]);
		},
		(context) => {
			const result = context.messages.findLast((message) => message.role === "toolResult");
			assert.equal(result.isError, false);
			assert.match(JSON.stringify(result), /Goal is active/);
			return response([call("todo", { action: "toggle", id: 1 })]);
		},
		response("Implemented [DONE:1]"),
	]);
	await submitTask(session, "/todo-goal Implement the endpoint");
	await submitTask(session, "__PI_DECK_PLAN_MODE__Plan the implementation");
	assert.equal(faux.state.callCount, 7);
	assert.deepEqual(errors, []);
});

test("real SDK allows goal clarification then blocks the actual ask_question tool after a successful add", { timeout: 20000 }, async (t) => {
	const { session, faux, errors, dialogs } = await createSession(t, { withAsk: true });
	faux.setResponses([
		response([call("ask_question", { type: "select", question: "Before checklist?", options: ["Yes"], allowOther: false })]),
		response([call("todo", { action: "add", text: "Implement" })]),
		response([call("ask_question", { type: "select", question: "After checklist?", options: ["Yes"], allowOther: false })]),
		(context) => {
			const blocked = context.messages.findLast((message) => message.role === "toolResult");
			assert.equal(blocked.isError, true);
			assert.match(JSON.stringify(blocked), /ask_question/);
			return response([call("todo", { action: "toggle", id: 1 })]);
		},
		response("Finished"),
	]);
	await submitTask(session, "/todo-goal Implement the endpoint");
	assert.equal(faux.state.callCount, 5);
	assert.deepEqual(dialogs, ["Before checklist?"]);
	assert.deepEqual(errors, []);
});

test("real SDK resumes a final provider error while keeping the original checklist", { timeout: 20000 }, async (t) => {
	const { session, faux, errors, widgets } = await createSession(t);
	faux.setResponses([
		response([call("todo", { action: "add", text: "Implement" })]),
		response("", { stopReason: "error", errorMessage: "Test provider error" }),
		(context) => {
			assert.match(JSON.stringify(context), /CONTINUE UNFINISHED TODO GOAL/);
			return response([call("todo", { action: "toggle", id: 1 })]);
		},
		response("Finished"),
	]);
	await submitTask(session, "/todo-goal Implement the endpoint");
	assert.equal(faux.state.callCount, 4);
	assert.match(widgets.at(-1).join("\n"), /☑ #1 Implement/);
	assert.deepEqual(errors, []);
});

test("real SDK gives its built-in retry priority without adding a duplicate goal continuation", { timeout: 20000 }, async (t) => {
	const { session, faux, errors } = await createSession(t, { retry: { enabled: true, maxRetries: 1, baseDelayMs: 1, maxDelayMs: 1 } });
	faux.setResponses([
		response([call("todo", { action: "add", text: "Implement" })]),
		response("", { stopReason: "error", errorMessage: "503 service unavailable" }),
		(context) => {
			assert.doesNotMatch(JSON.stringify(context), /CONTINUE UNFINISHED TODO GOAL/);
			return response([call("todo", { action: "toggle", id: 1 })]);
		},
		response("Finished"),
	]);
	const events = [];
	const unsubscribe = session.subscribe((event) => events.push(event.type));
	t.after(unsubscribe);
	await submitTask(session, "/todo-goal Implement the endpoint");
	assert.ok(events.includes("auto_retry_start"));
	assert.equal(faux.state.callCount, 4);
	assert.equal(session.sessionManager.getBranch().some((entry) => entry.type === "custom_message" && entry.customType === "pi-deck-todo-task-continue"), false);
	assert.deepEqual(errors, []);
});

test("real SDK cancellation while committing a continuation prevents the next provider request", { timeout: 20000 }, async (t) => {
	const { session, faux, errors } = await createSession(t);
	faux.setResponses([
		response([call("todo", { action: "add", text: "Implement" })]),
		response("Early stop"),
	]);
	const unsubscribe = session.subscribe((event) => {
		if (event.type === "entry_appended" && event.entry.type === "custom_message"
			&& event.entry.customType === "pi-deck-todo-task-continue") void session.abort().catch((error) => errors.push(error));
	});
	t.after(unsubscribe);
	await submitTask(session, "/todo-goal Implement the endpoint");
	assert.equal(faux.state.callCount, 2);
	assert.deepEqual(errors, []);
});

test("real SDK atomic task goals remain visible through the desktop history projector", { timeout: 20000 }, async (t) => {
	const { session, faux, errors } = await createSession(t);
	faux.setResponses([response("Finished")]);
	await submitTask(session, "/todo Inspect the endpoint");
	const branch = session.sessionManager.getBranch();
	const goals = branch.filter((entry) => entry.type === "custom_message" && entry.display);
	assert.equal(goals.length, 1);
	const { AgentMessageProjector } = loadTsCommonJs("src/main/pi/AgentMessageProjector.ts");
	const projector = new AgentMessageProjector({ translate: (key) => key, isAskAborted: () => false });
	const messages = projector.convert("agent", session.messages);
	const displayedGoals = messages.filter((message) => message.meta?.type === "todoTask");
	assert.equal(displayedGoals.length, 1);
	assert.equal(displayedGoals[0].text, "Inspect the endpoint");
	assert.deepEqual(errors, []);
});

test("goal startup is cancelled while asynchronous startup work is still waiting", { timeout: 20000 }, async (t) => {
	const entered = Promise.withResolvers();
	const gate = Promise.withResolvers();
	const wait = async () => { entered.resolve(); await gate.promise; };
	const { session, faux, errors } = await createSession(t, {
		inputHook: async (event) => { if (event.source === "extension") await wait(); },
		beforeStart: wait,
	});
	faux.setResponses([
		response([call("todo", { action: "add", text: "Implement" })]),
		response([call("todo", { action: "toggle", id: 1 })]), response("Done"),
	]);
	const settled = Promise.withResolvers();
	const unsubscribe = session.subscribe((event) => { if (event.type === "agent_settled") settled.resolve(); });
	t.after(unsubscribe);
	const command = session.prompt("/todo-goal Implement");
	await entered.promise;
	const abort = session.abort();
	gate.resolve();
	await Promise.all([command, abort, settled.promise]);
	assert.equal(faux.state.callCount, 0, "stopping during startup must prevent all provider/tool work");
	assert.deepEqual(errors, []);
});

test("same-batch todo add locks the actual ask_question execution", { timeout: 20000 }, async (t) => {
	const { session, faux, errors, dialogs } = await createSession(t, { withAsk: true });
	faux.setResponses([
		response([
			call("todo", { action: "add", text: "Implement" }),
			call("ask_question", { type: "select", question: "Too late?", options: ["Yes"], allowOther: false }),
		]),
		(context) => {
			const result = context.messages.findLast((message) => message.role === "toolResult" && message.toolName === "ask_question");
			assert.equal(result.isError, true);
			return response([call("todo", { action: "toggle", id: 1 })]);
		},
		response("Done"),
	]);
	await submitTask(session, "/todo-goal Implement");
	assert.deepEqual(dialogs, []);
	assert.deepEqual(errors, []);
});

for (const planChoice of ["pause", "close"]) {
	test(`plan ${planChoice} stops goal continuation instead of starting more requests`, { timeout: 20000 }, async (t) => {
		const { session, faux, errors, dialogs } = await createSession(t, { withPlan: true, planChoice });
		faux.setResponses([
			response([call("todo", { action: "add", text: "Inspect" })]),
			response([call("todo_goal_blocked", { reason: "Need access", needs: "Grant access" })]),
			response("Blocked: grant access."),
			response("Plan:\n1. Inspect the parser"),
		]);
		await submitTask(session, "/todo-goal Inspect parser");
		// Entering plan mode suspends the goal; the dialog choice must not resume it.
		await submitTask(session, "__PI_DECK_PLAN_MODE__Plan the change");
		assert.equal(dialogs.length, 1);
		assert.equal(faux.state.callCount, 4, "an explicit pause/close wins over automatic recovery");
		assert.equal(session.sessionManager.getBranch().filter((entry) => entry.type === "custom_message"
			&& entry.customType === "pi-deck-todo-task-continue").length, 0);
		assert.deepEqual(errors, []);
	});
}
