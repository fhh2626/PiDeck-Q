import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { AgentMessageProjector, buildActiveBranchEntryIds } = loadTsCommonJs("src/main/pi/AgentMessageProjector.ts");
const { alignEntryIdsForDisplayMessages } = loadTsCommonJs("src/main/pi/sessionEntryIds.ts");
const { AgentManager } = loadTsCommonJs("src/main/pi/AgentManager.ts");

const textMessage = (role, text) => ({ role, content: [{ type: "text", text }], timestamp: 1000 });
const bashMessage = (excludeFromContext = false) => ({
  role: "bashExecution", command: "pwd", output: "/project", exitCode: 0,
  cancelled: false, truncated: false, excludeFromContext, timestamp: 1000,
});
const projector = () => new AgentMessageProjector({ translate: (key) => key, isAskAborted: () => false });

for (const excludeFromContext of [false, true]) {
  test(`hidden bash entries retain later message identities (excludeFromContext=${excludeFromContext})`, () => {
    const raw = [
      { role: "compactionSummary", summary: "Earlier work", timestamp: 1000 },
      bashMessage(excludeFromContext), textMessage("user", "Question"), bashMessage(excludeFromContext),
      textMessage("assistant", "Answer"), textMessage("user", "Next question"),
    ];
    const ids = ["bash-head", "user-one", "bash-middle", "assistant-one", "user-two"];
    const branch = ids.map((id, index) => ({ id, parentId: ids[index - 1] ?? null, type: "message" }));
    const rows = projector().convert("agent", raw, buildActiveBranchEntryIds(branch, ids.at(-1)));
    assert.deepEqual(Array.from(rows, (row) => row.role), ["system", "user", "assistant", "user"]);
    assert.deepEqual(Array.from(rows.slice(1), (row) => row.meta.entryId), ["user-one", "assistant-one", "user-two"]);
    assert.equal(rows.at(-1).text, "Next question");
  });
}

test("entry alignment records a hidden bash slot before the next editable message", () => {
  const aligned = alignEntryIdsForDisplayMessages([
    bashMessage(), textMessage("user", "Question"), bashMessage(), textMessage("assistant", "Answer"),
  ], ["bash-head", "user", "bash-middle", "assistant"], (content) => content?.[0]?.text ?? "");
  assert.deepEqual(Array.from(aligned, (row) => ({ ...row })), [
    { role: "bashExecution", entryId: "bash-head", skipped: true },
    { role: "user", entryId: "user", skipped: false },
    { role: "bashExecution", entryId: "bash-middle", skipped: true },
    { role: "assistant", entryId: "assistant", skipped: false },
  ]);
});

/** Read a real JSONL branch through the production runtime and history reader. */
async function loadedHistory(t, source) {
  const directory = await mkdtemp(join(tmpdir(), "pideck-bash-entry-slots-"));
  const sessionPath = join(directory, "session.jsonl");
  const entries = [];
  let parentId = null;
  const append = (id, message) => {
    entries.push({ id, parentId, type: "message", message });
    parentId = id;
  };
  append("bash-head", bashMessage());
  for (let turn = 1; turn <= 52; turn++) {
    append(`u${turn}`, textMessage("user", `Question ${turn}`));
    if (turn === 1 || turn === 3) append(`bash-${turn}`, bashMessage());
    append(`a${turn}`, textMessage("assistant", `Answer ${turn}`));
  }
  await writeFile(sessionPath, entries.map(JSON.stringify).join("\n") + "\n");
  const manager = new AgentManager(() => ({ id: "project", name: "Project", path: directory }),
    () => null, { get: () => ({}) }, {});
  manager.agents.set("agent", {
    tab: { id: "agent", projectId: "project", cwd: directory, title: "Session", status: "idle", createdAt: 1,
      sessionPath, sessionEnvironment: "native", sessionSource: "pi" },
    process: { stop() {}, client: { request: async ({ type }) => {
      if (type === "get_entries") {
        assert.equal(source, "rpc-identities");
        return { success: true, data: { entries, leafId: parentId } };
      }
      assert.equal(type, "get_messages");
      assert.notEqual(source, "local-snapshot");
      return { success: true, data: { messages: entries.map((entry) => entry.message) } };
    } } },
  });
  t.after(async () => { manager.stopAll(); await rm(directory, { recursive: true, force: true }); });
  let early;
  if (source === "local-snapshot") {
    const response = await manager.sessionHistoryReader.readRecentMessages(sessionPath, 50);
    const snapshot = manager.sessionHistoryReader.getRecentSnapshot(response, sessionPath);
    const bashIndex = response.data.messages.findIndex((message) => message.role === "bashExecution");
    const paired = entries.find((entry) => entry.id === snapshot.entryIds[bashIndex]);
    assert.equal(paired.message.role, "bashExecution", "the pinned identity vector describes the same raw bodies, including hidden bash entries");
    early = Promise.resolve(response);
  }
  await manager.loadMessages("agent", source !== "rpc-identities", early);
  return { manager, sessionPath, entries };
}

for (const source of ["rpc-identities", "rpc-fallback", "local-snapshot"]) {
  test(`bash slots preserve the trimmed window and older-page seam through ${source}`, async (t) => {
    const { manager, sessionPath, entries } = await loadedHistory(t, source);
    const window = manager.getMessageWindow("agent");
    assert.equal(window.messages[0].text, "Question 3");
    assert.equal(window.windowStartFilePos, 6, "the first two turns and their two hidden bash entries occupy six file slots");
    if (source !== "rpc-fallback") {
      for (const row of window.messages) {
        const entry = entries.find((candidate) => candidate.id === row.meta.entryId);
        assert.equal(entry?.message.role, row.role);
        assert.equal(entry.message.content[0].text, row.text);
      }
    }
    const older = await manager.readSessionDisplayTurnPage(sessionPath, "agent", window.windowStartFilePos, 50);
    assert.deepEqual(Array.from(older.messages.filter((row) => row.role === "user"), (row) => row.meta.entryId), ["u1", "u2"]);
    assert.equal(older.messages.some((row) => row.text === "Question 3"), false, "older history must stop before the first retained user message");
  });
}
