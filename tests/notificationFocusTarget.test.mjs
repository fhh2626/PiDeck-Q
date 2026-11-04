import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { withHookHost } from "./helpers/l5_hookHost.mjs";
import { mountWorkspaceChromeFocus } from "./helpers/l1b_workspaceChromeFocusHarness.mjs";
import { loadAgentManagerWithFakePi } from "./helpers/l4_agentManagerHarness.mjs";
import { createNativeBackendHostHarness, runBackendRpcFocusWiring } from "./helpers/l1b_nativeBackendHostHarness.mjs";

// 用户反馈 bug：点击系统通知能激活窗口，但不会跳转到对应会话。
// 根因：notifySessionEnd 用 tab.sessionId（pi 侧会话 id）嵌入 toast launch，
// renderer 的 sessionRecordByIdAtomFamily 只按 SessionRecord.id 索引，两套 id
// 不一致（见 index.ts attachRuntime 的 sessionId/piSessionId 双字段），
// 导致通知点击后 record 解析永远失败，仅完成窗口激活。
// 修复：通知跳转目标只使用 coordinator 维护的 record.id；缺少稳定身份时只聚焦应用根页。

const RECORD_ID = "11111111-2222-3333-4444-555555555555";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

test("resolveNotificationSessionId only returns a stable record id", async () => {
  const { resolveNotificationSessionId } = await import(
    "../src/main/pi/agentUtils.ts"
  );
  // record.id 解析成功：renderer 能按稳定身份索引会话。
  assert.equal(resolveNotificationSessionId(() => RECORD_ID), RECORD_ID);
  // coordinator 尚未绑定或未注入 resolver 时，不得把 pi session id 当作 record.id。
  assert.equal(resolveNotificationSessionId(() => undefined), undefined);
  assert.equal(resolveNotificationSessionId(undefined), undefined);
});

/** 通过真实 agent_settled 事件驱动 AgentManager 的会话完成通知。 */
function settleWithNotification({ resolveRecordId, piSessionId }) {
  const harness = loadAgentManagerWithFakePi();
  const shown = [];
  const focused = [];
  const manager = new harness.AgentManager(
    () => undefined,
    () => undefined,
    { get: () => ({ enableNotifications: true, removedBuiltInExtensions: [] }) },
    { getProjectTrustDecision: async () => true },
    { push: () => undefined },
    { info: () => undefined, warn: () => undefined, error: () => undefined },
    undefined,
    (key) => `t:${key}`,
    undefined,
    undefined,
    undefined,
    resolveRecordId,
    {
      appName: "PiDeck",
      appPath: "/app",
      resourcesPath: "/res",
      isPackaged: true,
      notifications: { isSupported: () => true, show: (options) => shown.push(options) },
      focusSessionFromNotification: (sessionId) => {
        focused.push(sessionId);
        return true;
      },
      hasLiveWindow: () => true,
    },
  );
  manager.getRuntimeState = async () => ({});
  const tab = { id: "agent-1", projectId: "p1", cwd: "/proj", title: "T", status: "running", createdAt: 1 };
  if (piSessionId) tab.sessionId = piSessionId;
  manager.agents.set("agent-1", {
    tab,
    process: { isRunning: () => true, client: { request: async () => ({ success: true }) } },
  });
  manager.messages.set("agent-1", [{ id: "m1", agentId: "agent-1", role: "assistant", text: "done", timestamp: 1 }]);
  manager.handlePiEvent("agent-1", { type: "agent_settled" });
  return { shown, focused };
}

test("session-complete notification targets the record id resolved for the agent, not the pi session id", () => {
  const resolvedFor = [];
  const { shown, focused } = settleWithNotification({
    resolveRecordId: (agentId) => {
      resolvedFor.push(agentId);
      return RECORD_ID;
    },
    piSessionId: "pi-session-xyz",
  });
  assert.equal(shown.length, 1);
  assert.equal(shown[0].activationUrl, `pideck://session/${RECORD_ID}`);
  assert.deepEqual(resolvedFor, ["agent-1"]);
  // 点击通知后传给宿主聚焦的也必须是 record.id
  shown[0].onClick();
  assert.deepEqual(focused, [RECORD_ID]);
});

test("session-complete notification falls back to the app root when no record id is bound", () => {
  const { shown, focused } = settleWithNotification({ resolveRecordId: undefined, piSessionId: "pi-only" });
  assert.equal(shown.length, 1);
  assert.equal(shown[0].activationUrl, "pideck://");
  shown[0].onClick();
  assert.deepEqual(focused, [undefined]);
});

// ---- 冷启动时序：加载期目标必须进 pending 队列，且 renderer 挂载后主动拉取 ----

test("focus request while the window is not live is queued with a unique id and returns false", () => {
  const { nativeHost, bridge, renderer } = createNativeBackendHostHarness();
  assert.equal(nativeHost.focusSessionFromNotification(RECORD_ID), false);
  const first = nativeHost.peekPendingFocusTarget();
  assert.equal(first.sessionId, RECORD_ID);
  assert.match(first.id, UUID_PATTERN);
  assert.deepEqual(renderer.broadcasts, [], "no push before the page can receive it");
  // peek 不清除：renderer 的拉取与 SSE 推送都可能晚到，只有 ACK 才能清掉
  assert.equal(nativeHost.peekPendingFocusTarget(), first);
  assert.deepEqual(bridge.requests.map((r) => r.method), ["window.show", "window.focus"]);
});

test("a second notification supersedes the pending target with a fresh id", () => {
  const { nativeHost } = createNativeBackendHostHarness();
  nativeHost.focusSessionFromNotification("session-a");
  const first = nativeHost.peekPendingFocusTarget();
  nativeHost.focusSessionFromNotification("session-b");
  const second = nativeHost.peekPendingFocusTarget();
  assert.equal(second.sessionId, "session-b");
  assert.notEqual(second.id, first.id);
});

test("focus request on a live window pushes the same target that stays pending for pull", () => {
  const { nativeHost, renderer, channels } = createNativeBackendHostHarness();
  nativeHost.markWindowCreated();
  assert.equal(nativeHost.focusSessionFromNotification(RECORD_ID), true);
  assert.equal(renderer.broadcasts.length, 1);
  assert.equal(renderer.broadcasts[0].channel, channels.appFocusSessionTarget);
  // SSE 可能尚未连上：推送之外必须保留可拉取副本，且与推送是同一个目标（同 id）
  assert.equal(renderer.broadcasts[0].args.length, 1);
  assert.equal(renderer.broadcasts[0].args[0], nativeHost.peekPendingFocusTarget());
});

test("focus request without a session id only focuses the window and queues nothing", () => {
  const { nativeHost, bridge, renderer } = createNativeBackendHostHarness();
  nativeHost.markWindowCreated();
  nativeHost.focusSessionFromNotification(undefined);
  assert.equal(nativeHost.peekPendingFocusTarget(), null);
  assert.deepEqual(renderer.broadcasts, []);
  assert.deepEqual(bridge.requests.map((r) => r.method), ["window.show", "window.focus"]);
});

test("focus request with focusWindow=false (secondary launch) queues the target without touching the window", () => {
  const { nativeHost, bridge } = createNativeBackendHostHarness();
  nativeHost.focusSessionFromNotification(RECORD_ID, false);
  assert.equal(nativeHost.peekPendingFocusTarget().sessionId, RECORD_ID);
  assert.deepEqual(bridge.requests, []);
});

test("onWindowReady re-pushes the pending target but never consumes it", () => {
  const { nativeHost, renderer, channels } = createNativeBackendHostHarness();
  nativeHost.focusSessionFromNotification(RECORD_ID);
  const pending = nativeHost.peekPendingFocusTarget();
  nativeHost.onWindowReady();
  assert.equal(renderer.broadcasts.length, 1);
  assert.equal(renderer.broadcasts[0].channel, channels.appFocusSessionTarget);
  assert.equal(renderer.broadcasts[0].args[0], pending);
  // window.ready 可能早于 EventSource 连接，推送丢失时 renderer 仍要能拉取到
  assert.equal(nativeHost.peekPendingFocusTarget(), pending);
  assert.equal(nativeHost.hasLiveWindow(), true);
});

test("onWindowReady without a pending target pushes nothing", () => {
  const { nativeHost, renderer } = createNativeBackendHostHarness();
  nativeHost.onWindowReady();
  assert.deepEqual(renderer.broadcasts, []);
});

test("acknowledgeFocusTarget clears only the matching target id", () => {
  const { nativeHost } = createNativeBackendHostHarness();
  nativeHost.focusSessionFromNotification("session-a");
  const older = nativeHost.peekPendingFocusTarget();
  nativeHost.focusSessionFromNotification("session-b");
  // 迟到的旧 ACK 不得清掉更新的通知
  nativeHost.acknowledgeFocusTarget(older.id);
  assert.equal(nativeHost.peekPendingFocusTarget().sessionId, "session-b");
  nativeHost.acknowledgeFocusTarget(nativeHost.peekPendingFocusTarget().id);
  assert.equal(nativeHost.peekPendingFocusTarget(), null);
});

test("Qt application.focusTarget event with a session id becomes a pending target; one without is ignored", () => {
  const { nativeHost, bridge } = createNativeBackendHostHarness();
  bridge.emit("application.focusTarget", {});
  assert.equal(nativeHost.peekPendingFocusTarget(), null);
  bridge.emit("application.focusTarget", { sessionId: RECORD_ID });
  const target = nativeHost.peekPendingFocusTarget();
  assert.equal(target.sessionId, RECORD_ID);
  assert.match(target.id, UUID_PATTERN);
});

test("backend RPC exposes the pending target by pull and ACK-by-id with input validation", () => {
  const wiring = runBackendRpcFocusWiring();
  const target = { id: "t1", sessionId: RECORD_ID };
  wiring.host.pending = target;
  assert.equal(wiring.invoke(wiring.channels.appGetFocusTargetPending), target);
  // 渲染层入参不可信：非字符串 / 空串 / 超长 id 不得到达宿主
  for (const bad of [undefined, 42, "", "x".repeat(129)]) wiring.invoke(wiring.channels.appAcknowledgeFocusTarget, bad);
  assert.deepEqual(wiring.host.acked, []);
  wiring.invoke(wiring.channels.appAcknowledgeFocusTarget, "t1");
  assert.deepEqual(wiring.host.acked, ["t1"]);
});

// ---- renderer 侧：拉取 / 推送 / 重试 / ACK 的真实 hook 行为 ----

test("renderer pulls the pending target on mount, focuses its record and ACKs by id", async () => {
  await withHookHost(async (host) => {
    const chrome = await mountWorkspaceChromeFocus(host);
    await chrome.setRecords({ [RECORD_ID]: { id: RECORD_ID, projectId: "proj-1" } });
    assert.equal(chrome.pulls.length, 1, "mount must pull the host's pending target");
    await chrome.resolvePull(0, { id: "t1", sessionId: RECORD_ID });
    assert.deepEqual(chrome.focusCalls, [{ projectId: "proj-1", sessionId: RECORD_ID }]);
    assert.deepEqual(chrome.acks, ["t1"]);
  });
});

test("renderer does nothing when the host has no pending focus target", async () => {
  await withHookHost(async (host) => {
    const chrome = await mountWorkspaceChromeFocus(host);
    await chrome.resolvePull(0, null);
    assert.deepEqual(chrome.focusCalls, []);
    assert.deepEqual(chrome.acks, []);
    assert.equal(chrome.pendingRetries(), 0);
  });
});

test("renderer retries every 200ms until the record is loaded and ACKs only after focusing", async () => {
  await withHookHost(async (host) => {
    const chrome = await mountWorkspaceChromeFocus(host);
    await chrome.resolvePull(0, { id: "t1", sessionId: RECORD_ID });
    // 冷启动时会话目录尚未加载：不能 ACK（否则宿主丢掉目标，跳转永远失败）
    assert.deepEqual(chrome.acks, []);
    assert.equal(chrome.pendingRetries(), 1);
    assert.equal(chrome.timers[0].ms, 200);
    await chrome.fireRetries();
    assert.deepEqual(chrome.acks, []);
    await chrome.setRecords({ [RECORD_ID]: { id: RECORD_ID, projectId: "proj-1" } });
    await chrome.fireRetries();
    assert.deepEqual(chrome.focusCalls, [{ projectId: "proj-1", sessionId: RECORD_ID }]);
    assert.deepEqual(chrome.acks, ["t1"]);
    assert.equal(chrome.pendingRetries(), 0);
  });
});

test("renderer stops retrying after the bounded number of attempts and never ACKs", async () => {
  await withHookHost(async (host) => {
    const chrome = await mountWorkspaceChromeFocus(host);
    await chrome.resolvePull(0, { id: "t1", sessionId: "never-loaded" });
    for (let i = 0; i < 40 && chrome.pendingRetries() > 0; i += 1) await chrome.fireRetries();
    assert.equal(chrome.pendingRetries(), 0, "retry chain must terminate");
    assert.equal(chrome.timers.length, 15);
    assert.deepEqual(chrome.acks, []);
    assert.deepEqual(chrome.focusCalls, []);
  });
});

test("a newer pushed target supersedes retries scheduled for an older target", async () => {
  await withHookHost(async (host) => {
    const chrome = await mountWorkspaceChromeFocus(host);
    await chrome.push({ id: "old", sessionId: "session-old" });
    assert.equal(chrome.pendingRetries(), 1);
    await chrome.setRecords({ "session-new": { id: "session-new", projectId: "p" } });
    await chrome.push({ id: "new", sessionId: "session-new" });
    assert.deepEqual(chrome.focusCalls, [{ projectId: "p", sessionId: "session-new" }]);
    // 旧目标的记录之后才出现：它的迟到重试不得再抢焦点
    await chrome.setRecords({
      "session-new": { id: "session-new", projectId: "p" },
      "session-old": { id: "session-old", projectId: "p" },
    });
    await chrome.fireRetries();
    assert.deepEqual(chrome.focusCalls, [{ projectId: "p", sessionId: "session-new" }]);
    assert.deepEqual(chrome.acks, ["new"]);
  });
});

test("a push that arrives after the initial pull started wins over the older pull response", async () => {
  await withHookHost(async (host) => {
    const chrome = await mountWorkspaceChromeFocus(host);
    await chrome.setRecords({
      "session-pull": { id: "session-pull", projectId: "p" },
      "session-push": { id: "session-push", projectId: "p" },
    });
    await chrome.push({ id: "push", sessionId: "session-push" });
    await chrome.resolvePull(0, { id: "pull", sessionId: "session-pull" });
    assert.deepEqual(chrome.focusCalls, [{ projectId: "p", sessionId: "session-push" }]);
    assert.deepEqual(chrome.acks, ["push"]);
  });
});

test("unmounting unsubscribes the push listener and cancels pending retries and pull results", async () => {
  await withHookHost(async (host) => {
    const chrome = await mountWorkspaceChromeFocus(host);
    await chrome.push({ id: "t1", sessionId: RECORD_ID });
    assert.equal(chrome.listenerCount(), 1);
    await chrome.mounted.unmount();
    assert.equal(chrome.listenerCount(), 0);
    await chrome.setRecords({ [RECORD_ID]: { id: RECORD_ID, projectId: "p" } });
    await chrome.fireRetries();
    await chrome.resolvePull(0, { id: "t2", sessionId: RECORD_ID });
    assert.deepEqual(chrome.focusCalls, []);
    assert.deepEqual(chrome.acks, []);
  });
});

// 保留文本断言：src/native-node/index.ts 是依赖 PIDECK_HOST_PORT/TOKEN 与真实 TCP 宿主的顶层入口脚本，
// 无法在不重构生产代码的前提下加载；只守住“二次启动/冷启动用 agentId 解析 record.id 再交给 NativeBackendHost
// 的 pending 队列”这条装配。队列本身的行为已由上面的 NativeBackendHost 测试覆盖。
test("sidecar entry resolves agent ids to record ids before queueing focus targets", () => {
  const indexSource = readFileSync("src/native-node/index.ts", "utf8");
  assert.match(indexSource, /renderer\.ready/);
  assert.match(indexSource, /backend\?\.resolveSessionIdForAgent\(agentId\)/);
  assert.match(indexSource, /nativeHost\.focusSessionFromNotification\(sessionId, false\)/);
});