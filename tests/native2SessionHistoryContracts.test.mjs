import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, describe, test } from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import {
	createFakePi,
	resolveBackendExecutable,
	startBackendSession,
} from "./helpers/native2BackendHarness.mjs";

const executable = resolveBackendExecutable();
const PROJECT_ID = "history-contracts";
const slash = (value) => String(value).replaceAll("\\", "/");

// Real Node oracle functions. Entry ids and page boundaries below are computed by
// executing the production source, not copied as constants.
const { mapCachedMessageToEntryCandidates } = loadTsCommonJs(resolve("src/main/pi/agentUtils.ts"));
const { findTurnPageStart } = loadTsCommonJs(resolve("src/main/pi/SessionHistoryReader.ts"));

/**
 * One declarative timeline feeds both the JSONL and the fake-pi projection.
 * `secondAssistant` adds a file-only assistant (same text as the live one) and
 * `aborted` adds the empty assistant pi writes on abort — both are invisible to the
 * live cache, which is exactly the skew C9 must survive.
 */
function timeline(projectPath, { turns = [], repeatedAssistant = false, abortEmptyAssistant = false } = {}) {
	const entries = [
		{ type: "session", version: 3, id: `s-${Math.random().toString(16).slice(2)}`, timestamp: "2026-01-01T00:00:00.000Z", cwd: projectPath },
		{ type: "model_change", id: "m1", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", provider: "anthropic", modelId: "claude-sonnet-4" },
	];
	const messages = [];
	let parentId = "m1";
	const push = (entry, liveMessage) => {
		entries.push(entry);
		parentId = entry.id;
		if (liveMessage) messages.push(liveMessage);
	};
	for (const turn of turns) {
		push({
			type: "message",
			id: `u-${turn.index}`,
			parentId,
			timestamp: "2026-01-01T00:00:01.000Z",
			message: { id: `pi-u-${turn.index}`, role: "user", content: [{ type: "text", text: turn.user }], timestamp: 1_767_225_601_000 + turn.index },
		}, { role: "user", content: [{ type: "text", text: turn.user }] });
		push({
			type: "message",
			id: `a-${turn.index}`,
			parentId,
			timestamp: "2026-01-01T00:00:02.000Z",
			message: { id: `pi-a-${turn.index}`, role: "assistant", content: [{ type: "text", text: turn.assistant }], timestamp: 1_767_225_602_000 + turn.index },
		}, { role: "assistant", content: [{ type: "text", text: turn.assistant }] });
		if (repeatedAssistant && turn.secondAssistant !== undefined) {
			push({
				type: "message",
				id: `a2-${turn.index}`,
				parentId,
				timestamp: "2026-01-01T00:00:03.000Z",
				message: { id: `pi-a2-${turn.index}`, role: "assistant", content: [{ type: "text", text: turn.secondAssistant }], timestamp: 1_767_225_603_000 + turn.index },
			});
		}
		if (abortEmptyAssistant && turn.aborted) {
			push({
				type: "message",
				id: `a-abort-${turn.index}`,
				parentId,
				timestamp: "2026-01-01T00:00:04.000Z",
				message: { id: `pi-a-abort-${turn.index}`, role: "assistant", content: [], stopReason: "aborted", timestamp: 1_767_225_604_000 + turn.index },
			});
		}
	}
	return { entries, messages };
}

function writeEntries(path, entries) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
}

const readEntries = (path) => readFileSync(path, "utf8")
	.split("\n")
	.filter(Boolean)
	.map((line) => JSON.parse(line));

const entryIdsOf = (page) => page.messages.map((message) => message.meta.entryId);

if (executable) {
	describe("native2 session history contracts (C1/C2/C4/C5/C9/C10 + tree guard)", () => {
		const scopes = [];
		const makeScope = (prefix) => {
			const root = mkdtempSync(join(tmpdir(), `pideck-native2-${prefix}-`));
			const projectPath = join(root, "project");
			const downloadsDir = join(root, "downloads");
			for (const directory of [projectPath, downloadsDir]) mkdirSync(directory, { recursive: true });
			scopes.push(root);
			return { root, projectPath, downloadsDir };
		};
		after(() => {
			for (const root of scopes) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
		});

		const baseEnv = (scope) => ({
			PIDECK_HOST_HOME: scope.root,
			PIDECK_DOWNLOADS_DIR: scope.downloadsDir,
		});
		const startPlain = (t, scope) => startBackendSession(t, {
			projects: [{ id: PROJECT_ID, path: scope.projectPath }],
			settings: { language: "en-US" },
			env: baseEnv(scope),
		});
		/**
		 * Start with a scriptable fake pi. `scenario` may be a function of the fixture so a
		 * test can point `state.sessionFile` at a path only the fixture knows.
		 */
		const startWithPi = async (t, scope, scenario) => {
			let fake = null;
			const session = await startBackendSession(t, {
				projects: [{ id: PROJECT_ID, path: scope.projectPath }],
				settings: { language: "en-US" },
				env: baseEnv(scope),
				prepare: (fixture) => {
					const resolved = typeof scenario === "function" ? scenario(fixture) : scenario;
					fake = createFakePi(fixture, resolved);
					return {
						settings: { customPiPath: fake.shim },
						env: { FAKE_PI_SCENARIO: fake.scenarioPath, FAKE_PI_LOG: fake.logPath },
					};
				},
			});
			return { ...session, fake };
		};
		const catalogRecord = async (invoke, filePath) => {
			const list = await invoke("sessions:catalog-list", [PROJECT_ID]);
			assert.equal(list.payload.ok, true, JSON.stringify(list.payload));
			const record = list.payload.result.find((entry) => slash(entry.filePath) === slash(filePath));
			assert.ok(record, `session ${filePath} must be in the catalog`);
			return record;
		};

		test("catalog-copy registers the clone under a new UUID and leaves the source record untouched", async (t) => {
			const scope = makeScope("copy");
			const clonePath = join(scope.projectPath, "sessions", "copied.jsonl");
			const { invoke, fixture, fake } = await startWithPi(t, scope, {
				state: { sessionFile: clonePath },
				responses: { clone: { data: { sessionId: "pi-clone" } } },
			});
			const source = timeline(scope.projectPath, {
				turns: [{ index: 1, user: "hello", assistant: "hi" }],
			});
			const sourcePath = join(fixture.sessions, "copy-source.jsonl");
			writeEntries(sourcePath, source.entries);
			mkdirSync(join(scope.projectPath, "sessions"), { recursive: true });
			writeFileSync(clonePath, readFileSync(sourcePath, "utf8"));
			const sourceBytes = readFileSync(sourcePath, "utf8");
			const record = await catalogRecord(invoke, sourcePath);

			const copied = await invoke("sessions:catalog-copy", [record.id]);
			assert.equal(copied.payload.ok, true, JSON.stringify(copied.payload));
			const result = copied.payload.result;
			assert.equal(result.cancelled, false);
			assert.match(result.targetSessionId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
			assert.notEqual(result.targetSessionId, record.id, "a copy must own a different stable id");

			const commands = fake.commands().map((entry) => entry.command);
			assert.deepEqual(commands.filter((command) => command === "clone" || command === "get_state"),
				["clone", "get_state"],
				"the clone path needs both pi requests, like AgentManager.cloneSessionFile");

			const afterList = await invoke("sessions:catalog-list", [PROJECT_ID, { scan: false }]);
			const sourceAfter = afterList.payload.result.find((entry) => entry.id === record.id);
			assert.ok(sourceAfter, "the source record must still exist");
			assert.equal(slash(sourceAfter.filePath), slash(sourcePath),
				"copying must never repoint the source record at the clone (attachRuntime bug)");
			assert.equal(readFileSync(sourcePath, "utf8"), sourceBytes);
			const cloneRecord = afterList.payload.result.find((entry) => entry.id === result.targetSessionId);
			assert.ok(cloneRecord, "the clone must be addressable by its new UUID");
			assert.equal(slash(cloneRecord.filePath), slash(clonePath));
			assert.equal(afterList.payload.result.length, 2);
		});

		test("catalog-copy reports pi's cancelled clone without touching the catalog", async (t) => {
			const scope = makeScope("copy-cancel");
			const { invoke, fixture } = await startWithPi(t, scope, {
				responses: { clone: { data: { cancelled: true } } },
			});
			const sourcePath = join(fixture.sessions, "cancel-source.jsonl");
			writeEntries(sourcePath, timeline(scope.projectPath, {
				turns: [{ index: 1, user: "hello", assistant: "hi" }],
			}).entries);
			const record = await catalogRecord(invoke, sourcePath);

			const copied = await invoke("sessions:catalog-copy", [record.id]);
			assert.equal(copied.payload.ok, true, JSON.stringify(copied.payload));
			assert.deepEqual(copied.payload.result, { cancelled: true });
			const afterList = await invoke("sessions:catalog-list", [PROJECT_ID, { scan: false }]);
			assert.equal(afterList.payload.result.length, 1);
			assert.equal(slash(afterList.payload.result[0].filePath), slash(sourcePath));
		});

		test("catalog-export-html forwards pi's {path} and never fabricates an HTML file", async (t) => {
			const scope = makeScope("export");
			const exported = join(scope.downloadsDir, "session-1767225600000.html");
			const { invoke, fixture, fake } = await startWithPi(t, scope, {
				responses: { export_html: { data: { path: exported } } },
			});
			const sourcePath = join(fixture.sessions, "export-source.jsonl");
			writeEntries(sourcePath, timeline(scope.projectPath, {
				turns: [{ index: 1, user: "hello", assistant: "hi" }],
			}).entries);
			const record = await catalogRecord(invoke, sourcePath);

			const result = await invoke("sessions:catalog-export-html", [record.id]);
			assert.equal(result.payload.ok, true, JSON.stringify(result.payload));
			assert.deepEqual(result.payload.result, { path: exported },
				"the oracle forwards export_html's path; it never writes its own template");
			assert.equal(fake.commands().some((entry) => entry.command === "export_html"), true);
			assert.deepEqual(readdirSync(scope.downloadsDir), [],
				"no <title>.html may be invented beside pi's own export");
		});

		test("catalog-export-html reports the oracle's exportFailed copy when pi returns no path", async (t) => {
			const scope = makeScope("export-fail");
			const { invoke, fixture } = await startWithPi(t, scope, {
				responses: { export_html: { data: {} } },
			});
			const sourcePath = join(fixture.sessions, "export-fail.jsonl");
			writeEntries(sourcePath, timeline(scope.projectPath, {
				turns: [{ index: 1, user: "hello", assistant: "hi" }],
			}).entries);
			const record = await catalogRecord(invoke, sourcePath);

			const result = await invoke("sessions:catalog-export-html", [record.id]);
			assert.equal(result.payload.ok, false, JSON.stringify(result.payload));
			assert.equal(result.payload.error.message, "Failed to export the session. Try again.");
			assert.deepEqual(readdirSync(scope.downloadsDir), []);
		});

		test("draft and unknown sessions return the oracle's empty history shapes", async (t) => {
			const scope = makeScope("draft");
			const { invoke } = await startPlain(t, scope);
			const draft = await invoke("sessions:catalog-create-draft", [{ projectId: PROJECT_ID, title: "Draft history" }]);
			assert.equal(draft.payload.ok, true, JSON.stringify(draft.payload));
			const draftId = draft.payload.result.id;
			const unknownId = "00000000-0000-4000-8000-000000000000";

			for (const sessionId of [draftId, unknownId]) {
				assert.deepEqual((await invoke("sessions:catalog-read-messages", [sessionId])).payload.result, []);
				assert.deepEqual((await invoke("sessions:catalog-read-message-page", [sessionId])).payload.result,
					{ messages: [], total: 0, nextBefore: null });
				assert.deepEqual((await invoke("sessions:catalog-read-message-page",
					[sessionId, null, 3, { unit: "turn" }])).payload.result,
					{ messages: [], total: 0, nextBefore: null });
				assert.deepEqual((await invoke("sessions:catalog-read-process-events", [sessionId])).payload.result, []);
				assert.deepEqual((await invoke("sessions:catalog-read-reference-messages", [sessionId])).payload.result, []);
				const single = await invoke("sessions:read-tool-export-payload", [{ sessionId, messageId: "m1" }]);
				assert.equal(single.payload.ok, true, JSON.stringify(single.payload));
				assert.equal(single.payload.result, null);
				const batch = await invoke("sessions:read-tool-export-payloads", [{ sessionId, messageIds: ["m1"] }]);
				assert.equal(batch.payload.ok, true, JSON.stringify(batch.payload));
				assert.deepEqual(batch.payload.result, {});
			}
			// The oracle also short-circuits a blank session id in process events.
			assert.deepEqual((await invoke("sessions:catalog-read-process-events", [""])).payload.result, []);
		});

		test("tool payloads fall back to the live runtime session file for a file-less session", async (t) => {
			const scope = makeScope("runtime-payload");
			const livePath = join(scope.root, "live", "session.jsonl");
			mkdirSync(join(scope.root, "live"), { recursive: true });
			const liveEntries = [
				{ type: "session", version: 3, id: "live", timestamp: "2026-01-01T00:00:00.000Z", cwd: scope.projectPath },
				{
					type: "message",
					id: "la1",
					parentId: null,
					timestamp: "2026-01-01T00:00:01.000Z",
					message: {
						id: "pi-la1",
						role: "assistant",
						content: [{ type: "toolCall", id: "call-live", name: "read", arguments: { path: "/tmp/live.txt" } }],
						timestamp: 1_767_225_601_000,
					},
				},
				{
					type: "message",
					id: "lr1",
					parentId: "la1",
					timestamp: "2026-01-01T00:00:02.000Z",
					message: {
						id: "pi-lr1",
						role: "toolResult",
						toolCallId: "call-live",
						toolName: "read",
						content: [{ type: "text", text: `LIVE-${"y".repeat(9000)}` }],
						details: { source: "live-runtime" },
						timestamp: 1_767_225_602_000,
					},
				},
			];
			writeEntries(livePath, liveEntries);
			const { invoke } = await startWithPi(t, scope, {
				state: { sessionFile: livePath },
				messages: liveEntries.filter((entry) => entry.type === "message").map((entry) => entry.message),
			});
			const created = await invoke("sessions:create-anonymous", [{ projectId: PROJECT_ID }]);
			assert.equal(created.payload.ok, true, JSON.stringify(created.payload));
			const anonymous = created.payload.result.session;
			assert.equal(anonymous.noSession, true);
			const activated = await invoke("sessions:runtime-activate", [anonymous.id]);
			assert.equal(activated.payload.ok, true, JSON.stringify(activated.payload));

			// A noSession record never gets a catalog filePath; the runtime does.
			const listed = await invoke("sessions:catalog-list", [PROJECT_ID, { scan: false }]);
			const record = listed.payload.result.find((entry) => entry.id === anonymous.id);
			assert.ok(record, "the transient record must be listed");
			assert.equal(record.filePath ?? "", "", "the fallback branch requires an empty catalog filePath");

			const single = await invoke("sessions:read-tool-export-payload", [{ sessionId: anonymous.id, messageId: "lr1" }]);
			assert.equal(single.payload.ok, true, JSON.stringify(single.payload));
			assert.equal(single.payload.result.resultText.startsWith("LIVE-"), true,
				JSON.stringify(single.payload.result).slice(0, 200));
			assert.equal(single.payload.result.argsText.includes("/tmp/live.txt"), true);
			// The oracle serializes details with JSON.stringify(details, null, 2).
			assert.equal(single.payload.result.detailsText, JSON.stringify({ source: "live-runtime" }, null, 2));

			const batch = await invoke("sessions:read-tool-export-payloads", [{ sessionId: anonymous.id, messageIds: ["lr1"] }]);
			assert.equal(batch.payload.ok, true, JSON.stringify(batch.payload));
			assert.equal(batch.payload.result.lr1.resultText.startsWith("LIVE-"), true);
		});

		test("a vanished session file yields null/{} tool payloads, not an IO error", async (t) => {
			const scope = makeScope("payload-vanished");
			const { invoke, fixture } = await startPlain(t, scope);
			const sourcePath = join(fixture.sessions, "vanished.jsonl");
			writeEntries(sourcePath, timeline(scope.projectPath, {
				turns: [{ index: 1, user: "hello", assistant: "hi" }],
			}).entries);
			const record = await catalogRecord(invoke, sourcePath);
			rmSync(sourcePath, { force: true });
			// SessionHistoryReader.readToolExportPayloads swallows read failures and returns
			// an empty map, so the channels answer null/{} rather than surfacing ENOENT.
			const single = await invoke("sessions:read-tool-export-payload", [{ sessionId: record.id, messageId: "m1" }]);
			assert.equal(single.payload.ok, true, JSON.stringify(single.payload));
			assert.equal(single.payload.result, null);
			const batch = await invoke("sessions:read-tool-export-payloads", [{ sessionId: record.id, messageIds: ["m1"] }]);
			assert.equal(batch.payload.ok, true, JSON.stringify(batch.payload));
			assert.deepEqual(batch.payload.result, {});
		});

		test("tool export payload channels enforce the oracle's request bounds", async (t) => {
			const scope = makeScope("payload-bounds");
			const { invoke, fixture } = await startPlain(t, scope);
			const sourcePath = join(fixture.sessions, "bounds.jsonl");
			writeEntries(sourcePath, timeline(scope.projectPath, {
				turns: [{ index: 1, user: "hello", assistant: "hi" }],
			}).entries);
			const record = await catalogRecord(invoke, sourcePath);

			const singleNoArg = await invoke("sessions:read-tool-export-payload", []);
			assert.equal(singleNoArg.payload.ok, false);
			assert.equal(singleNoArg.payload.error.message, "Invalid tool export payload request");
			const singleMissingId = await invoke("sessions:read-tool-export-payload", [{ sessionId: record.id }]);
			assert.equal(singleMissingId.payload.error.message, "Invalid sessionId or messageId");
			const singleBlankId = await invoke("sessions:read-tool-export-payload", [{ sessionId: record.id, messageId: "   " }]);
			assert.equal(singleBlankId.payload.error.message, "Invalid sessionId or messageId");
			const singleNonString = await invoke("sessions:read-tool-export-payload", [{ sessionId: 7, messageId: "m1" }]);
			assert.equal(singleNonString.payload.error.message, "Invalid sessionId or messageId");

			const batchNoArg = await invoke("sessions:read-tool-export-payloads", []);
			assert.equal(batchNoArg.payload.error.message, "Invalid tool export payloads request");
			for (const input of [
				{ sessionId: record.id },
				{ sessionId: record.id, messageIds: [] },
				{ sessionId: record.id, messageIds: ["m1", 5] },
				{ sessionId: record.id, messageIds: ["m1", "  "] },
				{ sessionId: "", messageIds: ["m1"] },
				{ sessionId: record.id, messageIds: Array.from({ length: 201 }, (_, index) => `m${index}`) },
			]) {
				const rejected = await invoke("sessions:read-tool-export-payloads", [input]);
				assert.equal(rejected.payload.ok, false, JSON.stringify(input).slice(0, 80));
				assert.equal(rejected.payload.error.message, "Invalid tool export payloads request");
			}
			// 200 ids is the inclusive maximum: accepted, and simply finds nothing.
			const atLimit = await invoke("sessions:read-tool-export-payloads", [{
				sessionId: record.id,
				messageIds: Array.from({ length: 200 }, (_, index) => `missing-${index}`),
			}]);
			assert.equal(atLimit.payload.ok, true, JSON.stringify(atLimit.payload));
			assert.deepEqual(atLimit.payload.result, {});
			// The oracle trims ids before looking them up; padding must not turn into a miss.
			const padded = await invoke("sessions:read-tool-export-payloads", [{
				sessionId: `  ${record.id}  `,
				messageIds: ["  missing-0  "],
			}]);
			assert.equal(padded.payload.ok, true, JSON.stringify(padded.payload));
			assert.deepEqual(padded.payload.result, {});
			// Same limit with a body far larger than one socket read: the hardened HTTP parser
			// must parse the head once and then only frame the body, otherwise every large RPC
			// fails intermittently with "Duplicate Content-Length header".
			const largeIds = Array.from(
				{ length: 200 },
				(_, index) => `missing-${String(index).padStart(3, "0")}-${"x".repeat(512)}`,
			);
			const largeBody = await invoke("sessions:read-tool-export-payloads", [{
				sessionId: record.id,
				messageIds: largeIds,
			}]);
			assert.equal(largeBody.payload.ok, true, JSON.stringify(largeBody.payload).slice(0, 200));
			assert.deepEqual(largeBody.payload.result, {});
		});

		test("runtime turn paging answers from the live window but keeps file-space cursors", async (t) => {
			const scope = makeScope("turn-cache");
			const source = timeline(scope.projectPath, {
				turns: [
					{ index: 0, user: "q0", assistant: "a0" },
					{ index: 1, user: "q1", assistant: "a1" },
					{ index: 2, user: "q2", assistant: "a2" },
					{ index: 3, user: "q3", assistant: "a3" },
				],
			});
			// File keeps all 4 turns; the runtime window only covers turns 2..4.
			const liveEntries = source.entries.filter((entry) => entry.type === "message" && Number(entry.id.split("-").at(-1)) > 0);
			const liveMessages = source.messages.slice(2);
			const liveEntryIds = liveEntries.map((entry) => entry.id);
			let runtimeFile = "";
			const { invoke } = await startWithPi(t, scope, (fixture_) => {
				runtimeFile = join(fixture_.sessions, "turn-cache.jsonl");
				return {
					state: { sessionFile: runtimeFile },
					messages: liveMessages,
					entries: {
						entries: liveEntries.map((entry) => ({ id: entry.id, parentId: entry.parentId, type: entry.type })),
						leafId: liveEntryIds.at(-1),
					},
				};
			});
			writeEntries(runtimeFile, source.entries);
			const record = await catalogRecord(invoke, runtimeFile);
			const activated = await invoke("sessions:runtime-activate", [record.id]);
			assert.equal(activated.payload.ok, true, JSON.stringify(activated.payload));

			// The initial page (no cursor) must come from the file end, not the cache.
			const tail = await invoke("sessions:catalog-read-message-page", [record.id, null, 1, { unit: "turn" }]);
			assert.equal(tail.payload.ok, true, JSON.stringify(tail.payload));
			assert.deepEqual(entryIdsOf(tail.payload.result), ["u-3", "a-3"]);
			assert.equal(tail.payload.result.total, 8);
			assert.equal(tail.payload.result.nextBefore, 6);

			// Anchor on the newest live row: the page rows come from the runtime window, but
			// the first row is the Node golden's turn start and nextBefore is its FILE index.
			const liveRoles = liveMessages.map((message) => ({ role: message.role, byteLength: 0, turnBoundary: false }));
			const goldenStart = findTurnPageStart(liveRoles, 5, 1, Number.MAX_SAFE_INTEGER);
			assert.equal(goldenStart, 4, "Node golden: one turn back from a-3 starts at q3");
			const first = await invoke("sessions:catalog-read-message-page",
				[record.id, null, 1, { unit: "turn", beforeEntryId: "a-3" }]);
			assert.equal(first.payload.ok, true, JSON.stringify(first.payload));
			assert.deepEqual(entryIdsOf(first.payload.result), ["u-3"]);
			assert.equal(first.payload.result.messages[0].meta.entryId, liveEntryIds[goldenStart]);
			assert.equal(first.payload.result.total, 8, "total stays the file active-entry count");
			assert.equal(first.payload.result.nextBefore, 6, "nextBefore must be u-3's FILE index, not its live index (4)");
			assert.equal(first.payload.result.nextBeforeEntryId, "u-3");
			assert.match(first.payload.result.indexVersion, /^\d+:\d+$/);

			// Second page via the numeric file cursor: resolve entry -> live row -> file cursor.
			const goldenSecond = findTurnPageStart(liveRoles, 4, 1, Number.MAX_SAFE_INTEGER);
			assert.equal(goldenSecond, 2, "Node golden: one turn back from q3 starts at q2");
			const second = await invoke("sessions:catalog-read-message-page",
				[record.id, 6, 1, { unit: "turn", beforeEntryId: "u-3" }]);
			assert.equal(second.payload.ok, true, JSON.stringify(second.payload));
			assert.deepEqual(entryIdsOf(second.payload.result), ["u-2", "a-2"]);
			assert.equal(second.payload.result.messages[0].meta.entryId, liveEntryIds[goldenSecond]);
			assert.equal(second.payload.result.nextBefore, 4, "u-2's file index");
			assert.equal(second.payload.result.nextBeforeEntryId, "u-2");
			assert.equal(second.payload.result.total, 8);
		});

		test("repeated user text is edited by turn position, matching the Node mapping golden", async (t) => {
			const scope = makeScope("turn-edit");
			const source = timeline(scope.projectPath, {
				turns: [
					{ index: 1, user: "start", assistant: "one" },
					{ index: 2, user: "continue", assistant: "dup", secondAssistant: "dup", aborted: true },
					{ index: 3, user: "continue", assistant: "three" },
				],
				repeatedAssistant: true,
				abortEmptyAssistant: true,
			});
			let runtimeFile = "";
			const { invoke } = await startWithPi(t, scope, (fixture_) => {
				runtimeFile = join(fixture_.sessions, "edit.jsonl");
				return {
					state: { sessionFile: runtimeFile },
					messages: source.messages,
					entries: { entries: [], leafId: null },
				};
			});
			writeEntries(runtimeFile, source.entries);
			const record = await catalogRecord(invoke, runtimeFile);
			const activated = await invoke("sessions:runtime-activate", [record.id]);
			assert.equal(activated.payload.ok, true, JSON.stringify(activated.payload));
			const target = activated.payload.result.value;
			// No get_entries -> the projection id is the raw message index, so the renderer id
			// never appears in the JSONL (the real "reconnect before entries load" case).
			const cached = source.messages.map((message, index) => ({
				id: `${target.agentId}-history-${index}`,
				role: message.role,
			}));
			const fileRoles = [
				{ id: "u-1", role: "user" }, { id: "a-1", role: "assistant" },
				{ id: "u-2", role: "user" }, { id: "a-2", role: "assistant" },
				{ id: "a2-2", role: "assistant" }, { id: "a-abort-2", role: "assistant" },
				{ id: "u-3", role: "user" }, { id: "a-3", role: "assistant" },
			];
			const messageId = `${target.agentId}-history-4`;
			const golden = mapCachedMessageToEntryCandidates(cached, fileRoles, messageId);
			// Cross-realm object: compare fields (the vm realm has a different prototype).
			assert.equal(golden.role, "user",
				"Node golden: the repeated turn is aligned by turn position from the end");
			assert.equal(golden.entryId, "u-3");

			const edited = await invoke("sessions:runtime-edit-message", [
				{ sessionId: record.id, agentId: target.agentId, runtimeGeneration: target.runtimeGeneration },
				messageId,
				"edited continue",
			]);
			assert.equal(edited.payload.ok, true, JSON.stringify(edited.payload));
			assert.equal(edited.payload.result.ok, true, JSON.stringify(edited.payload));
			const entries = readEntries(runtimeFile);
			assert.equal(entries.find((entry) => entry.id === golden.entryId).message.content[0].text, "edited continue");
			assert.equal(entries.find((entry) => entry.id === "u-2").message.content[0].text, "continue");
		});

		test("repeated assistant text picks the abort-row's turn candidate, not the first match", async (t) => {
			const scope = makeScope("turn-assistant");
			const source = timeline(scope.projectPath, {
				turns: [
					{ index: 1, user: "start", assistant: "one" },
					{ index: 2, user: "continue", assistant: "dup", secondAssistant: "dup", aborted: true },
					{ index: 3, user: "continue", assistant: "three" },
				],
				repeatedAssistant: true,
				abortEmptyAssistant: true,
			});
			let runtimeFile = "";
			const { invoke } = await startWithPi(t, scope, (fixture_) => {
				runtimeFile = join(fixture_.sessions, "assistant.jsonl");
				return {
					state: { sessionFile: runtimeFile },
					messages: source.messages,
					entries: { entries: [], leafId: null },
				};
			});
			writeEntries(runtimeFile, source.entries);
			const record = await catalogRecord(invoke, runtimeFile);
			const activated = await invoke("sessions:runtime-activate", [record.id]);
			const target = activated.payload.result.value;
			const cached = source.messages.map((message, index) => ({
				id: `${target.agentId}-history-${index}`,
				role: message.role,
			}));
			const messageId = `${target.agentId}-history-3`;
			const fileRoles = [
				{ id: "u-1", role: "user" }, { id: "a-1", role: "assistant" },
				{ id: "u-2", role: "user" }, { id: "a-2", role: "assistant" },
				{ id: "a2-2", role: "assistant" }, { id: "a-abort-2", role: "assistant" },
				{ id: "u-3", role: "user" }, { id: "a-3", role: "assistant" },
			];
			const golden = mapCachedMessageToEntryCandidates(cached, fileRoles, messageId);
			assert.equal(golden.role, "assistant");
			assert.deepEqual([...golden.candidateIds], ["a-2", "a2-2", "a-abort-2"]);
			// The oracle keeps the LAST body-equal candidate of the turn; the empty abort row
			// is skipped because its text does not match.
			const chosen = [...golden.candidateIds].reverse().find((entryId) => {
				const entry = source.entries.find((candidate) => candidate.id === entryId);
				return entry.message.content.some((block) => block.type === "text" && block.text === "dup");
			});
			assert.equal(chosen, "a2-2");

			const edited = await invoke("sessions:runtime-edit-message", [
				{ sessionId: record.id, agentId: target.agentId, runtimeGeneration: target.runtimeGeneration },
				messageId,
				"edited dup",
			]);
			assert.equal(edited.payload.ok, true, JSON.stringify(edited.payload));
			const entries = readEntries(runtimeFile);
			assert.equal(entries.find((entry) => entry.id === chosen).message.content[0].text, "edited dup");
			assert.equal(entries.find((entry) => entry.id === "a-2").message.content[0].text, "dup");
		});

		test("delete-message on a repeated assistant tombstones exactly its turn", async (t) => {
			const scope = makeScope("turn-delete");
			const source = timeline(scope.projectPath, {
				turns: [
					{ index: 1, user: "start", assistant: "one" },
					{ index: 2, user: "continue", assistant: "dup", secondAssistant: "dup", aborted: true },
					{ index: 3, user: "continue", assistant: "three" },
				],
				repeatedAssistant: true,
				abortEmptyAssistant: true,
			});
			let runtimeFile = "";
			const { invoke } = await startWithPi(t, scope, (fixture_) => {
				runtimeFile = join(fixture_.sessions, "delete.jsonl");
				return {
					state: { sessionFile: runtimeFile },
					messages: source.messages,
					entries: { entries: [], leafId: null },
				};
			});
			writeEntries(runtimeFile, source.entries);
			const record = await catalogRecord(invoke, runtimeFile);
			const activated = await invoke("sessions:runtime-activate", [record.id]);
			const target = activated.payload.result.value;
			const deleted = await invoke("sessions:runtime-delete-message", [
				{ sessionId: record.id, agentId: target.agentId, runtimeGeneration: target.runtimeGeneration },
				`${target.agentId}-history-3`,
			]);
			assert.equal(deleted.payload.ok, true, JSON.stringify(deleted.payload));
			assert.equal(deleted.payload.result.ok, true, JSON.stringify(deleted.payload));
			const tombstones = readEntries(runtimeFile)
				.filter((entry) => entry.type === "deleted")
				.map((entry) => entry.id);
			// Deleting an assistant tombstones the turn *after* its user anchor, exactly like
			// SessionFileEditor.turnSegmentMessageIds: the user row itself survives.
			assert.deepEqual(tombstones.sort(), ["a-2", "a2-2", "a-abort-2"].sort());
		});

		test("deleting a parent is blocked while a session file inside its tree is live", async (t) => {
			const scope = makeScope("tree-child");
			const { invoke, fixture } = await startWithPi(t, scope, { state: {} });
			const parentPath = join(fixture.sessions, "tree.jsonl");
			writeEntries(parentPath, timeline(scope.projectPath, {
				turns: [{ index: 1, user: "parent", assistant: "answer" }],
			}).entries);
			// A nested child under <stem>/ that carries no parentSessionPath metadata (it is
			// not an internal subagent): only a path-prefix tree guard can see it.
			const childPath = join(fixture.sessions, "tree", "forked", "session.jsonl");
			writeEntries(childPath, readFileSync(parentPath, "utf8")
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line)));
			const parentRecord = await catalogRecord(invoke, parentPath);
			const childRecord = await catalogRecord(invoke, childPath);
			assert.equal(childRecord.parentSessionPath, undefined,
				"the fixture must not rely on parentSessionPath metadata");

			const activated = await invoke("sessions:runtime-activate", [childRecord.id]);
			assert.equal(activated.payload.ok, true, JSON.stringify(activated.payload));
			const deleted = await invoke("sessions:catalog-delete", [parentRecord.id]);
			assert.equal(deleted.payload.ok, false, JSON.stringify(deleted.payload));
			assert.equal(deleted.payload.error.message, "A child session is still running. Stop it first.");
			assert.equal(existsSync(parentPath), true, "a refused delete must not move the file");
		});

		test("deleting a parent is blocked while a live agent appends inside its tree", async (t) => {
			const scope = makeScope("tree-agent");
			const { invoke, fixture } = await startWithPi(t, scope, (fixture_) => ({
				state: { sessionFile: join(fixture_.sessions, "tree", "anon", "session.jsonl") },
				messages: [],
			}));
			const parentPath = join(fixture.sessions, "tree.jsonl");
			writeEntries(parentPath, timeline(scope.projectPath, {
				turns: [{ index: 1, user: "parent", assistant: "answer" }],
			}).entries);
			// The live anonymous runtime writes under <stem>/ but has no catalog filePath.
			const treeLivePath = join(fixture.sessions, "tree", "anon", "session.jsonl");
			writeEntries(treeLivePath, readFileSync(parentPath, "utf8")
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line)));
			const parentRecord = await catalogRecord(invoke, parentPath);
			const created = await invoke("sessions:create-anonymous", [{ projectId: PROJECT_ID }]);
			const anonymous = created.payload.result.session;
			const activated = await invoke("sessions:runtime-activate", [anonymous.id]);
			assert.equal(activated.payload.ok, true, JSON.stringify(activated.payload));

			const deleted = await invoke("sessions:catalog-delete", [parentRecord.id]);
			assert.equal(deleted.payload.ok, false, JSON.stringify(deleted.payload));
			assert.equal(deleted.payload.error.message,
				`Session "${anonymous.title}" is in use. Close its Agent before deleting it.`);
			assert.equal(existsSync(parentPath), true);
		});
		test("a live agent outside the session tree does not block deleting the parent", async (t) => {
			const scope = makeScope("tree-scope");
			const { invoke, fixture } = await startWithPi(t, scope, (fixture_) => ({
				state: { sessionFile: join(fixture_.sessions, "scope-copy.jsonl") },
				messages: [],
			}));
			const rootPath = join(fixture.sessions, "scope.jsonl");
			writeEntries(rootPath, timeline(scope.projectPath, {
				turns: [{ index: 1, user: "parent", assistant: "answer" }],
			}).entries);
			const livePath = join(fixture.sessions, "scope-copy.jsonl");
			writeEntries(livePath, readFileSync(rootPath, "utf8")
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line)));
			const rootRecord = await catalogRecord(invoke, rootPath);
			const created = await invoke("sessions:create-anonymous", [{ projectId: PROJECT_ID }]);
			const anonymous = created.payload.result.session;
			const activated = await invoke("sessions:runtime-activate", [anonymous.id]);
			assert.equal(activated.payload.ok, true, JSON.stringify(activated.payload));

			// Same directory, different stem: `scope-copy.jsonl` is not `scope.jsonl` and not
			// under `scope/`, so the structural tree guard must not treat it as a child.
			const deleted = await invoke("sessions:catalog-delete", [rootRecord.id]);
			assert.equal(deleted.payload.ok, true, JSON.stringify(deleted.payload));
			const afterList = await invoke("sessions:catalog-list", [PROJECT_ID, { scan: false }]);
			assert.equal(afterList.payload.result.some((entry) => entry.id === rootRecord.id), false,
				"the out-of-scope live agent must not keep the parent's catalog record alive");
			assert.equal(existsSync(livePath), true, "the unrelated live session keeps its file");
		});
	});
}
