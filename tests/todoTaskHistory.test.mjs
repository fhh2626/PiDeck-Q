import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { loadSessionScanner, flushLoadedScanners } from "./helpers/loadSessionScanner.mjs";

const { AgentMessageProjector, buildActiveBranchEntryIds } = loadTsCommonJs("src/main/pi/AgentMessageProjector.ts");
const { SessionHistoryReader } = loadTsCommonJs("src/main/pi/SessionHistoryReader.ts");
const { trimHistoryMessages } = loadTsCommonJs("src/main/pi/agentUtils.ts");
const projector = new AgentMessageProjector({ translate: (key) => key, isAskAborted: () => false });
const task = { type: "custom_message", customType: "pi-deck-todo-task-start", content: "Inspect the parser", display: true, id: "goal", parentId: "root", timestamp: "2026-11-11T00:00:00.000Z" };
const hidden = { ...task, id: "rules", parentId: "goal", customType: "pi-deck-todo-task-context", display: false };
const resume = { ...task, id: "resume", parentId: "rules", customType: "pi-deck-todo-task-resume", content: "Access granted", details: { taskId: "task-1" } };
const assistant = { id: "reply", parentId: "rules", type: "message", timestamp: task.timestamp, message: { role: "assistant", content: "Inspection complete", timestamp: 1 } };

async function historyFixture(t) {
	const home = await mkdtemp(join(tmpdir(), "pideck-todo-history-"));
	t.after(async () => { await flushLoadedScanners(); await rm(home, { recursive: true, force: true }); });
	const directory = join(home, ".pi", "agent", "sessions", "project");
	await mkdir(directory, { recursive: true });
	const path = join(directory, "session.jsonl");
	const rows = [{ type: "session", id: "root", cwd: home }, task, hidden, assistant];
	await writeFile(path, rows.map(JSON.stringify).join("\n") + "\n");
	const reader = new SessionHistoryReader({ toHostPath: (value) => value, trimMessages: trimHistoryMessages,
		convertMessages: (...args) => projector.convert(...args), translate: (key) => key });
	return { home, path, rows, reader };
}

test("neutral task-start messages are visible while hidden rules do not consume identity slots", () => {
	const ids = buildActiveBranchEntryIds([{ id: "root", parentId: null }, task, hidden, assistant], "reply");
	const messages = projector.convert("agent", [
		{ role: "custom", ...task }, { role: "custom", ...hidden }, assistant.message,
	], ids);
	assert.equal(messages.length, 2);
	assert.equal(messages[0].text, task.content);
	assert.equal(messages[0].role, "system", "extension task goals are not editable/resendable fake user entries");
	assert.equal(messages[0].meta.entryId, "goal");
	assert.equal(messages[1].meta.entryId, "reply");
});

test("task goals survive full, paginated and recent file-based history reads", async (t) => {
	const { reader, path } = await historyFixture(t);
	for (const messages of [
		await reader.readSessionDisplayMessages(path, "agent"),
		(await reader.readSessionDisplayTurnPage(path, "agent", undefined, 1)).messages,
		(await reader.readSessionDisplayMessagePage(path, "agent", undefined, 10)).messages,
	]) {
		assert.deepEqual(Array.from(messages, (message) => message.text), [task.content, "Inspection complete"]);
		assert.equal(messages[1].meta.entryId, "reply");
	}
	const recent = await reader.readRecentMessages(path, 1);
	assert.equal(recent.data.messages.length, 2);
	const identity = await reader.readActiveEntryIdentity(path);
	assert.deepEqual(Array.from(identity.entryIds), ["goal", "reply"]);
	const snapshot = reader.getRecentSnapshot(recent, path);
	assert.deepEqual(Array.from(snapshot.entryIds), ["goal", "reply"]);
});

test("catalog title and preview retain the original task after atomic custom startup", async (t) => {
	const { home, path } = await historyFixture(t);
	const { SessionScanner } = loadSessionScanner(home);
	const scanner = new SessionScanner(undefined, home, undefined, undefined, home);
	const summaries = await scanner.list(home);
	const summary = summaries.find((row) => row.filePath === path);
	assert.ok(summary);
	assert.equal(summary.name, task.content);
	assert.equal(summary.preview, task.content);
	const messages = await scanner.readMessages(path);
	assert.deepEqual(Array.from(messages, (message) => message.content), [task.content, "Inspection complete"]);
	assert.equal(messages[0].role, "system");
});

test("resume guidance is a visible read-only turn boundary in live and file history", async (t) => {
	// Chain the branch explicitly: guidance is a turn of its own, not a sibling of the reply.
	const resumeEntry = { ...resume, parentId: "rules" };
	const reply = { ...assistant, parentId: "resume" };
	const rows = [{ id: "root", parentId: null }, task, hidden, resumeEntry, reply];
	const ids = buildActiveBranchEntryIds(rows, "reply");
	const messages = projector.convert("agent", [
		{ role: "custom", ...task }, { role: "custom", ...hidden }, { role: "custom", ...resumeEntry }, reply.message,
	], ids);
	assert.deepEqual(Array.from(messages, (message) => message.text),
		[task.content, resume.content, "Inspection complete"], "guidance is not dropped from the timeline");
	assert.equal(messages[1].role, "system", "guidance stays read-only instead of a fake user entry");
	assert.equal(messages[1].meta.todoTaskKind, "resume");
	assert.equal(messages[0].meta.todoTaskKind, "goal");
	assert.equal(messages[1].meta.entryId, "resume");

	const home = await mkdtemp(join(tmpdir(), "pideck-todo-resume-"));
	t.after(async () => { await flushLoadedScanners(); await rm(home, { recursive: true, force: true }); });
	const directory = join(home, ".pi", "agent", "sessions", "project");
	await mkdir(directory, { recursive: true });
	const path = join(directory, "session.jsonl");
	await writeFile(path, [{ type: "session", id: "root", cwd: home }, task, hidden, resumeEntry, reply]
		.map(JSON.stringify).join("\n") + "\n");
	const reader = new SessionHistoryReader({ toHostPath: (value) => value, trimMessages: trimHistoryMessages,
		convertMessages: (...args) => projector.convert(...args), translate: (key) => key });
	for (const history of [await reader.readSessionDisplayMessages(path, "agent"),
		(await reader.readSessionDisplayMessagePage(path, "agent", undefined, 10)).messages]) {
		assert.deepEqual(Array.from(history, (message) => message.text), [task.content, resume.content, "Inspection complete"]);
		assert.equal(history[1].meta.todoTaskKind, "resume");
	}
	// Catalog titles keep the original goal: guidance is not a new task.
	const { SessionScanner } = loadSessionScanner(home);
	const summary = (await new SessionScanner(undefined, home, undefined, undefined, home).list(home))
		.find((row) => row.filePath === path);
	assert.equal(summary?.name, task.content);
});

test("live resume guidance is added once and never merged into the goal card", async (t) => {
	const { loadAgentManagerWithFakePi, createFakePiManager } = await import("./helpers/l4_agentManagerHarness.mjs");
	const manager = createFakePiManager(loadAgentManagerWithFakePi());
	const agentId = "agent";
	manager.agents.set(agentId, { tab: { id: agentId, projectId: "p1", cwd: "/proj", title: "Title", status: "running", createdAt: 1 },
		process: { stop() {}, client: { request: async () => ({ success: true, data: {} }) } } });
	t.after(() => manager.stopAll());
	manager.handlePiEvent(agentId, { type: "message_end", message: { role: "custom", ...task, details: { taskId: "task-1" } } });
	manager.handlePiEvent(agentId, { type: "message_end", message: { role: "custom", ...resume } });
	manager.handlePiEvent(agentId, { type: "message_end", message: { role: "custom", ...resume } });
	const cards = manager.messages.get(agentId);
	assert.deepEqual(Array.from(cards, (message) => message.text), [task.content, resume.content],
		"guidance is visible once even though it repeats the goal's task id");
	assert.deepEqual(Array.from(cards, (message) => message.meta.todoTaskKind), ["goal", "resume"]);
});

test("file index marks task cards as turn boundaries so user entry mapping stays aligned", async (t) => {
	const { reader, path } = await historyFixture(t);
	const identity = await reader.readActiveEntryIdentity(path);
	const goalEntry = identity.activeMessageEntries.find((entry) => entry.id === "goal");
	assert.equal(goalEntry?.turnBoundary, true, "the goal card is a turn boundary in the file index");
	assert.equal(identity.activeMessageEntries.find((entry) => entry.id === "reply")?.turnBoundary, undefined);
	// Cached side: the goal card is system + todoTask meta. Both sides must count the same turns.
	const { mapCachedMessageToEntryCandidates } = loadTsCommonJs("src/main/pi/agentUtils.ts");
	const cached = [
		{ id: "u1", role: "user" },
		{ id: "goal", role: "system", turnBoundary: true },
		{ id: "u2", role: "user" },
	];
	const entries = [
		{ id: "e-u1", role: "user" },
		{ id: "goal", role: "user", turnBoundary: true },
		{ id: "e-u2", role: "user" },
	];
	assert.equal(mapCachedMessageToEntryCandidates(cached, entries, "u1")?.entryId, "e-u1");
	assert.equal(mapCachedMessageToEntryCandidates(cached, entries, "u2")?.entryId, "e-u2");
});

test("live resume cards with the same text: a real second resume is shown, a replay is deduped", async (t) => {
	const { loadAgentManagerWithFakePi, createFakePiManager } = await import("./helpers/l4_agentManagerHarness.mjs");
	const manager = createFakePiManager(loadAgentManagerWithFakePi());
	const agentId = "agent";
	manager.agents.set(agentId, { tab: { id: agentId, projectId: "p1", cwd: "/proj", title: "Title", status: "running", createdAt: 1 },
		process: { stop() {}, client: { request: async () => ({ success: true, data: {} }) } } });
	t.after(() => manager.stopAll());
	manager.handlePiEvent(agentId, { type: "message_end", message: { role: "custom", ...task, details: { taskId: "task-1" } } });
	const first = { role: "custom", ...resume, timestamp: "2026-11-11T00:00:00.500Z" };
	manager.handlePiEvent(agentId, { type: "message_end", message: first });
	// A separate resume repeats the same guidance after a second blocker.
	manager.handlePiEvent(agentId, { type: "message_end", message: { role: "custom", ...resume, timestamp: "2026-11-11T00:00:01.000Z" } });
	assert.deepEqual(Array.from(manager.messages.get(agentId), (message) => message.text),
		[task.content, resume.content, resume.content], "two real resumes are two user turns");
	// Replaying the same message (reconnect) must not add a third card.
	manager.handlePiEvent(agentId, { type: "message_end", message: first });
	assert.equal(manager.messages.get(agentId).length, 3);
});

test("task boundaries survive context trimming and consume matching identity slots", () => {
	const { contextTrimStartIndex, countRoleMessagesBefore } = loadTsCommonJs("src/main/pi/agentUtils.ts");
	const first = { role: "custom", ...task };
	const second = { ...first, content: "Second task" };
	const longTurn = [first, ...Array.from({ length: 60 }, () => assistant.message)];
	assert.equal(contextTrimStartIndex(longTurn, 1), 0, "a long goal turn must not be truncated to 50 messages");
	assert.equal(contextTrimStartIndex([...longTurn, second, assistant.message], 1), longTurn.length);
	assert.equal(countRoleMessagesBefore([first, { role: "custom", ...hidden }, assistant.message], 3), 2);
	const displayed = projector.convert("agent", [first, assistant.message]);
	assert.equal(countRoleMessagesBefore(displayed, 2), 2, "runtime-cache trimming uses the same slot count as raw RPC history");
});

test("live custom task starts are displayed once, including after history replacement", async (t) => {
	const { loadAgentManagerWithFakePi, createFakePiManager } = await import("./helpers/l4_agentManagerHarness.mjs");
	const manager = createFakePiManager(loadAgentManagerWithFakePi());
	const agentId = "agent";
	manager.agents.set(agentId, { tab: { id: agentId, projectId: "p1", cwd: "/proj", title: "Title", status: "running", createdAt: 1 },
		process: { stop() {}, client: { request: async () => ({ success: true, data: {} }) } } });
	t.after(() => manager.stopAll());
	const message = { role: "custom", ...task, details: { taskId: "task-1" } };
	manager.handlePiEvent(agentId, { type: "message_end", message });
	assert.equal(manager.messages.get(agentId)?.length, 1);
	assert.equal(manager.messages.get(agentId)[0].text, task.content);
	manager.handlePiEvent(agentId, { type: "message_end", message });
	assert.equal(manager.messages.get(agentId).length, 1);
	manager.messages.set(agentId, projector.convert(agentId, [message], ["goal"]));
	manager.handlePiEvent(agentId, { type: "message_end", message });
	assert.equal(manager.messages.get(agentId).length, 1);
	manager.handlePiEvent(agentId, { type: "message_end", message: { role: "custom", ...hidden } });
	assert.equal(manager.messages.get(agentId).length, 1, "internal task rules stay hidden in the live timeline");
});

test("projected task cards keep a numeric timestamp and the sender's message identity", () => {
	const [card] = projector.convert("agent", [
		{ role: "custom", ...resume, details: { taskId: "task-1", messageId: "resume-1" } },
	], ["resume"]);
	assert.equal(card.meta.todoTaskMessageId, "resume-1", "live and projected cards must share one identity");
	assert.equal(typeof card.timestamp, "number", "an ISO entry timestamp must not leak into the numeric chat timestamp");
	assert.equal(card.timestamp, Date.parse(resume.timestamp));
});

test("a new live resume is not swallowed by a same-text history card", async (t) => {
	const { loadAgentManagerWithFakePi, createFakePiManager } = await import("./helpers/l4_agentManagerHarness.mjs");
	const manager = createFakePiManager(loadAgentManagerWithFakePi());
	const agentId = "agent";
	manager.agents.set(agentId, { tab: { id: agentId, projectId: "p1", cwd: "/proj", title: "Title", status: "running", createdAt: 1 },
		process: { stop() {}, client: { request: async () => ({ success: true, data: {} }) } } });
	t.after(() => manager.stopAll());
	// History reload projects an older resume that predates per-message identities.
	manager.messages.set(agentId, projector.convert(agentId, [{ role: "custom", ...resume }], ["resume"]));
	const live = { role: "custom", ...resume, details: { taskId: "task-1", messageId: "resume-2" }, timestamp: 2 };
	manager.handlePiEvent(agentId, { type: "message_end", message: live });
	assert.equal(manager.messages.get(agentId).length, 2,
		"a real new resume must not be mistaken for a replay of the history card");
	manager.handlePiEvent(agentId, { type: "message_end", message: live });
	assert.equal(manager.messages.get(agentId).length, 2, "replaying the same message still adds nothing");
});

test("session references and HTML exports show visible task messages but never hidden rules", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "pideck-todo-export-"));
	t.after(async () => { await flushLoadedScanners(); await rm(home, { recursive: true, force: true }); });
	const directory = join(home, ".pi", "agent", "sessions", "project");
	await mkdir(directory, { recursive: true });
	const downloads = join(home, "Downloads");
	await mkdir(downloads, { recursive: true });
	const path = join(directory, "session.jsonl");
	const hiddenRules = { ...hidden, content: "HIDDEN TASK RULES" };
	await writeFile(path, [{ type: "session", id: "root", cwd: home }, task, hiddenRules, resume, assistant]
		.map(JSON.stringify).join("\n") + "\n");
	const { SessionScanner } = loadSessionScanner(home);
	const scanner = new SessionScanner(undefined, home, undefined, downloads, home);
	const messages = await scanner.readMessages(path);
	assert.deepEqual(Array.from(messages, (message) => message.content),
		[task.content, resume.content, "Inspection complete"], "resume guidance belongs to the session reference");
	assert.equal(messages[1].role, "system");
	const { path: htmlPath } = await scanner.exportHtml(path);
	const html = await readFile(htmlPath, "utf8");
	assert.match(html, /Inspect the parser/);
	assert.match(html, /Access granted/);
	assert.doesNotMatch(html, /HIDDEN TASK RULES/, "hidden task rules must never reach an export");
});
