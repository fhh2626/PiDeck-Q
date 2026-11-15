import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import {
	createFakePi,
	resolveBackendExecutable,
	SseClient,
	startBackendSession,
} from "./helpers/native2BackendHarness.mjs";

/**
 * Manual compaction parity: `sessions:runtime-compact`.
 *
 * Every expectation is derived from the Node oracle at this HEAD —
 * `AgentManager.compact` / `finishManualCompaction` / `reattachProcess` plus
 * `SessionRuntimeCoordinator.compactRuntime` — and asserted over the real wire
 * (`PiDeckBackend.exe` + the scriptable fake pi), never against internals:
 *
 *  - the command resolves with `SessionTargetedValue<AgentRuntimeState>`, not pi's
 *    `compact` reply (`compact()` returns `getRuntimeState(agentId)`);
 *  - a duplicate request while one is in flight resolves with the *current* state
 *    (`isCompacting:true`) and issues no second pi RPC instead of failing;
 *  - a pi process that exits during compaction is reattached under the same agentId /
 *    runtimeGeneration, its compacted history is reloaded, and the command still resolves
 *    successfully with a localized "Session compacted" row;
 *  - a real pi failure (process alive) is surfaced as a command error, and the manual
 *    gates are released so a later compaction works instead of being treated as a
 *    duplicate.
 */

const executable = resolveBackendExecutable();
const PROJECT_ID = "runtime-compact";
const slash = (value) => String(value).replaceAll("\\", "/");

/** Minimal pi session file so the catalog has a real identity to activate. */
function writeSessionFile(sessionsDir, projectPath, name) {
	const entries = [
		{ type: "session", version: 3, id: name, timestamp: "2026-01-01T00:00:00.000Z", cwd: projectPath },
		{ type: "model_change", id: "m1", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", provider: "anthropic", modelId: "claude-sonnet-4" },
		{
			type: "message",
			id: "u1",
			parentId: "m1",
			timestamp: "2026-01-01T00:00:01.000Z",
			message: { role: "user", content: [{ type: "text", text: "before" }], timestamp: 1_767_225_601_000 },
		},
		{
			type: "message",
			id: "a1",
			parentId: "u1",
			timestamp: "2026-01-01T00:00:02.000Z",
			message: { role: "assistant", content: [{ type: "text", text: "answer" }], timestamp: 1_767_225_602_000 },
		},
	];
	const path = join(sessionsDir, `${name}.jsonl`);
	writeFileSync(path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
	return path;
}

const runtimeEvents = (sse, sourceChannel) => sse.frames
	.filter((frame) => frame.payload.channel === "sessions:runtime-event")
	.map((frame) => frame.payload.args[0])
	.filter((event) => event.sourceChannel === sourceChannel);

if (!executable) {
	// Never let a missing build turn this suite into a silent pass.
	describe("native2 manual compaction parity", () => {
		test("backend executable is available", () => {
			assert.fail("PiDeckBackend.exe was not built; run xmake build -y PiDeckBackend");
		});
	});
} else {
	describe("native2 manual compaction parity", () => {
		let root;
		let projectPath;

		before(() => {
			root = mkdtempSync(join(tmpdir(), "pideck-native2-compact-"));
			projectPath = join(root, "project");
			mkdirSync(projectPath, { recursive: true });
		});

		after(() => {
			if (root) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
		});

		const start = async (t, { scenario = {}, name = "compact" } = {}) => {
			let fake = null;
			let filePath = "";
			const session = await startBackendSession(t, {
				projects: [{ id: PROJECT_ID, path: projectPath }],
				settings: { language: "en-US" },
				prepare: (fixture) => {
					filePath = writeSessionFile(
						fixture.sessions,
						projectPath,
						`${name}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
					);
					fake = createFakePi(fixture, scenario);
					return {
						settings: { customPiPath: fake.shim },
						env: { FAKE_PI_SCENARIO: fake.scenarioPath, FAKE_PI_LOG: fake.logPath },
					};
				},
			});
			const list = await session.invoke("sessions:catalog-list", [PROJECT_ID]);
			const record = list.payload.result.find((entry) => slash(entry.filePath) === slash(filePath));
			assert.ok(record, "imported session must appear in the catalog");
			const target = (await session.invoke("sessions:runtime-activate", [record.id])).payload.result.value;
			const sse = new SseClient(`${session.baseUrl}__pideck/events?token=${encodeURIComponent(session.token)}`);
			await sse.connect().catch(() => undefined);
			t.after(() => sse.close());
			const args = [{
				sessionId: record.id,
				agentId: target.agentId,
				runtimeGeneration: target.runtimeGeneration,
			}];
			return { ...session, fake, record, filePath, target, sse, args };
		};

		const waitForCondition = async (predicate, timeoutMs = 10_000) => {
			const deadline = Date.now() + timeoutMs;
			while (Date.now() < deadline) {
				if (predicate()) return;
				await new Promise((resolve) => setTimeout(resolve, 20));
			}
			assert.fail("condition was not met before the timeout");
		};

		const spawns = (fake) => fake.readLog().filter((entry) => entry.kind === "spawn");
		const sessionArg = (spawn) => {
			const index = spawn.argv.indexOf("--session");
			return index < 0 ? "" : slash(spawn.argv[index + 1]);
		};

		test("compact resolves with the agent runtime state, not pi's reply", async (t) => {
			const { invoke, record, args } = await start(t, {
				scenario: {
					state: {
						model: { provider: "anthropic", id: "claude-sonnet-4", name: "Sonnet 4" },
						thinkingLevel: "high",
					},
					responses: { compact: { data: { summary: "compacted", firstKeptEntryId: null } } },
				},
			});
			const result = (await invoke("sessions:runtime-compact", args)).payload.result;
			assert.equal(result.ok, true, JSON.stringify(result));
			// Oracle `SessionRuntimeCoordinator.runTargetCommand`: {target, value}.
			assert.deepEqual(result.value.target, {
				sessionId: record.id,
				agentId: args[0].agentId,
				runtimeGeneration: args[0].runtimeGeneration,
			});
			// Oracle `compact()` returns `getRuntimeState(agentId)` — the AgentRuntimeState is
			// the pi state merged with the tab, never pi's own `compact` payload.
			const state = result.value.value;
			assert.equal(state.modelName, "Sonnet 4", JSON.stringify(state));
			assert.equal(state.provider, "anthropic");
			assert.equal(state.modelId, "claude-sonnet-4");
			assert.equal(state.thinkingLevel, "high");
			assert.equal(state.isStreaming, false);
			assert.equal(state.isCompacting, false);
			assert.equal(state.isExecutingTool, false);
			for (const piOnly of ["summary", "firstKeptEntryId", "sessionId", "sessionFile"]) {
				assert.equal(piOnly in state, false, `pi reply field leaked into the command value: ${piOnly}`);
			}
		});

		test("a duplicate compact resolves with the in-flight state and issues one pi RPC", async (t) => {
			const { invoke, fake, args } = await start(t, {
				scenario: { responses: { compact: { delayMs: 1_500, data: { summary: "ok" } } } },
			});
			const first = invoke("sessions:runtime-compact", args);
			await waitForCondition(() => fake.commands().some((entry) => entry.command === "compact"));
			const duplicate = (await invoke("sessions:runtime-compact", args)).payload.result;
			// Oracle: `return this.getRuntimeState(agentId)` — a resolved, not a failed, command.
			assert.equal(duplicate.ok, true, JSON.stringify(duplicate));
			assert.equal(duplicate.value.target.agentId, args[0].agentId);
			// Oracle `getRuntimeState`: isCompacting = pi flag || rpcCompactingAgents ||
			// compactingAgents, so the duplicate must report the running compaction.
			assert.equal(duplicate.value.value.isCompacting, true, JSON.stringify(duplicate.value.value));
			assert.equal(fake.commands().filter((entry) => entry.command === "compact").length, 1);
			assert.equal((await first).payload.result.ok, true);
		});

		test("pi exiting during compaction is reattached under the same agentId", async (t) => {
			const { invoke, fake, record, args, sse, target } = await start(t, {
				scenario: { responses: { compact: { exitBeforeReply: true } } },
			});
			const result = (await invoke("sessions:runtime-compact", args)).payload.result;
			assert.equal(result.ok, true, JSON.stringify(result));
			// Same runtime identity: the renderer's target stays valid (no new generation).
			assert.deepEqual(result.value.target, {
				sessionId: record.id,
				agentId: target.agentId,
				runtimeGeneration: target.runtimeGeneration,
			});
			assert.equal(result.value.value.modelId, "claude-sonnet-4");

			// Exactly one replacement process, on the same session file.
			const all = spawns(fake);
			assert.equal(all.length, 2, `expected one reattach, saw ${all.length} spawns`);
			assert.equal(all[0].env.PIDECK_SESSION_ID, record.id);
			assert.equal(all[1].env.PIDECK_SESSION_ID, record.id);
			assert.equal(sessionArg(all[0]), slash(sessionArg(all[1])), "reattach must reuse the session file");
			assert.equal(sessionArg(all[1]).endsWith(".jsonl"), true);

			// The renderer must not be told the runtime detached: it is the same runtime.
			assert.deepEqual(runtimeEvents(sse, "sessions:runtime-detach"), []);
			const list = (await invoke("sessions:runtime-list")).payload.result;
			const entry = list.find((candidate) => candidate.sessionId === record.id);
			assert.ok(entry, JSON.stringify(list));
			assert.equal(entry.agentId, target.agentId);
			assert.equal(entry.runtimeGeneration, target.runtimeGeneration);
			assert.equal(entry.status, "idle");

			// The compacted history is re-read from the session file by the new process.
			const log = fake.readLog();
			const firstSpawn = log.findIndex((item) => item.kind === "spawn");
			const secondSpawn = log.findIndex((item, index) => item.kind === "spawn" && index > firstSpawn);
			assert.ok(secondSpawn > firstSpawn, "reattach must spawn a replacement process");
			assert.ok(log.slice(secondSpawn).some((item) => item.kind === "command" && item.command === "get_messages"),
				"reattach must reload the history through the new process");

			// Oracle `addLocalizedMessage(..., "diagnostic.compactDone", ...)`.
			await waitForCondition(() => sse.frames.some((frame) => frame.payload.channel === "sessions:runtime-event"
				&& frame.payload.args[0].sourceChannel === "agents:message"
				&& JSON.stringify(frame.payload.args[0].payload.messages ?? []).includes("Session compacted")));

			// The replacement process is the one serving commands now.
			const promptsBefore = fake.commands().filter((item) => item.command === "prompt").length;
			await invoke("sessions:send-prompt", [{
				...args[0],
				requestId: "after-reattach",
				message: "still here?",
			}]);
			await waitForCondition(() => fake.commands().filter((item) => item.command === "prompt").length > promptsBefore);
			const after = (await invoke("sessions:runtime-list")).payload.result
				.find((candidate) => candidate.sessionId === record.id);
			assert.equal(after.runtimeGeneration, target.runtimeGeneration);
		});

		test("a compaction failure is reported and releases the manual gates", async (t) => {
			const { invoke, fake, record, args } = await start(t, {
				// First attempt fails like pi's "nothing to compact", the retry succeeds.
				scenario: {
					responses: { compact: [{ error: "nothing to compact" }, { data: { summary: "ok" } }] },
				},
			});
			const failed = (await invoke("sessions:runtime-compact", args)).payload.result;
			assert.equal(failed.ok, false, JSON.stringify(failed));
			assert.match(String(failed.error.debugDetails), /nothing to compact/);
			// The renderer maps this message to the friendly "nothing to do" toast.
			assert.equal(spawns(fake).length, 1, "a pi-level failure must not reattach");

			const list = (await invoke("sessions:runtime-list")).payload.result;
			const entry = list.find((candidate) => candidate.sessionId === record.id);
			assert.equal(entry.status, "idle", "a failed compaction must not stay busy");

			// The gate is released: a second compact reaches pi again instead of resolving as
			// a duplicate of a compaction that already failed.
			const retried = (await invoke("sessions:runtime-compact", args)).payload.result;
			assert.equal(retried.ok, true, JSON.stringify(retried));
			assert.equal(fake.commands().filter((item) => item.command === "compact").length, 2);
			assert.equal(retried.value.value.isCompacting, false, JSON.stringify(retried.value.value));
		});

		test("aborting during a compaction settles the command once", async (t) => {
			const { invoke, fake, args } = await start(t, {
				scenario: { responses: { compact: { delayMs: 600, error: "Compaction aborted" } } },
			});
			const compacted = invoke("sessions:runtime-compact", args);
			await waitForCondition(() => fake.commands().some((entry) => entry.command === "compact"));
			const aborted = (await invoke("sessions:runtime-abort", args)).payload.result;
			assert.equal(aborted.ok, true, JSON.stringify(aborted));
			const result = (await compacted).payload.result;
			assert.equal(result.ok, false, JSON.stringify(result));
			assert.match(String(result.error.debugDetails), /Compaction aborted/);
			// One compact RPC, one spawn: the abort must not make the command reattach.
			assert.equal(fake.commands().filter((entry) => entry.command === "compact").length, 1);
			assert.equal(spawns(fake).length, 1);
		});

		test("quitting during a compaction ACKs inside the host budget", async (t) => {
			const { host, backend, invoke, args } = await start(t, {
				scenario: { responses: { compact: { delayMs: 10_000, data: { summary: "late" } } } },
			});
			const pending = invoke("sessions:runtime-compact", args).catch(() => undefined);
			const started = Date.now();
			host.emit("application.prepareQuit", {});
			await host.waitForEvent("application.readyToExit", 10_000);
			const elapsed = Date.now() - started;
			// The Qt host force-kills the job object 1500 ms after prepareQuit.
			assert.ok(elapsed < 1_500, `shutdown took ${elapsed} ms, host budget is 1500 ms`);
			const exit = await backend.exited;
			assert.equal(exit.code, 0, `stderr: ${exit.stderr}`);
			await pending;
		});
	});
}
