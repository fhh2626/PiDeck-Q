import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
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
async function createSession(t, { withPlan = false, withAsk = false, retry = { enabled: false }, inputHook, beforeStart, planChoice } = {}) {
	const cwd = await mkdtemp(join(tmpdir(), "pideck-todo-sdk-"));
	t.after(() => rm(cwd, { recursive: true, force: true }));
	const paths = [resolve("resources/extensions/pi-deck-todo.ts")];
	if (withPlan) paths.push(resolve("resources/extensions/pi-deck-plan-mode.ts"));
	if (withAsk) paths.push(resolve("resources/extensions/pideck-q-ask-question.ts"));
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
		getSystemPrompt: () => "Test assistant",
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
		settingsManager: pi.SettingsManager.inMemory({ compaction: { enabled: false }, retry, cacheWarming: { mode: "off" } }),
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

test("real SDK pauses after three no-progress rounds and does not leak rules into the next task", { timeout: 20000 }, async (t) => {
	const { session, faux, errors, notifications } = await createSession(t);
	faux.setResponses([response("No checklist"), response("Still no checklist"), response("No progress")]);
	await submitTask(session, "/todo-goal Implement the endpoint");
	assert.equal(faux.state.callCount, 3);
	assert.ok(notifications.some((text) => /3/.test(text)));
	faux.setResponses([(context) => {
		assert.doesNotMatch(JSON.stringify(context), /CONTINUE UNFINISHED TODO GOAL|\[TODO TASK:/);
		return response("New task complete");
	}]);
	await session.prompt("An unrelated task");
	assert.deepEqual(errors, []);
});

test("real SDK task commands do not implicitly disable plan mode", { timeout: 20000 }, async (t) => {
	const { session, faux, errors } = await createSession(t, { withPlan: true });
	await session.prompt("/plan on");
	faux.setResponses([(context) => {
		assert.match(JSON.stringify(context), /PLAN MODE ACTIVE/);
		return response("Read-only exploration complete");
	}]);
	await submitTask(session, "/todo Inspect the parser without editing");
	assert.deepEqual(errors, []);
	assert.equal(session.getActiveToolNames().includes("write"), false);
	assert.equal(faux.state.callCount, 1);
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
		await session.prompt("/plan on");
		faux.setResponses([
			response([call("todo", { action: "add", text: "Inspect" })]),
			response("Plan:\n1. Inspect the parser"),
			response("Plan:\n1. Inspect the parser"),
			response("Plan:\n1. Inspect the parser"),
		]);
		await submitTask(session, "/todo-goal Inspect parser");
		assert.equal(faux.state.callCount, 2, "an explicit pause/close wins over automatic recovery");
		assert.equal(dialogs.length, 1);
		assert.deepEqual(errors, []);
	});
}
