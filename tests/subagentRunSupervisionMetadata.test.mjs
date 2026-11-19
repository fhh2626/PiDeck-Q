/** Automatic host reviews must not depend on the optional child conversation bridge. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { installSubagentGraphLoader } from "./helpers/subagentGraphLoader.mjs";

const modelCacheDir = mkdtempSync(join(tmpdir(), "pideck-review-metadata-models-"));
const previousExclusionsPath = process.env.PI_MODEL_EXCLUSIONS_PATH;
const previousTempRoot = process.env.PI_SUBAGENTS_TEMP_ROOT;
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const agentDir = join(modelCacheDir, "agent");
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_MODEL_EXCLUSIONS_PATH = join(modelCacheDir, "model-exclusions.json");
// Fake clock cleanup must not race with live request directories owned by another test file.
process.env.PI_SUBAGENTS_TEMP_ROOT = join(modelCacheDir, "runtime");
after(() => {
	if (previousExclusionsPath === undefined) delete process.env.PI_MODEL_EXCLUSIONS_PATH;
	else process.env.PI_MODEL_EXCLUSIONS_PATH = previousExclusionsPath;
	if (previousTempRoot === undefined) delete process.env.PI_SUBAGENTS_TEMP_ROOT;
	else process.env.PI_SUBAGENTS_TEMP_ROOT = previousTempRoot;
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	rmSync(modelCacheDir, { recursive: true, force: true });
});

installSubagentGraphLoader();
const { runSync } = await import("../resources/extensions/pideck-q-subagents/src/runs/foreground/execution.ts");
const { childSupervisorMetadata } = await import("../resources/extensions/pideck-q-subagents/src/runs/shared/child-runtime-config.ts");
const { resolveRunSupervisionMetadata } = await import("../resources/extensions/pideck-q-subagents/src/runs/shared/run-supervision-metadata.ts");
const { resolveIntercomBridge, applyIntercomBridgeToAgent } = await import("../resources/extensions/pideck-q-subagents/src/intercom/intercom-bridge.ts");
const { DEFAULT_CONTROL_CONFIG } = await import("../resources/extensions/pideck-q-subagents/src/runs/shared/subagent-control.ts");
const { RUN_SUPERVISION_INTERVAL_MS } = await import("../resources/extensions/pideck-q-subagents/src/runs/shared/run-supervision.ts");
const native = await import("../resources/extensions/pideck-q-subagents/src/intercom/native-supervisor-channel.ts");
const { shellPolicySnapshotPath } = await import("../resources/extensions/pideck-q-subagents/src/policy/environment/policySnapshot.ts");

const flush = () => new Promise((resolve) => setImmediate(resolve));

function runtimeConfig(overrides = {}) {
	return { fanoutChild: false, depth: 1, waitTool: { enabled: false }, fast: false,
		orchestratorSessionId: "owner", runId: "logical-run", agent: "worker", childIndex: 0, ...overrides };
}

test("host reviews preserve an existing manual supervisor route", () => {
	const config = Object.freeze(runtimeConfig({ supervisorChannelDir: "/existing/manual-channel", orchestratorTarget: "parent-route", intercomSessionName: "child-route" }));
	assert.deepEqual(resolveRunSupervisionMetadata(config), childSupervisorMetadata(config));
});

test("host review metadata requires a complete owner and child identity", () => {
	for (const override of [
		{ orchestratorSessionId: undefined, parentSessionId: "another-owner" }, { orchestratorSessionId: " " },
		{ runId: undefined }, { runId: "\t" }, { agent: "" }, { agent: 7 },
		{ childIndex: undefined }, { childIndex: -1 }, { childIndex: 0.5 }, { childIndex: Number.NaN },
	]) {
		assert.equal(resolveRunSupervisionMetadata(runtimeConfig(override)), undefined);
		assert.equal(resolveRunSupervisionMetadata(runtimeConfig({ ...override, supervisorChannelDir: "/manual-channel" })), undefined);
	}
});

test("derived host routes distinguish siblings without mutating child configuration", () => {
	const config = Object.freeze(runtimeConfig());
	const first = resolveRunSupervisionMetadata(config);
	const second = resolveRunSupervisionMetadata(runtimeConfig({ childIndex: 1 }));
	assert.equal(first.channelDir, native.resolveSupervisorChannelDir(config.runId, config.agent, 0));
	assert.notEqual(first.channelDir, second.channelDir);
	assert.equal(first.orchestratorSessionId, "owner");
	assert.equal(config.supervisorChannelDir, undefined);
	assert.equal(childSupervisorMetadata(config), undefined);
});

function eventBus() {
	const handlers = new Map();
	return {
		on(name, callback) { const listeners = handlers.get(name) ?? new Set(); listeners.add(callback); handlers.set(name, listeners); return () => listeners.delete(callback); },
		emit(name, value) { for (const callback of handlers.get(name) ?? []) callback(value); },
	};
}

/** Install the production hooks with the same session lifecycle the Pi SDK supplies. */
async function childToolSurface(input, sessionId) {
	const tools = new Map([["read", { name: "read" }]]);
	let active = [...tools.keys()];
	const handlers = new Map();
	const ctx = {
		cwd: input.cwd, hasUI: false,
		sessionManager: { getSessionId: () => sessionId, getSessionFile: () => undefined },
	};
	const pi = {
		events: eventBus(), registerTool(tool) { tools.set(tool.name, tool); active.push(tool.name); },
		getAllTools: () => [...tools.values()], getActiveTools: () => [...active],
		setActiveTools(names) { active = [...names]; },
		on(name, handler) { const callbacks = handlers.get(name) ?? []; callbacks.push(handler); handlers.set(name, callbacks); },
	};
	for (const hook of input.hooks) await hook.factory(pi);
	let shutdowns = 0;
	const dispose = async () => {
		if (shutdowns) return;
		shutdowns++;
		for (const handler of handlers.get("session_shutdown") ?? []) await handler({ type: "session_shutdown", reason: "quit" }, ctx);
	};
	try {
		for (const handler of handlers.get("session_start") ?? []) await handler({ type: "session_start", reason: "startup" }, ctx);
		let systemPrompt = input.systemPrompt ?? input.appendSystemPrompt ?? "Read the requested file.";
		for (const handler of handlers.get("before_agent_start") ?? []) {
			const update = await handler({ type: "before_agent_start", systemPrompt }, ctx);
			if (update?.systemPrompt !== undefined) systemPrompt = update.systemPrompt;
		}
		return { tools, systemPrompt, dispose, get active() { return [...active]; }, get shutdowns() { return shutdowns; } };
	} catch (error) {
		await dispose();
		throw error;
	}
}

/** Keep an ordinary read alive through a real native review, then complete it explicitly. */
async function startWithoutConversationBridge(t, host, mode) {
	const cwd = mkdtempSync(join(tmpdir(), "pideck-review-metadata-"));
	const runId = `review-${randomUUID()}`;
	const parentSessionId = `owner-${randomUUID()}`;
	// The launching parent has authorized this read, independently of manual contact tools.
	mkdirSync(join(agentDir, "subagents", "environment"), { recursive: true });
	writeFileSync(shellPolicySnapshotPath(agentDir, parentSessionId), JSON.stringify({
		version: 2, platform: process.platform, shell: { bash: false, powershell: false }, parentActiveTools: ["read"],
	}));
	const bridge = resolveIntercomBridge({ config: { mode }, context: "fresh", orchestratorTarget: parentSessionId, agentDir: cwd, settingsDir: cwd });
	assert.equal(bridge.active, false);
	const agent = applyIntercomBridgeToAgent({ name: "worker", description: "Offline review fixture", systemPrompt: "Read the requested file.", model: "test/model", tools: ["read"], completionGuard: false }, bridge);
	const events = eventBus();
	const parentTools = new Map();
	const state = {
		currentSessionId: parentSessionId, supervisorOwnerSessionId: parentSessionId,
		foregroundControls: new Map([[runId, { sessionId: parentSessionId }]]),
		foregroundRuns: new Map(),
		asyncJobs: new Map([]),
	};
	const idleHandle = { unref() {} };
	const channel = native.createNativeSupervisorChannel({ events, registerTool(tool) { parentTools.set(tool.name, tool); }, getAllTools: () => [...parentTools.values()], sendMessage() {} }, state, {
		platform: "win32", timers: { setInterval: () => idleHandle, clearInterval() {}, setImmediate: () => idleHandle, clearImmediate() {} },
	});
	channel.start();
	const pending = Promise.withResolvers();
	const started = Promise.withResolvers();
	const detached = Promise.withResolvers();
	const owner = new AbortController();
	let listener;
	let childInput;
	let childSurface;
	let aborts = 0;
	const child = {
		messages: [], modelId: "test/model", sessionId: `child-${randomUUID()}`,
		subscribe(callback) { listener = callback; return () => { listener = undefined; }; },
		async prompt() { listener?.({ type: "tool_execution_start", toolCallId: "read-1", toolName: "read", args: { path: "input.txt" } }); started.resolve(); await pending.promise; },
		async abort() { aborts++; pending.resolve(); }, async dispose() { await childSurface?.dispose(); }, async steer() {}, async followUp() {},
	};
	const factory = { async create(input) { childInput = input; childSurface = await childToolSurface(input, child.sessionId); return child; }, async dispose() {} };
	let result;
	{
		const receipt = runSync(cwd, [agent], "worker", "Read input.txt.", {
			cwd, runId, index: 0, parentSessionId,
			orchestratorIntercomTarget: bridge.active ? bridge.orchestratorTarget : undefined,
			allowIntercomDetach: bridge.active, intercomEvents: events, retainAbortOnDetach: true,
			acceptance: false, artifactConfig: { enabled: false }, childSessionFactory: factory, signal: owner.signal,
			controlConfig: DEFAULT_CONTROL_CONFIG, onDetachedExit(terminal) { detached.resolve(terminal); },
		});
		result = receipt.then((value) => value.detached ? detached.promise : value);
	}
	t.after(async () => {
		owner.abort(); pending.resolve(); await flush(); await childSurface?.dispose(); channel.dispose();
		rmSync(native.resolveSupervisorChannelDir(runId, "worker", 0), { recursive: true, force: true });
		rmSync(cwd, { recursive: true, force: true });
	});
	// A hook/setup rejection settles the production host before prompt() runs. Surface that
	// result instead of waiting forever for an event the failed child cannot emit.
	await Promise.race([
		started.promise,
		result.then((terminal) => { throw new Error(`Child settled before prompt startup: ${terminal.error ?? JSON.stringify(terminal)}`); }),
	]);
	return {
		result, childInput, childSurface, get aborts() { return aborts; },
		async pendingReviews() { return (await parentTools.get("subagent_supervisor").execute("pending", { action: "pending" })).details.pending; },
		async continueReview(id) { const reply = await parentTools.get("subagent_supervisor").execute("reply", { action: "reply", replyTo: id, message: "CONTINUE" }); assert.notEqual(reply.isError, true); t.mock.timers.tick(251); await flush(); },
		complete() {
			listener?.({ type: "tool_execution_end", toolCallId: "read-1", toolName: "read" });
			const message = { role: "assistant", content: [{ type: "text", text: "Read completed." }], stopReason: "stop", timestamp: Date.now() };
			child.messages.push(message); listener?.({ type: "message_end", message }); pending.resolve();
		},
	};
}

for (const host of ["foreground"]) {
	for (const mode of ["off", "fork-only"]) {
		test(`${host} automatically reviews a fresh child with intercomBridge ${mode} without enabling child contact tools`, async (t) => {
			t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
			const run = await startWithoutConversationBridge(t, host, mode);
			const originalRuntime = { ...run.childInput.runtime };
			assert.equal(originalRuntime.supervisorChannelDir, undefined);
			assert.equal(originalRuntime.orchestratorTarget, undefined);
			assert.equal(childSupervisorMetadata(originalRuntime), undefined);
			assert.equal(run.childSurface.tools.has("contact_supervisor"), false);
			assert.deepEqual(run.childSurface.active, ["read"]);
			assert.doesNotMatch(run.childSurface.systemPrompt, /contact_supervisor|INTERCOM_BRIDGE/);
			t.mock.timers.tick(RUN_SUPERVISION_INTERVAL_MS);
			await flush();
			const requests = await run.pendingReviews();
			assert.equal(requests.length, 1, "the host review must work without a child supervisor channel");
			assert.equal(requests[0].replyFormat, "run_decision");
			assert.equal(run.aborts, 0);
			await run.continueReview(requests[0].id);
			assert.deepEqual(run.childInput.runtime, originalRuntime, "host supervision must not expand child capabilities");
			run.complete();
			assert.equal((await run.result).exitCode, 0);
			assert.equal(run.childSurface.shutdowns, 1, "the host must release its captured session binding on disposal");
		});
	}
}
