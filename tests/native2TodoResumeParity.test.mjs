import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, statSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, test } from "node:test";
import {
	createFakePi,
	resolveBackendExecutable,
	SseClient,
	startBackendSession,
} from "./helpers/native2BackendHarness.mjs";

// Contract under test: e978ad8a todo task goal/resume identity (src/shared/piTaskMessage.ts
// + AgentMessageProjector + SessionDisplayIndexStore + SessionHistoryReader +
// AgentManager dedupe + SessionScanner). Expected values are produced by executing the
// production Node sources on the same bytes, never copied as constants.
const executable = resolveBackendExecutable();
const PROJECT_ID = "todo-resume";
const slash = (value) => String(value).replaceAll("\\", "/");

const GOAL_TEXT = "Inspect the parser";
const REPLY_TEXT = "Inspection complete";
const HIDDEN_TEXT = "HIDDEN TASK RULES";
const GOAL_AT = "2026-11-11T00:00:00.000Z";
const RESUME_AT = "2026-11-11T00:00:01.000Z";
const LEGACY_AT = "2026-11-11T00:00:02.000Z";
const REPLY_AT = "2026-11-11T00:00:03.000Z";

/**
 * One task with three visible messages that all repeat the same text:
 * - `goal` and `resume` carry distinct `details.messageId` identities,
 * - `legacy` predates per-message identities (text + timestamp fallback),
 * - a hidden rules entry must never surface in history, references or exports.
 */
function timeline(projectPath) {
	const goal = {
		type: "custom_message", id: "goal", parentId: "root",
		customType: "pi-deck-todo-task-start", content: GOAL_TEXT, display: true,
		timestamp: GOAL_AT, details: { taskId: "task-1", messageId: "goal-1" },
	};
	const hidden = {
		type: "custom_message", id: "rules", parentId: "goal",
		customType: "pi-deck-todo-task-context", content: HIDDEN_TEXT, display: false,
		timestamp: GOAL_AT, details: { taskId: "task-1" },
	};
	const resume = {
		type: "custom_message", id: "resume", parentId: "rules",
		customType: "pi-deck-todo-task-resume", content: GOAL_TEXT, display: true,
		timestamp: RESUME_AT, details: { taskId: "task-1", messageId: "resume-1" },
	};
	const legacy = {
		type: "custom_message", id: "legacy", parentId: "resume",
		customType: "pi-deck-todo-task-resume", content: GOAL_TEXT, display: true,
		timestamp: LEGACY_AT, details: { taskId: "task-1" },
	};
	const reply = {
		// Numeric entry timestamp: `readMessages` uses `Number(entry.timestamp)`, so an ISO
		// string is NaN for every message row (unrelated to the task contract).
		type: "message", id: "reply", parentId: "legacy", timestamp: Date.parse(REPLY_AT),
		message: {
			id: "pi-reply", role: "assistant",
			content: [{ type: "text", text: REPLY_TEXT }],
			timestamp: Date.parse(REPLY_AT),
		},
	};
	const header = { type: "session", version: 3, id: "root", timestamp: GOAL_AT, cwd: projectPath };
	const entries = [header, goal, hidden, resume, legacy, reply];
	// What pi answers `get_messages` with: custom entries keep role "custom", hidden rules included.
	const messages = [goal, hidden, resume, legacy].map((entry) => ({
		role: "custom", type: entry.type, customType: entry.customType,
		content: entry.content, display: entry.display, details: entry.details, timestamp: entry.timestamp,
	}));
	messages.push(reply.message);
	return { entries, messages, leafId: "reply", activeEntryIds: ["goal", "resume", "legacy", "reply"] };
}

const writeTimeline = (path, entries) => {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
};

if (executable) {
	describe("native2 todo task goal/resume parity (e978ad8a identity + turn boundary)", () => {
		const scopes = [];
		const makeScope = (prefix) => {
			const root = mkdtempSync(join(tmpdir(), `pideck-native2-todo-${prefix}-`));
			const projectPath = join(root, "project");
			mkdirSync(projectPath, { recursive: true });
			scopes.push(root);
			return { root, projectPath };
		};
		after(async () => {
			for (const root of scopes) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
		});

		const baseEnv = (scope) => ({ PIDECK_HOST_HOME: scope.root });
		const startPlain = (t, scope) => startBackendSession(t, {
			projects: [{ id: PROJECT_ID, path: scope.projectPath }],
			settings: { language: "en-US" },
			env: baseEnv(scope),
		});
		const catalogRecord = async (invoke, filePath) => {
			const list = await invoke("sessions:catalog-list", [PROJECT_ID]);
			assert.equal(list.payload.ok, true, JSON.stringify(list.payload));
			const record = list.payload.result.find((entry) => slash(entry.filePath) === slash(filePath));
			assert.ok(record, `session ${filePath} must be in the catalog`);
			return record;
		};
		const entryIdsOf = (messages) => messages.map((message) => message.meta?.entryId);
		// The oracle runs in a vm realm; JSON projection keeps deepStrictEqual on shape, not
		// on a foreign Object.prototype (and drops vm-only undefined keys like the RPC does).


		test("goal and resume history cards carry kind, sender identity and hover stamp", async (t) => {
			const scope = makeScope("history");
			const { invoke, fixture } = await startPlain(t, scope);
			const filePath = join(fixture.sessions, "todo-resume.jsonl");
			const fixtureTimeline = timeline(scope.projectPath);
			writeTimeline(filePath, fixtureTimeline.entries);
			const record = await catalogRecord(invoke, filePath);

			const page = await invoke("sessions:catalog-read-message-page", [record.id, null, 100, { unit: "message" }]);
			assert.equal(page.payload.ok, true, JSON.stringify(page.payload));

			const [goalCard, resumeCard, legacyCard, replyRow] = page.payload.result.messages;
			assert.deepEqual(
				page.payload.result.messages.map((message) => message.text),
				[GOAL_TEXT, GOAL_TEXT, GOAL_TEXT, REPLY_TEXT],
				"identical guidance text must still be its own card",
			);
			assert.deepEqual(entryIdsOf(page.payload.result.messages), fixtureTimeline.activeEntryIds,
				"all three visible task messages consume an entryId slot");
			assert.deepEqual(
				[goalCard.meta.todoTaskKind, resumeCard.meta.todoTaskKind, legacyCard.meta.todoTaskKind],
				["goal", "resume", "resume"],
				"kind is what labels a Task vs Guidance card; a resume must not render as a goal",
			);
			assert.deepEqual(
				[goalCard.meta.todoTaskMessageId, resumeCard.meta.todoTaskMessageId, legacyCard.meta.todoTaskMessageId],
				["goal-1", "resume-1", undefined],
				"sender identity travels with the card; legacy senders have none",
			);
			assert.deepEqual(
				[goalCard.meta.todoTaskId, resumeCard.meta.todoTaskId, legacyCard.meta.todoTaskId],
				["task-1", "task-1", "task-1"],
				"every card belongs to the same task",
			);
			assert.deepEqual(
				[goalCard.meta.todoTaskAt, resumeCard.meta.todoTaskAt, legacyCard.meta.todoTaskAt],
				[Date.parse(GOAL_AT), Date.parse(RESUME_AT), Date.parse(LEGACY_AT)],
				"an ISO entry timestamp must become epoch milliseconds",
			);
			assert.deepEqual(
				[goalCard.timestamp, resumeCard.timestamp, legacyCard.timestamp],
				[Date.parse(GOAL_AT), Date.parse(RESUME_AT), Date.parse(LEGACY_AT)],
				"the card timestamp follows the same stamp",
			);
			assert.equal(replyRow.role, "assistant");
			assert.equal(replyRow.meta.todoTaskKind, undefined, "only task cards carry the kind");
		});

		test("turn paging treats resume guidance as a turn start", async (t) => {
			const scope = makeScope("turn-page");
			const { invoke, fixture } = await startPlain(t, scope);
			const filePath = join(fixture.sessions, "todo-turn.jsonl");
			const fixtureTimeline = timeline(scope.projectPath);
			writeTimeline(filePath, fixtureTimeline.entries);
			const record = await catalogRecord(invoke, filePath);

			const page = await invoke("sessions:catalog-read-message-page", [record.id, null, 2, { unit: "turn" }]);
			assert.equal(page.payload.ok, true, JSON.stringify(page.payload));
			const result = page.payload.result;
			assert.deepEqual(entryIdsOf(result.messages), ["resume", "legacy", "reply"],
				"the resume cards must not be split away from their answer");
			assert.equal(result.nextBefore, 1, "the goal card is the older page");
			assert.equal(result.nextBeforeEntryId, "resume");
			assert.equal(result.total, 4);
			// The version is `mtime:size`; the same file must yield the same numbers.
			const [versionMtime, versionSize] = String(result.indexVersion).split(":");
			const fileInfo = statSync(filePath);
			assert.equal(Number(versionSize), fileInfo.size);
			assert.ok(Math.abs(Number(versionMtime) - fileInfo.mtimeMs) < 2);
		});

		test("reference messages and catalog summary keep the goal and drop hidden rules", async (t) => {
			const scope = makeScope("reference");
			// The Node scanner resolves sessions from `~/.pi/agent/sessions`; point the backend
			// at the same root so both read one file instead of a fixture-local copy.
			const sessionsRoot = join(scope.root, ".pi", "agent", "sessions");
			const { invoke } = await startBackendSession(t, {
				projects: [{ id: PROJECT_ID, path: scope.projectPath }],
				settings: { language: "en-US" },
				env: { ...baseEnv(scope), PIDECK_SESSIONS_DIR: sessionsRoot },
			});
			const filePath = join(sessionsRoot, "project", "todo-reference.jsonl");
			const fixtureTimeline = timeline(scope.projectPath);
			writeTimeline(filePath, fixtureTimeline.entries);
			const record = await catalogRecord(invoke, filePath);

			const references = await invoke("sessions:catalog-read-reference-messages", [record.id]);
			assert.equal(references.payload.ok, true, JSON.stringify(references.payload));
			assert.deepEqual(references.payload.result, [
				{ role: "system", content: GOAL_TEXT, timestamp: Date.parse(GOAL_AT) },
				{ role: "system", content: GOAL_TEXT, timestamp: Date.parse(RESUME_AT) },
				{ role: "system", content: GOAL_TEXT, timestamp: Date.parse(LEGACY_AT) },
				{ role: "assistant", content: REPLY_TEXT, timestamp: Date.parse(REPLY_AT) },
			], "resume guidance belongs to the session reference; hidden task rules never do");

			assert.equal(record.title, GOAL_TEXT, "guidance is not a new task title");
			assert.equal(record.preview, GOAL_TEXT, "the preview keeps the original task");
			assert.equal(record.messageCount, 2, "resume guidance remains visible without inflating the user/assistant message count");
		});

		test("live resume cards dedupe by sender identity and keep the reloaded card", async (t) => {
			const scope = makeScope("live");
			const fixtureTimeline = timeline(scope.projectPath);
			let filePath = "";
			let fake = null;
			const session = await startBackendSession(t, {
				projects: [{ id: PROJECT_ID, path: scope.projectPath }],
				settings: { language: "en-US" },
				env: baseEnv(scope),
				prepare: (fixture) => {
					filePath = join(fixture.sessions, "todo-live.jsonl");
					writeTimeline(filePath, fixtureTimeline.entries);
					const [goalMessage, , resumeMessage, legacyMessage] = fixtureTimeline.messages;
					fake = createFakePi(fixture, {
						state: { sessionFile: filePath },
						messages: fixtureTimeline.messages,
						entries: { entries: fixtureTimeline.entries, leafId: fixtureTimeline.leafId },
						turns: [{
							ack: true,
							events: [
								// Replayed history cards: goal/resume share identities, the legacy
								// card has none, so it may only dedupe on text + timestamp.
								{ event: { type: "message_end", message: goalMessage } },
								{ event: { type: "message_end", message: resumeMessage } },
								{ event: { type: "message_end", message: legacyMessage } },
								// A genuinely new resume with the goal's text, even though a
								// same-text history card without an identity already exists.
								{ event: { type: "message_end", message: {
									...resumeMessage,
									timestamp: "2026-11-11T00:00:04.000Z",
									details: { taskId: "task-1", messageId: "resume-2" },
								} } },
								// Replaying the legacy guidance must not add a second card.
								{ event: { type: "message_end", message: legacyMessage } },
								{ event: { type: "agent_settled" } },
							],
						}],
					});
					return {
						settings: { customPiPath: fake.shim },
						env: { FAKE_PI_SCENARIO: fake.scenarioPath, FAKE_PI_LOG: fake.logPath },
					};
				},
			});
			const { invoke, baseUrl, token } = session;
			const record = await catalogRecord(invoke, filePath);
			const fileBytes = readFileSync(filePath, "utf8");
			const sse = new SseClient(`${baseUrl}__pideck/events?token=${encodeURIComponent(token)}`);
			await sse.connect().catch(() => undefined);
			t.after(() => sse.close());

			const activated = await invoke("sessions:runtime-activate", [record.id]);
			assert.equal(activated.payload.ok, true, JSON.stringify(activated.payload));
			const target = activated.payload.result.value;

			// Activation projects pi's get_messages with the branch entry ids: that projection is
			// exactly what the renderer received before any new event.
			const historyFrame = await sse.waitFor((frame) => frame.payload.channel === "sessions:runtime-event"
				&& frame.payload.args[0].sourceChannel === "agents:message"
				&& frame.payload.args[0].payload.messages?.length === 4);
			const historyRows = historyFrame.payload.args[0].payload.messages;
			assert.deepEqual(entryIdsOf(historyRows), fixtureTimeline.activeEntryIds);

			// Runtime-first turn paging must see the resume card as a live turn boundary.
			const livePage = await invoke("sessions:catalog-read-message-page", [
				record.id, null, 2, { unit: "turn", beforeEntryId: "reply" },
			]);
			assert.equal(livePage.payload.ok, true, JSON.stringify(livePage.payload));
			assert.deepEqual(entryIdsOf(livePage.payload.result.messages), ["resume", "legacy"],
				"the live window must answer the page from the resume boundary");
			assert.equal(livePage.payload.result.nextBefore, 1, "cursors stay in file index space");
			assert.equal(livePage.payload.result.nextBeforeEntryId, "resume");

			const sent = await invoke("sessions:send-prompt", [{
				sessionId: record.id, requestId: "todo-replay", message: "go",
				agentId: target.agentId, runtimeGeneration: target.runtimeGeneration,
			}]);
			assert.equal(sent.payload.ok, true, JSON.stringify(sent.payload));

			// History rows + the prompt's own user turn + exactly one appended card: all
			// replayed message_ends must be swallowed, by identity or by text + stamp.
			const finalFrame = await sse.waitFor((frame) => frame.payload.channel === "sessions:runtime-event"
				&& frame.payload.args[0].sourceChannel === "agents:message"
				&& frame.payload.args[0].payload.messages?.length === 6);
			const rows = finalFrame.payload.args[0].payload.messages;
			assert.deepEqual(rows.map((row) => row.text),
				[GOAL_TEXT, GOAL_TEXT, GOAL_TEXT, REPLY_TEXT, "go", GOAL_TEXT],
				"a replay adds nothing, a new identity with identical text is a new user turn");
			assert.equal(rows[5].meta.todoTaskKind, "resume");
			assert.equal(rows[5].meta.todoTaskMessageId, "resume-2");
			assert.equal(rows[5].meta.todoTaskAt, Date.parse("2026-11-11T00:00:04.000Z"));
			// The live card shape is the oracle's addMessage meta: no file-projection fields.
			assert.deepEqual(Object.keys(rows[5].meta).sort(), [
				"todoTaskAt", "todoTaskId", "todoTaskKind", "todoTaskMessageId", "type",
			]);
			assert.equal(fake.commands().filter((entry) => entry.command === "prompt").length, 1);
			assert.equal(readFileSync(filePath, "utf8"), fileBytes,
				"live task cards must never rewrite the persisted task entries");
		});
	});
}
