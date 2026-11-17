import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { resolveBackendExecutable, startBackendSession } from "./helpers/native2BackendHarness.mjs";
import { holdExclusiveFileLock } from "./helpers/native2FileLock.mjs";

const executable = resolveBackendExecutable();
const PROJECT_ID = "sessions";

/** The backend reports absolute paths with forward slashes. */
const slash = (value) => String(value).replaceAll("\\", "/");

/** Minimal pi session: header, model change, two turns, a tool pair, a compaction. */
function writeSessionFile(sessionsDir, projectPath, { name = "demo", turns = 2, compaction = false } = {}) {
	const entries = [
		{ type: "session", version: 3, id: name, timestamp: "2026-01-01T00:00:00.000Z", cwd: projectPath },
		{ type: "model_change", id: "m1", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", provider: "anthropic", modelId: "claude-sonnet-4" },
	];
	let parentId = "m1";
	let sequence = 0;
	const push = (entry) => {
		entries.push(entry);
		parentId = entry.id ?? parentId;
	};
	for (let turn = 0; turn < turns; turn += 1) {
		const userId = `u${sequence++}`;
		push({
			type: "message",
			id: userId,
			parentId,
			timestamp: `2026-01-01T00:00:0${turn}.000Z`,
			message: { role: "user", content: [{ type: "text", text: `question ${turn}` }], timestamp: 1_767_225_600_000 + turn },
		});
		const assistantId = `a${sequence++}`;
		push({
			type: "message",
			id: assistantId,
			parentId,
			timestamp: `2026-01-01T00:00:1${turn}.000Z`,
			message: {
				role: "assistant",
				content: [
					{ type: "thinking", thinking: `thinking ${turn}`, thinkingSignature: "sig" },
					{ type: "toolCall", id: `call-${turn}`, name: "read", arguments: { path: `/tmp/${turn}.txt` } },
				],
				timestamp: 1_767_225_601_000 + turn,
				usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			},
		});
		const resultId = `r${sequence++}`;
		push({
			type: "message",
			id: resultId,
			parentId,
			timestamp: `2026-01-01T00:00:2${turn}.000Z`,
			message: {
				role: "toolResult",
				toolCallId: `call-${turn}`,
				toolName: "read",
				content: [{ type: "text", text: `result ${turn} ${"x".repeat(9000)}` }],
				isError: false,
				timestamp: 1_767_225_602_000 + turn,
			},
		});
	}
	if (compaction) {
		push({
			type: "compaction",
			id: "c1",
			parentId,
			timestamp: "2026-01-01T00:00:59.000Z",
			summary: "compacted summary",
			firstKeptEntryId: "u1",
			tokensBefore: 1234,
		});
	}
	push({
		type: "session_info",
		id: "si1",
		parentId,
		timestamp: "2026-01-01T00:00:59.500Z",
		name,
		cwd: projectPath,
	});
	const path = join(sessionsDir, `${name}.jsonl`);
	writeFileSync(path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
	return path;
}

if (executable) {
	describe("native2 session catalog and history parity", () => {
		let root;
		let projectPath;
		let homeDir;
		let sessionsDir;
		let downloadsDir;

		before(() => {
			root = mkdtempSync(join(tmpdir(), "pideck-native2-sessions-"));
			projectPath = join(root, "project");
			homeDir = join(root, "home");
			downloadsDir = join(root, "downloads");
			for (const directory of [projectPath, homeDir, downloadsDir]) mkdirSync(directory, { recursive: true });
		});

		after(() => {
			if (root) rmSync(root, { recursive: true, force: true });
		});

		const start = async (t, hostHandlers = {}) => {
			const session = await startBackendSession(t, {
				hostHandlers,
				projects: [{ id: PROJECT_ID, path: projectPath }],
				settings: { language: "en-US" },
				env: { PIDECK_HOST_HOME: homeDir, PIDECK_DOWNLOADS_DIR: downloadsDir },
			});
			sessionsDir = session.fixture.sessions;
			return session;
		};

		test("catalog-create-draft writes metadata only and never a session file", async (t) => {
			const { invoke } = await start(t);
			const before_ = readdirSync(sessionsDir);
			const created = await invoke("sessions:catalog-create-draft", [{ projectId: PROJECT_ID, title: "Draft one" }]);
			assert.equal(created.payload.ok, true, JSON.stringify(created.payload));
			const record = created.payload.result;
			assert.match(record.id, /^[0-9a-f-]{36}$/);
			assert.equal(record.status, "draft");
			assert.equal(record.title, "Draft one");
			assert.equal(record.filePath, undefined);
			// No JSONL: a draft is catalog metadata, not a half-initialized pi session.
			assert.deepEqual(readdirSync(sessionsDir), before_);

			const second = await invoke("sessions:catalog-create-draft", [{ projectId: PROJECT_ID, title: "Draft two" }]);
			assert.notEqual(second.payload.result.id, record.id);
		});

		test("catalog-delete rejects malformed permanent deletion options without removing the record", async (t) => {
			const { invoke } = await start(t);
			const created = await invoke("sessions:catalog-create-draft", [{ projectId: PROJECT_ID, title: "Protected draft" }]);
			const id = created.payload.result.id;
			const deleted = await invoke("sessions:catalog-delete", [id, { permanent: "true" }]);
			assert.equal(deleted.payload.ok, false, JSON.stringify(deleted.payload));
			const list = await invoke("sessions:catalog-list", [PROJECT_ID, { scan: false }]);
			assert.ok(list.payload.result.some((record) => record.id === id));
		});

		test("explicit trash refusal preserves the catalog and a permanent retry removes only owned targets", async (t) => {
			const calls = [];
			const { invoke } = await start(t, { "shell.trashItem": (params) => {
				calls.push(params);
				if (calls.length === 1) { rmSync(params.path, { recursive: true, force: true }); return { result: null }; }
				return { result: { status: "trash-failed" } };
			} });
			const filePath = writeSessionFile(sessionsDir, projectPath, { name: "trash-failure" });
			const peerPath = writeSessionFile(sessionsDir, projectPath, { name: "trash-peer" });
			const backup = `${filePath}.1700000000000-0f0e0d0c-0b0a-4908-8706-050403020100.edit-backup`;
			writeFileSync(backup, "backup");
			const artifacts = join(sessionsDir, "subagent-artifacts", "outputs");
			mkdirSync(artifacts, { recursive: true });
			const owned = "11111111-2222-4333-8444-555555555555";
			const shared = "99999999-8888-4777-8666-555555555555";
			const entry = (runId) => JSON.stringify({ type: "message", message: { role: "toolResult", toolName: "subagent", details: { mode: "single", runId } } });
			writeFileSync(filePath, `${readFileSync(filePath, "utf8")}${entry(owned)}\n${entry(shared)}\n`);
			writeFileSync(peerPath, `${readFileSync(peerPath, "utf8")}${entry(shared)}\n`);
			const ownedPath = join(artifacts, `${owned}_output`);
			const sharedPath = join(artifacts, `${shared}_output`);
			const longDir = join(ownedPath, "long-" + "x".repeat(110), "nested-" + "y".repeat(80));
			mkdirSync(longDir, { recursive: true }); writeFileSync(join(longDir, "result.txt"), "owned");
			assert.ok(join(longDir, "result.txt").length > 260);
			mkdirSync(sharedPath); writeFileSync(join(sharedPath, "result.txt"), "shared");
			const list = await invoke("sessions:catalog-list", [PROJECT_ID]);
			const record = list.payload.result.find((item) => slash(item.filePath) === slash(filePath));
			const failed = await invoke("sessions:catalog-delete", [record.id]);
			assert.deepEqual(failed.payload.result, { status: "trash-failed" });
			assert.equal(calls[0].typedFailure, true);
			assert.equal(existsSync(backup), false, "a previously moved target is already absent on retry");
			assert.ok(existsSync(filePath));
			const cached = await invoke("sessions:catalog-list", [PROJECT_ID, { scan: false }]);
			assert.ok(cached.payload.result.some((item) => item.id === record.id));
			const removed = await invoke("sessions:catalog-delete", [record.id, { permanent: true }]);
			assert.equal(removed.payload.result, true, JSON.stringify(removed.payload));
			assert.equal(existsSync(filePath), false);
			assert.equal(existsSync(ownedPath), false);
			assert.ok(existsSync(sharedPath));
			assert.ok(existsSync(peerPath));
			const after = await invoke("sessions:catalog-list", [PROJECT_ID, { scan: false }]);
			assert.equal(after.payload.result.some((item) => item.id === record.id), false);
		});

		test("bridge failures are not recycle-bin refusals", async (t) => {
			const { invoke } = await start(t, { "shell.trashItem": () => ({ ok: false, error: "bridge unavailable" }) });
			const filePath = writeSessionFile(sessionsDir, projectPath, { name: "bridge-failure" });
			const list = await invoke("sessions:catalog-list", [PROJECT_ID]);
			const record = list.payload.result.find((item) => slash(item.filePath) === slash(filePath));
			const result = await invoke("sessions:catalog-delete", [record.id]);
			assert.equal(result.payload.ok, false);
			const after = await invoke("sessions:catalog-list", [PROJECT_ID, { scan: false }]);
			assert.ok(after.payload.result.some((item) => item.id === record.id));
		});

		test("a failed permanent deletion keeps its catalog record", { skip: process.platform !== "win32" }, async (t) => {
			const { invoke } = await start(t, { "shell.trashItem": () => ({ result: { status: "trash-failed" } }) });
			const filePath = writeSessionFile(sessionsDir, projectPath, { name: "readonly-delete" });
			const list = await invoke("sessions:catalog-list", [PROJECT_ID]);
			const record = list.payload.result.find((item) => slash(item.filePath) === slash(filePath));
			const initial = await invoke("sessions:catalog-delete", [record.id]);
			assert.deepEqual(initial.payload.result, { status: "trash-failed" });
			// A real sharing violation remains a failure even when permanent cleanup
			// can clear ordinary Windows read-only attributes, like the shared fs walker.
			const release = await holdExclusiveFileLock(t, filePath);
			try {
				const result = await invoke("sessions:catalog-delete", [record.id, { permanent: true }]);
				assert.equal(result.payload.ok, false, JSON.stringify(result.payload));
				assert.ok(existsSync(filePath));
				const after = await invoke("sessions:catalog-list", [PROJECT_ID, { scan: false }]);
				assert.ok(after.payload.result.some((item) => item.id === record.id));
			} finally { await release(); }
		});

		test("catalog-list merges the scanned file under a stable UUID identity", async (t) => {
			const { invoke } = await start(t);
			const filePath = writeSessionFile(sessionsDir, projectPath, { name: "listed" });
			const first = await invoke("sessions:catalog-list", [PROJECT_ID]);
			assert.equal(first.payload.ok, true, JSON.stringify(first.payload));
			const entry = first.payload.result.find((record) => slash(record.filePath) === slash(filePath));
			assert.ok(entry, "scanned session must be in the catalog");
			assert.match(entry.id, /^[0-9a-f-]{36}$/);

			// A second list must keep the identity: the UUID is the cross-restart owner.
			const second = await invoke("sessions:catalog-list", [PROJECT_ID, { scan: false }]);
			const again = second.payload.result.find((record) => slash(record.filePath) === slash(filePath));
			assert.equal(again.id, entry.id);

			// scan:false must not pick up a brand new file (it is the cached read path).
			writeSessionFile(sessionsDir, projectPath, { name: "unscanned" });
			const cached = await invoke("sessions:catalog-list", [PROJECT_ID, { scan: false }]);
			assert.equal(cached.payload.result.some((record) => record.title === "unscanned"), false);
		});

		test("catalog-list rejects an unknown project", async (t) => {
			const { invoke } = await start(t);
			const actual = await invoke("sessions:catalog-list", ["missing"]);
			assert.equal(actual.payload.ok, false);
			assert.equal(actual.payload.error.message, "Project not found: missing");
		});

		test("read-message-page pages by turn without splitting a turn or dropping entries", async (t) => {
			const { invoke } = await start(t);
			const filePath = writeSessionFile(sessionsDir, projectPath, { name: "paged", turns: 4 });
			const list = await invoke("sessions:catalog-list", [PROJECT_ID]);
			const record = list.payload.result.find((entry) => slash(entry.filePath) === slash(filePath));
			assert.ok(record);

			const all = await invoke("sessions:catalog-read-messages", [record.id]);
			assert.equal(all.payload.ok, true, JSON.stringify(all.payload));
			const allMessages = all.payload.result;
			assert.ok(allMessages.length >= 12, `expected the whole timeline, got ${allMessages.length}`);

			const seen = [];
			let before;
			let beforeEntryId;
			for (let page = 0; page < 20; page += 1) {
				const args = [record.id, before ?? null, 2, { unit: "turn" }];
				if (beforeEntryId) args[3].beforeEntryId = beforeEntryId;
				const response = await invoke("sessions:catalog-read-message-page", args);
				assert.equal(response.payload.ok, true, JSON.stringify(response.payload));
				const result = response.payload.result;
				assert.ok(result.messages.length > 0);
				assert.ok(result.messages.length <= 6, "a turn page must stay bounded");
				// A turn page starts on a user message: an answer is never cut in half.
				assert.equal(result.messages[0].role, "user");
				seen.unshift(...result.messages);
				if (result.nextBefore === null || result.nextBefore === undefined) break;
				before = result.nextBefore;
				beforeEntryId = result.nextBeforeEntryId;
			}
			assert.deepEqual(seen.map((message) => message.id), allMessages.map((message) => message.id));
			assert.equal(seen.length, allMessages.length);
		});

		test("read-message-page keeps tool pairing and truncates tool detail", async (t) => {
			const { invoke } = await start(t);
			const filePath = writeSessionFile(sessionsDir, projectPath, { name: "tools", turns: 1 });
			const list = await invoke("sessions:catalog-list", [PROJECT_ID]);
			const record = list.payload.result.find((entry) => slash(entry.filePath) === slash(filePath));

			const page = await invoke("sessions:catalog-read-message-page", [record.id, null, 100, { unit: "message" }]);
			assert.equal(page.payload.ok, true, JSON.stringify(page.payload));
			const toolResult = page.payload.result.messages.find((message) => message.role === "tool");
			assert.ok(toolResult, "the tool result must be projected");
			assert.equal(toolResult.meta.toolCallId, "call-0");
			assert.equal(toolResult.meta.toolName, "read");
			assert.ok(toolResult.meta.detailText.length < 9000, "tool detail must be truncated in the timeline");
			assert.equal(toolResult.meta.truncated, true);
			assert.equal(toolResult.role, "tool");

			// The renderer passes meta.entryId for history rows: the message id is a synthetic
			// `<agent>-history-<entryId>` handle, not the JSONL entry id.
			assert.ok(toolResult.meta.entryId, "history rows must expose their entryId");
			const full = await invoke("sessions:catalog-read-message-full-text", [record.id, "agent", toolResult.id, toolResult.meta.entryId]);
			assert.equal(full.payload.ok, true, JSON.stringify(full.payload));
			assert.ok(full.payload.result.text.length > 9000, "full text must be untruncated");
		});

		test("read-tool-export-payloads returns untruncated arguments and results", async (t) => {
			const { invoke } = await start(t);
			const filePath = writeSessionFile(sessionsDir, projectPath, { name: "export", turns: 1 });
			const list = await invoke("sessions:catalog-list", [PROJECT_ID]);
			const record = list.payload.result.find((entry) => slash(entry.filePath) === slash(filePath));
			const page = await invoke("sessions:catalog-read-message-page", [record.id, null, 100, { unit: "message" }]);
			const toolResult = page.payload.result.messages.find((message) => message.role === "tool");

			const single = await invoke("sessions:read-tool-export-payload", [{ sessionId: record.id, messageId: toolResult.id }]);
			assert.equal(single.payload.ok, true, JSON.stringify(single.payload));
			assert.ok(single.payload.result.resultText.length > 9000);

			const batch = await invoke("sessions:read-tool-export-payloads", [{ sessionId: record.id, messageIds: [toolResult.id] }]);
			assert.equal(batch.payload.ok, true, JSON.stringify(batch.payload));
			assert.deepEqual(Object.keys(batch.payload.result), [toolResult.id]);

			const missing = await invoke("sessions:read-tool-export-payload", [{ sessionId: record.id, messageId: "nope" }]);
			assert.equal(missing.payload.ok, true);
			assert.equal(missing.payload.result, null);
		});

		test("read-process-events lists only non-message entries", async (t) => {
			const { invoke } = await start(t);
			const filePath = writeSessionFile(sessionsDir, projectPath, { name: "events", turns: 1 });
			const list = await invoke("sessions:catalog-list", [PROJECT_ID]);
			const record = list.payload.result.find((entry) => slash(entry.filePath) === slash(filePath));
			const events = await invoke("sessions:catalog-read-process-events", [record.id]);
			assert.equal(events.payload.ok, true, JSON.stringify(events.payload));
			assert.ok(Array.isArray(events.payload.result));
			assert.ok(events.payload.result.length > 0);
			for (const event of events.payload.result) {
				assert.notEqual(event.kind, "message");
			}
		});

		test("archive moves the file and its companion directory, then unarchive restores both", async (t) => {
			const { invoke } = await start(t);
			const filePath = writeSessionFile(sessionsDir, projectPath, { name: "archived" });
			const companion = join(sessionsDir, "archived");
			mkdirSync(companion, { recursive: true });
			writeFileSync(join(companion, "note.txt"), "companion\n");

			const list = await invoke("sessions:catalog-list", [PROJECT_ID]);
			const record = list.payload.result.find((entry) => slash(entry.filePath) === slash(filePath));
			const archived = await invoke("sessions:catalog-archive", [record.id]);
			assert.equal(archived.payload.ok, true, JSON.stringify(archived.payload));
			assert.equal(archived.payload.result, true);
			assert.equal(existsSync(filePath), false);
			assert.equal(existsSync(companion), false);

			const archiveDir = join(sessionsDir, ".pideck-archive");
			const archivedFiles = readdirSync(archiveDir).filter((name) => name.endsWith(".jsonl"));
			assert.deepEqual(archivedFiles, ["archived.jsonl"]);
			assert.equal(existsSync(join(archiveDir, "archived", "note.txt")), true);
			const index = JSON.parse(readFileSync(join(archiveDir, "index.json"), "utf8"));
			assert.deepEqual(Object.keys(index).map(slash), [slash(join(archiveDir, "archived.jsonl"))]);
			assert.equal(slash(index[Object.keys(index)[0]]), slash(filePath));

			const listed = await invoke("sessions:catalog-list-archived");
			assert.equal(listed.payload.ok, true, JSON.stringify(listed.payload));
			assert.equal(listed.payload.result.some((summary) => slash(summary.filePath) === slash(join(archiveDir, "archived.jsonl"))), true);

			const restored = await invoke("sessions:catalog-unarchive", [join(archiveDir, "archived.jsonl")]);
			assert.equal(restored.payload.ok, true, JSON.stringify(restored.payload));
			assert.equal(existsSync(filePath), true);
			assert.equal(readFileSync(join(companion, "note.txt"), "utf8"), "companion\n");
			assert.deepEqual(JSON.parse(readFileSync(join(archiveDir, "index.json"), "utf8")), {});
		});

		test("archive rejects a path that is not inside an archive directory", async (t) => {
			const { invoke } = await start(t);
			const actual = await invoke("sessions:catalog-unarchive", [join(sessionsDir, "nope.jsonl")]);
			assert.equal(actual.payload.ok, false);
			assert.match(actual.payload.error.message, /archived session path/i);
		});

		test("catalog-delete trashes the file, its edit backups and only owned artifacts", async (t) => {
			const session = await start(t);
			const { invoke } = session;
			const filePath = writeSessionFile(sessionsDir, projectPath, { name: "deleted" });
			const backup = `${filePath}.1700000000000-0f0e0d0c-0b0a-4908-8706-050403020100.edit-backup`;
			writeFileSync(backup, "backup\n");
			const artifacts = join(sessionsDir, "subagent-artifacts");
			mkdirSync(artifacts, { recursive: true });
			const ownedRunId = "11111111-2222-4333-8444-555555555555";
			const peerRunId = "99999999-8888-4777-8666-555555555555";
			writeFileSync(join(artifacts, `${ownedRunId}_output.txt`), "owned\n");
			writeFileSync(join(artifacts, `${peerRunId}_output.txt`), "peer\n");
			// Ownership comes from a structured subagent tool result, not from prose.
			const withRun = readFileSync(filePath, "utf8").trimEnd().split("\n");
			withRun.push(JSON.stringify({
				type: "message",
				id: "sub1",
				parentId: "si1",
				timestamp: "2026-01-01T00:01:00.000Z",
				message: {
					role: "toolResult",
					toolCallId: "sub-call",
					toolName: "subagent",
					content: [{ type: "text", text: "done" }],
					details: { mode: "single", runId: ownedRunId },
					timestamp: 1_767_225_660_000,
				},
			}));
			writeFileSync(filePath, `${withRun.join("\n")}\n`);

			const list = await invoke("sessions:catalog-list", [PROJECT_ID]);
			const record = list.payload.result.find((entry) => slash(entry.filePath) === slash(filePath));
			const removed = await invoke("sessions:catalog-delete", [record.id]);
			assert.equal(removed.payload.ok, true, JSON.stringify(removed.payload));
			assert.equal(removed.payload.result, true);

			const trashed = session.trashCalls.map((path) => path.replaceAll("\\", "/"));
			assert.ok(trashed.includes(filePath.replaceAll("\\", "/")), `file must be trashed: ${trashed}`);
			assert.ok(trashed.includes(backup.replaceAll("\\", "/")), `edit backup must be trashed: ${trashed}`);
			assert.ok(
				trashed.includes(join(artifacts, `${ownedRunId}_output.txt`).replaceAll("\\", "/")),
				`owned artifact must be trashed: ${trashed}`,
			);
			assert.equal(
				trashed.includes(join(artifacts, `${peerRunId}_output.txt`).replaceAll("\\", "/")),
				false,
				"an artifact another session references must survive",
			);

			const after_ = await invoke("sessions:catalog-list", [PROJECT_ID]);
			assert.equal(after_.payload.result.some((entry) => entry.id === record.id), false);
		});

		test("codex import writes pi-native JSONL with a session_info trailer", async (t) => {
			const { invoke } = await start(t);
			const codexRoot = join(homeDir, ".codex", "sessions", "2026", "01", "01");
			mkdirSync(codexRoot, { recursive: true });
			const rollout = join(codexRoot, "rollout-1.jsonl");
			const entries = [
				{ type: "session_meta", payload: { id: "codex-1", cwd: projectPath, timestamp: "2026-01-01T00:00:00.000Z", model: "gpt-5", model_provider: "openai" } },
				{ type: "event_msg", timestamp: "2026-01-01T00:00:01.000Z", payload: { type: "user_message", message: "hello codex" } },
				{ type: "response_item", timestamp: "2026-01-01T00:00:02.000Z", payload: { type: "reasoning", summary: [{ text: "thinking" }] } },
				{ type: "response_item", timestamp: "2026-01-01T00:00:03.000Z", payload: { type: "message", role: "assistant", content: [{ text: "hi" }] } },
			];
			writeFileSync(rollout, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);

			const scan = await invoke("codex-sessions:scan", [PROJECT_ID]);
			assert.equal(scan.payload.ok, true, JSON.stringify(scan.payload));
			assert.equal(scan.payload.result.length, 1);
			const summary = scan.payload.result[0];
			assert.equal(summary.id, "codex-1");
			assert.equal(summary.status, "new");
			assert.equal(summary.title, "hello codex");
			assert.equal(summary.messageCount, 2);

			const imported = await invoke("codex-sessions:import", [PROJECT_ID, [rollout]]);
			assert.equal(imported.payload.ok, true, JSON.stringify(imported.payload));
			assert.equal(imported.payload.result.imported, 1);
			assert.equal(imported.payload.result.failed, 0);
			const result = imported.payload.result.results[0];
			assert.equal(result.success, true);
			assert.equal(result.overwritten, false);

			const lines = readFileSync(result.targetPath, "utf8").trimEnd().split("\n").map((line) => JSON.parse(line));
			assert.equal(lines[0].type, "session");
			assert.equal(lines[0].cwd, projectPath);
			assert.equal(lines[1].type, "codex_import");
			assert.equal(lines[2].type, "model_change");
			// pi refuses to load a session whose first line is not a typed record, so the
			// title must arrive as a trailing session_info, never a header sessionName.
			assert.equal(lines.at(-1).type, "session_info");
			assert.equal(lines.at(-1).name, "hello codex");
			assert.equal(lines.some((line) => line.sessionName !== undefined), false);

			const rescan = await invoke("codex-sessions:scan", [PROJECT_ID]);
			assert.equal(rescan.payload.result[0].status, "current");
		});

		test("claude import mirrors the same pi session shape", async (t) => {
			const { invoke } = await start(t);
			// Both importers remove the POSIX root slash before encoding directory separators.
			const projectDirectory = slash(projectPath).replace(/^([A-Za-z]):\/(.+)$/, "$1--$2")
				.replace(/^\//, "").replaceAll("/", "-");
			const claudeDir = join(homeDir, ".claude", "projects", projectDirectory);
			mkdirSync(claudeDir, { recursive: true });
			const source = join(claudeDir, "session-1.jsonl");
			const entries = [
				{ type: "user", sessionId: "claude-1", cwd: projectPath, timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: "hello claude" } },
				{ type: "assistant", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "assistant", model: "claude-sonnet-4", stop_reason: "end_turn", content: [{ type: "text", text: "hi back" }] } },
			];
			writeFileSync(source, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);

			const scan = await invoke("claude-sessions:scan", [PROJECT_ID]);
			assert.equal(scan.payload.ok, true, JSON.stringify(scan.payload));
			assert.equal(scan.payload.result.length, 1);
			assert.equal(scan.payload.result[0].id, "claude-1");
			assert.equal(scan.payload.result[0].title, "hello claude");

			const imported = await invoke("claude-sessions:import", [PROJECT_ID, [source]]);
			assert.equal(imported.payload.ok, true, JSON.stringify(imported.payload));
			assert.equal(imported.payload.result.imported, 1);
			const lines = readFileSync(imported.payload.result.results[0].targetPath, "utf8").trimEnd().split("\n").map((line) => JSON.parse(line));
			assert.equal(lines[1].type, "claude_import");
			assert.equal(lines.at(-1).type, "session_info");
		});

		test("import rejects a source outside the importer root", async (t) => {
			const { invoke } = await start(t);
			const outside = join(root, "outside.jsonl");
			writeFileSync(outside, "{}\n");
			const imported = await invoke("claude-sessions:import", [PROJECT_ID, [outside]]);
			assert.equal(imported.payload.ok, true, JSON.stringify(imported.payload));
			assert.equal(imported.payload.result.failed, 1);
			assert.match(imported.payload.result.results[0].error, /outside the expected directory/i);
		});
	});
}
