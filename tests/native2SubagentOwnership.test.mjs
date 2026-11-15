import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { after, before, describe, test } from "node:test";
import {
	createFakePi,
	resolveBackendExecutable,
	SseClient,
	startBackendSession,
} from "./helpers/native2BackendHarness.mjs";

/**
 * Subagent execution ownership + timer-driven expiry (native2).
 *
 * Oracle: `src/main/pi/SubagentExecutionOwnership.ts`, `SubagentRunTracker.ts` and
 * `SubagentExpiryScheduler.ts`. Everything here is asserted over the real wire:
 * `PiDeckBackend.exe`, the scriptable fake pi and the renderer SSE envelopes
 * (`sessions:runtime-event` -> `agents:subagent-status`). Nothing imports backend source.
 *
 * Why the TTL overrides: the oracle expires a vanished heartbeat after 30 s and a running
 * row after 10 min. A black-box gate cannot wait that long, so the backend exposes
 * test-only env overrides for those three TTLs (`SubagentRuns::limitsFromEnvironment`);
 * production keeps the oracle constants.
 */

const executable = resolveBackendExecutable();
const PROJECT_ID = "subagent-ownership";
const slash = (value) => String(value).replaceAll("\\", "/");

/** Long TTLs by default: a scenario must not race a timer unless the test asks for it. */
const NO_EXPIRY = {
	PIDECK_SUBAGENT_SNAPSHOT_STALE_MS: "600000",
	PIDECK_SUBAGENT_RUNNING_TTL_MS: "600000",
	PIDECK_SUBAGENT_ERROR_TTL_MS: "600000",
};

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
			message: { role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1_767_225_601_000 },
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

/** Published subagent projections, in arrival order. */
const subagentFrames = (sse) => runtimeEvents(sse, "agents:subagent-status").map((event) => event.payload.runs);

const paths = (runs) => runs.map((run) => slash(run.sessionFile)).sort();
const rowFor = (runs, sessionFile) => runs.find((run) => slash(run.sessionFile) === slash(sessionFile));

/** Waits until one published projection satisfies `predicate` (or fails loudly). */
async function waitForRuns(sse, predicate, timeoutMs = 10_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const frames = subagentFrames(sse);
		const match = frames.find(predicate);
		if (match) return match;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	assert.fail(`no subagent projection matched before ${timeoutMs} ms: ${JSON.stringify(subagentFrames(sse))}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function statusFrame(phase, workflowRunId, sequence, children, extras = {}) {
	return {
		event: {
			type: "extension_ui_request",
			id: `status-${phase}`,
			method: "setStatus",
			statusKey: `pideck.subagent-status.v1:${workflowRunId}`,
			statusText: JSON.stringify({
				version: 1,
				ownerSessionId: extras.ownerSessionId ?? extras.sessionPath,
				parentToolCallId: "tool-1",
				workflowRunId,
				sequence,
				complete: extras.complete ?? false,
				truncated: extras.truncated ?? false,
				observedAt: 1_767_225_600_000,
				children,
			}),
		},
	};
}

const clearFrame = (phase, workflowRunId) => ({
	event: {
		type: "extension_ui_request",
		id: `status-${phase}`,
		method: "setStatus",
		statusKey: `pideck.subagent-status.v1:${workflowRunId}`,
		statusText: "",
	},
});

if (!executable) {
	describe("native2 subagent ownership", () => {
		test("backend executable is available", () => {
			assert.fail("PiDeckBackend.exe was not built; run xmake build -y PiDeckBackend");
		});
	});
} else {
	describe("native2 subagent ownership", () => {
		let root;
		let projectPath;

		before(() => {
			root = mkdtempSync(join(tmpdir(), "pideck-native2-subagents-"));
			projectPath = join(root, "project");
			mkdirSync(projectPath, { recursive: true });
		});

		after(() => {
			if (root) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
		});

		/**
		 * Start a backend, import one session, activate it and run one prompt whose fake pi
		 * emits `events` (owner-relative `setStatus` frames are built with `sessionPath`).
		 */
		const start = async (t, { events, env = {}, name = "ownership", sessionDir = null } = {}) => {
			let fake = null;
			let filePath = "";
			const sessionRoot = sessionDir ?? null;
			const session = await startBackendSession(t, {
				projects: [{ id: PROJECT_ID, path: projectPath }],
				settings: { language: "en-US" },
				prepare: (fixture) => {
					if (sessionRoot) mkdirSync(sessionRoot, { recursive: true });
					filePath = writeSessionFile(
						sessionRoot ?? fixture.sessions,
						projectPath,
						`${name}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
					);
					const resolved = events(filePath);
					fake = createFakePi(fixture, { turns: [{ ack: true, events: resolved }] });
					return {
						settings: { customPiPath: fake.shim },
						env: {
							...(sessionRoot ? { PIDECK_SESSIONS_DIR: sessionRoot } : {}),
							FAKE_PI_SCENARIO: fake.scenarioPath,
							FAKE_PI_LOG: fake.logPath,
							...NO_EXPIRY,
							...env,
						},
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

		const sendTurn = async ({ invoke, record, target }) => {
			const sent = await invoke("sessions:send-prompt", [{
				sessionId: record.id,
				requestId: "subagent-ownership-turn",
				message: "run a subagent",
				agentId: target.agentId,
				runtimeGeneration: target.runtimeGeneration,
			}]);
			assert.equal(sent.payload.result.accepted, true, JSON.stringify(sent.payload));
		};

		test("a vanished heartbeat expires on the runtime timer with no further pi event", async (t) => {
			const child = join(projectPath, "timer-heartbeat.jsonl");
			const context = await start(t, {
				name: "timer-heartbeat",
				env: { PIDECK_SUBAGENT_SNAPSHOT_STALE_MS: "400" },
				events: (sessionPath) => [
					{ event: { type: "agent_start" } },
					statusFrame("h1", "wf-1", 1, [
						{ taskKey: "k1", sessionFile: child, state: "running", agent: "researcher", executionId: "exec-1" },
					], { sessionPath }),
				],
			});
			const { sse, fake } = context;
			await sendTurn(context);
			await waitForRuns(sse, (runs) => runs.length === 1 && rowFor(runs, child)?.status === "running");

			// Nothing else is scripted for this runtime: only the deadline timer can publish
			// the cleanup, so an empty projection here proves timer-driven expiry.
			const commandsAtHeartbeat = fake.commands().length;
			const startedAt = Date.now();
			await waitForRuns(sse, (runs) => runs.length === 0);
			const elapsed = Date.now() - startedAt;
			assert.ok(elapsed >= 300, `expiry must wait for the TTL, took ${elapsed} ms`);
			assert.equal(fake.commands().length, commandsAtHeartbeat,
				"expiry must not need another pi round trip");

			const beforeIdle = subagentFrames(sse).length;
			await sleep(1_000);
			assert.equal(subagentFrames(sse).length, beforeIdle,
				`an expired projection must disarm the timer: ${JSON.stringify(subagentFrames(sse))}`);
		});

		test("timer expiry keeps failure rows and drops only the stale running row", async (t) => {
			const running = join(projectPath, "ttl-running.jsonl");
			const failed = join(projectPath, "ttl-error.jsonl");
			const context = await start(t, {
				name: "timer-ttl",
				env: { PIDECK_SUBAGENT_RUNNING_TTL_MS: "400", PIDECK_SUBAGENT_ERROR_TTL_MS: "600000" },
				events: (sessionPath) => [
					{ event: { type: "agent_start" } },
					statusFrame("t1", "wf-1", 1, [
						{ taskKey: "run", sessionFile: running, state: "running", agent: "researcher", executionId: "exec-run" },
						{ taskKey: "fail", sessionFile: failed, state: "failed", agent: "researcher", executionId: "exec-fail" },
					], { sessionPath }),
				],
			});
			const { sse } = context;
			await sendTurn(context);
			await waitForRuns(sse, (runs) => rowFor(runs, running)?.status === "running" && rowFor(runs, failed)?.status === "error");

			const afterRunningTtl = await waitForRuns(sse, (runs) => rowFor(runs, running) === undefined && runs.length === 1);
			assert.equal(rowFor(afterRunningTtl, failed).status, "error",
				`failures live on their own 30 minute TTL: ${JSON.stringify(afterRunningTtl)}`);

			// The failure deadline is 10 minutes away: the timer must not keep firing.
			const beforeIdle = subagentFrames(sse).length;
			await sleep(700);
			assert.equal(subagentFrames(sse).length, beforeIdle, JSON.stringify(subagentFrames(sse)));
		});

		test("a failure row expires by its own deadline without new events", async (t) => {
			const failed = join(projectPath, "timer-error.jsonl");
			const context = await start(t, {
				name: "timer-error",
				env: { PIDECK_SUBAGENT_ERROR_TTL_MS: "400" },
				events: (sessionPath) => [
					{ event: { type: "agent_start" } },
					statusFrame("e1", "wf-1", 1, [
						{ taskKey: "fail", sessionFile: failed, state: "failed", agent: "researcher", executionId: "exec-fail" },
					], { sessionPath }),
				],
			});
			const { sse } = context;
			await sendTurn(context);
			await waitForRuns(sse, (runs) => rowFor(runs, failed)?.status === "error");
			await waitForRuns(sse, (runs) => runs.length === 0);
		});

		test("an old execution cannot reclaim a reused path and a foreign owner never lights it", async (t) => {
			const reused = join(projectPath, "reused.jsonl");
			const foreignPath = join(projectPath, "foreign-owner.jsonl");
			const context = await start(t, {
				name: "path-reuse",
				events: (sessionPath) => [
					{ event: { type: "agent_start" } },
					statusFrame("r1", "wf-a", 1, [
						{ taskKey: "old", sessionFile: reused, state: "failed", agent: "old", executionId: "z-old" },
					], { sessionPath }),
					statusFrame("r2", "wf-b", 1, [
						{ taskKey: "resume", sessionFile: reused, state: "running", agent: "resume", executionId: "a-new" },
					], { sessionPath }),
					// Late heartbeat of the retired attempt (same path, same opaque id).
					statusFrame("r3", "wf-a", 2, [
						{ taskKey: "old", sessionFile: reused, state: "failed", agent: "old", executionId: "z-old" },
					], { sessionPath }),
					// Legacy frame without ids resolves to the same retired attempt.
					statusFrame("r4", "wf-a", 3, [
						{ taskKey: "old", sessionFile: reused, state: "running", agent: "ghost" },
					], { sessionPath }),
					// Another session file's publisher must not light this sidebar.
					statusFrame("r5", "wf-c", 1, [
						{ taskKey: "foreign", sessionFile: foreignPath, state: "running", agent: "foreign" },
					], { sessionPath, ownerSessionId: join(root, "other-session.jsonl") }),
				],
			});
			const { sse } = context;
			await sendTurn(context);
			const resumed = await waitForRuns(sse, (runs) => rowFor(runs, reused)?.agent === "resume");
			assert.equal(rowFor(resumed, reused).status, "running");

			await sleep(600);
			const frames = subagentFrames(sse);
			const resumedAt = frames.findIndex((runs) => rowFor(runs, reused)?.agent === "resume");
			assert.ok(resumedAt >= 0, JSON.stringify(frames));
			for (const runs of frames.slice(resumedAt)) {
				assert.equal(rowFor(runs, reused)?.status, "running", `retired attempt revived a row: ${JSON.stringify(runs)}`);
				assert.equal(rowFor(runs, reused)?.agent, "resume", JSON.stringify(runs));
			}
			for (const runs of frames) {
				assert.equal(rowFor(runs, foreignPath), undefined, `foreign owner lit a row: ${JSON.stringify(runs)}`);
				assert.equal(rowFor(runs, reused)?.agent === "ghost", false, JSON.stringify(runs));
			}
			// The old failure is still readable before the resume took over the path.
			assert.ok(frames.some((runs) => rowFor(runs, reused)?.status === "error"), JSON.stringify(frames));
		});

		test("duplicate sequences are ignored and a completed workflow cannot reopen", async (t) => {
			const child = join(projectPath, "fenced.jsonl");
			const context = await start(t, {
				name: "fence",
				events: (sessionPath) => [
					{ event: { type: "agent_start" } },
					statusFrame("f1", "wf-1", 1, [
						{ taskKey: "k1", sessionFile: child, state: "running", agent: "first" },
					], { sessionPath }),
					// Same sequence: a replay must not be applied (would otherwise paint red).
					// Legacy ids on purpose: only the sequence fence can reject this frame.
					statusFrame("f2", "wf-1", 1, [
						{ taskKey: "k1", sessionFile: child, state: "failed", agent: "duplicate" },
					], { sessionPath }),
					statusFrame("f3", "wf-1", 2, [], { sessionPath, complete: true }),
					// Higher sequence after `complete`: the task is closed for good.
					statusFrame("f4", "wf-1", 3, [
						{ taskKey: "k1", sessionFile: child, state: "running", agent: "reopened" },
					], { sessionPath }),
					// Replayed final frame.
					statusFrame("f5", "wf-1", 2, [], { sessionPath, complete: true }),
				],
			});
			const { sse } = context;
			await sendTurn(context);
			await waitForRuns(sse, (runs) => runs.length === 0);
			await sleep(500);
			const frames = subagentFrames(sse);
			assert.deepEqual(frames.at(0), [{ sessionFile: child, status: "running", agent: "first", updatedAt: frames[0][0].updatedAt }]);
			assert.equal(frames.filter((runs) => runs.length === 0).length, 1, JSON.stringify(frames));
			for (const runs of frames) {
				assert.equal(runs.some((run) => run.status === "error"), false, JSON.stringify(runs));
				assert.equal(runs.some((run) => run.agent === "reopened"), false, JSON.stringify(runs));
			}
		});

		test("complete wins over truncated, and an invalid child row never closes a live row", async (t) => {
			const live = join(projectPath, "live.jsonl");
			const queued = join(projectPath, "queued.jsonl");
			const finalChild = join(projectPath, "final.jsonl");
			const context = await start(t, {
				name: "truncated",
				events: (sessionPath) => [
					{ event: { type: "agent_start" } },
					statusFrame("c1", "wf-a", 1, [
						{ taskKey: "keep", sessionFile: live, state: "running", agent: "keep", executionId: "exec-keep" },
					], { sessionPath }),
					// The invalid row is dropped (frame becomes truncated): it must not be read
					// as "this child is terminal", which would close the live row.
					statusFrame("c2", "wf-b", 1, [
						{ taskKey: "bad", sessionFile: live, state: "bogus", agent: "bad" },
						{ taskKey: "q", sessionFile: queued, state: "running", agent: "queued", executionId: "exec-q" },
					], { sessionPath }),
					// A valid terminal child closes the row.
					statusFrame("c3", "wf-c", 1, [
						{ taskKey: "keep", sessionFile: live, state: "completed", agent: "keep", executionId: "exec-keep" },
					], { sessionPath }),
					statusFrame("c4", "wf-d", 1, [
						{ taskKey: "final", sessionFile: finalChild, state: "running", agent: "final", executionId: "exec-final" },
					], { sessionPath }),
					// `complete` is a final inventory even when the publisher also reports that the
					// row list was truncated (oracle deletes the omitted owned rows).
					statusFrame("c5", "wf-d", 2, [], { sessionPath, complete: true, truncated: true }),
				],
			});
			const { sse } = context;
			await sendTurn(context);
			// The dropped row leaves the frame truncated, so the live row survives it.
			await waitForRuns(sse, (runs) => rowFor(runs, live)?.status === "running" && rowFor(runs, queued)?.status === "running");
			await waitForRuns(sse, (runs) => rowFor(runs, live) === undefined && runs.length === 1);
			const afterComplete = await waitForRuns(sse, (runs) => rowFor(runs, finalChild) === undefined);
			assert.equal(afterComplete.length, 1, JSON.stringify(afterComplete));
			assert.equal(afterComplete[0].status, "running", JSON.stringify(afterComplete));
			const frames = subagentFrames(sse);
			assert.ok(frames.some((runs) => paths(runs).includes(slash(live)) && paths(runs).includes(slash(queued))),
				`the invalid row must not close the live row: ${JSON.stringify(frames)}`);
			assert.ok(frames.some((runs) => paths(runs).includes(slash(finalChild))), JSON.stringify(frames));
			assert.deepEqual(paths(frames.at(-1)), [slash(queued)], JSON.stringify(frames.at(-1)));
		});

		test("explicit clear closes only its own workflow and preserves failures", async (t) => {
			const failed = join(projectPath, "clear-error.jsonl");
			const cleared = join(projectPath, "clear-running.jsonl");
			const legacy = join(projectPath, "clear-legacy.jsonl");
			const context = await start(t, {
				name: "clear",
				events: (sessionPath) => [
					{ event: { type: "agent_start" } },
					statusFrame("x1", "wf-a", 1, [
						{ taskKey: "fail", sessionFile: failed, state: "failed", agent: "researcher", executionId: "exec-fail" },
					], { sessionPath }),
					statusFrame("x2", "wf-b", 1, [
						{ taskKey: "run", sessionFile: cleared, state: "running", agent: "researcher", executionId: "exec-run" },
					], { sessionPath }),
					// Id-less publisher: after the clear only the closed fence can keep it dark.
					statusFrame("x3", "wf-c", 1, [
						{ taskKey: "legacy", sessionFile: legacy, state: "running", agent: "legacy" },
					], { sessionPath }),
					clearFrame("x4", "wf-b"),
					clearFrame("x5", "wf-c"),
					// The cleared tasks are closed: later heartbeats cannot reopen them.
					statusFrame("x6", "wf-b", 2, [
						{ taskKey: "run", sessionFile: cleared, state: "running", agent: "revived", executionId: "exec-run" },
					], { sessionPath }),
					statusFrame("x7", "wf-c", 2, [
						{ taskKey: "legacy", sessionFile: legacy, state: "running", agent: "legacy-revived" },
					], { sessionPath }),
				],
			});
			const { sse } = context;
			await sendTurn(context);
			await waitForRuns(sse, (runs) => rowFor(runs, cleared) === undefined
				&& rowFor(runs, legacy) === undefined && runs.length === 1);
			await sleep(400);
			const frames = subagentFrames(sse);
			assert.ok(frames.some((runs) => rowFor(runs, cleared)?.status === "running"), JSON.stringify(frames));
			assert.ok(frames.some((runs) => rowFor(runs, legacy)?.status === "running"), JSON.stringify(frames));
			assert.equal(rowFor(frames.at(-1), failed).status, "error", JSON.stringify(frames.at(-1)));
			for (const runs of frames) {
				assert.equal(rowFor(runs, cleared)?.agent === "revived", false, JSON.stringify(runs));
				assert.equal(rowFor(runs, legacy)?.agent === "legacy-revived", false, JSON.stringify(runs));
			}
		});

		test("a project-relative ownerSessionId is resolved before the identity gate", async (t) => {
			// pi can keep its session files inside the project (`<project>/.pi/sessions`). Only in
			// that layout can a relative owner id name this runtime's session, which is exactly
			// the case the oracle resolves (`toAbsoluteSessionPath(ownerSessionId, projectPath)`)
			// and a raw comparison drops.
			const sessionDir = join(projectPath, ".pi", "sessions");
			const relativeChild = join(projectPath, "relative-owner.jsonl");
			const foreignChild = join(projectPath, "foreign-owner.jsonl");
			const context = await start(t, {
				name: "relative-owner",
				sessionDir,
				events: (sessionPath) => [
					{ event: { type: "agent_start" } },
					statusFrame("rel1", "wf-abs", 1, [
						{ taskKey: "abs", sessionFile: relativeChild, state: "running", agent: "absolute", executionId: "exec-abs" },
					], { sessionPath }),
					// Same session, project-relative id: this must publish.
					statusFrame("rel2", "wf-rel", 1, [
						{ taskKey: "rel", sessionFile: relativeChild, state: "running", agent: "relative-owner", executionId: "exec-rel" },
					], { ownerSessionId: relative(projectPath, sessionPath) }),
					// Relative but resolving to another session under the same root: still foreign.
					statusFrame("rel3", "wf-foreign", 1, [
						{ taskKey: "foreign", sessionFile: foreignChild, state: "running", agent: "foreign", executionId: "exec-foreign" },
					], { ownerSessionId: relative(projectPath, join(sessionDir, "other-session.jsonl")) }),
				],
			});
			const { sse } = context;
			await sendTurn(context);
			const runs = await waitForRuns(sse, (published) => rowFor(published, relativeChild)?.agent === "relative-owner");
			assert.equal(rowFor(runs, relativeChild).status, "running", JSON.stringify(runs));
			// The foreign relative publisher stays dark in every frame, including the last one.
			await sleep(300);
			for (const frame of subagentFrames(sse)) {
				assert.equal(rowFor(frame, foreignChild), undefined, JSON.stringify(frame));
			}
		});

		test("a stopped runtime leaves no expiry frame behind", async (t) => {
			const child = join(projectPath, "stopped.jsonl");
			const context = await start(t, {
				name: "stopped",
				env: { PIDECK_SUBAGENT_SNAPSHOT_STALE_MS: "400" },
				events: (sessionPath) => [
					{ event: { type: "agent_start" } },
					statusFrame("s1", "wf-1", 1, [
						{ taskKey: "k1", sessionFile: child, state: "running", agent: "researcher", executionId: "exec-1" },
					], { sessionPath }),
				],
			});
			const { sse, invoke, args } = context;
			await sendTurn(context);
			await waitForRuns(sse, (runs) => rowFor(runs, child)?.status === "running");
			const beforeStop = subagentFrames(sse).length;
			const stopped = await invoke("sessions:runtime-stop", [args[0]]);
			assert.equal(stopped.payload.result.ok, true, JSON.stringify(stopped.payload));
			// Longer than the 400 ms heartbeat TTL: a timer that outlived the runtime (or a
			// stale projection still armed on it) would publish here.
			await sleep(1_200);
			assert.equal(subagentFrames(sse).length, beforeStop,
				`a stopped runtime must not publish expiry frames: ${JSON.stringify(subagentFrames(sse))}`);
		});
	});
}
