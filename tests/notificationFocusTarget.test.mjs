import assert from "node:assert/strict";
import test from "node:test";
import { withHookHost } from "./helpers/l5_hookHost.mjs";
import { mountSessionWorkspace } from "./helpers/sessionWorkspaceHarness.mjs";

// 用户反馈 bug：点击系统通知能激活窗口，但不会跳转到对应会话。
// 根因：notifySessionEnd 用 tab.sessionId（pi 侧会话 id）嵌入 toast launch，
// renderer 的 sessionRecordByIdAtomFamily 只按 SessionRecord.id 索引，两套 id
// 不一致（见 index.ts attachRuntime 的 sessionId/piSessionId 双字段），
// 导致通知点击后 record 解析永远失败，仅完成窗口激活。
// 修复：通知跳转目标只使用 coordinator 维护的 record.id；缺少稳定身份时只聚焦应用根页。

const RECORD_ID = "11111111-2222-3333-4444-555555555555";

// ---- renderer 侧：拉取 / 推送 / 重试 / ACK 的真实 hook 行为 ----

test("renderer pulls the pending target on mount, focuses its record and ACKs by id", async () => {
  await withHookHost(async (host) => {
    const chrome = await mountSessionWorkspace(host);
    await chrome.setRecords({ [RECORD_ID]: { id: RECORD_ID, projectId: "proj-1" } });
    assert.equal(chrome.pulls.length, 1, "mount must pull the host's pending target");
    await chrome.resolvePull(0, { id: "t1", sessionId: RECORD_ID });
    assert.deepEqual(chrome.focusCalls, [{ projectId: "proj-1", sessionId: RECORD_ID }]);
    assert.deepEqual(chrome.acks, ["t1"]);
  });
});

test("renderer does nothing when the host has no pending focus target", async () => {
  await withHookHost(async (host) => {
    const chrome = await mountSessionWorkspace(host);
    await chrome.resolvePull(0, null);
    assert.deepEqual(chrome.focusCalls, []);
    assert.deepEqual(chrome.acks, []);
    assert.equal(chrome.pendingRetries(), 0);
  });
});

test("renderer retries every 200ms until the record is loaded and ACKs only after focusing", async () => {
  await withHookHost(async (host) => {
    const chrome = await mountSessionWorkspace(host);
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
    const chrome = await mountSessionWorkspace(host);
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
    const chrome = await mountSessionWorkspace(host);
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
    const chrome = await mountSessionWorkspace(host);
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
    const chrome = await mountSessionWorkspace(host);
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
test("notification lookup failure leaves push focus usable", async () => withHookHost(async (host) => {
  const harness = await mountSessionWorkspace(host, {}, {
    ready: { id: "ready", projectId: "project" },
  });
  await harness.rejectPull(0, new Error("backend temporarily unavailable"));
  await harness.push({ id: "push-after-error", sessionId: "ready" });
  assert.deepEqual(harness.focusCalls, [{ projectId: "project", sessionId: "ready" }]);
  assert.deepEqual(harness.acks, ["push-after-error"]);
}));

test("superseded notification retries and unmounted listeners are released", async () => withHookHost(async (host) => {
  const harness = await mountSessionWorkspace(host);
  await harness.push({ id: "first", sessionId: "missing-first" });
  assert.equal(harness.pendingRetries(), 1);
  await harness.push({ id: "second", sessionId: "missing-second" });
  assert.equal(harness.pendingRetries(), 1);
  await harness.mounted.unmount();
  assert.equal(harness.pendingRetries(), 0);
  assert.equal(harness.listenerCount(), 0);
}));

test("manual sidebar navigation supersedes a notification waiting for its record", async () => withHookHost(async (host) => {
  const selectionRequestRef = { current: 0 };
  const harness = await mountSessionWorkspace(host, { selectionRequestRef });
  await harness.push({ id: "stale", sessionId: RECORD_ID });
  selectionRequestRef.current++;
  await harness.setRecords({ [RECORD_ID]: { id: RECORD_ID, projectId: "p" } });
  await harness.fireRetries();
  assert.deepEqual(harness.focusCalls, []);
  assert.deepEqual(harness.acks, ["stale"], "dismiss the superseded target so reload cannot replay it");
  assert.equal(harness.pendingRetries(), 0);
  await harness.push({ id: "new", sessionId: RECORD_ID });
  assert.deepEqual(harness.focusCalls, [{ projectId: "p", sessionId: RECORD_ID }]);
}));

test("a delayed initial notification lookup cannot override later navigation", async () => withHookHost(async (host) => {
  const selectionRequestRef = { current: 0 };
  const harness = await mountSessionWorkspace(host, { selectionRequestRef }, {
    [RECORD_ID]: { id: RECORD_ID, projectId: "p" },
  });
  selectionRequestRef.current++;
  await harness.resolvePull(0, { id: "stale-pull", sessionId: RECORD_ID });
  assert.deepEqual(harness.focusCalls, []);
  assert.deepEqual(harness.acks, ["stale-pull"]);
}));
