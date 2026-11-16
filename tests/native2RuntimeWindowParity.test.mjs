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
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const executable = resolveBackendExecutable();
const PROJECT_ID = "runtime-window";
const slash = (value) => String(value).replaceAll("\\", "/");

// Real oracle helpers: the trim index and the task-card date parser are pure functions in
// the Node sources, so the expected values must come from them, not from this test.
const { toEpochMs, readTodoTaskMessage } = loadTsCommonJs("src/shared/piTaskMessage.ts");

const writeLines = (path, entries) => {
	writeFileSync(path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
	return path;
};

const header = (projectPath, id) => ({
	type: "session",
	version: 3,
	id,
	timestamp: "2026-01-01T00:00:00.000Z",
	cwd: projectPath,
});

const userMessage = (id, parentId, text, stamp) => ({
	type: "message",
	id,
	parentId,
	timestamp: new Date(stamp).toISOString(),
	message: { role: "user", content: [{ type: "text", text }], timestamp: stamp },
});

const assistantMessage = (id, parentId, text, stamp) => ({
	type: "message",
	id,
	parentId,
	timestamp: new Date(stamp).toISOString(),
	message: {
		role: "assistant",
		content: [{ type: "text", text }],
		timestamp: stamp,
		usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	},
});

async function waitForFrameIndex(sse, predicate, from = 0, timeoutMs = 10_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		for (let index = from; index < sse.frames.length; index += 1) {
			if (predicate(sse.frames[index])) return index;
		}
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error("expected SSE frame did not arrive");
}

async function waitForFrame(sse, predicate, timeoutMs = 10_000) {
	const index = await waitForFrameIndex(sse, predicate, 0, timeoutMs);
	return sse.frames[index];
}


if (executable) {
	describe("native2 runtime window + reference messages", () => {
		let root;
		let projectPath;

		before(() => {
			root = mkdtempSync(join(tmpdir(), "pideck-native2-window-"));
			projectPath = join(root, "project");
			mkdirSync(projectPath, { recursive: true });
		});

		after(() => {
			if (root) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
		});

		const start = async (t, { scenario = {}, fileEntries = null } = {}) => {
			let fake = null;
			const session = await startBackendSession(t, {
				projects: [{ id: PROJECT_ID, path: projectPath }],
				settings: { language: "en-US" },
				prepare: (fixture) => {
					fake = createFakePi(fixture, scenario);
					return {
						settings: { customPiPath: fake.shim },
						env: { FAKE_PI_SCENARIO: fake.scenarioPath, FAKE_PI_LOG: fake.logPath },
					};
				},
			});
			const name = `w-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
			const filePath = join(session.fixture.sessions, `${name}.jsonl`);
			writeLines(filePath, fileEntries ?? [
				header(projectPath, name),
				userMessage("u1", null, "hello", 1_767_225_601_000),
				assistantMessage("a1", "u1", "hi there", 1_767_225_602_000),
			]);
			const list = await session.invoke("sessions:catalog-list", [PROJECT_ID]);
			assert.equal(list.payload.ok, true, JSON.stringify(list.payload));
			const record = list.payload.result.find((entry) => slash(entry.filePath) === slash(filePath));
			assert.ok(record, "imported session must appear in the catalog");
			// Activation is the caller's job: the SSE subscription must exist before the
			// activation flush, otherwise the first frame is not replayable.
			return { ...session, fake, record, filePath };
		};

		test("trim keeps exactly the newest 50 turns and reports the removed prefix", async (t) => {
			// 51 user turns = 102 rows: one turn too many for the 50-turn cache budget.
			const messages = [];
			for (let turn = 1; turn <= 51; turn += 1) {
				const stamp = 1_767_225_600_000 + turn * 10;
				messages.push({ role: "user", content: [{ type: "text", text: `question ${turn}` }], timestamp: stamp });
				messages.push({ role: "assistant", content: [{ type: "text", text: `answer ${turn}` }], timestamp: stamp + 1 });
			}
			const { invoke, baseUrl, token, record } = await start(t, {
				scenario: {
					messages,
					entries: { entries: [], leafId: null },
					turns: [{ ack: true, events: [{ event: { type: "agent_start" } }, { event: { type: "agent_settled" } }] }],
				},
			});
			const sse = new SseClient(`${baseUrl}__pideck/events?token=${encodeURIComponent(token)}`);
			await sse.connect().catch(() => undefined);
			t.after(() => sse.close());

			const target = (await invoke("sessions:runtime-activate", [record.id])).payload.result.value;
			const activationFrame = await waitForFrame(sse, (frame) => frame.payload.channel === "sessions:runtime-event"
				&& frame.payload.args[0].sourceChannel === "agents:message"
				&& frame.payload.args[0].payload.messages.length === 102);
			const rows = activationFrame.payload.args[0].payload.messages;
			assert.deepEqual(rows.slice(0, 2).map((row) => row.text), ["question 1", "answer 1"]);

			await invoke("sessions:send-prompt", [{
				sessionId: record.id,
				requestId: "trim-turn",
				message: "go",
				agentId: target.agentId,
				runtimeGeneration: target.runtimeGeneration,
			}]);
			// The optimistic user row for this prompt is part of the cache the oracle trims,
			// so the golden must start from the flush that already contains it (103 rows).
			const withOptimisticIndex = await waitForFrameIndex(sse, (frame) => frame.payload.channel === "sessions:runtime-event"
				&& frame.payload.args[0].sourceChannel === "agents:message"
				&& frame.payload.args[0].payload.messages.length === 103);
			const cached = sse.frames[withOptimisticIndex].payload.args[0].payload.messages;
			const trimmedIndex = await waitForFrameIndex(sse, (frame) => frame.payload.channel === "sessions:runtime-event"
				&& frame.payload.args[0].sourceChannel === "agents:message"
				&& frame.payload.args[0].payload.messages.length < 103, withOptimisticIndex + 1);
			const trimmed = sse.frames[trimmedIndex].payload.args[0].payload;

			const goldenStart = 4; // 52 user turns minus the 50-turn budget removes two pairs.
			assert.deepEqual(trimmed.messages, cached.slice(goldenStart));
			assert.equal(trimmed.messages.length, cached.length - goldenStart, "99 rows remain in the active window");
			// The delivery cursor retains this generation's full extent. The removed
			// prefix is handed to the renderer so previously loaded history survives.
			assert.equal(trimmed.windowStart, goldenStart);
			assert.equal(trimmed.totalLength, cached.length, "the complete projection still spans 103 rows");
			assert.deepEqual(trimmed.slideOut, cached.slice(0, goldenStart));
			assert.equal(trimmed.messages[0].text, "question 3");
		});

		test("fewer than 50 turns keeps the leading non-user context", async (t) => {
			// pi's compaction segment often starts with an assistant row and summary card;
			// head-trimming at the first user would delete the answer the user just read.
			const messages = [
				{ role: "assistant", content: [{ type: "text", text: "pre-compaction answer" }], timestamp: 1_767_225_500_000 },
			];
			for (let turn = 1; turn <= 10; turn += 1) {
				const stamp = 1_767_225_600_000 + turn * 10;
				messages.push({ role: "user", content: [{ type: "text", text: `question ${turn}` }], timestamp: stamp });
				messages.push({ role: "assistant", content: [{ type: "text", text: `answer ${turn}` }], timestamp: stamp + 1 });
			}
			const { invoke, baseUrl, token, record } = await start(t, {
				scenario: {
					messages,
					entries: { entries: [], leafId: null },
					turns: [{ ack: true, events: [{ event: { type: "agent_start" } }, { event: { type: "agent_settled" } }] }],
				},
			});
			const sse = new SseClient(`${baseUrl}__pideck/events?token=${encodeURIComponent(token)}`);
			await sse.connect().catch(() => undefined);
			t.after(() => sse.close());

			const target = (await invoke("sessions:runtime-activate", [record.id])).payload.result.value;
			const activationFrame = await waitForFrame(sse, (frame) => frame.payload.channel === "sessions:runtime-event"
				&& frame.payload.args[0].sourceChannel === "agents:message"
				&& frame.payload.args[0].payload.messages.length === 21);
			const rows = activationFrame.payload.args[0].payload.messages;

			await invoke("sessions:send-prompt", [{
				sessionId: record.id,
				requestId: "short-turn",
				message: "go",
				agentId: target.agentId,
				runtimeGeneration: target.runtimeGeneration,
			}]);
			// The optimistic row's flush also marks the cache the settle will look at.
			const afterOptimistic = await waitForFrameIndex(sse, (frame) => frame.payload.channel === "sessions:runtime-event"
				&& frame.payload.args[0].sourceChannel === "agents:message"
				&& frame.payload.args[0].payload.messages.length === rows.length + 1);
			// Wait for the turn to settle (idle after running), then force a flush: the
			// settle itself deliberately does not flush when nothing was trimmed.
			await waitForFrameIndex(sse, (frame) => frame.payload.channel === "agents:state"
				&& frame.payload.args[0].some?.((tab) => tab.status === "idle"), afterOptimistic + 1);
			const flushed = await invoke("sessions:runtime-flush-messages", [{
				sessionId: record.id,
				agentId: target.agentId,
				runtimeGeneration: target.runtimeGeneration,
			}]);
			assert.equal(flushed.payload.result.ok, true, JSON.stringify(flushed.payload));
			const flushedIndex = await waitForFrameIndex(sse, (frame) => frame.payload.channel === "sessions:runtime-event"
				&& frame.payload.args[0].sourceChannel === "agents:message", afterOptimistic + 1);
			const after = sse.frames[flushedIndex].payload.args[0].payload;
			// The optimistic user row of this prompt is appended after the cache; the 21
			// rows loaded from pi must survive unchanged (no head trim).
			assert.deepEqual(after.messages.slice(0, rows.length), rows);
			assert.equal(after.totalLength, rows.length + 1);
			assert.equal(after.messages.at(-1).text, "go");
		});

		test("reference messages reproduce the oracle's Number(timestamp) wire values", async (t) => {
			const name = `ref-${Date.now()}`;
			const entries = [
				header(projectPath, name),
				// Legacy PiDeck header line: no type, no message -> skipped by both sides.
				{ sessionName: "legacy" },
				{ type: "message", id: "r1", timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: [{ type: "text", text: "iso timestamp" }] } },
				{ type: "message", id: "r2", ts: 1_767_225_600_000, message: { role: "assistant", content: [{ type: "text", text: "numeric ts" }] } },
				{ type: "message", id: "r3", message: { role: "user", content: [{ type: "text", text: "missing stamp" }] } },
				{ type: "message", id: "r4", ts: " 1767225600 ", message: { role: "user", content: [{ type: "text", text: "numeric string ts" }] } },
				{ type: "message", id: "r5", ts: null, timestamp: 1_767_225_601_000, message: { role: "assistant", content: [{ type: "text", text: "null ts falls through" }] } },
				{ type: "custom_message", id: "t1", customType: "pi-deck-todo-task-start", display: true, role: "custom", content: "goal card", timestamp: "2026-01-01" },
				{ type: "custom_message", id: "t2", customType: "pi-deck-todo-task-resume", display: true, role: "custom", content: "resume card", timestamp: "Thu, 01 Jan 2026 00:00:00 GMT" },
				{ type: "custom_message", id: "t3", customType: "pi-deck-todo-task-start", display: true, role: "custom", content: "goal with ms", timestamp: "2026-01-01T00:00:00.500Z" },
			];
			const { invoke, record } = await start(t, { fileEntries: entries });
			const result = await invoke("sessions:catalog-read-reference-messages", [record.id]);
			assert.equal(result.payload.ok, true, JSON.stringify(result.payload));
			const actual = result.payload.result;
			assert.deepEqual(actual.map((message) => message.content), [
				"iso timestamp",
				"numeric ts",
				"missing stamp",
				"numeric string ts",
				"null ts falls through",
				"goal card",
				"resume card",
				"goal with ms",
			]);

			// Oracle expressions, executed against the same entries. The legacy sessionName
			// header is skipped by both sides.
			const goldenTimestamp = (entry) => {
				if (readTodoTaskMessage(entry) !== undefined) {
					const parsed = typeof entry.timestamp === "number"
						? entry.timestamp
						: Date.parse(String(entry.timestamp));
					return Number.isFinite(parsed) ? parsed : null;
				}
				const raw = entry.ts ?? entry.timestamp;
				if (raw === undefined) return "now";
				const number = Number(raw);
				return Number.isFinite(number) ? number : null;
			};
			const expected = entries
				.slice(1)
				.filter((entry) => !(entry.sessionName && entry.message === undefined))
				.map(goldenTimestamp);
			assert.equal(expected.length, actual.length);
			const before_ = Date.now();
			for (let index = 0; index < expected.length; index += 1) {
				if (expected[index] === "now") {
					// Missing stamp -> Date.now() on both sides.
					assert.equal(typeof actual[index].timestamp, "number");
					assert.ok(actual[index].timestamp >= before_ - 5_000 && actual[index].timestamp <= before_ + 60_000,
						`${actual[index].timestamp} must be a fresh now`);
					continue;
				}
				assert.deepEqual(actual[index].timestamp, expected[index],
					`entry ${index} (${actual[index].content}) must equal the oracle value`);
			}
			// Spot-check the semantics the oracle expressions encode.
			assert.equal(actual[0].timestamp, null, "ISO strings become NaN -> JSON null, not now");
			assert.equal(actual[1].timestamp, 1_767_225_600_000);
			assert.equal(actual[3].timestamp, 1_767_225_600, "Number(' 1767225600 ') is seconds");
			assert.equal(actual[4].timestamp, 1_767_225_601_000, "null ts is skipped by ??");
			assert.equal(actual[5].timestamp, Date.parse("2026-01-01"));
			assert.equal(actual[6].timestamp, Date.parse("Thu, 01 Jan 2026 00:00:00 GMT"));
			assert.equal(actual[7].timestamp, Date.parse("2026-01-01T00:00:00.500Z"));
			assert.deepEqual(actual.map((message) => message.timestamp).slice(5), [
				toEpochMs("2026-01-01"),
				toEpochMs("Thu, 01 Jan 2026 00:00:00 GMT"),
				toEpochMs("2026-01-01T00:00:00.500Z"),
			]);
		});
	});
}
