import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import {
	createFakePi,
	resolveBackendExecutable,
	SseClient,
	startBackendSession,
} from "./helpers/native2BackendHarness.mjs";

const executable = resolveBackendExecutable();
const PROJECT_ID = "runtime-tail";
const slash = (value) => String(value).replaceAll("\\", "/");

function writeSessionFile(sessionsDir, projectPath, name) {
	const entries = [
		{ type: "session", version: 3, id: name, timestamp: "2026-01-01T00:00:00.000Z", cwd: projectPath },
		{ type: "model_change", id: "m1", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", provider: "anthropic", modelId: "claude-sonnet-4" },
		{
			type: "message",
			id: "u1",
			parentId: "m1",
			timestamp: "2026-01-01T00:00:01.000Z",
			message: { role: "user", content: [{ type: "text", text: "first question" }], timestamp: 1_767_225_601_000 },
		},
		{
			type: "message",
			id: "a1",
			parentId: "u1",
			timestamp: "2026-01-01T00:00:02.000Z",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "first answer" }],
				timestamp: 1_767_225_602_000,
				usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			},
		},
		{
			type: "message",
			id: "u2",
			parentId: "a1",
			timestamp: "2026-01-01T00:00:03.000Z",
			message: { role: "user", content: [{ type: "text", text: "second question" }], timestamp: 1_767_225_603_000 },
		},
		{
			type: "message",
			id: "a2",
			parentId: "u2",
			timestamp: "2026-01-01T00:00:04.000Z",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "second answer" }],
				timestamp: 1_767_225_604_000,
				usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			},
		},
	];
	const path = join(sessionsDir, `${name}.jsonl`);
	writeFileSync(path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
	return path;
}

const readEntries = (path) => readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));

/** Poll the replayable SSE stream until `predicate` matches a parsed frame. */
async function waitForFrame(sse, predicate, timeoutMs = 10_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		for (const frame of sse.frames) {
			if (predicate(frame)) return frame;
		}
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error("expected SSE frame did not arrive");
}

const eventsOf = (sse, channel) => sse.frames
	.map((frame) => frame.payload)
	.filter((payload) => payload.channel === "sessions:runtime-event")
	.map((payload) => payload.args[0])
	.filter((event) => event.sourceChannel === channel);

if (executable) {
	describe("native2 runtime tail parity (restart preferences, replacements, resend, full text)", () => {
		let root;
		let projectPath;

		before(() => {
			root = mkdtempSync(join(tmpdir(), "pideck-native2-tail-"));
			projectPath = join(root, "project");
			mkdirSync(projectPath, { recursive: true });
		});

		after(() => {
			if (root) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
		});

		const start = async (t, { scenario = {}, settings = {} } = {}) => {
			let fake = null;
			const session = await startBackendSession(t, {
				projects: [{ id: PROJECT_ID, path: projectPath }],
				settings: { language: "en-US", ...settings },
				prepare: (fixture) => {
					fake = createFakePi(fixture, scenario);
					return {
						settings: { customPiPath: fake.shim },
						env: { FAKE_PI_SCENARIO: fake.scenarioPath, FAKE_PI_LOG: fake.logPath },
					};
				},
			});
			const filePath = writeSessionFile(session.fixture.sessions, projectPath,
				`t-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`);
			const list = await session.invoke("sessions:catalog-list", [PROJECT_ID]);
			assert.equal(list.payload.ok, true, JSON.stringify(list.payload));
			const record = list.payload.result.find((entry) => slash(entry.filePath) === slash(filePath));
			assert.ok(record, "imported session must appear in the catalog");
			const target = (await session.invoke("sessions:runtime-activate", [record.id])).payload.result.value;
			return { ...session, fake, record, filePath, target };
		};

		/** Commands the fake pi received in its most recent process (after the last spawn). */
		const lastProcessCommands = (fake) => {
			const log = fake.readLog();
			let startIndex = 0;
			log.forEach((entry, index) => {
				if (entry.kind === "spawn") startIndex = index;
			});
			return log.slice(startIndex).filter((entry) => entry.kind === "command");
		};

		const askEvents = (requestId) => [
			{ event: { type: "agent_start" } },
			{ event: { type: "extension_ui_request", id: requestId, method: "input", title: "Name?" } },
		];

		test("restart re-applies the catalog model/thinking and drops the old pending ask", async (t) => {
			const { invoke, fake, record, target, baseUrl, token } = await start(t, {
				scenario: {
					// pi clamps the requested model: the runtime state must show pi's value,
					// not the catalog value the backend asked for.
					state: { model: { provider: "anthropic", id: "clamped-model", name: "Clamped" }, thinkingLevel: "high" },
					responses: { set_model: { data: { model: { provider: "anthropic", id: "clamped-model", name: "Clamped" } } } },
					turns: [{ ack: true, events: askEvents("ask-restart") }],
				},
			});
			const sse = new SseClient(`${baseUrl}__pideck/events?token=${encodeURIComponent(token)}`);
			await sse.connect().catch(() => undefined);
			t.after(() => sse.close());

			const targetOf = (generation = target.runtimeGeneration) => ({
				sessionId: record.id,
				agentId: target.agentId,
				runtimeGeneration: generation,
			});
			const setModel = await invoke("sessions:runtime-set-model", [targetOf(), "anthropic", "claude-opus-4"]);
			assert.equal(setModel.payload.result.ok, true, JSON.stringify(setModel.payload));
			const setThinking = await invoke("sessions:runtime-set-thinking", [targetOf(), "high"]);
			assert.equal(setThinking.payload.result.ok, true, JSON.stringify(setThinking.payload));

			await invoke("sessions:send-prompt", [{
				sessionId: record.id,
				requestId: "ask-turn",
				message: "ask me",
				agentId: target.agentId,
				runtimeGeneration: target.runtimeGeneration,
			}]);
			await waitForFrame(sse, (frame) => frame.payload.channel === "sessions:runtime-event"
				&& frame.payload.args[0].sourceChannel === "agents:ui-request"
				&& frame.payload.args[0].payload.requestId === "ask-restart");

			const restarted = await invoke("sessions:runtime-restart", [targetOf()]);
			assert.equal(restarted.payload.result.ok, true, JSON.stringify(restarted.payload));
			const next = restarted.payload.result.value.runtime;
			assert.equal(next.runtimeGeneration, target.runtimeGeneration + 1);

			// Oracle `restartSession` -> `applyPreferences`: set_model then set_thinking_level
			// in the *new* process, in that order (thinking depends on the model).
			const commands = lastProcessCommands(fake);
			const modelIndex = commands.findIndex((entry) => entry.command === "set_model");
			assert.ok(modelIndex >= 0, JSON.stringify(commands.map((entry) => entry.command)));
			const applied = commands[modelIndex].payload;
			assert.equal(applied.provider, "anthropic");
			assert.equal(applied.modelId, "claude-opus-4");
			const thinkingIndex = commands.findIndex((entry, index) => index > modelIndex
				&& entry.command === "set_thinking_level");
			assert.ok(thinkingIndex > modelIndex, "thinking must be applied after the model");
			assert.equal(commands[thinkingIndex].payload.level, "high");

			// The published state reflects pi's accepted model, not the requested one.
			const stateFrame = await waitForFrame(sse, (frame) => frame.payload.channel === "sessions:runtime-event"
				&& frame.payload.args[0].sourceChannel === "agents:runtime-state"
				&& frame.payload.args[0].agentId === next.agentId
				&& frame.payload.args[0].payload.state?.modelId === "clamped-model");
			assert.equal(stateFrame.payload.args[0].payload.state.thinkingLevel, "high");

			// The old process's ask cannot be answered: the restart dropped it.
			const answered = await invoke("sessions:ui-response", [{
				sessionId: record.id,
				agentId: next.agentId,
				runtimeGeneration: next.runtimeGeneration,
				requestId: "ask-restart",
				response: { value: "late" },
			}]);
			assert.equal(answered.payload.result.ok, false, JSON.stringify(answered.payload));
			assert.match(JSON.stringify(answered.payload.result.error), /not pending/i);
			assert.equal(fake.commands().some((entry) => entry.command === "extension_ui_response"
				&& entry.payload.id === "ask-restart"), false,
			"a dropped ask must never be forwarded to the restarted process");
		});

		test("a cancelled fork restores the binding and drops the pending ask", async (t) => {
			const { invoke, fake, record, target, baseUrl, token } = await start(t, {
				scenario: {
					responses: { fork: { data: { cancelled: true } } },
					turns: [{ ack: true, events: askEvents("ask-fork") }],
				},
			});
			const sse = new SseClient(`${baseUrl}__pideck/events?token=${encodeURIComponent(token)}`);
			await sse.connect().catch(() => undefined);
			t.after(() => sse.close());

			const targetOf = (generation = target.runtimeGeneration) => ({
				sessionId: record.id,
				agentId: target.agentId,
				runtimeGeneration: generation,
			});
			await invoke("sessions:send-prompt", [{
				sessionId: record.id,
				requestId: "ask-fork-turn",
				message: "ask me",
				agentId: target.agentId,
				runtimeGeneration: target.runtimeGeneration,
			}]);
			await waitForFrame(sse, (frame) => frame.payload.channel === "sessions:runtime-event"
				&& frame.payload.args[0].sourceChannel === "agents:ui-request"
				&& frame.payload.args[0].payload.requestId === "ask-fork");

			const forked = await invoke("sessions:runtime-fork", [targetOf(), "u1"]);
			assert.equal(forked.payload.result.ok, true, JSON.stringify(forked.payload));
			// Oracle `replaceBoundRuntime`: `cancelled` returns the pi result unchanged and
			// re-binds the original session *at the reserved generation*.
			assert.equal(forked.payload.result.value.cancelled, true, JSON.stringify(forked.payload));
			assert.equal("targetSessionId" in forked.payload.result.value, false);

			const stale = await invoke("sessions:runtime-state", [targetOf()]);
			assert.equal(stale.payload.result.ok, false, JSON.stringify(stale.payload));
			assert.equal(stale.payload.result.error.code, "SESSION_RUNTIME_CHANGED");
			const restoredGeneration = target.runtimeGeneration + 1;
			const restored = await invoke("sessions:runtime-state", [targetOf(restoredGeneration)]);
			assert.equal(restored.payload.result.ok, true, JSON.stringify(restored.payload));

			const answered = await invoke("sessions:ui-response", [{
				sessionId: record.id,
				agentId: target.agentId,
				runtimeGeneration: restoredGeneration,
				requestId: "ask-fork",
				response: { value: "late" },
			}]);
			assert.equal(answered.payload.result.ok, false, JSON.stringify(answered.payload));
			assert.match(JSON.stringify(answered.payload.result.error), /not pending/i);
			assert.equal(fake.commands().some((entry) => entry.command === "extension_ui_response"
				&& entry.payload.id === "ask-fork"), false);
		});

		test("resend returns the live cached row text, not the older file text", async (t) => {
			const sourceMessages = [
				{ role: "user", content: [{ type: "text", text: "first question" }], timestamp: 1_767_225_601_000 },
				{ role: "assistant", content: [{ type: "text", text: "first answer" }], timestamp: 1_767_225_602_000 },
				// A host instruction rewrote the prompt in the live row; the file kept the original.
				{ role: "user", content: [{ type: "text", text: "rewritten by host" }], timestamp: 1_767_225_603_000 },
				{ role: "assistant", content: [{ type: "text", text: "second answer" }], timestamp: 1_767_225_604_000 },
			];
			const { invoke, fake, record, filePath, target } = await start(t, {
				scenario: { messages: sourceMessages, entries: { entries: [], leafId: null } },
			});
			const before = readEntries(filePath).find((entry) => entry.id === "u2");
			assert.equal(before.message.content[0].text, "second question");

			// No get_entries -> live ids are `<agentId>-history-<index>`; index 2 is the
			// rewritten user row. The turn mapping resolves it to file entry u2.
			const prepared = await invoke("sessions:runtime-prepare-resend", [{
				sessionId: record.id,
				agentId: target.agentId,
				runtimeGeneration: target.runtimeGeneration,
			}, `${target.agentId}-history-2`, { provider: "anthropic", modelId: "claude-sonnet-4" }, "high"]);
			assert.equal(prepared.payload.result.ok, true, JSON.stringify(prepared.payload));
			assert.equal(prepared.payload.result.value.value.text, "rewritten by host",
				"oracle `locateMessageTarget` returns the cached row's text on the mapped path");

			const entries = readEntries(filePath);
			assert.ok(entries.filter((entry) => entry.type === "deleted").map((entry) => entry.id).includes("u2"));
			assert.ok(fake.commands().some((entry) => entry.command === "switch_session"));
		});

		test("a file-less draft serves the untruncated tool result from the live cache", async (t) => {
			const fullText = "L".repeat(9_000);
			const { invoke, fixture, baseUrl, token } = await start(t, {
				scenario: {
					turns: [{
						ack: true,
						events: [
							{ event: { type: "agent_start" } },
							{ event: { type: "tool_execution_start", toolCallId: "call-full", toolName: "read", args: { path: "/tmp/large" } } },
							{ event: { type: "tool_execution_end", toolCallId: "call-full", toolName: "read", result: { content: [{ type: "text", text: fullText }] }, isError: false } },
							{ event: { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" } } },
							{ event: { type: "agent_end", messages: [] } },
							{ event: { type: "agent_settled" } },
						],
					}],
				},
			});
			const sse = new SseClient(`${baseUrl}__pideck/events?token=${encodeURIComponent(token)}`);
			await sse.connect().catch(() => undefined);
			t.after(() => sse.close());

			const created = await invoke("sessions:create-anonymous", [{ projectId: PROJECT_ID }]);
			assert.equal(created.payload.ok, true, JSON.stringify(created.payload));
			const record = created.payload.result.session;
			assert.equal(record.filePath ?? "", "", "the draft has no session file");
			const target = (await invoke("sessions:runtime-activate", [record.id])).payload.result.value;
			await invoke("sessions:send-prompt", [{
				sessionId: record.id,
				requestId: "tool-turn",
				message: "read it",
				agentId: target.agentId,
				runtimeGeneration: target.runtimeGeneration,
			}]);

			// Wait for the *settled* tool row: the start event also flushes a running row.
			const frame = await waitForFrame(sse, (candidate) => candidate.payload.channel === "sessions:runtime-event"
				&& candidate.payload.args[0].sourceChannel === "agents:message"
				&& candidate.payload.args[0].payload.messages.some((row) => row.role === "tool"
					&& row.meta?.toolCallId === "call-full" && row.meta?.status !== "running"));
			const toolRow = frame.payload.args[0].payload.messages
				.find((row) => row.role === "tool" && row.meta?.toolCallId === "call-full");
			// The delivered row is truncated; the cache is the only place the full text lives
			// (the draft never wrote a JSONL file).
			assert.equal(toolRow.meta.truncated, true, JSON.stringify(toolRow.meta).slice(0, 400));
			assert.ok(toolRow.meta.detailText.length < fullText.length);

			const full = await invoke("sessions:catalog-read-message-full-text",
				[record.id, target.agentId, toolRow.id, null]);
			assert.equal(full.payload.ok, true, JSON.stringify(full.payload));
			assert.equal(full.payload.result.text, fullText,
				"oracle `readMessageFullText` hits the live tool cache before any file");
			void fixture;
		});
	});
}
