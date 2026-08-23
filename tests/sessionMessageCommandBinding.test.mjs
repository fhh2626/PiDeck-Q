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
  vm.runInNewContext(
    output,
    {
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
        dispatchEvent: () => {},
      },
      CustomEvent: class CustomEvent {
        constructor(type, init) {
          this.type = type;
          this.detail = init?.detail;
        }
      },
    },
    { filename: filePath },
  );
  return module.exports;
}

const sessionCommandsModule = compileModule("src/renderer/src/utils/sessionCommands.ts", {
  "../i18n": { t: (key) => key },
});

test("isSameSessionRuntimeTarget: accurately compares session, agent, and runtime generation", () => {
  const { isSameSessionRuntimeTarget } = sessionCommandsModule;

  const targetA = { sessionId: "s1", agentId: "a1", runtimeGeneration: 1 };
  const targetAIdentical = { sessionId: "s1", agentId: "a1", runtimeGeneration: 1 };
  const targetDiffSession = { sessionId: "s2", agentId: "a1", runtimeGeneration: 1 };
  const targetDiffAgent = { sessionId: "s1", agentId: "a2", runtimeGeneration: 1 };
  const targetDiffGen = { sessionId: "s1", agentId: "a1", runtimeGeneration: 2 };

  assert.equal(isSameSessionRuntimeTarget(targetA, targetAIdentical), true);
  assert.equal(isSameSessionRuntimeTarget(targetA, targetDiffSession), false);
  assert.equal(isSameSessionRuntimeTarget(targetA, targetDiffAgent), false);
  assert.equal(isSameSessionRuntimeTarget(targetA, targetDiffGen), false);
  assert.equal(isSameSessionRuntimeTarget(targetA, undefined), false);
  assert.equal(isSameSessionRuntimeTarget(undefined, targetA), false);
  assert.equal(isSameSessionRuntimeTarget(undefined, undefined), false);
});

function createMockCommandsEnvironment(customDesktopApiOverrides = {}) {
  const i18n = {
    t: (key, params) => (params ? `${key}(${JSON.stringify(params)})` : key),
  };

  const commandEvents = [];
  let onConfirmCallback = null;

  const fakeDesktopApi = {
    desktopApi: {
      sessions: {
        editRuntimeMessage: async (target, messageId, newText) => {
          commandEvents.push({ type: "api:edit", target, messageId, newText });
          return { ok: true, value: { success: true } };
        },
        deleteRuntimeMessage: async (target, messageId) => {
          commandEvents.push({ type: "api:delete", target, messageId });
          return { ok: true, value: { success: true } };
        },
        prepareRuntimeResend: async (target, messageId) => {
          commandEvents.push({ type: "api:prepareResend", target, messageId });
          // 与生产契约一致：SessionCommandResult<SessionTargetedValue<{text, images}>>
          return { ok: true, value: { target, value: { text: "resend-text", images: [] } } };
        },
        getRuntimeForkMessages: async (target) => {
          commandEvents.push({ type: "api:forkMessages", target });
          return { ok: true, value: { target, value: [{ entryId: "entry-1", text: "msg-fork" }] } };
        },
        forkRuntimeSession: async (target, entryId) => {
          commandEvents.push({ type: "api:fork", target, entryId });
          return { ok: true, value: { target, value: { targetSessionId: "session-forked", text: "msg-fork" } } };
        },
        ...customDesktopApiOverrides,
      },
    },
  };

  const commandsModule = compileModule("src/renderer/src/hooks/useSessionMessageCommands.ts", {
    "../desktopApi": fakeDesktopApi,
    "../i18n": i18n,
    "../utils/sessionCommands": sessionCommandsModule,
    "./useSessionTimelineController": {},
    react: {
      useRef: (val) => ({ current: val }),
      useState: (init) => [init, () => {}],
      useEffect: () => {},
    },
  });

  return {
    commandsModule,
    commandEvents,
    fakeDesktopApi,
    getOnConfirm: () => onConfirmCallback,
    setOnConfirm: (cb) => {
      onConfirmCallback = cb;
    },
  };
}

test("deleteMessage: target disappearing before confirm rejects without API call or refresh snapshot", async () => {
  const { commandsModule, commandEvents, setOnConfirm, getOnConfirm } = createMockCommandsEnvironment();

  const targetV1 = { sessionId: "session-1", agentId: "agent-1", runtimeGeneration: 1 };
  let currentTarget = targetV1;

  const mockCommands = commandsModule.useSessionMessageCommands({
    activeAgentStatus: "running",
    activeProjectId: "proj-1",
    agents: [{ id: "agent-1", projectId: "proj-1", status: "running" }],
    isRuntimeTargetBusy: () => false,
    getRuntimeTargetForSession: (sessionId) => (sessionId === "session-1" ? currentTarget : undefined),
    submitPromptSnapshot: async () => true,
    openReplacedRuntimeSession: async () => {},
    currentSessionIdRef: { current: "session-1" },
    setPromptForAgent: () => {},
    showToast: (msg) => commandEvents.push({ type: "toast", msg }),
    overlays: {
      showConfirm: ({ onConfirm }) => {
        setOnConfirm(onConfirm);
      },
      clearConfirm: () => {},
    },
    captureHistoryMutationRefresh: (sessionId) => {
      commandEvents.push({ type: "capture", sessionId });
      return { sessionId, expectedMutationSequence: 1 };
    },
    refreshHistoryAfterMutation: async (snapshot) => {
      commandEvents.push({ type: "refresh", snapshot });
    },
  });

  // 1. 打开删除确认框
  mockCommands.deleteMessage(targetV1, "msg-1");
  const onConfirm = getOnConfirm();
  assert.ok(onConfirm, "confirm callback should be registered");

  // 2. 模拟在确认前会话被删除 / target 变为 undefined
  currentTarget = undefined;

  // 3. 用户点击确认
  await onConfirm();

  // 4. 断言：没有调用删除 API，没有捕获快照，没有刷新历史，toast 显示 runtimeChanged
  const apiCalls = commandEvents.filter((e) => e.type === "api:delete");
  const captures = commandEvents.filter((e) => e.type === "capture");
  const refreshes = commandEvents.filter((e) => e.type === "refresh");
  const toasts = commandEvents.filter((e) => e.type === "toast");

  assert.equal(apiCalls.length, 0, "must not call delete API when target is gone");
  assert.equal(captures.length, 0, "must not capture mutation refresh snapshot");
  assert.equal(refreshes.length, 0, "must not call refreshHistoryAfterMutation");
  assert.ok(toasts.length > 0, "should show toast on target change");
  assert.match(toasts[0].msg, /sessionCommand\.runtimeChanged/);
  assert.doesNotMatch(toasts[0].msg, /sessionCommand\.sessionNotFound/);
});

test("deleteMessage: generation change before confirm rejects and displays runtimeChanged", async () => {
  const { commandsModule, commandEvents, setOnConfirm, getOnConfirm } = createMockCommandsEnvironment();

  const targetV1 = { sessionId: "session-1", agentId: "agent-1", runtimeGeneration: 1 };
  let currentTarget = targetV1;

  const mockCommands = commandsModule.useSessionMessageCommands({
    activeAgentStatus: "running",
    activeProjectId: "proj-1",
    agents: [{ id: "agent-1", projectId: "proj-1", status: "running" }],
    isRuntimeTargetBusy: () => false,
    getRuntimeTargetForSession: (sessionId) => (sessionId === "session-1" ? currentTarget : undefined),
    submitPromptSnapshot: async () => true,
    openReplacedRuntimeSession: async () => {},
    currentSessionIdRef: { current: "session-1" },
    setPromptForAgent: () => {},
    showToast: (msg) => commandEvents.push({ type: "toast", msg }),
    overlays: {
      showConfirm: ({ onConfirm }) => setOnConfirm(onConfirm),
      clearConfirm: () => {},
    },
    captureHistoryMutationRefresh: (sessionId) => {
      commandEvents.push({ type: "capture", sessionId });
      return { sessionId, expectedMutationSequence: 1 };
    },
    refreshHistoryAfterMutation: async (snapshot) => {
      commandEvents.push({ type: "refresh", snapshot });
    },
  });

  mockCommands.deleteMessage(targetV1, "msg-1");
  // 模拟 Agent 重启，runtimeGeneration 递增到 2
  currentTarget = { sessionId: "session-1", agentId: "agent-1", runtimeGeneration: 2 };
  await getOnConfirm()();

  const apiCalls = commandEvents.filter((e) => e.type === "api:delete");
  assert.equal(apiCalls.length, 0, "must not call delete API when generation changed");
  const toasts = commandEvents.filter((e) => e.type === "toast");
  assert.match(toasts[0].msg, /sessionCommand\.runtimeChanged/);
});

test("deleteMessage: agentId change before confirm rejects and displays runtimeChanged", async () => {
  const { commandsModule, commandEvents, setOnConfirm, getOnConfirm } = createMockCommandsEnvironment();

  const targetV1 = { sessionId: "session-1", agentId: "agent-1", runtimeGeneration: 1 };
  let currentTarget = targetV1;

  const mockCommands = commandsModule.useSessionMessageCommands({
    activeAgentStatus: "running",
    activeProjectId: "proj-1",
    agents: [{ id: "agent-1", projectId: "proj-1", status: "running" }],
    isRuntimeTargetBusy: () => false,
    getRuntimeTargetForSession: (sessionId) => (sessionId === "session-1" ? currentTarget : undefined),
    submitPromptSnapshot: async () => true,
    openReplacedRuntimeSession: async () => {},
    currentSessionIdRef: { current: "session-1" },
    setPromptForAgent: () => {},
    showToast: (msg) => commandEvents.push({ type: "toast", msg }),
    overlays: {
      showConfirm: ({ onConfirm }) => setOnConfirm(onConfirm),
      clearConfirm: () => {},
    },
  });

  mockCommands.deleteMessage(targetV1, "msg-1");
  // 模拟 Agent 重新绑定为 agent-2
  currentTarget = { sessionId: "session-1", agentId: "agent-2", runtimeGeneration: 2 };
  await getOnConfirm()();

  const apiCalls = commandEvents.filter((e) => e.type === "api:delete");
  assert.equal(apiCalls.length, 0, "must not call delete API when agentId changed");
  const toasts = commandEvents.filter((e) => e.type === "toast");
  assert.match(toasts[0].msg, /sessionCommand\.runtimeChanged/);
});

test("deleteMessage: split pane safety - focus changing to other session does not block non-focused pane", async () => {
  const { commandsModule, commandEvents, setOnConfirm, getOnConfirm } = createMockCommandsEnvironment();

  const targetPaneA = { sessionId: "session-A", agentId: "agent-A", runtimeGeneration: 1 };
  const targetPaneB = { sessionId: "session-B", agentId: "agent-B", runtimeGeneration: 1 };

  // mock getRuntimeTargetForSession 按 sessionId 返回正确的 pane target
  const mockCommands = commandsModule.useSessionMessageCommands({
    activeAgentStatus: "running",
    activeProjectId: "proj-1",
    agents: [
      { id: "agent-A", projectId: "proj-1", status: "running" },
      { id: "agent-B", projectId: "proj-1", status: "running" },
    ],
    isRuntimeTargetBusy: () => false,
    getRuntimeTargetForSession: (sessionId) => {
      if (sessionId === "session-A") return targetPaneA;
      if (sessionId === "session-B") return targetPaneB;
      return undefined;
    },
    submitPromptSnapshot: async () => true,
    openReplacedRuntimeSession: async () => {},
    currentSessionIdRef: { current: "session-B" }, // 模拟全局当前聚焦在 session-B
    setPromptForAgent: () => {},
    showToast: (msg) => commandEvents.push({ type: "toast", msg }),
    overlays: {
      showConfirm: ({ onConfirm }) => setOnConfirm(onConfirm),
      clearConfirm: () => {},
    },
    captureHistoryMutationRefresh: (sessionId) => {
      commandEvents.push({ type: "capture", sessionId });
      return { sessionId, expectedMutationSequence: 1 };
    },
    refreshHistoryAfterMutation: async (snapshot) => {
      commandEvents.push({ type: "refresh", snapshot });
    },
  });

  // 在 Pane A 中发起删除
  mockCommands.deleteMessage(targetPaneA, "msg-in-pane-A");
  await getOnConfirm()();

  // 确认调用的目标是 session-A，而不是全局聚焦的 session-B
  const apiCalls = commandEvents.filter((e) => e.type === "api:delete");
  assert.equal(apiCalls.length, 1);
  assert.deepEqual(apiCalls[0].target, targetPaneA);
  assert.equal(apiCalls[0].messageId, "msg-in-pane-A");
});

test("editMessage, resendUserMessage, forkFromUserMessage validate target freshness", async () => {
  const { commandsModule, commandEvents } = createMockCommandsEnvironment();

  const targetV1 = { sessionId: "session-1", agentId: "agent-1", runtimeGeneration: 1 };
  let currentTarget = { sessionId: "session-1", agentId: "agent-1", runtimeGeneration: 2 }; // 已过期的 targetV1

  const mockCommands = commandsModule.useSessionMessageCommands({
    activeAgentStatus: "running",
    activeProjectId: "proj-1",
    agents: [{ id: "agent-1", projectId: "proj-1", status: "running" }],
    isRuntimeTargetBusy: () => false,
    getRuntimeTargetForSession: (sessionId) => (sessionId === "session-1" ? currentTarget : undefined),
    submitPromptSnapshot: async () => true,
    openReplacedRuntimeSession: async () => {},
    currentSessionIdRef: { current: "session-1" },
    setPromptForAgent: () => {},
    showToast: (msg) => commandEvents.push({ type: "toast", msg }),
    overlays: {
      showConfirm: () => {},
      clearConfirm: () => {},
    },
  });

  // 1. editMessage 与过期的 targetV1
  await mockCommands.editMessage(targetV1, "msg-1", "edited text");
  assert.equal(commandEvents.filter((e) => e.type === "api:edit").length, 0);
  assert.match(commandEvents[commandEvents.length - 1].msg, /sessionCommand\.runtimeChanged/);

  // 2. resendUserMessage 与过期的 targetV1
  mockCommands.resendUserMessage(targetV1, { id: "msg-2", role: "user", text: "hello", agentId: "agent-1" });
  assert.equal(commandEvents.filter((e) => e.type === "api:prepareResend").length, 0);
  assert.match(commandEvents[commandEvents.length - 1].msg, /sessionCommand\.runtimeChanged/);

  // 3. forkFromUserMessage 与过期的 targetV1
  await mockCommands.forkFromUserMessage(targetV1, { id: "msg-3", role: "user", text: "fork me", agentId: "agent-1" });
  assert.equal(commandEvents.filter((e) => e.type === "api:fork").length, 0);
  assert.match(commandEvents[commandEvents.length - 1].msg, /sessionCommand\.runtimeChanged/);
});

test("forkFromUserMessage: split pane busy check uses target session, not global focused session", async () => {
  const { commandsModule, commandEvents } = createMockCommandsEnvironment();

  const targetPaneA = { sessionId: "session-A", agentId: "agent-A", runtimeGeneration: 1 };
  const targetPaneB = { sessionId: "session-B", agentId: "agent-B", runtimeGeneration: 1 };

  // Case 1: Pane A is idle, Pane B is busy. Fork on Pane A must NOT be blocked by B's busy state.
  let busySessionId = "session-B";
  const mockCommands = commandsModule.useSessionMessageCommands({
    activeAgentStatus: "running",
    activeProjectId: "proj-1",
    agents: [
      { id: "agent-A", projectId: "proj-1", status: "running" },
      { id: "agent-B", projectId: "proj-1", status: "running" },
    ],
    isRuntimeTargetBusy: (target) => target.sessionId === busySessionId,
    getRuntimeTargetForSession: (sessionId) => {
      if (sessionId === "session-A") return targetPaneA;
      if (sessionId === "session-B") return targetPaneB;
      return undefined;
    },
    submitPromptSnapshot: async () => true,
    openReplacedRuntimeSession: async () => {},
    currentSessionIdRef: { current: "session-B" },
    setPromptForAgent: () => {},
    showToast: (msg) => commandEvents.push({ type: "toast", msg }),
    overlays: { showConfirm: () => {}, clearConfirm: () => {} },
  });

  const msgA = { id: "agent-A-history-entry-1", role: "user", text: "msg-fork" };
  await mockCommands.forkFromUserMessage(targetPaneA, msgA);

  assert.equal(commandEvents.filter((e) => e.type === "api:fork").length, 1, "Pane A fork should succeed when A is idle even if B is busy");

  commandEvents.length = 0;

  // Case 2: Pane A is busy, Pane B is idle. Fork on Pane A MUST be blocked by A's busy state.
  busySessionId = "session-A";
  await mockCommands.forkFromUserMessage(targetPaneA, msgA);
  assert.equal(commandEvents.filter((e) => e.type === "api:fork").length, 0, "Pane A fork must be blocked when A itself is busy");
});

test("forkFromUserMessage: fallback query race condition where target changes while awaiting getRuntimeForkMessages", async () => {
  let resolveForkMessagesPromise;
  const forkMessagesPromise = new Promise((resolve) => {
    resolveForkMessagesPromise = resolve;
  });

  const { commandsModule, commandEvents } = createMockCommandsEnvironment({
    getRuntimeForkMessages: async (target) => {
      commandEvents.push({ type: "api:forkMessages", target });
      return forkMessagesPromise;
    },
  });

  const targetV1 = { sessionId: "session-1", agentId: "agent-1", runtimeGeneration: 1 };
  let currentTarget = targetV1;

  const mockCommands = commandsModule.useSessionMessageCommands({
    activeAgentStatus: "running",
    activeProjectId: "proj-1",
    agents: [{ id: "agent-1", projectId: "proj-1", status: "running" }],
    isRuntimeTargetBusy: () => false,
    getRuntimeTargetForSession: (sessionId) => (sessionId === "session-1" ? currentTarget : undefined),
    submitPromptSnapshot: async () => true,
    openReplacedRuntimeSession: async () => {},
    currentSessionIdRef: { current: "session-1" },
    setPromptForAgent: () => {},
    showToast: (msg) => commandEvents.push({ type: "toast", msg }),
    overlays: { showConfirm: () => {}, clearConfirm: () => {} },
  });

  // 消息没有 meta.entryId 也没有 history 格式 ID，必须走 fallback 查询
  const messageWithoutEntryId = { id: "msg-custom-id", role: "user", text: "target text" };

  // 1. 发起 fork（进入 getRuntimeForkMessages 等待）
  const forkPromise = mockCommands.forkFromUserMessage(targetV1, messageWithoutEntryId);

  // 2. 模拟在查询挂起期间，Agent 重启，generation 变为 2
  currentTarget = { sessionId: "session-1", agentId: "agent-1", runtimeGeneration: 2 };

  // 3. 释放查询结果
  resolveForkMessagesPromise({
    ok: true,
    value: {
      target: targetV1,
      value: [{ entryId: "entry-deferred", text: "target text" }],
    },
  });

  await forkPromise;

  // 4. 断言：forkRuntimeSession 未被调用，没有发给失效 target，toast 提示 runtimeChanged 而非 forkMissingEntryId
  const forkApiCalls = commandEvents.filter((e) => e.type === "api:fork");
  assert.equal(forkApiCalls.length, 0, "must not call forkRuntimeSession when target changed during fallback query");
  const toasts = commandEvents.filter((e) => e.type === "toast");
  assert.ok(toasts.length > 0);
  assert.match(toasts[toasts.length - 1].msg, /sessionCommand\.runtimeChanged/);
  assert.doesNotMatch(toasts[toasts.length - 1].msg, /app\.forkMissingEntryId/);
});

test("forkFromUserMessage: getRuntimeForkMessages failure does not get swallowed into forkMissingEntryId", async () => {
  const { commandsModule, commandEvents } = createMockCommandsEnvironment({
    getRuntimeForkMessages: async () => {
      return {
        ok: false,
        error: { code: "SESSION_RUNTIME_CHANGED", message: "runtime generation changed" },
      };
    },
  });

  const targetV1 = { sessionId: "session-1", agentId: "agent-1", runtimeGeneration: 1 };
  const mockCommands = commandsModule.useSessionMessageCommands({
    activeAgentStatus: "running",
    activeProjectId: "proj-1",
    agents: [{ id: "agent-1", projectId: "proj-1", status: "running" }],
    isRuntimeTargetBusy: () => false,
    getRuntimeTargetForSession: (sessionId) => (sessionId === "session-1" ? targetV1 : undefined),
    submitPromptSnapshot: async () => true,
    openReplacedRuntimeSession: async () => {},
    currentSessionIdRef: { current: "session-1" },
    setPromptForAgent: () => {},
    showToast: (msg) => commandEvents.push({ type: "toast", msg }),
    overlays: { showConfirm: () => {}, clearConfirm: () => {} },
  });

  const messageWithoutEntryId = { id: "msg-custom-id", role: "user", text: "target text" };
  await mockCommands.forkFromUserMessage(targetV1, messageWithoutEntryId);

  const toasts = commandEvents.filter((e) => e.type === "toast");
  assert.ok(toasts.length > 0);
  assert.match(toasts[0].msg, /sessionCommand\.runtimeChanged/);
  assert.doesNotMatch(toasts[0].msg, /app\.forkMissingEntryId/);
});

test("useSessionRuntimeController: real compiled hook correctly evaluates canMutateActiveMessages across full state matrix", () => {
  const store = createStore();

  const runtimeState = compileModule("src/renderer/src/utils/agentRuntimeState.ts");
  const sessionRecordIdentity = compileModule("src/renderer/src/utils/sessionRecordIdentity.ts");
  const messageFingerprint = compileModule("src/shared/messageFingerprint.ts");
  const atoms = compileModule("src/renderer/src/atoms/session-atoms.ts", {
    "../utils/agentRuntimeState": runtimeState,
    "../utils/sessionRecordIdentity": sessionRecordIdentity,
    "../../../shared/messageFingerprint": messageFingerprint,
  });
  const sessionSelectors = compileModule("src/renderer/src/atoms/session-selectors.ts", {
    "./session-atoms": atoms,
  });
  const canStopBoundAgent = compileModule("src/renderer/src/utils/canStopBoundAgent.ts");
  const runtimeNotification = compileModule("src/renderer/src/utils/runtimeNotification.ts");

  const controllerModule = compileModule("src/renderer/src/hooks/useSessionRuntimeController.ts", {
    jotai: {
      useAtomValue: (anAtom) => {
        if (anAtom && typeof anAtom.read === "function") {
          return anAtom.read((a) => store.get(a));
        }
        return store.get(anAtom);
      },
    },
    "jotai/utils": {
      selectAtom: (anAtom, selector) => ({
        read: (get) => selector(get(anAtom)),
      }),
    },
    react: {
      useMemo: (fn) => fn(),
      useEffect: () => {},
      useRef: (v) => ({ current: v }),
    },
    "../atoms/session-atoms": atoms,
    "../atoms/session-selectors": sessionSelectors,
    "../atoms/composer-atoms": {
      sessionSendStateByIdAtom: atoms.sessionSendStateByIdAtom || { read: () => ({}) },
    },
    "./useSessionTimelineController": {
      isUserFacingSessionStart: () => false,
    },
    "../utils/canStopBoundAgent": canStopBoundAgent,
    "./useQueuedPrompt": {},
    "../i18n": { t: (k) => k },
    "../utils/notice": { dismissNotice: () => {} },
    "../utils/runtimeNotification": runtimeNotification,
  });

  const baseOptions = {
    agents: [{ id: "agent-1", projectId: "proj-1", status: "idle" }],
    queueFlushBySessionRef: { current: new Set() },
    activeQueuedPrompts: [],
    restartingAgentId: null,
    sessionDurationByAgent: {},
    activeProjectId: "proj-1",
    showNotice: () => {},
  };

  const sessionId = "session-matrix-test";

  // 1. 全部存在（Record, Runtime, Live Agent） -> canMutateActiveMessages === true
  store.set(atoms.sessionRecordsAtom, {
    [sessionId]: { id: sessionId, projectId: "proj-1", title: "Test Session" },
  });
  store.set(atoms.sessionRuntimeByIdAtom, {
    [sessionId]: { agentId: "agent-1", runtimeGeneration: 1, status: "idle" },
  });

  let controller = controllerModule.useSessionRuntimeController({
    ...baseOptions,
    sessionId,
  });
  assert.equal(controller.canMutateActiveMessages, true, "should be true when Record, Target, and Live Agent all exist");

  // 2. SessionRecord 不存在（会话已从 catalog 删除） -> canMutateActiveMessages === false
  store.set(atoms.sessionRecordsAtom, {});
  controller = controllerModule.useSessionRuntimeController({
    ...baseOptions,
    sessionId,
  });
  assert.equal(controller.canMutateActiveMessages, false, "must be false when SessionRecord is missing (deleted session)");

  // 3. Runtime Target 未建立（无 agentId） -> canMutateActiveMessages === false
  store.set(atoms.sessionRecordsAtom, {
    [sessionId]: { id: sessionId, projectId: "proj-1", title: "Test Session" },
  });
  store.set(atoms.sessionRuntimeByIdAtom, {
    [sessionId]: { agentId: undefined, runtimeGeneration: undefined },
  });
  controller = controllerModule.useSessionRuntimeController({
    ...baseOptions,
    sessionId,
  });
  assert.equal(controller.canMutateActiveMessages, false, "must be false when Runtime Target is not ready");

  // 4. Agent 状态为 closed -> canMutateActiveMessages === false
  store.set(atoms.sessionRuntimeByIdAtom, {
    [sessionId]: { agentId: "agent-1", runtimeGeneration: 1, status: "idle" },
  });
  controller = controllerModule.useSessionRuntimeController({
    ...baseOptions,
    sessionId,
    agents: [{ id: "agent-1", projectId: "proj-1", status: "closed" }],
  });
  assert.equal(controller.canMutateActiveMessages, false, "must be false when bound agent status is closed");

  // 5. Agent 状态为 error -> canMutateActiveMessages === false
  controller = controllerModule.useSessionRuntimeController({
    ...baseOptions,
    sessionId,
    agents: [{ id: "agent-1", projectId: "proj-1", status: "error" }],
  });
  assert.equal(controller.canMutateActiveMessages, false, "must be false when bound agent status is error");

  // 6. sessionId 为空 -> canMutateActiveMessages === false
  controller = controllerModule.useSessionRuntimeController({
    ...baseOptions,
    sessionId: undefined,
    agents: [{ id: "agent-1", projectId: "proj-1", status: "idle" }],
  });
  assert.equal(controller.canMutateActiveMessages, false, "must be false when sessionId is undefined");
});

// ── 编辑回调「开始编辑时捕获」策略（真实编译生产模块）──

const trackedEditSubmitModule = compileModule("src/renderer/src/utils/trackedEditSubmit.ts");

function flushMicrotasks() {
  return new Promise((resolve) => setImmediate(resolve));
}

function createHookEnvironment(currentTargetRef, overrides = {}) {
  const { commandsModule, commandEvents } = createMockCommandsEnvironment(overrides.desktopApi ?? {});
  const submittedSnapshots = [];
  const mockCommands = commandsModule.useSessionMessageCommands({
    activeAgentStatus: "running",
    activeProjectId: "proj-1",
    agents: [{ id: "agent-1", projectId: "proj-1", status: "running" }],
    isRuntimeTargetBusy: () => false,
    getRuntimeTargetForSession: (sessionId) =>
      sessionId === "session-1" ? currentTargetRef.current : undefined,
    submitPromptSnapshot: async (sessionId, text) => {
      submittedSnapshots.push({ sessionId, text });
      commandEvents.push({ type: "submit", sessionId, text });
      return true;
    },
    openReplacedRuntimeSession: async () => {},
    currentSessionIdRef: { current: "session-1" },
    setPromptForAgent: () => {},
    showToast: (msg) => commandEvents.push({ type: "toast", msg }),
    overlays: { showConfirm: () => {}, clearConfirm: () => {} },
    ...(overrides.input ?? {}),
  });
  return { mockCommands, commandEvents, submittedSnapshots };
}

test("trackedEditSubmit: captures callback on begin, consumes once on submit, rejects without capture", () => {
  const { createTrackedEditSubmit } = trackedEditSubmitModule;

  // 未 begin 时 submit 返回 false 且不调用任何回调
  const empty = createTrackedEditSubmit();
  let called = 0;
  assert.equal(empty.submit("msg-1", "text"), false);
  assert.equal(called, 0);

  // begin 后 submit 调用捕获的回调并返回 true；一次性消费后再次 submit 失败
  const tracker = createTrackedEditSubmit();
  tracker.begin((messageId, newText) => {
    called += 1;
    assert.equal(messageId, "msg-1");
    assert.equal(newText, "edited");
  });
  assert.equal(tracker.submit("msg-1", "edited"), true);
  assert.equal(called, 1);
  // 一次性消费：第二次 submit 无可用捕获，返回 false 且不再派发
  assert.equal(tracker.submit("msg-1", "edited again"), false);
  assert.equal(called, 1, "second submit must not dispatch again");
});

test("edit save uses callback captured when editing began: stale captured target is rejected, not redirected to new generation", async () => {
  const { createTrackedEditSubmit } = trackedEditSubmitModule;
  const currentTargetRef = { current: { sessionId: "session-1", agentId: "agent-1", runtimeGeneration: 1 } };
  const { mockCommands, commandEvents } = createHookEnvironment(currentTargetRef);

  const tracker = createTrackedEditSubmit();

  // 模拟 SessionRuntimeInjector 渲染语义：每次渲染产生绑定「当时 target」的回调。
  const makeOnEditMessage = () => {
    const boundTarget = currentTargetRef.current;
    return (messageId, newText) => mockCommands.editMessage(boundTarget, messageId, newText);
  };

  // 1. 用户在 V1 时点击「编辑」：组件捕获当次渲染的 onEditMessage（绑定 V1）。
  tracker.begin(makeOnEditMessage());

  // 2. 编辑期间 Agent 重启，runtime 换为 V2；Injector 重渲染会产生新 wrapper，
  //    但组件持有的是开始编辑时捕获的旧回调（这正是被测行为）。
  currentTargetRef.current = { sessionId: "session-1", agentId: "agent-1", runtimeGeneration: 2 };

  // 3. 用户点击保存：调用捕获的旧回调 → 真实 hook 应拒绝并提示 runtimeChanged。
  const dispatched = tracker.submit("msg-assistant-1", "edited text");
  assert.equal(dispatched, true, "captured callback must be invoked on save");
  await flushMicrotasks();

  const apiEdits = commandEvents.filter((e) => e.type === "api:edit");
  assert.equal(apiEdits.length, 0, "must not call edit API when captured target is stale");
  const toasts = commandEvents.filter((e) => e.type === "toast");
  assert.ok(toasts.length > 0);
  assert.match(toasts[toasts.length - 1].msg, /sessionCommand\.runtimeChanged/);
});

test("edit save uses callback captured when editing began: unchanged target still edits successfully", async () => {
  const { createTrackedEditSubmit } = trackedEditSubmitModule;
  const currentTargetRef = { current: { sessionId: "session-1", agentId: "agent-1", runtimeGeneration: 1 } };
  const { mockCommands, commandEvents } = createHookEnvironment(currentTargetRef);

  const tracker = createTrackedEditSubmit();
  // 开始编辑时捕获当前渲染的回调（绑定 V1）
  tracker.begin((messageId, newText) => mockCommands.editMessage(currentTargetRef.current, messageId, newText));

  // 未发生 runtime 变化，保存应正常提交到 V1
  const dispatched = tracker.submit("msg-assistant-1", "edited text");
  assert.equal(dispatched, true);
  await flushMicrotasks();

  const apiEdits = commandEvents.filter((e) => e.type === "api:edit");
  assert.equal(apiEdits.length, 1);
  assert.deepEqual(apiEdits[0].target, { sessionId: "session-1", agentId: "agent-1", runtimeGeneration: 1 });
  assert.equal(apiEdits[0].messageId, "msg-assistant-1");
  assert.equal(apiEdits[0].newText, "edited text");
});

test("resendUserMessage: target changing during prepareRuntimeResend must not submit snapshot to new runtime", async () => {
  let resolvePrepare;
  const preparePromise = new Promise((resolve) => {
    resolvePrepare = resolve;
  });
  const currentTargetRef = { current: { sessionId: "session-1", agentId: "agent-1", runtimeGeneration: 1 } };
  const { mockCommands, commandEvents, submittedSnapshots } = createHookEnvironment(currentTargetRef, {
    desktopApi: {
      prepareRuntimeResend: async (target) => {
        commandEvents.push({ type: "api:prepareResend", target });
        return preparePromise;
      },
    },
  });

  const targetV1 = currentTargetRef.current;
  // 1. 发起 resend（进入 prepareRuntimeResend 等待）
  mockCommands.resendUserMessage(targetV1, { id: "msg-1", role: "user", text: "hello", agentId: "agent-1" });
  assert.equal(commandEvents.filter((e) => e.type === "api:prepareResend").length, 1);

  // 2. prepare 完成前 runtime 被替换为 V2
  currentTargetRef.current = { sessionId: "session-1", agentId: "agent-1", runtimeGeneration: 2 };

  // 3. 释放 prepare 结果（携带旧消息的 resend snapshot）
  resolvePrepare({ ok: true, value: { text: "resend-text", images: [] } });
  await flushMicrotasks();

  // 4. 断言：快照未被提交到新 runtime，toast 提示 runtimeChanged
  assert.equal(submittedSnapshots.length, 0, "must not submitPromptSnapshot after target changed during prepare");
  const toasts = commandEvents.filter((e) => e.type === "toast");
  assert.ok(toasts.length > 0);
  assert.match(toasts[toasts.length - 1].msg, /sessionCommand\.runtimeChanged/);
});

test("resendUserMessage: unchanged target submits snapshot after prepare succeeds", async () => {
  const currentTargetRef = { current: { sessionId: "session-1", agentId: "agent-1", runtimeGeneration: 1 } };
  const { mockCommands, commandEvents, submittedSnapshots } = createHookEnvironment(currentTargetRef);

  mockCommands.resendUserMessage(currentTargetRef.current, { id: "msg-1", role: "user", text: "hello", agentId: "agent-1" });
  await flushMicrotasks();

  assert.equal(submittedSnapshots.length, 1, "happy path must still submit the resend snapshot");
  assert.deepEqual(submittedSnapshots[0], { sessionId: "session-1", text: "resend-text" });
  const toasts = commandEvents.filter((e) => e.type === "toast");
  assert.equal(toasts.length, 0, "no error toast expected on happy path");
});

test("edit save after runtime target disappears still dispatches captured callback and surfaces runtimeChanged", async () => {
  const { createTrackedEditSubmit } = trackedEditSubmitModule;
  const currentTargetRef = { current: { sessionId: "session-1", agentId: "agent-1", runtimeGeneration: 1 } };
  const { mockCommands, commandEvents } = createHookEnvironment(currentTargetRef);

  const tracker = createTrackedEditSubmit();

  // 模拟 Injector 渲染语义：每次渲染产生绑定「当时 target」的回调。
  const makeOnEditMessage = () => {
    const boundTarget = currentTargetRef.current;
    return (messageId, newText) => mockCommands.editMessage(boundTarget, messageId, newText);
  };

  // 1. 用户在 V1 时打开编辑框，组件捕获当时的提交回调。
  tracker.begin(makeOnEditMessage());

  // 2. 编辑期间 runtime 完全消失（Agent 关闭/重启窗口期）：Injector 的 messageActions
  //    返回 onEditMessage: undefined —— 这正是此前导致保存被静默拦截的状态。
  currentTargetRef.current = undefined;

  // 3. 用户点击保存：捕获回调存在即派发（不依赖当前 prop），由 hook 拒绝并提示。
  const dispatched = tracker.submit("msg-assistant-1", "edited text");
  assert.equal(dispatched, true, "save must dispatch the captured callback even when current onEditMessage prop became undefined");
  await flushMicrotasks();

  const apiEdits = commandEvents.filter((e) => e.type === "api:edit");
  assert.equal(apiEdits.length, 0, "must not call edit API when target is gone");
  const toasts = commandEvents.filter((e) => e.type === "toast");
  assert.ok(toasts.length > 0, "user must see a toast instead of silent no-op");
  assert.match(toasts[toasts.length - 1].msg, /sessionCommand\.runtimeChanged/);
});
