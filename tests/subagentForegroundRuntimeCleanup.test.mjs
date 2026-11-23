/** A retained direct child must keep an owner until its authoritative exit. */
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import test from "node:test";
import { createFixture, resetDoubles, setRunSyncBehavior, runSyncCalls, completedResult } from "./helpers/subagentResumeHarness.mjs";
import { createHistoryRepo } from "./helpers/native2GitFixture.mjs";

await import("./helpers/piFixtureResolver.mjs");
const executionDouble = new URL("./helpers/subagentExecutionDouble.mjs", import.meta.url).href;
registerHooks({
	resolve(specifier, context, nextResolve) {
		if (context.parentURL?.includes("pideck-q-subagents") && specifier.endsWith("/execution.ts")) {
			return { url: executionDouble, shortCircuit: true };
		}
		return nextResolve(specifier, context);
	},
});
const { default: registerSubagentExtension } = await import("../resources/extensions/pideck-q-subagents/src/extension/index.ts");
const { loadConfig, saveConfig } = await import("../resources/extensions/pideck-q-subagents/src/extension/config.ts");
const { withWorktreeTransaction } = await import("../resources/extensions/pideck-q-subagents/src/runs/shared/worktree.ts");
const { createSubagentExecutor } = await import("../resources/extensions/pideck-q-subagents/src/runs/foreground/subagent-executor.ts");
const { interruptForegroundControls } = await import("../resources/extensions/pideck-q-subagents/src/runs/foreground/foreground-control.ts");

/** Minimal host surface with the production extension's real session lifecycle callbacks. */
function host(ctx) {
	const hooks = new Map();
	const listeners = new Map();
	const tools = new Map([["read", { name: "read", description: "Read a local file." }]]);
	let active = ["read"];
	const pi = {
		events: {
			on(name, handler) { const set = listeners.get(name) ?? new Set(); set.add(handler); listeners.set(name, set); return () => set.delete(handler); },
			emit(name, event) { for (const handler of listeners.get(name) ?? []) handler(event); },
		},
		on(name, handler) { const callbacks = hooks.get(name) ?? []; callbacks.push(handler); hooks.set(name, callbacks); },
		registerTool(tool) { tools.set(tool.name, tool); active.push(tool.name); },
		getAllTools: () => [...tools.values()], getActiveTools: () => [...active],
		setActiveTools(names) { active = [...names]; },
		getSessionName: () => undefined, getThinkingLevel: () => "off",
		registerMessageRenderer() {}, registerCommand() {}, registerShortcut() {},
		sendMessage() {}, appendEntry() {},
		async exec() { return { code: 0, stdout: "", stderr: "", killed: false }; },
	};
	registerSubagentExtension(pi);
	return {
		pi, tools,
		async emit(name, event) { for (const handler of hooks.get(name) ?? []) await handler(event, ctx); },
	};
}

for (const transition of ["switch", "reload", "same-session"]) {
	test(`pending direct worktree setup obeys parent ${transition} ownership`, { timeout: 15_000 }, async (t) => {
		const fixture = createFixture({}, `pending-${transition}`);
		createHistoryRepo(fixture.projectDir);
		Object.assign(fixture.ctx.sessionManager, { getEntries: () => [], getBranch: () => [] });
		const previousConfig = loadConfig();
		saveConfig({ worktreeProvider: "native", worktreeBaseDir: path.join(fixture.dir, "worktrees") });
		const original = host(fixture.ctx);
		let replacement;
		const owner = new AbortController();
		let releaseSetup;
		const blocked = withWorktreeTransaction(() => new Promise((resolve) => { releaseSetup = resolve; }));
		t.after(async () => {
			releaseSetup?.();
			await blocked;
			owner.abort();
			await original.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
			await replacement?.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
			saveConfig(previousConfig);
		});
		await original.emit("session_start", { type: "session_start", reason: "startup" });
		resetDoubles();
		setRunSyncBehavior(() => completedResult(fixture, { agent: "writable" }));
		const execution = original.tools.get("subagent").execute(`pending-${transition}`, {
			agent: "writable", task: "Inspect the worktree.", worktree: true, context: "fresh", acceptance: false, output: false, mission: false,
		}, owner.signal, undefined, fixture.ctx);
		let pending = false;
		for (let i = 0; i < 100 && !pending; i++) {
			await new Promise((resolve) => setImmediate(resolve));
			const status = await original.tools.get("subagent").execute("pending-status", { action: "status" }, owner.signal, undefined, fixture.ctx);
			pending = status.content.some((part) => part.type === "text" && /State: running/.test(part.text));
		}
		assert.equal(pending, true, "the run must own its control while worktree scheduling is blocked");
		assert.equal(runSyncCalls.length, 0);
		if (transition === "switch") {
			fixture.ctx.sessionManager.getSessionFile = () => `${fixture.parentSessionFile}.new`;
			fixture.ctx.sessionManager.getSessionId = () => "pending-new-parent";
			await original.emit("session_start", { type: "session_start", reason: "switch", previousSessionFile: fixture.parentSessionFile });
		} else if (transition === "reload") {
			replacement = host(fixture.ctx);
			await replacement.emit("session_start", { type: "session_start", reason: "reload" });
		} else {
			await original.emit("session_start", { type: "session_start", reason: "resume" });
		}
		assert.equal(owner.signal.aborted, false, "cleanup must cancel the owned run even when the caller's signal remains live");
		releaseSetup();
		if (transition === "same-session") {
			const result = await execution;
			assert.notEqual(result.isError, true, JSON.stringify(result));
			assert.equal(runSyncCalls.length, 1, "the same parent's queued child remains authorized to start");
		} else {
			await assert.rejects(execution, /Worktree setup aborted/);
			assert.equal(runSyncCalls.length, 0, "an outgoing parent's queued child must never launch after reset");
		}
	});
}

for (const transition of ["switch", "reload", "same-session"]) {
	test(`fork preparation before control creation obeys parent ${transition} ownership`, { timeout: 15_000 }, async (t) => {
		const fixture = createFixture({}, `fork-${transition}`);
		Object.assign(fixture.ctx.sessionManager, {
			getEntries: () => [], getBranch: () => [], getLeafId: () => "parent-leaf",
			openSession: () => ({ createBranchedSession: () => fixture.childSessionFile }),
		});
		const model = { provider: "test", id: `fork-${transition}`, name: "Fork model", api: "openai-responses", input: ["text"], contextWindow: 100_000, maxTokens: 4096, reasoning: false, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
		const modelRef = `${model.provider}/${model.id}`;
		const credentialWait = Promise.withResolvers();
		const credentialLookup = Promise.withResolvers();
		Object.assign(fixture.ctx.modelRegistry, {
			getAvailable: () => [model],
			find: (provider, id) => provider === model.provider && id === model.id ? model : undefined,
			getApiKeyAndHeaders() { credentialLookup.resolve(); return credentialWait.promise; },
		});
		const previousConfig = loadConfig();
		saveConfig({ forkContext: { mode: "pruned", model: modelRef } });
		const original = host(fixture.ctx);
		let replacement;
		const owner = new AbortController();
		t.after(async () => {
			credentialWait.resolve({ ok: true, apiKey: "fixture-key" });
			owner.abort();
			await original.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
			await replacement?.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
			saveConfig(previousConfig);
		});
		await original.emit("session_start", { type: "session_start", reason: "startup" });
		resetDoubles();
		setRunSyncBehavior(() => completedResult(fixture, { agent: "writable" }));
		// Fork summarization and the child launch choose models independently. Keep
		// both on the fixture registry, regardless of the installed agent defaults.
		const execution = original.tools.get("subagent").execute(`fork-${transition}`, {
			agent: "writable", task: "Inspect the assigned file.", model: modelRef, context: "fork", acceptance: false, output: false, mission: false,
		}, owner.signal, undefined, fixture.ctx);
		await credentialLookup.promise;
		assert.equal(runSyncCalls.length, 0);
		if (transition === "switch") {
			const nextSession = `${fixture.parentSessionFile}.new`;
			writeFileSync(nextSession, "");
			fixture.ctx.sessionManager.getSessionFile = () => nextSession;
			fixture.ctx.sessionManager.getSessionId = () => "fork-new-parent";
			await original.emit("session_start", { type: "session_start", reason: "switch", previousSessionFile: fixture.parentSessionFile });
		} else if (transition === "reload") {
			replacement = host(fixture.ctx);
			await replacement.emit("session_start", { type: "session_start", reason: "reload" });
		} else {
			await original.emit("session_start", { type: "session_start", reason: "resume" });
		}
		assert.equal(owner.signal.aborted, false);
		credentialWait.resolve({ ok: true, apiKey: "fixture-key" });
		const outcome = await execution.then((result) => ({ result }), (error) => ({ error }));
		if (transition === "same-session") {
			assert.equal(outcome.error, undefined);
			assert.notEqual(outcome.result.isError, true, JSON.stringify(outcome.result));
			assert.equal(runSyncCalls.length, 1);
			assert.equal(runSyncCalls[0].options.modelOverride, modelRef);
		} else {
			assert.equal(runSyncCalls.length, 0, "preparation owned by an outgoing parent must not create a later child");
			assert.ok(outcome.error, "the registered tool must report the canceled launch");
		}
	});
}

for (const transition of ["switch", "reload", "same-session"]) {
	test(`environment preparation before owner capture obeys parent ${transition} ownership`, async (t) => {
		const fixture = createFixture({}, `environment-${transition}`);
		fixture.state.currentSessionId = fixture.parentSessionFile;
		const preparation = Promise.withResolvers();
		fixture.deps.prepareEnvironment = (_params, ctx) => ctx.sessionManager.getSessionFile() === fixture.parentSessionFile
			? preparation.promise : Promise.resolve();
		const executor = createSubagentExecutor(fixture.deps);
		resetDoubles();
		setRunSyncBehavior(() => completedResult(fixture));
		const owner = new AbortController();
		const nextChild = Promise.withResolvers();
		let nextExecution;
		const execution = executor.executePublic(`environment-${transition}`, {
			agent: "worker", task: "Inspect the assigned file.", context: "fresh", acceptance: false, output: false, mission: false,
		}, owner.signal, undefined, fixture.ctx);
		t.after(async () => {
			preparation.resolve();
			nextChild.resolve(completedResult(fixture));
			owner.abort();
			await Promise.allSettled([execution, nextExecution]);
		});
		if (transition === "switch") {
			fixture.ctx.sessionManager.getSessionFile = () => `${fixture.parentSessionFile}.new`;
			fixture.state.currentSessionId = fixture.ctx.sessionManager.getSessionFile();
		}
		interruptForegroundControls(fixture.state, transition === "reload" ? undefined : fixture.state.currentSessionId);
		assert.equal(fixture.state.subagentInProgress, transition === "same-session", "cleanup must project only the current parent's dispatch ownership");
		if (transition === "switch") {
			const started = Promise.withResolvers();
			setRunSyncBehavior(() => { started.resolve(); return nextChild.promise; });
			const nextParams = { agent: "worker", task: "Inspect the new session's file.", context: "fresh", acceptance: false, output: false, mission: false };
			nextExecution = executor.executePublic("new-parent-first", nextParams, owner.signal, undefined, fixture.ctx);
			const firstOutcome = await Promise.race([
				started.promise.then(() => ({ started: true })),
				nextExecution.then((result) => ({ result })),
			]);
			assert.equal(firstOutcome.started, true, `the new parent must launch before the canceled preparation settles: ${JSON.stringify(firstOutcome)}`);
			assert.equal(fixture.state.subagentInProgress, true);
			const duplicateBefore = await executor.executePublic("new-parent-duplicate-before", nextParams, owner.signal, undefined, fixture.ctx);
			assert.equal(duplicateBefore.isError, true, "the active parent still permits only one foreground call");
			const unavailableContext = { ...fixture.ctx, sessionManager: { getSessionFile: () => undefined, getSessionId: () => undefined } };
			const unavailable = await executor.executePublic("unavailable-parent", nextParams, owner.signal, undefined, unavailableContext);
			assert.equal(unavailable.isError, true);
			assert.equal(fixture.state.subagentInProgress, true, "a request without a parent identity must not replace the active guard");
			preparation.resolve();
			const outgoing = await execution;
			assert.equal(outgoing.isError, true);
			assert.equal(fixture.state.subagentInProgress, true, "the outgoing request's finally must preserve the new parent's active guard");
			const duplicateAfter = await executor.executePublic("new-parent-duplicate-after", nextParams, owner.signal, undefined, fixture.ctx);
			assert.equal(duplicateAfter.isError, true, "late cleanup must not admit a second child in the new parent");
			assert.equal(runSyncCalls.length, 1, "only the new parent's first child may launch");
			nextChild.resolve(completedResult(fixture));
			const completed = await nextExecution;
			assert.notEqual(completed.isError, true, JSON.stringify(completed));
			assert.equal(fixture.state.subagentInProgress, false, "the current owner releases its own dispatch guard");
			return;
		}
		if (transition === "same-session") {
			const duplicate = await executor.executePublic("same-parent-duplicate", {
				agent: "worker", task: "This second launch must stay blocked.", context: "fresh", acceptance: false, output: false, mission: false,
			}, owner.signal, undefined, fixture.ctx);
			assert.equal(duplicate.isError, true, "same-session reset must preserve the one-call guard during preparation");
			assert.equal(runSyncCalls.length, 0);
		}
		preparation.resolve();
		const result = await execution;
		assert.equal(owner.signal.aborted, false);
		if (transition === "same-session") {
			assert.notEqual(result.isError, true, JSON.stringify(result));
			assert.equal(runSyncCalls.length, 1);
		} else {
			assert.equal(runSyncCalls.length, 0, "an outgoing request cannot acquire a new owner after environment preparation");
			assert.equal(result.isError, true);
		}
	});
}

for (const transition of ["switch", "reload", "same-session"]) {
	const label = transition === "same-session" ? "a repeated session start preserves the direct child's live control"
		: `a direct detached child is cancelled when its parent ${transition === "switch" ? "switches session" : "extension is replaced"}`;
	test(label, async (t) => {
		const fixture = createFixture({}, `runtime-${transition}`);
		Object.assign(fixture.ctx.sessionManager, { getEntries: () => [], getBranch: () => [] });
		const original = host(fixture.ctx);
		let replacement;
		let child;
		const owner = new AbortController();
		t.after(async () => {
			if (child) await child.onDetachedExit(completedResult(fixture, { agent: "writable", interrupted: true, finalOutput: "CANCELLED" }));
			owner.abort();
			await original.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
			await replacement?.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
		});
		await original.emit("session_start", { type: "session_start", reason: "startup" });
		resetDoubles();
		setRunSyncBehavior(({ options }) => {
			child = options;
			return completedResult(fixture, { agent: "writable", detached: true, detachedReason: "intercom coordination", exitCode: undefined, finalOutput: undefined });
		});
		const result = await original.tools.get("subagent").execute(`cleanup-${transition}`, {
			agent: "writable", task: "Inspect the current file.", context: "fresh", acceptance: false, output: false, mission: false,
		}, owner.signal, undefined, fixture.ctx);
		assert.notEqual(result.isError, true, JSON.stringify(result));
		assert.ok(child);
		assert.equal(child.interruptSignal.aborted, false);
		if (transition === "switch") {
			fixture.ctx.sessionManager.getSessionFile = () => `${fixture.parentSessionFile}.new`;
			fixture.ctx.sessionManager.getSessionId = () => "new-parent-session";
			await original.emit("session_start", { type: "session_start", reason: "switch", previousSessionFile: fixture.parentSessionFile });
		} else if (transition === "reload") {
			replacement = host(fixture.ctx);
			await replacement.emit("session_start", { type: "session_start", reason: "reload" });
		} else {
			await original.emit("session_start", { type: "session_start", reason: "resume" });
			assert.equal(child.interruptSignal.aborted, false, "the original child remains live in the same session");
			const interrupted = await original.tools.get("subagent").execute("same-owner-interrupt", { action: "interrupt", id: child.runId }, owner.signal, undefined, fixture.ctx);
			assert.notEqual(interrupted.isError, true, "the original parent must retain its child's interrupt control");
		}
		assert.equal(child.interruptSignal.aborted, true, "the outgoing parent must cancel its direct child before losing its control");
	});
}
