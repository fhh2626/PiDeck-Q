import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
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
