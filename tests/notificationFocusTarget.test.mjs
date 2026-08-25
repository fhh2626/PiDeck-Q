import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// 用户反馈 bug：点击系统通知能激活窗口，但不会跳转到对应会话。
// 根因：notifySessionEnd 用 tab.sessionId（pi 侧会话 id）嵌入 toast launch，
// renderer 的 sessionRecordByIdAtomFamily 只按 SessionRecord.id 索引，两套 id
// 不一致（见 index.ts attachRuntime 的 sessionId/piSessionId 双字段），
// 导致通知点击后 record 解析永远失败，仅完成窗口激活。
// 修复：通知跳转目标只使用 coordinator 维护的 record.id；缺少稳定身份时只聚焦应用根页。

const RECORD_ID = "11111111-2222-3333-4444-555555555555";

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

// 契约断言：notifySessionEnd 必须走 resolveNotificationSessionId（不再直接取 tab.sessionId）
test("AgentManager notification target uses record id resolver", () => {
  const source = readFileSync(
    "src/main/pi/AgentManager.ts",
    "utf8",
  );
  assert.match(source, /resolveNotificationSessionId\(\s*resolveSessionId \? \(\) => resolveSessionId\(agentId\) : undefined,/);
});

// 冷启动时序：加载期目标必须进 pending 队列，且 renderer 挂载后主动拉取
test("cold start focus target goes through pending queue", () => {
  const indexSource = readFileSync("src/native-node/index.ts", "utf8");
  const hostSource = readFileSync("src/native-node/host/NativeBackendHost.ts", "utf8");
  const rendererSource = readFileSync("src/renderer/src/hooks/useSessionWorkspaceChrome.ts", "utf8");
  assert.match(indexSource, /renderer\.ready/);
  assert.match(indexSource, /resolveSessionIdForAgent/);
  assert.match(hostSource, /pendingFocusTarget/);
  assert.match(hostSource, /appFocusSessionTarget/);
  assert.match(hostSource, /focusSessionFromNotification/);
  assert.match(hostSource, /peekPendingFocusTarget/);
  assert.match(hostSource, /randomUUID\(\)/);
  assert.match(hostSource, /this\.pendingFocusTarget = \{ id: randomUUID\(\), sessionId/);
  assert.match(hostSource, /acknowledgeFocusTarget\(id: string\)/);
  assert.doesNotMatch(hostSource, /onWindowReady\(\)[\s\S]{0,500}takePendingFocusTarget/);
  assert.match(rendererSource, /getPendingFocusTarget/);
  assert.match(rendererSource, /ackFocusSessionTarget\(target\.id\)/);
  assert.match(rendererSource, /latestFocusTargetIdRef/);
  assert.match(rendererSource, /latestFocusTargetIdRef\.current !== target\.id/);
});
