import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createStore } from "jotai/vanilla";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const nodeRequire = createRequire(import.meta.url);
const forbidProcess = () => { throw new Error("History regression must not launch processes"); };
const { AgentManager } = loadTsCommonJs("src/main/pi/AgentManager.ts", {
  stubs: {
    "node:child_process": {
      ...nodeRequire("node:child_process"),
      spawn: forbidProcess,
      exec: forbidProcess,
      execFile: forbidProcess,
    },
  },
});
const { registerSessionIpc } = loadTsCommonJs("src/main/ipc/sessionIpc.ts", {
  stubs: { "node:child_process": { ...nodeRequire("node:child_process"), spawn: forbidProcess, exec: forbidProcess, execFile: forbidProcess } },
});
const { ipcChannels } = loadTsCommonJs("src/shared/ipc.ts");
const { groupToolMessages } = loadTsCommonJs("src/renderer/src/components/app/AppUtils.ts", {
  stubs: { "../../i18n": { t: (key) => key }, "../session/composer/chips": {} },
});
const { resolveTimelineTurnWindow } = loadTsCommonJs("src/renderer/src/components/session/timeline/turnRenderWindow.ts");
const atoms = loadTsCommonJs("src/renderer/src/atoms/session-atoms.ts");
const { hasMoreRuntimeHistory, resolveMinimumHistoryTopUp } = loadTsCommonJs(
  "src/renderer/src/hooks/useSessionTimelineController.ts",
  {
    // Exercise the public pure timeline policies; no hook, DOM or desktop RPC is mounted.
    stubs: {
      react: {},
      jotai: { atom: (value) => ({ value }) },
      "jotai/utils": {},
      "../atoms": atoms,
      "../desktopApi": {},
      "../i18n": {},
      "../utils/notice": {},
      "../utils/sessionCommands": {},
      "../components/session/timeline/turnRenderWindow": {},
    },
  },
);

/** Build an isolated seven-turn file with four archived turns and three RPC turns. */
async function createCompactedHarness(t, { summaryRole, skipEntries = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "pideck-compaction-history-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sessionPath = join(directory, "session.jsonl");
  const entries = [];
  let parentId = null;
  for (let turn = 1; turn <= 7; turn += 1) {
    if (turn === 7) {
      entries.push({
        id: "compact", parentId, type: "compaction", timestamp: "2026-01-01T00:00:00Z",
        firstKeptEntryId: "u5", summary: "Fixture summary", tokensBefore: 100,
      });
      parentId = "compact";
    }
    for (const role of ["user", "assistant"]) {
      const id = `${role === "user" ? "u" : "a"}${turn}`;
      entries.push({
        id, parentId, type: "message", timestamp: "2026-01-01T00:00:00Z",
        message: { role, content: [{ type: "text", text: id }] },
      });
      parentId = id;
    }
  }
  await writeFile(sessionPath, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  const rpcMessages = entries
    .filter((entry) => entry.type === "message" && Number(entry.id.slice(1)) >= 5)
    .map((entry) => entry.message);
  if (summaryRole) rpcMessages.unshift({
    role: summaryRole,
    summary: summaryRole === "compactionSummary" ? "Fixture summary" : "RPC branch summary",
    timestamp: Date.parse("2026-01-01T00:00:00Z"),
    tokensBefore: 100,
  });
  const agentId = "fixture-agent";
  const sessionId = "fixture-session";
  const runtime = {
    tab: {
      id: agentId, projectId: "fixture-project", cwd: directory, title: "Fixture", status: "idle",
      sessionPath, sessionEnvironment: "native", sessionSource: "pi", createdAt: 1,
    },
    process: {
      stop: () => {},
      client: {
        request: async ({ type }) => {
          if (type === "get_entries") {
            assert.equal(skipEntries, false, "skipEntries path must use only the numeric file cursor");
            return { success: true, data: { entries, leafId: parentId } };
          }
          assert.equal(type, "get_messages");
          return { success: true, data: { messages: rpcMessages } };
        },
      },
    },
  };
  const manager = new AgentManager(
    () => ({ id: "fixture-project", name: "Fixture", path: directory }),
    () => null, { get: () => ({}) }, {},
  );
  manager.agents.set(agentId, runtime);
  t.after(() => manager.stopAll());
  const store = createStore();
  const payloads = [];
  const unsubscribe = manager.onOutput((channel, payload) => {
    if (channel !== "agents:message") return;
    payloads.push(payload);
    store.set(atoms.applySessionRuntimeEventAtom, {
      sessionId, agentId, runtimeGeneration: 1,
      sourceChannel: channel, payload,
    });
  });
  t.after(unsubscribe);
  await manager.loadMessages(agentId, skipEntries);
  const handlers = new Map();
  registerSessionIpc({ handle: (channel, handler) => handlers.set(channel, handler) }, {
    sessionCatalog: { get: (id) => id === sessionId ? { id, filePath: sessionPath } : undefined },
    sessionRuntimeCoordinator: { getTarget: (id) => id === sessionId ? { sessionId, agentId, runtimeGeneration: 1 } : undefined },
    agentManager: manager,
  });
  const readPage = handlers.get(ipcChannels.sessionsCatalogReadMessagePage);
  assert.equal(typeof readPage, "function");
  return {
    manager, store, payloads, sessionPath, sessionId, agentId, readPage,
    entry: () => store.get(atoms.sessionMessagesCacheAtom)[sessionId],
  };
}

/** Drive real file paging and the renderer continuation guard, not a synthetic page. */
async function readAndPrepend(harness, { before, beforeEntryId, turnCount }) {
  const { readPage, store, sessionId, entry } = harness;
  const expectedRevision = entry().revision;
  const continuationBefore = entry().history?.nextBefore ?? undefined;
  // Use the real IPC adapter: its disk fallback projects with sessionId, not transient agentId.
  const page = await readPage(sessionId, before, turnCount, { unit: "turn", beforeEntryId });
  assert.equal(store.set(atoms.prependSessionHistoryPageAtom, {
    sessionId, expectedRevision, before: continuationBefore, page,
  }), true);
  return page;
}

for (const scenario of [
  { name: "file-injected compaction card", options: {}, cardType: "compaction" },
  { name: "RPC compaction card without entry IDs", options: { summaryRole: "compactionSummary", skipEntries: true }, cardType: "compaction" },
  { name: "RPC branch card without entry IDs", options: { summaryRole: "branchSummary", skipEntries: true }, cardType: "branchSummary" },
]) {
  test(`${scenario.name} keeps archived history available when the runtime window starts at zero`, async (t) => {
    const harness = await createCompactedHarness(t, scenario.options);
    const { manager, entry, payloads, agentId } = harness;
    const window = manager.getMessageWindow(agentId);
    assert.equal(window.windowStart ?? 0, 0);
    assert.equal(window.messages[0].meta.type, scenario.cardType);
    assert.equal(entry().history, undefined);
    assert.equal(hasMoreRuntimeHistory(entry()), true, "summary cards must not hide unread archived turns");
    assert.equal(window.windowStartFilePos, 8, "cursor points to u5, after four archived complete turns");
    assert.equal(payloads.at(-1).windowStartFilePos, window.windowStartFilePos);
    assert.equal(entry().windowStartFilePos, window.windowStartFilePos);
    assert.equal(resolveMinimumHistoryTopUp({ historyTurns: 0, windowTurns: 3, hasMore: hasMoreRuntimeHistory(entry()), busy: false }), 47);

    // Numeric fallback is required when get_entries was skipped; entry-ID and numeric pages must agree.
    const byEntry = await harness.readPage(harness.sessionId, undefined, 3, { unit: "turn", beforeEntryId: "u5" });
    const first = await readAndPrepend(harness, { before: window.windowStartFilePos, turnCount: 3 });
    assert.deepEqual(Array.from(first.messages, (message) => message.meta.entryId), Array.from(byEntry.messages, (message) => message.meta.entryId));
    // The file page includes its boundary card; the runtime cache must deduplicate that card.
    assert.deepEqual(Array.from(first.messages, (message) => message.text), ["u2", "a2", "u3", "a3", "u4", "a4", "Fixture summary"]);
    assert.equal(first.messages.at(-1).meta.type, "compaction");
    assert.equal(first.messages.at(-1).meta.compactionId, "compact");
    assert.equal(first.messages.at(-1).meta.firstKeptEntryId, "u5");
    assert.equal(first.messages.at(-1).meta.tokensBefore, 100);
    assert.equal(first.nextBefore, 2);
    assert.equal(hasMoreRuntimeHistory(entry()), true);
    const last = await readAndPrepend(harness, { before: first.nextBefore, turnCount: 3 });
    assert.deepEqual(Array.from(last.messages, (message) => message.text), ["u1", "a1"]);
    assert.equal(last.nextBefore, null);
    assert.equal(hasMoreRuntimeHistory(entry()), false, "the button only disappears after reaching the file beginning");
    assert.equal(entry().history.exhausted, true);
    const displayed = [...entry().history.messages, ...entry().messages];
    assert.deepEqual(displayed.filter((message) => message.role === "user").map((message) => message.text), ["u1", "u2", "u3", "u4", "u5", "u6", "u7"]);
    assert.equal(new Set(displayed.map((message) => message.id)).size, displayed.length);
    const displayItems = resolveTimelineTurnWindow(groupToolMessages(displayed), 50).displayItems;
    const summaryTypes = displayItems
      .filter((item) => item.kind === "message" && item.message.role === "system")
      .map((item) => item.message.meta.type);
    assert.deepEqual(Array.from(summaryTypes), scenario.cardType === "branchSummary" ? ["compaction", "branchSummary"] : ["compaction"], "deduplicate the same compaction across session/runtime projections, not a distinct branch summary");
  });
}

test("compacted runtime minimum top-up restores every available turn below the fifty-turn target", async (t) => {
  const harness = await createCompactedHarness(t);
  const missing = resolveMinimumHistoryTopUp({ historyTurns: 0, windowTurns: 3, hasMore: hasMoreRuntimeHistory(harness.entry()), busy: false });
  assert.equal(missing, 47);
  const page = await readAndPrepend(harness, { before: harness.entry().windowStartFilePos, turnCount: missing });
  assert.equal(page.nextBefore, null);
  assert.equal(harness.entry().history.messages.filter((message) => message.role === "user").length, 4);
  assert.equal(hasMoreRuntimeHistory(harness.entry()), false);
});

/** Window snapshots must count only cards skipped before the requested window, never visible cards. */
for (const scenario of [
  { name: "summary at window head", cardTypes: ["compaction"], start: 0, head: 8, expected: 8 },
  { name: "window inside two summary cards", cardTypes: ["compaction", "branchSummary"], start: 1, head: 8, expected: 8 },
  { name: "window after two summary cards", cardTypes: ["compaction", "branchSummary"], start: 2, head: 8, expected: 8 },
  { name: "shifted window after summary cards", cardTypes: ["compaction", "branchSummary"], start: 3, head: 8, expected: 9 },
  { name: "no summary cards", cardTypes: [], start: 1, head: 8, expected: 9 },
  { name: "known file beginning", cardTypes: ["compaction"], start: 0, head: 0, expected: 0 },
  { name: "unknown anonymous head", cardTypes: ["compaction"], start: 0, head: -1, expected: undefined },
]) {
  test(`runtime window cursor handles ${scenario.name}`, (t) => {
    const manager = new AgentManager(() => undefined, () => null, { get: () => ({}) }, {});
    t.after(() => manager.stopAll());
    const messages = [
      ...scenario.cardTypes.map((type, index) => ({ id: `summary-${index}`, agentId: "window-agent", role: "system", text: type, timestamp: 1, meta: { type } })),
      { id: "user", agentId: "window-agent", role: "user", text: "Question", timestamp: 1 },
      { id: "assistant", agentId: "window-agent", role: "assistant", text: "Answer", timestamp: 2 },
    ];
    manager.messages.set("window-agent", messages);
    manager.messageHeadOffsetByAgent.set("window-agent", scenario.head);
    manager.displayWindowStartByAgent.set("window-agent", scenario.start);
    const window = manager.getMessageWindow("window-agent");
    assert.equal(window.windowStartFilePos, scenario.expected);
    assert.equal(hasMoreRuntimeHistory({ source: "runtime", ...window }), scenario.expected !== undefined && scenario.expected > 0);
  });
}
