import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";
import { createStore } from "jotai/vanilla";

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
    window: {
      setTimeout,
      clearTimeout,
    },
  }, { filename: filePath });
  return module.exports;
}

function setupTestEnvironment() {
  const runtimeState = compileModule("src/renderer/src/utils/agentRuntimeState.ts");
  const sessionRecordIdentity = compileModule("src/renderer/src/utils/sessionRecordIdentity.ts");
  const messageFingerprint = compileModule("src/shared/messageFingerprint.ts");
  const atoms = compileModule("src/renderer/src/atoms/session-atoms.ts", {
    "../utils/agentRuntimeState": runtimeState,
    "../utils/sessionRecordIdentity": sessionRecordIdentity,
    "../../../shared/messageFingerprint": messageFingerprint,
  });

  const i18n = {
    t: (key) => key,
  };

  const notices = [];
  const noticeUtils = {
    showNotice: (msg, dur, kind) => {
      notices.push({ msg, dur, kind });
    },
  };

  return { atoms, i18n, noticeUtils, notices };
}

test("captureHistoryMutationRefresh & refreshHistoryAfterMutation flow: editing history message updates timeline", async () => {
  const env = setupTestEnvironment();
  const store = createStore();

  let readPageCallCount = 0;
  const fakeDesktopApi = {
    desktopApi: {
      sessions: {
        readRecordMessagePage: async (sessionId, requestBefore, pageSize, options) => {
          readPageCallCount += 1;
          // 返回修改后的历史消息
          return {
            messages: [
              { id: "h1", role: "user", text: "question-1-EDITED", meta: { entryId: "e1" } },
              { id: "h2", role: "assistant", text: "answer-1", meta: { entryId: "e2" } },
            ],
            total: 4,
            nextBefore: null,
            nextBeforeEntryId: null,
            indexVersion: "200:1000",
          };
        },
      },
    },
  };

  const controllerModule = compileModule("src/renderer/src/hooks/useSessionTimelineController.ts", {
    "../atoms": env.atoms,
    "../i18n": env.i18n,
    "../utils/notice": env.noticeUtils,
    "../desktopApi": fakeDesktopApi,
    "../components/agents/message-scroller": {},
    "../components/session/timeline/turnRenderWindow": {
      TIMELINE_SCROLLED_TURN_LIMIT: 20,
      TIMELINE_WINDOW_EXPAND_STEP: 5,
    },
  });

  // 1. 初始化包含旧历史的会话缓存
  store.set(env.atoms.cacheSessionMessagesAtom, {
    sessionId: "session-1",
    source: "runtime",
    messages: [
      { id: "r1", role: "user", text: "recent-q", meta: { entryId: "e3" } },
      { id: "r2", role: "assistant", text: "recent-a", meta: { entryId: "e4" } },
    ],
    windowStart: 2,
    cardCount: 0,
    windowStartFilePos: 2,
    history: {
      messages: [
        { id: "h1", role: "user", text: "question-1-ORIGINAL", meta: { entryId: "e1" } },
        { id: "h2", role: "assistant", text: "answer-1", meta: { entryId: "e2" } },
      ],
      nextBefore: 0,
      nextBeforeEntryId: "e1",
      exhausted: true,
      version: "100:1000",
    },
  });

  // 2. 模拟在 await 前捕获快照
  const snapshot = controllerModule.captureHistoryMutationRefresh(store, "session-1");
  assert.ok(snapshot, "snapshot should be captured when history is present");
  assert.equal(snapshot.sessionId, "session-1");
  assert.equal(snapshot.expectedMutationSequence, 1);
  assert.equal(snapshot.loadedHistoryTurnCount, 1);
  assert.equal(snapshot.loadedHistoryMessageCount, 2);

  // 3. 模拟 mutation 成功后执行刷新
  await controllerModule.refreshHistoryAfterMutation({ store }, snapshot);

  // 4. 验证历史消息已被新内容替换
  const entry = store.get(env.atoms.sessionMessagesCacheAtom)["session-1"];
  assert.equal(readPageCallCount, 1);
  assert.equal(entry.history.messages[0].text, "question-1-EDITED");
  assert.equal(entry.history.version, "200:1000");
  assert.equal(entry.messages[0].text, "recent-q");
});

test("captureHistoryMutationRefresh: returns null when no history is loaded (skips redundant refresh)", () => {
  const env = setupTestEnvironment();
  const store = createStore();

  const controllerModule = compileModule("src/renderer/src/hooks/useSessionTimelineController.ts", {
    "../atoms": env.atoms,
    "../i18n": env.i18n,
    "../utils/notice": env.noticeUtils,
    "../desktopApi": { desktopApi: { sessions: {} } },
    "../components/agents/message-scroller": {},
    "../components/session/timeline/turnRenderWindow": {
      TIMELINE_SCROLLED_TURN_LIMIT: 20,
      TIMELINE_WINDOW_EXPAND_STEP: 5,
    },
  });

  store.set(env.atoms.cacheSessionMessagesAtom, {
    sessionId: "session-no-history",
    source: "runtime",
    messages: [{ id: "r1", role: "user", text: "recent-q" }],
  });

  const snapshot = controllerModule.captureHistoryMutationRefresh(store, "session-no-history");
  assert.equal(snapshot, null, "should return null when history is empty");
});

test("concurrency & race: later mutation supersedes earlier in-flight refresh", async () => {
  const env = setupTestEnvironment();
  const store = createStore();

  let resolveFirstPage;
  const firstPagePromise = new Promise((resolve) => {
    resolveFirstPage = resolve;
  });

  let callIndex = 0;
  const fakeDesktopApi = {
    desktopApi: {
      sessions: {
        readRecordMessagePage: async (sessionId, requestBefore, pageSize, options) => {
          callIndex += 1;
          if (callIndex === 1) {
            // 第一个 refresh 请求挂起
            await firstPagePromise;
            return {
              messages: [{ id: "h1", role: "user", text: "FIRST_EDIT", meta: { entryId: "e1" } }],
              total: 2,
              nextBefore: null,
              indexVersion: "101:1000",
            };
          }
          // 第二个 refresh 立即返回
          return {
            messages: [{ id: "h1", role: "user", text: "SECOND_EDIT", meta: { entryId: "e1" } }],
            total: 2,
            nextBefore: null,
            indexVersion: "102:1000",
          };
        },
      },
    },
  };

  const controllerModule = compileModule("src/renderer/src/hooks/useSessionTimelineController.ts", {
    "../atoms": env.atoms,
    "../i18n": env.i18n,
    "../utils/notice": env.noticeUtils,
    "../desktopApi": fakeDesktopApi,
    "../components/agents/message-scroller": {},
    "../components/session/timeline/turnRenderWindow": {
      TIMELINE_SCROLLED_TURN_LIMIT: 20,
      TIMELINE_WINDOW_EXPAND_STEP: 5,
    },
  });

  store.set(env.atoms.cacheSessionMessagesAtom, {
    sessionId: "session-race",
    source: "runtime",
    messages: [{ id: "r1", role: "user", text: "recent" }],
    history: {
      messages: [{ id: "h1", role: "user", text: "ORIGINAL", meta: { entryId: "e1" } }],
      nextBefore: null,
      version: "100:1000",
    },
  });

  // 第一次编辑：捕获快照并启动 refresh 1
  const snapshot1 = controllerModule.captureHistoryMutationRefresh(store, "session-race");
  const refresh1Promise = controllerModule.refreshHistoryAfterMutation({ store }, snapshot1);

  // 第二次编辑：捕获快照并启动 refresh 2
  const snapshot2 = controllerModule.captureHistoryMutationRefresh(store, "session-race");
  const refresh2Promise = controllerModule.refreshHistoryAfterMutation({ store }, snapshot2);

  // refresh 2 先执行完毕
  await refresh2Promise;

  // 释放 refresh 1
  resolveFirstPage();
  await refresh1Promise;

  // 最终状态必须是 SECOND_EDIT，FIRST_EDIT 不得覆盖
  const entry = store.get(env.atoms.sessionMessagesCacheAtom)["session-race"];
  assert.equal(entry.history.messages[0].text, "SECOND_EDIT");
  assert.equal(entry.history.version, "102:1000");
});

test("error handling: page read failure marks stale history invalid without throwing", async () => {
  const env = setupTestEnvironment();
  const store = createStore();

  const fakeDesktopApi = {
    desktopApi: {
      sessions: {
        readRecordMessagePage: async () => {
          throw new Error("Simulated network/disk error");
        },
      },
    },
  };

  const controllerModule = compileModule("src/renderer/src/hooks/useSessionTimelineController.ts", {
    "../atoms": env.atoms,
    "../i18n": env.i18n,
    "../utils/notice": env.noticeUtils,
    "../desktopApi": fakeDesktopApi,
    "../components/agents/message-scroller": {},
    "../components/session/timeline/turnRenderWindow": {
      TIMELINE_SCROLLED_TURN_LIMIT: 20,
      TIMELINE_WINDOW_EXPAND_STEP: 5,
    },
  });

  store.set(env.atoms.cacheSessionMessagesAtom, {
    sessionId: "session-err",
    source: "runtime",
    messages: [{ id: "r1", role: "user", text: "recent" }],
    history: {
      messages: [{ id: "h1", role: "user", text: "stale-content", meta: { entryId: "e1" } }],
      nextBefore: null,
    },
  });

  const snapshot = controllerModule.captureHistoryMutationRefresh(store, "session-err");
  await controllerModule.refreshHistoryAfterMutation({ store }, snapshot);

  // 验证：旧历史被清理（防止继续展示陈旧内容），并展示了通知
  const entry = store.get(env.atoms.sessionMessagesCacheAtom)["session-err"];
  assert.equal(entry.history, undefined, "stale history must be cleared on refresh failure");
  assert.equal(env.notices.length, 1);
  assert.equal(env.notices[0].msg, "message.mutationHistoryRefreshFailed");
});

test("useSessionMessageCommands: editMessage and deleteMessage both capture before await and refresh on success", async () => {
  const env = setupTestEnvironment();

  const commandEvents = [];
  const fakeDesktopApi = {
    desktopApi: {
      sessions: {
        editRuntimeMessage: async (target, messageId, newText) => {
          commandEvents.push({ type: "api:edit", target, messageId, newText });
          return { success: true };
        },
        deleteRuntimeMessage: async (target, messageId) => {
          commandEvents.push({ type: "api:delete", target, messageId });
          return { success: true };
        },
      },
    },
  };

  const commandsModule = compileModule("src/renderer/src/hooks/useSessionMessageCommands.ts", {
    "../desktopApi": fakeDesktopApi,
    "../i18n": env.i18n,
    "../utils/sessionCommands": {
      requireSessionCommand: (res) => res,
    },
    "./useSessionTimelineController": {},
    react: {
      useRef: (val) => ({ current: val }),
      useState: (init) => [init, () => {}],
      useEffect: () => {},
    },
  });

  const capturedSnapshots = [];
  const refreshedSnapshots = [];

  const mockCommands = commandsModule.useSessionMessageCommands({
    activeAgentId: "agent-1",
    activeAgentStatus: "running",
    activeProjectId: "proj-1",
    currentSessionId: "session-1",
    agents: [{ id: "agent-1", projectId: "proj-1", status: "running" }],
    isAgentCurrentlyBusy: () => false,
    getRuntimeTargetForAgent: (agentId) => ({ agentId, sessionId: "session-1", runtimeGeneration: 1 }),
    submitPromptSnapshot: async () => true,
    openReplacedRuntimeSession: async () => {},
    currentSessionIdRef: { current: "session-1" },
    setPromptForAgent: () => {},
    showToast: (msg) => commandEvents.push({ type: "toast", msg }),
    overlays: {
      showConfirm: ({ onConfirm }) => onConfirm(),
      clearConfirm: () => {},
    },
    captureHistoryMutationRefresh: (sessionId) => {
      const snap = { sessionId, expectedMutationSequence: 1, loadedHistoryTurnCount: 2, loadedHistoryMessageCount: 4 };
      capturedSnapshots.push(snap);
      commandEvents.push({ type: "capture", sessionId });
      return snap;
    },
    refreshHistoryAfterMutation: async (snapshot) => {
      refreshedSnapshots.push(snapshot);
      commandEvents.push({ type: "refresh", snapshot });
    },
  });

  // 1. 测试 editMessage
  await mockCommands.editMessage("msg-1", "new content");
  assert.equal(commandEvents[0].type, "capture", "capture must be called before api call");
  assert.equal(commandEvents[1].type, "api:edit");
  assert.equal(commandEvents[2].type, "refresh", "refresh must be called after api call");

  commandEvents.length = 0;

  // 2. 测试 deleteMessage
  mockCommands.deleteMessage("msg-2");
  // deleteMessage 的 onConfirm 是 async，等待微任务清空
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(commandEvents[0].type, "capture", "delete must also capture before api call");
  assert.equal(commandEvents[1].type, "api:delete");
  assert.equal(commandEvents[2].type, "refresh", "delete must refresh after api call");
});

test("refreshHistoryAfterMutation survives runtime flushes that arrive while awaiting API", async () => {
  const env = setupTestEnvironment();
  const store = createStore();

  const fakeDesktopApi = {
    desktopApi: {
      sessions: {
        readRecordMessagePage: async () => ({
          messages: [{ id: "h1", role: "user", text: "UPDATED_HISTORY" }],
          total: 1,
          nextBefore: null,
          indexVersion: "300:1000",
        }),
      },
    },
  };

  const controllerModule = compileModule("src/renderer/src/hooks/useSessionTimelineController.ts", {
    "../atoms": env.atoms,
    "../i18n": env.i18n,
    "../utils/notice": env.noticeUtils,
    "../desktopApi": fakeDesktopApi,
    "../components/agents/message-scroller": {},
    "../components/session/timeline/turnRenderWindow": {
      TIMELINE_SCROLLED_TURN_LIMIT: 20,
      TIMELINE_WINDOW_EXPAND_STEP: 5,
    },
  });

  // 1. 初始缓存状态
  store.set(env.atoms.cacheSessionMessagesAtom, {
    sessionId: "session-flush-interleave",
    source: "runtime",
    messages: [{ id: "r1", role: "user", text: "recent-window", meta: { entryId: "e1" } }],
    history: {
      messages: [{ id: "h1", role: "user", text: "old-history", meta: { entryId: "e0" } }],
      nextBefore: null,
    },
  });
  const initialRevision = store.get(env.atoms.sessionMessagesCacheAtom)["session-flush-interleave"].revision;

  // 2. await 前捕获快照（写入 mutationSequence = 1）
  const snapshot = controllerModule.captureHistoryMutationRefresh(store, "session-flush-interleave");
  assert.ok(snapshot);
  assert.equal(snapshot.expectedMutationSequence, 1);

  // 3. 模拟在 await 期间后端推送 runtime flush（增量/全量流式更新），revision 递增，mutationSequence 继承
  store.set(env.atoms.cacheSessionMessagesAtom, {
    sessionId: "session-flush-interleave",
    source: "runtime",
    messages: [
      { id: "r1", role: "user", text: "recent-window", meta: { entryId: "e1" } },
      { id: "r2", role: "assistant", text: "streamed-token", meta: { entryId: "e2" } },
    ],
    history: store.get(env.atoms.sessionMessagesCacheAtom)["session-flush-interleave"].history,
  });

  const intermediateEntry = store.get(env.atoms.sessionMessagesCacheAtom)["session-flush-interleave"];
  assert.equal(intermediateEntry.revision, initialRevision + 1, "revision must bump");

  // 4. 重读完成并落地（refresh 启动时激活 mutationSequence 并重读页面）
  await controllerModule.refreshHistoryAfterMutation({ store }, snapshot);

  // 5. 验证新历史成功替换，窗口消息保持
  const finalEntry = store.get(env.atoms.sessionMessagesCacheAtom)["session-flush-interleave"];
  assert.equal(finalEntry.history.messages[0].text, "UPDATED_HISTORY", "history must be refreshed despite revision bump");
  assert.equal(finalEntry.messages.length, 2, "runtime window messages must be retained");
});

test("failed subsequent mutation does not block earlier successful mutation from refreshing", async () => {
  const env = setupTestEnvironment();
  const store = createStore();

  const fakeDesktopApi = {
    desktopApi: {
      sessions: {
        readRecordMessagePage: async () => ({
          messages: [{ id: "h1", role: "user", text: "MUTATION_A_SUCCESS", meta: { entryId: "e0" } }],
          total: 1,
          nextBefore: null,
          indexVersion: "101:1000",
        }),
      },
    },
  };

  const controllerModule = compileModule("src/renderer/src/hooks/useSessionTimelineController.ts", {
    "../atoms": env.atoms,
    "../i18n": env.i18n,
    "../utils/notice": env.noticeUtils,
    "../desktopApi": fakeDesktopApi,
    "../components/agents/message-scroller": {},
    "../components/session/timeline/turnRenderWindow": {
      TIMELINE_SCROLLED_TURN_LIMIT: 20,
      TIMELINE_WINDOW_EXPAND_STEP: 5,
    },
  });

  store.set(env.atoms.cacheSessionMessagesAtom, {
    sessionId: "session-failed-subsequent",
    source: "runtime",
    messages: [{ id: "r1", role: "user", text: "recent", meta: { entryId: "e1" } }],
    history: {
      messages: [{ id: "h1", role: "user", text: "ORIGINAL_HISTORY", meta: { entryId: "e0" } }],
      nextBefore: null,
    },
  });

  // 1. 发起 Mutation A -> 捕获快照 (seq = 1)
  const snapshotA = controllerModule.captureHistoryMutationRefresh(store, "session-failed-subsequent");
  assert.equal(snapshotA.expectedMutationSequence, 1);

  // 2. 很快又发起 Mutation B -> 捕获快照 (seq = 2)
  const snapshotB = controllerModule.captureHistoryMutationRefresh(store, "session-failed-subsequent");
  assert.equal(snapshotB.expectedMutationSequence, 2);

  // 3. Mutation B 失败了（API 报错），因此 refresh B 根本没有被调用
  // 4. Mutation A 成功完成，调用 refresh A
  await controllerModule.refreshHistoryAfterMutation({ store }, snapshotA);

  // 5. 断言：A 的历史刷新必须成功落地，不能被失败的 B 取消
  const entry = store.get(env.atoms.sessionMessagesCacheAtom)["session-failed-subsequent"];
  assert.equal(entry.history.messages[0].text, "MUTATION_A_SUCCESS", "A must succeed even if subsequent B failed");
});

test("stale refresh failure does not clear history from a newer successful mutation", async () => {
  const env = setupTestEnvironment();
  const store = createStore();

  let rejectFirstPage;
  const firstPagePromise = new Promise((_, reject) => {
    rejectFirstPage = reject;
  });

  let callCount = 0;
  const fakeDesktopApi = {
    desktopApi: {
      sessions: {
        readRecordMessagePage: async (sessionId, requestBefore, pageSize, options) => {
          callCount += 1;
          if (callCount === 1) {
            // 第一个 refresh 挂起，等待被 reject 模拟读取错误
            await firstPagePromise;
          }
          // 第二个 refresh 正常返回成功
          return {
            messages: [{ id: "h1", role: "user", text: "MUTATION_B_SUCCESS", meta: { entryId: "e0" } }],
            total: 1,
            nextBefore: null,
            indexVersion: "200:1000",
          };
        },
      },
    },
  };

  const controllerModule = compileModule("src/renderer/src/hooks/useSessionTimelineController.ts", {
    "../atoms": env.atoms,
    "../i18n": env.i18n,
    "../utils/notice": env.noticeUtils,
    "../desktopApi": fakeDesktopApi,
    "../components/agents/message-scroller": {},
    "../components/session/timeline/turnRenderWindow": {
      TIMELINE_SCROLLED_TURN_LIMIT: 20,
      TIMELINE_WINDOW_EXPAND_STEP: 5,
    },
  });

  store.set(env.atoms.cacheSessionMessagesAtom, {
    sessionId: "session-catch-guard",
    source: "runtime",
    messages: [{ id: "r1", role: "user", text: "recent", meta: { entryId: "e1" } }],
    history: {
      messages: [{ id: "h1", role: "user", text: "ORIGINAL_HISTORY", meta: { entryId: "e0" } }],
      nextBefore: null,
    },
  });

  // 1. Mutation A 捕获快照并启动 refresh A
  const snapshotA = controllerModule.captureHistoryMutationRefresh(store, "session-catch-guard");
  const refreshAPromise = controllerModule.refreshHistoryAfterMutation({ store }, snapshotA);

  // 2. Mutation B 捕获快照并成功完成 refresh B
  const snapshotB = controllerModule.captureHistoryMutationRefresh(store, "session-catch-guard");
  await controllerModule.refreshHistoryAfterMutation({ store }, snapshotB);

  // 确认 B 已经成功落地
  assert.equal(
    store.get(env.atoms.sessionMessagesCacheAtom)["session-catch-guard"].history.messages[0].text,
    "MUTATION_B_SUCCESS",
  );

  // 3. 此时 refresh A 发生磁盘读取错误（reject）
  rejectFirstPage(new Error("Disk read error"));
  await refreshAPromise;

  // 4. 断言：B 已经刷好的正确 history 不能被 A 的 catch 清空，也不应弹出 A 的失败提示
  const entry = store.get(env.atoms.sessionMessagesCacheAtom)["session-catch-guard"];
  assert.ok(entry.history, "history must NOT be cleared by stale refresh failure");
  assert.equal(entry.history.messages[0].text, "MUTATION_B_SUCCESS");
  assert.equal(env.notices.length, 0, "no spurious error notice should be shown for superseded failure");
});

