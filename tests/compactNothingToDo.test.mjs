import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadModuleInternals } from "./helpers/l4_loadModuleInternals.mjs";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * #113 3.2-7：compact nothing-to-do 友好文案链路。
 * 1) AgentManager 必须把 RPC success:false 抛出（不能只 warn）
 * 2) 渲染层优先读 debugDetails 映射 nothing-to-do / too-small
 * 3) /compact 与 chip 共用同一映射
 */

const composer = readFileSync(
  "src/renderer/src/hooks/useSessionComposerController.ts",
  "utf8",
);

// ── 主进程：AgentManager.compact / compaction_end ─────────────────────

const ELECTRON_STUB = { app: {}, Notification: class {} };

/** 捕获 300ms 的 compaction 收尾定时器，其余定时器照常走真实 setTimeout。 */
function loadAgentManagerWithTimerCapture() {
  const captured = [];
  const loaded = loadTsCommonJs("src/main/pi/AgentManager.ts", {
    stubs: { electron: ELECTRON_STUB },
    globals: {
      setTimeout: (fn, delay, ...rest) => {
        if (delay === 300) {
          captured.push(fn);
          return { unref() {} };
        }
        return setTimeout(fn, delay, ...rest);
      },
    },
  });
  return { ...loaded, captured };
}

function createManager(request, { status = "running" } = {}) {
  const loaded = loadAgentManagerWithTimerCapture();
  const manager = new loaded.AgentManager(
    () => ({ id: "project-1", name: "Project", path: "C:/project" }),
    () => {},
    { get: () => ({}) },
    {},
  );
  const process = { client: { request }, isRunning: () => true };
  manager.agents.set("agent-1", {
    tab: {
      id: "agent-1",
      projectId: "project-1",
      cwd: "C:/project",
      title: "Session",
      status,
      sessionPath: "C:/project/.pi/sessions/x.jsonl",
      sessionEnvironment: "native",
      sessionSource: "pi",
      createdAt: 1,
    },
    process,
  });
  return { manager, process, captured: loaded.captured, tab: manager.agents.get("agent-1").tab };
}

test("AgentManager.compact throws the RPC error when pi returns success:false", async () => {
  const { manager, tab } = createManager(async () => ({
    success: false,
    error: "  Nothing to compact (session too small)  ",
  }));
  await assert.rejects(
    manager.compact("agent-1"),
    (error) => {
      // 渲染层靠错误文本映射 nothing-to-do / too-small；原文必须到达（trim 后）
      assert.equal(error.message, "Nothing to compact (session too small)");
      return true;
    },
  );
  // 失败也要收口：不能永久卡在 running，也不能留下 compacting 标记挡住后续发送
  assert.equal(tab.status, "idle");
  assert.equal(manager.compactingAgents.has("agent-1"), false);
  assert.equal(manager.rpcCompactingAgents.has("agent-1"), false);
});

test("AgentManager.compact falls back to a generic message when pi gives no error text", async () => {
  const { manager } = createManager(async () => ({ success: false }));
  await assert.rejects(manager.compact("agent-1"), /compact failed/);
});

test("AgentManager.compact resolves normally when pi reports success", async () => {
  const { manager, tab } = createManager(async (command) =>
    command.type === "compact" ? { success: true, data: {} } : { success: true, data: { messages: [] } },
  );
  await manager.compact("agent-1");
  assert.equal(tab.status, "idle");
});

/** 触发 compaction_end 并返回 300ms 兜底定时器的回调（压缩收尾后检查 idle）。 */
function endCompaction(manager, captured) {
  manager.handlePiEvent("agent-1", { type: "compaction_end", reason: "manual", result: {} });
  assert.equal(captured.length, 1, "compaction_end 必须安排一次 300ms 后的 idle 检查");
  return captured[0];
}

test("compaction_end keeps running until the delayed idle check confirms pi has no work", async () => {
  // pi 压缩结束不保证发 agent_settled：不主动检查会永远 stuck 在 running（2026-08 用户反馈）
  const { manager, tab, captured } = createManager(async () => ({
    success: true,
    data: { isStreaming: false, isCompacting: false, pendingMessageCount: 0 },
  }));
  const idleCheck = endCompaction(manager, captured);
  assert.equal(tab.status, "running", "事件当下不能提前 idle（可能还有 overflow retry）");
  idleCheck();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(tab.status, "idle");
});

test("delayed idle check leaves status running when pi still reports work", async () => {
  const { manager, tab, captured } = createManager(async () => ({
    success: true,
    data: { isStreaming: true },
  }));
  const idleCheck = endCompaction(manager, captured);
  idleCheck();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(tab.status, "running");
});

test("delayed idle check is bound to the process that ended compaction", async () => {
  // 定时器等待期间进程被替换（重连/重启）：旧检查不得关闭新一轮任务
  const { manager, tab, captured } = createManager(async () => ({
    success: true,
    data: { isStreaming: false },
  }));
  const idleCheck = endCompaction(manager, captured);
  manager.agents.get("agent-1").process = {
    client: { request: async () => ({ success: true, data: { isStreaming: false } }) },
    isRunning: () => true,
  };
  idleCheck();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(tab.status, "running");
});

test("delayed idle check is bound to the stream generation that ended compaction", async () => {
  const { manager, tab, captured } = createManager(async () => ({
    success: true,
    data: { isStreaming: false },
  }));
  const idleCheck = endCompaction(manager, captured);
  // 等待期间新一轮开始（generation 前进）
  manager.getStreamGate("agent-1").currentGeneration += 1;
  idleCheck();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(tab.status, "running");
});

// ── 渲染层：friendlyCompactError（hook 内私有纯函数，取出后直接执行）──────

const { friendlyCompactError } = loadModuleInternals(
  "src/renderer/src/hooks/useSessionComposerController.ts",
  ["friendlyCompactError"],
  // t 返回 key(+参数)，断言映射到了哪个文案而不依赖具体语言
  { "../i18n": { t: (key, params) => (params ? `${key}:${JSON.stringify(params)}` : key) } },
);

test("friendlyCompactError maps nothing-to-compact to the friendly key", () => {
  assert.equal(friendlyCompactError(new Error("Nothing to compact")), "app.compactNothingToDo");
  assert.equal(friendlyCompactError("Session already compacted"), "app.compactNothingToDo");
});

test("friendlyCompactError maps too-small errors to the too-small key", () => {
  assert.equal(friendlyCompactError(new Error("session too small")), "app.compactSessionTooSmall");
});

test("friendlyCompactError reads debugDetails first (generic wrapper message hides the pi error)", () => {
  const error = Object.assign(new Error("Operation failed"), {
    debugDetails: "Error invoking remote method 'sessions:compact': Error: nothing to compact",
  });
  assert.equal(friendlyCompactError(error), "app.compactNothingToDo");
});

test("friendlyCompactError is silent (null) for cancelled compaction", () => {
  // 取消响应可能延迟到正常对话后返回：弹 toast 会表现为“没点压缩却弹提示”
  assert.equal(friendlyCompactError(new Error("Compaction cancelled")), null);
  assert.equal(friendlyCompactError(new Error("request cancelled")), null);
});

test("friendlyCompactError falls back to a generic message carrying the reason", () => {
  assert.equal(
    friendlyCompactError(new Error("boom")),
    `app.compactFailedWithReason:${JSON.stringify({ error: "boom" })}`,
  );
  assert.equal(friendlyCompactError(undefined), "app.compactFailed");
});

// ── 渲染层接线（仍为源码文本）──────────────────────────────────────────

test("composer shows compact notices only for non-null friendlyCompactError results", () => {
  // 保留文本断言：两处调用点位于 React hook 内部，没有 DOM/React 渲染环境无法触发；
  // “已移除的 app.compactCancelled 文案不得回归”也属于文本规则。
  assert.doesNotMatch(composer, /app\.compactCancelled/);
  // chip 与 /compact 共用同一调用模式：null（静默）不弹 toast
  assert.equal(
    (composer.match(/const message = friendlyCompactError\(error\)/g) || []).length,
    2,
  );
  assert.match(composer, /if \(message\) showNotice\(message, 6000\)/);
});