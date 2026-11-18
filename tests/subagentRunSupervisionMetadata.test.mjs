/** Automatic host reviews must not depend on the optional child conversation bridge. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { installSubagentGraphLoader } from "./helpers/subagentGraphLoader.mjs";

const modelCacheDir = mkdtempSync(join(tmpdir(), "pideck-review-metadata-models-"));
const previousExclusionsPath = process.env.PI_MODEL_EXCLUSIONS_PATH;
const previousTempRoot = process.env.PI_SUBAGENTS_TEMP_ROOT;
process.env.PI_MODEL_EXCLUSIONS_PATH = join(modelCacheDir, "model-exclusions.json");
// Fake clock cleanup must not race with live request directories owned by another test file.
process.env.PI_SUBAGENTS_TEMP_ROOT = join(modelCacheDir, "runtime");
after(() => {
	if (previousExclusionsPath === undefined) delete process.env.PI_MODEL_EXCLUSIONS_PATH;
	else process.env.PI_MODEL_EXCLUSIONS_PATH = previousExclusionsPath;
	if (previousTempRoot === undefined) delete process.env.PI_SUBAGENTS_TEMP_ROOT;
	else process.env.PI_SUBAGENTS_TEMP_ROOT = previousTempRoot;
	rmSync(modelCacheDir, { recursive: true, force: true });
});

installSubagentGraphLoader();
const { runSync } = await import("../resources/extensions/pideck-q-subagents/src/runs/foreground/execution.ts");
const { runChildSession } = await import("../resources/extensions/pideck-q-subagents/src/runs/background/run-child-session.ts");
const { buildInProcessChildLaunch } = await import("../resources/extensions/pideck-q-subagents/src/runs/shared/child-launch.ts");
const { childSupervisorMetadata } = await import("../resources/extensions/pideck-q-subagents/src/runs/shared/child-runtime-config.ts");
const { resolveRunSupervisionMetadata } = await import("../resources/extensions/pideck-q-subagents/src/runs/shared/run-supervision-metadata.ts");
const { resolveIntercomBridge, applyIntercomBridgeToAgent } = await import("../resources/extensions/pideck-q-subagents/src/intercom/intercom-bridge.ts");
const { DEFAULT_CONTROL_CONFIG } = await import("../resources/extensions/pideck-q-subagents/src/runs/shared/subagent-control.ts");
const { RUN_SUPERVISION_INTERVAL_MS } = await import("../resources/extensions/pideck-q-subagents/src/runs/shared/run-supervision.ts");
const native = await import("../resources/extensions/pideck-q-subagents/src/intercom/native-supervisor-channel.ts");

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

/** Install the production child hooks and inspect their public tool and prompt output. */
async function childToolSurface(input) {
	const tools = new Map([["read", { name: "read" }]]);
	const handlers = new Map();
	const pi = {
		events: eventBus(), registerTool(tool) { tools.set(tool.name, tool); },
		getAllTools: () => [...tools.values()], getActiveTools: () => [...tools.keys()],
		on(name, handler) { const callbacks = handlers.get(name) ?? []; callbacks.push(handler); handlers.set(name, callbacks); },
	};
	for (const hook of input.hooks) await hook.factory(pi);
	let systemPrompt = input.systemPrompt ?? input.appendSystemPrompt ?? "Read the requested file.";
	for (const handler of handlers.get("before_agent_start") ?? []) {
		const update = await handler({ systemPrompt });
		if (update?.systemPrompt !== undefined) systemPrompt = update.systemPrompt;
	}
	return { tools, systemPrompt };
}

/** Keep an ordinary read alive through a real native review, then complete it explicitly. */
async function startWithoutConversationBridge(t, host, mode) {
	const cwd = mkdtempSync(join(tmpdir(), "pideck-review-metadata-"));
	const runId = `review-${randomUUID()}`;
	const parentSessionId = `owner-${randomUUID()}`;
	const bridge = resolveIntercomBridge({ config: { mode }, context: "fresh", orchestratorTarget: parentSessionId, agentDir: cwd, settingsDir: cwd });
	assert.equal(bridge.active, false);
	const agent = applyIntercomBridgeToAgent({ name: "worker", description: "Offline review fixture", systemPrompt: "Read the requested file.", model: "test/model", tools: ["read"], completionGuard: false }, bridge);
	const events = eventBus();
	const parentTools = new Map();
	const state = {
		currentSessionId: parentSessionId, supervisorOwnerSessionId: parentSessionId,
		foregroundControls: new Map(host === "foreground" ? [[runId, { sessionId: parentSessionId }]] : []),
		foregroundRuns: new Map(),
		asyncJobs: new Map(host === "background" ? [[runId, { status: "running", steps: [{ status: "running", agent: "worker" }] }]] : []),
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
		async abort() { aborts++; pending.resolve(); }, async dispose() {}, async steer() {}, async followUp() {},
	};
	const factory = { async create(input) { childInput = input; childSurface = await childToolSurface(input); return child; }, async dispose() {} };
	let result;
	if (host === "foreground") {
		const receipt = runSync(cwd, [agent], "worker", "Read input.txt.", {
			cwd, runId, index: 0, parentSessionId,
			orchestratorIntercomTarget: bridge.active ? bridge.orchestratorTarget : undefined,
			allowIntercomDetach: bridge.active, intercomEvents: events, retainAbortOnDetach: true,
			acceptance: false, artifactConfig: { enabled: false }, childSessionFactory: factory, signal: owner.signal,
			controlConfig: DEFAULT_CONTROL_CONFIG, onDetachedExit(terminal) { detached.resolve(terminal); },
		});
		result = receipt.then((value) => value.detached ? detached.promise : value);
	} else {
		const launch = buildInProcessChildLaunch({ cwd, host: "runner", parentSessionId, runId, childAgentName: "worker", childIndex: 0,
			orchestratorIntercomTarget: bridge.active ? bridge.orchestratorTarget : undefined,
			sessionEnabled: false, inheritProjectContext: false, inheritGlobalContext: false, inheritSkills: false, systemPrompt: agent.systemPrompt, tools: agent.tools, model: agent.model,
		});
		result = runChildSession({ factory, launch, prompt: "Read input.txt.", appendChildEvent() {}, writeOutputLine() {}, runSupervisionEnabled: true });
	}
	t.after(async () => {
		owner.abort(); pending.resolve(); await flush(); channel.dispose();
		rmSync(native.resolveSupervisorChannelDir(runId, "worker", 0), { recursive: true, force: true });
		rmSync(cwd, { recursive: true, force: true });
	});
	await started.promise;
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

for (const host of ["foreground", "background"]) {
	for (const mode of ["off", "fork-only"]) {
		test(`${host} automatically reviews a fresh child with intercomBridge ${mode} without enabling child contact tools`, async (t) => {
			t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
			const run = await startWithoutConversationBridge(t, host, mode);
			const originalRuntime = { ...run.childInput.runtime };
			assert.equal(originalRuntime.supervisorChannelDir, undefined);
			assert.equal(originalRuntime.orchestratorTarget, undefined);
			assert.equal(childSupervisorMetadata(originalRuntime), undefined);
			assert.equal(run.childSurface.tools.has("contact_supervisor"), false);
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
		});
	}
}
