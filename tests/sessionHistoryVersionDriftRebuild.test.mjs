import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";
import { atom, createStore } from "jotai/vanilla";

const nodeRequire = createRequire(import.meta.url);

function compileModule(filePath, imports = {}) {
  const source = readFileSync(filePath, "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: filePath,
  }).outputText;
  const module = { exports: {} };
  const localRequire = (specifier) => imports[specifier] ?? nodeRequire(specifier);
  vm.runInNewContext(output, {
    module,
    exports: module.exports,
    require: localRequire,
    console,
    Date,
    Set,
    Map,
    setTimeout,
    clearTimeout,
    window: { setTimeout, clearTimeout },
  }, { filename: filePath });
  return module.exports;
}

function setupEnvironment(pages) {
  const runtimeState = compileModule("src/renderer/src/utils/agentRuntimeState.ts");
  const sessionRecordIdentity = compileModule("src/renderer/src/utils/sessionRecordIdentity.ts");
  const messageFingerprint = compileModule("src/shared/messageFingerprint.ts");
  const atoms = compileModule("src/renderer/src/atoms/session-atoms.ts", {
    "./session-model-references": loadTsCommonJs("src/renderer/src/atoms/session-model-references.ts"),
    "./timelineRuntimeRecovery": loadTsCommonJs("src/renderer/src/atoms/timelineRuntimeRecovery.ts"),
    "../utils/agentRuntimeState": runtimeState,
    "../utils/optimisticUserReconciliation": compileModule(
      "src/renderer/src/utils/optimisticUserReconciliation.ts",
    ),
    "../utils/sessionRecordIdentity": sessionRecordIdentity,
    "../../../shared/messageFingerprint": messageFingerprint,
    "../utils/historyTurnWindow": compileModule("src/renderer/src/utils/historyTurnWindow.ts"),
  });
  const requests = [];
  const fakeDesktopApi = {
    desktopApi: {
      sessions: {
        readRecordMessagePage: async (sessionId, requestBefore, pageSize, options) => {
          requests.push({ sessionId, requestBefore, pageSize, beforeEntryId: options?.beforeEntryId });
          const next = pages.shift();
          if (!next) throw new Error("no more pages");
          if (next instanceof Error) throw next;
          return next;
        },
      },
    },
  };
  const controllerModule = compileModule("src/renderer/src/hooks/useSessionTimelineController.ts", {
    "../atoms": { ...atoms, sessionRuntimeBySessionIdAtomFamily: (id) => atom((get) => get(atoms.sessionRuntimeByIdAtom)[id]) },
    "../i18n": { t: (key) => key },
    "../utils/notice": { showNotice: () => {} },
    "../utils/sessionCommands": { toSessionRuntimeTarget: () => undefined },
    "../desktopApi": fakeDesktopApi,
    "../components/agents/message-scroller": {},
    "../components/session/timeline/turnRenderWindow": {
      TIMELINE_SCROLLED_TURN_LIMIT: 20,
      TIMELINE_WINDOW_EXPAND_STEP: 5,
    },
    // controller 依赖锚点/窗口位移策略：给真实模块而不是再 mock 一份，避免同一规则两套真相。
    "./timelineScrollAnchor": compileModule("src/renderer/src/hooks/timelineScrollAnchor.ts"),
  });
  return { atoms, controllerModule, requests };
}

function seedSession(store, atoms, overrides = {}) {
  store.set(atoms.sessionMessagesCacheAtom, {
    "session-drift": {
      sessionId: "session-drift",
      source: "runtime",
      messages: [
        { id: "w1", role: "user", text: "window-q", meta: { entryId: "e5" } },
        { id: "w2", role: "assistant", text: "window-a", meta: { entryId: "e6" } },
      ],
      windowStart: 4,
      revision: 3,
      ...overrides,
    },
  });
}

test("version-drift rebuild replaces the stale prefix once after reading from the current seam (2026-12)", async () => {
  const pages = [
    {
      messages: [
        { id: "n1", role: "user", text: "new-q1", meta: { entryId: "n1" } },
        { id: "n2", role: "assistant", text: "new-a1", meta: { entryId: "n2" } },
      ],
      total: 10,
      nextBefore: 6,
      nextBeforeEntryId: "n1",
      indexVersion: "200:800",
    },
    {
      messages: [
        { id: "n3", role: "user", text: "new-q0", meta: { entryId: "n3" } },
      ],
      total: 10,
      nextBefore: null,
      indexVersion: "200:800",
    },
  ];
  const { atoms, controllerModule, requests } = setupEnvironment(pages);
  const store = createStore();
  seedSession(store, atoms, {
    windowStartFilePos: 6,
    history: {
      messages: [{ id: "old", role: "user", text: "stale", meta: { entryId: "old" } }],
      nextBefore: 2,
      version: "100:2000",
    },
  });

  const applied = await controllerModule.rebuildHistoryPrefixAfterVersionDrift({
    sessionId: "session-drift",
    sequence: 0,
    store,
    targetTurnCount: 3,
    anchorFilePos: 6,
    isCurrent: () => true,
  });

  assert.equal(applied, true);
  const entry = store.get(atoms.sessionMessagesCacheAtom)["session-drift"];
  // 一次原子替换：多页按「旧 → 新」拼接（页序反转），不再是旧页与新页的拼接
  assert.deepEqual(
    Array.from(entry.history.messages, (message) => message.meta.entryId),
    ["n3", "n1", "n2"],
  );
  assert.equal(entry.history.version, "200:800");
  assert.equal(entry.history.nextBefore, null);
  assert.equal(entry.history.exhausted, true);
  // 从当前窗口接缝起读：数值游标优先（大历史窗口无 entryId 时也能重建）
  assert.deepEqual(requests[0], {
    sessionId: "session-drift",
    requestBefore: 6,
    pageSize: 3,
    beforeEntryId: undefined,
  });
  assert.deepEqual(requests[1], {
    sessionId: "session-drift",
    requestBefore: undefined,
    pageSize: 3,
    beforeEntryId: "n1",
  });
});

test("an in-flight history rebuild cannot resurrect the prefix after an edit", async () => {
  let release;
  const page = new Promise((resolve) => { release = resolve; });
  const { atoms, controllerModule, requests } = setupEnvironment([page]);
  const store = createStore();
  seedSession(store, atoms, {
    agentId: "agent",
    history: { messages: [{ id: "old", role: "user", text: "before edit" }], nextBefore: 2, version: "before" },
  });
  const rebuilding = controllerModule.rebuildHistoryPrefixAfterVersionDrift({
    sessionId: "session-drift", sequence: 0, store, targetTurnCount: 1, isCurrent: () => true,
  });
  assert.equal(requests.length, 1);
  store.set(atoms.applySessionRuntimeEventAtom, {
    sessionId: "session-drift", agentId: "agent", runtimeGeneration: 1, sourceChannel: "agents:message",
    payload: {
      messages: store.get(atoms.sessionMessagesCacheAtom)["session-drift"].messages,
      preserveHistory: false, fileVersion: "after",
    },
  });
  release({ messages: [{ id: "old", role: "user", text: "before edit" }], total: 4, nextBefore: null, indexVersion: "before" });
  assert.equal(await rebuilding, false);
  assert.equal(store.get(atoms.sessionMessagesCacheAtom)["session-drift"].history, undefined);
});

test("mutation reread restarts at the new seam when the HTTP reply beats the edit snapshot", async () => {
  let release;
  const firstPage = new Promise((resolve) => { release = resolve; });
  const updatedHistory = [{ id: "updated", role: "user", text: "edited history" }];
  const { atoms, controllerModule, requests } = setupEnvironment([
    firstPage,
    { messages: updatedHistory, total: 2, nextBefore: null, indexVersion: "after" },
  ]);
  const store = createStore();
  seedSession(store, atoms, {
    agentId: "agent",
    history: { messages: [{ id: "old", role: "user", text: "cached history" }], nextBefore: 2 },
  });
  const snapshot = controllerModule.captureHistoryMutationRefresh(store, "session-drift");
  const refreshing = controllerModule.refreshHistoryAfterMutation({ store }, snapshot);
  assert.equal(requests[0].beforeEntryId, "e5");
  store.set(atoms.applySessionRuntimeEventAtom, {
    sessionId: "session-drift", agentId: "agent", runtimeGeneration: 1, sourceChannel: "agents:message",
    payload: { messages: [{ id: "new-window", role: "user", text: "new seam", meta: { entryId: "e6" } }],
      preserveHistory: false, fileVersion: "after", historyMutationRevision: 1 },
  });
  release({ messages: [{ id: "stale", role: "user", text: "stale response" }], total: 4, nextBefore: null, indexVersion: "before" });
  await refreshing;
  assert.deepEqual(requests.map((request) => request.beforeEntryId), ["e5", "e6"]);
  assert.deepEqual(Array.from(store.get(atoms.sessionMessagesCacheAtom)["session-drift"].history.messages), updatedHistory);
});

test("mutation reread waits for the acknowledged replacement before reading any pages", async () => {
  const updatedHistory = [{ id: "updated", role: "user", text: "edited history" }];
  const { atoms, controllerModule, requests } = setupEnvironment([
    { messages: updatedHistory, total: 2, nextBefore: null, indexVersion: "after" },
  ]);
  const store = createStore();
  seedSession(store, atoms, {
    agentId: "agent",
    history: { messages: [{ id: "old", role: "user", text: "cached history" }], nextBefore: 2 },
  });
  const snapshot = controllerModule.captureHistoryMutationRefresh(store, "session-drift");
  const refreshing = controllerModule.refreshHistoryAfterMutation({ store }, snapshot, { historyMutationRevision: 1 });
  assert.deepEqual(requests, [], "history must not be read from the old seam after HTTP wins the race");
  store.set(atoms.applySessionRuntimeEventAtom, {
    sessionId: "session-drift", agentId: "agent", runtimeGeneration: 1, sourceChannel: "agents:message",
    payload: { messages: [{ id: "new-window", role: "user", text: "new seam", meta: { entryId: "e6" } }],
      preserveHistory: false, fileVersion: "after", historyMutationRevision: 1 },
  });
  await refreshing;
  assert.deepEqual(requests.map((request) => request.beforeEntryId), ["e6"]);
  assert.deepEqual(Array.from(store.get(atoms.sessionMessagesCacheAtom)["session-drift"].history.messages), updatedHistory);
});

test("waiting for a mutation snapshot cancels immediately when its runtime detaches", async () => {
  const { atoms, controllerModule, requests } = setupEnvironment([]);
  const store = createStore();
  seedSession(store, atoms, {
    agentId: "agent",
    history: { messages: [{ id: "old", role: "user", text: "cached history" }], nextBefore: 2 },
  });
  store.set(atoms.sessionRuntimeByIdAtom, { "session-drift": { agentId: "agent", runtimeGeneration: 1, status: "idle" } });
  const snapshot = controllerModule.captureHistoryMutationRefresh(store, "session-drift");
  const refreshing = controllerModule.refreshHistoryAfterMutation({ store }, snapshot, { historyMutationRevision: 1 });
  store.set(atoms.applySessionRuntimeEventAtom, {
    kind: "detach", sessionId: "session-drift", agentId: "agent", runtimeGeneration: 1,
    sourceChannel: "sessions:runtime-detach", payload: null,
  });
  let timer;
  try {
    const result = await Promise.race([refreshing.then(() => "cancelled"), new Promise((resolve) => {
      timer = setTimeout(() => resolve("still waiting"), 100);
    })]);
    assert.equal(result, "cancelled");
    assert.deepEqual(requests, []);
  } finally {
    clearTimeout(timer);
  }
});

test("a history reread cannot write after its runtime is replaced under the same agent id", async () => {
  let release;
  const page = new Promise((resolve) => { release = resolve; });
  const { atoms, controllerModule, requests } = setupEnvironment([page]);
  const store = createStore();
  seedSession(store, atoms, {
    agentId: "agent", historyMutationRevision: 1,
    history: { messages: [{ id: "valid", role: "user", text: "cached history" }], nextBefore: 2 },
  });
  store.set(atoms.sessionRuntimeByIdAtom, { "session-drift": { agentId: "agent", runtimeGeneration: 1, status: "idle" } });
  const snapshot = controllerModule.captureHistoryMutationRefresh(store, "session-drift");
  const refreshing = controllerModule.refreshHistoryAfterMutation({ store }, snapshot, { historyMutationRevision: 1 });
  assert.equal(requests.length, 1);
  store.set(atoms.sessionRuntimeByIdAtom, { "session-drift": { agentId: "agent", runtimeGeneration: 2, status: "idle" } });
  release({ messages: [{ id: "late", role: "user", text: "old runtime response" }], total: 2, nextBefore: null });
  await refreshing;
  assert.equal(store.get(atoms.sessionMessagesCacheAtom)["session-drift"].history.messages[0].id, "valid");
  await controllerModule.refreshHistoryAfterMutation({ store }, snapshot, { historyMutationRevision: 1 });
  assert.equal(requests.length, 1, "a late HTTP acknowledgement must not start a read against the replacement");
});

test("version-drift rebuild aborts when a page fails and keeps the old prefix (2026-12)", async () => {
  const pages = [new Error("disk read failed")];
  const { atoms, controllerModule } = setupEnvironment(pages);
  const store = createStore();
  seedSession(store, atoms, {
    history: {
      messages: [{ id: "old", role: "user", text: "stale", meta: { entryId: "old" } }],
      nextBefore: 2,
      version: "100:2000",
    },
  });

  const applied = await controllerModule.rebuildHistoryPrefixAfterVersionDrift({
    sessionId: "session-drift",
    sequence: 0,
    store,
    targetTurnCount: 3,
    anchorFilePos: 4,
    isCurrent: () => true,
  });

  assert.equal(applied, false, "a failed page must not produce a partial prefix");
  const entry = store.get(atoms.sessionMessagesCacheAtom)["session-drift"];
  assert.deepEqual(
    Array.from(entry.history.messages, (message) => message.meta.entryId),
    ["old"],
    "old prefix must stay untouched on failure",
  );
  assert.equal(entry.history.version, "100:2000");
});

test("version-drift rebuild aborts when the file version changes between pages (2026-12)", async () => {
  const pages = [
    {
      messages: [{ id: "n1", role: "user", text: "new-q1", meta: { entryId: "n1" } }],
      total: 10,
      nextBefore: 6,
      nextBeforeEntryId: "n1",
      indexVersion: "200:800",
    },
    {
      messages: [{ id: "n2", role: "user", text: "new-q0", meta: { entryId: "n2" } }],
      total: 10,
      nextBefore: null,
      indexVersion: "300:900",
    },
  ];
  const { atoms, controllerModule } = setupEnvironment(pages);
  const store = createStore();
  seedSession(store, atoms, {
    windowStartFilePos: 6,
    history: {
      messages: [{ id: "old", role: "user", text: "stale", meta: { entryId: "old" } }],
      nextBefore: 2,
      version: "100:2000",
    },
  });

  const applied = await controllerModule.rebuildHistoryPrefixAfterVersionDrift({
    sessionId: "session-drift",
    sequence: 0,
    store,
    targetTurnCount: 3,
    anchorFilePos: 6,
    isCurrent: () => true,
  });

  assert.equal(applied, false, "mixed versions must abort the rebuild");
  const entry = store.get(atoms.sessionMessagesCacheAtom)["session-drift"];
  assert.deepEqual(Array.from(entry.history.messages, (message) => message.meta.entryId), ["old"]);
});

test("version-drift rebuild stops at the safe page cap instead of looping forever (2026-12)", async () => {
  // 一个永远声称「还有更早」的页：重建不得超过安全页数上限，且只替换一次
  const endless = {
    messages: [{ id: "n1", role: "user", text: "q", meta: { entryId: "n1" } }],
    total: 999,
    nextBefore: 1,
    nextBeforeEntryId: "n1",
    indexVersion: "200:800",
  };
  const pages = Array.from({ length: controllerModulePageCount() + 2 }, () => endless);
  const { atoms, controllerModule, requests } = setupEnvironment(pages);
  const store = createStore();
  seedSession(store, atoms, {
    windowStartFilePos: 6,
    history: {
      messages: [{ id: "old", role: "user", text: "stale", meta: { entryId: "old" } }],
      nextBefore: 2,
      version: "100:2000",
    },
  });

  const applied = await controllerModule.rebuildHistoryPrefixAfterVersionDrift({
    sessionId: "session-drift",
    sequence: 0,
    store,
    targetTurnCount: 500,
    anchorFilePos: 6,
    isCurrent: () => true,
  });

  assert.equal(requests.length, controllerModulePageCount(), "reads must be bounded by the page cap");
  assert.equal(applied, true, "page cap stops the read; the bounded prefix is applied once");
  const entry = store.get(atoms.sessionMessagesCacheAtom)["session-drift"];
  assert.equal(
    entry.history.messages.length,
    controllerModulePageCount(),
    "prefix must match the number of pages actually read",
  );
  assert.equal(entry.history.version, "200:800");
});

test("version-drift rebuild falls back to the cached file cursor when the window has no entryId (2026-12)", async () => {
  const pages = [
    {
      messages: [{ id: "n1", role: "user", text: "new-q1", meta: { entryId: "n1" } }],
      total: 10,
      nextBefore: null,
      indexVersion: "200:800",
    },
  ];
  const { atoms, controllerModule, requests } = setupEnvironment(pages);
  const store = createStore();
  seedSession(store, atoms, {
    // skipEntries 大历史窗口：窗口消息整体缺 entryId，只能靠数值游标定位接缝
    messages: [{ id: "w1", role: "user", text: "window-q", meta: {} }],
    windowStartFilePos: 6,
    history: {
      messages: [{ id: "old", role: "user", text: "stale", meta: { entryId: "old" } }],
      nextBefore: 2,
      version: "100:2000",
    },
  });

  // 续页场景：调用方不再传 anchorFilePos（只有首次补历史才传）
  const applied = await controllerModule.rebuildHistoryPrefixAfterVersionDrift({
    sessionId: "session-drift",
    sequence: 0,
    store,
    targetTurnCount: 3,
    isCurrent: () => true,
  });

  assert.equal(applied, true, "a window without entryId must still rebuild via the file cursor");
  assert.deepEqual(requests[0], {
    sessionId: "session-drift",
    requestBefore: 6,
    pageSize: 3,
    beforeEntryId: undefined,
  });
});

test("version-drift rebuild prefers the window entryId over the cached file cursor (2026-12)", async () => {
  const pages = [
    {
      messages: [{ id: "n1", role: "user", text: "new-q1", meta: { entryId: "n1" } }],
      total: 10,
      nextBefore: null,
      indexVersion: "200:800",
    },
  ];
  const { atoms, controllerModule, requests } = setupEnvironment(pages);
  const store = createStore();
  seedSession(store, atoms, {
    messages: [{ id: "w1", role: "user", text: "window-q", meta: { entryId: "e5" } }],
    windowStartFilePos: 6,
    history: {
      messages: [{ id: "old", role: "user", text: "stale", meta: { entryId: "old" } }],
      nextBefore: 2,
      version: "100:2000",
    },
  });

  const applied = await controllerModule.rebuildHistoryPrefixAfterVersionDrift({
    sessionId: "session-drift",
    sequence: 0,
    store,
    targetTurnCount: 3,
    isCurrent: () => true,
  });

  assert.equal(applied, true);
  assert.deepEqual(requests[0], {
    sessionId: "session-drift",
    requestBefore: undefined,
    pageSize: 3,
    beforeEntryId: "e5",
  });
});

function controllerModulePageCount() {
  const source = readFileSync("src/renderer/src/hooks/useSessionTimelineController.ts", "utf8");
  const match = source.match(/HISTORY_REBUILD_MAX_PAGES\s*=\s*(\d+)/);
  return match ? Number(match[1]) : 20;
}
