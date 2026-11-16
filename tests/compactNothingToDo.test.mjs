import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadModuleInternals } from "./helpers/l4_loadModuleInternals.mjs";

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
