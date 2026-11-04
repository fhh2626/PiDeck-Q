import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

/** 编译 .ts 模块并在 vm 中加载（零外部依赖，node 直跑）。 */
function loadTsModule(filePath) {
  const output = ts.transpileModule(readFileSync(filePath, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
    },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(output, {
    module,
    exports: module.exports,
    require: (id) => (id.includes("duration") ? { formatDuration: (ms) => `${ms}ms` } : {}),
  });
  return module.exports;
}

test("formatDuration: ms / seconds / minutes buckets", () => {
  const { formatDuration } = loadTsModule("src/renderer/src/components/session/TimelineFormat.ts");
  assert.equal(formatDuration(850), "850ms");
  assert.equal(formatDuration(3200), "3.2s");
  assert.equal(formatDuration(64000), "1m4s");
  assert.equal(formatDuration(120000), "2m");
});

test("LiveDuration: live tick only while streaming, fixed after end", () => {
  const source = readFileSync(
    "src/renderer/src/components/session/LiveDuration.tsx",
    "utf8",
  );
  // 100ms tick：仅 isStreaming 时启动 interval，结束/卸载清理
  assert.match(source, /setInterval\(\(\) => \{/);
  assert.match(source, /\}, 100\);/);
  assert.match(
    source,
    /if \(!isStreaming \|\| started == null \|\| !Number\.isFinite\(started\) \|\| started <= 0\) return;/,
  );
  assert.match(source, /clearInterval\(timer\)/);
  // 结束截止：endedAt > 0 时用固定差值，不再依赖 now
  assert.match(source, /formatDuration\(Math\.max\(0, ended - started\)\)/);
  // 无（或非法）startedAt 不渲染
  assert.match(
    source,
    /if \(started == null \|\| !Number\.isFinite\(started\) \|\| started <= 0\) return null;/,
  );
});

test("advanceLiveElapsed: 同一 identity 只增不减，换 identity 立即重算", () => {
  const { advanceLiveElapsed } = loadTsModule(
    "src/renderer/src/components/session/liveElapsed.ts",
  );

  // 首次计算：直接 now - startedAt
  // 注意：对象来自 vm 沙箱上下文，跨 realm 不能用 deepStrictEqual 比原型，逐字段断言。
  let state = advanceLiveElapsed(null, "msg-1", 1_000, 1_500);
  assert.equal(state.identity, "msg-1");
  assert.equal(state.ms, 500);

  // 回归：上游把起点刷成更大的值（旧 bug：message.timestamp 每次 update 重置）——
  // 同一 identity 下读数不得回退。
  state = advanceLiveElapsed(state, "msg-1", 1_450, 1_450);
  assert.equal(state.ms, 500);

  // 正常推进继续增长（越过被刷新时冻结的平台期）
  state = advanceLiveElapsed(state, "msg-1", 1_450, 2_600);
  assert.equal(state.ms, 1_150);

  // 换计时器（换消息/换会话）：不继承旧最大值
  state = advanceLiveElapsed(state, "msg-2", 3_000, 3_050);
  assert.equal(state.identity, "msg-2");
  assert.equal(state.ms, 50);

  // 系统时钟回拨：不出现负值
  const rewound = advanceLiveElapsed(null, "msg-3", 5_000, 4_000);
  assert.equal(rewound.identity, "msg-3");
  assert.equal(rewound.ms, 0);

  // 非有限值不得把状态污死（Math.max(NaN, x) === NaN 会永久粘住）
  for (const [badStart, badNow] of [
    [Number.NaN, 5_000],
    [5_000, Number.NaN],
    [Number.NEGATIVE_INFINITY, 5_000],
    [5_000, Number.POSITIVE_INFINITY],
  ]) {
    const poisoned = advanceLiveElapsed(null, "msg-4", badStart, badNow);
    assert.equal(poisoned.ms, 0, `startedAt=${badStart} now=${badNow} 应计为 0`);
    // 污死后再推进合法值，仍能从 0 恢复增长
    assert.equal(advanceLiveElapsed(poisoned, "msg-4", 1_000, 1_500).ms, 500);
  }
});

test("LiveDuration 按 identity 钳制读数", () => {
  const source = readFileSync(
    "src/renderer/src/components/session/LiveDuration.tsx",
    "utf8",
  );
  assert.match(source, /advanceLiveElapsed\(previous, identity, started, nextNow\)/);
  // tracked 属于别的计时器时不得复用旧读数
  assert.match(source, /tracked\.identity === identity/);
});

test("three duration call sites reuse LiveDuration", () => {
  const turnRow = readFileSync("src/renderer/src/components/session/turn/TurnRow.tsx", "utf8");
  const toolCard = readFileSync("src/renderer/src/components/session/ToolCallComponents.tsx", "utf8");
  const thinking = readFileSync("src/renderer/src/components/session/TimelineEventCards.tsx", "utf8");
  // TurnRow run 耗时：流式中实时（agentRunning 驱动，不依赖 endedAt）、结束截止
  assert.match(turnRow, /<LiveDuration[\s\S]*?startedAt=\{run\.startedAt\}/);
  assert.match(turnRow, /isRunLive \?/);
  // ThinkingBlock 思考耗时（新架构在 TimelineEventCards.tsx）
  assert.match(thinking, /<LiveDuration[\s\S]*?startedAt=\{props\.startedAt\}/);
  // 思考流式中即带「思考了」前缀（结束时不蹦文案）
  assert.match(thinking, /thinking\.durationPrefix/);
  // ToolCard 工具耗时：running 时从 meta.startedAt（经 getToolStartedAt）实时计时
  assert.match(toolCard, /const startedAtMs = getToolStartedAt\(props\.message\)/);
  assert.match(toolCard, /<LiveDuration[\s\S]{0,160}?startedAt=\{startedAtMs\}/);
  assert.doesNotMatch(
    toolCard,
    /<LiveDuration[\s\S]{0,160}?startedAt=\{props\.message\.timestamp\}/,
  );
});

test("getToolStartedAt / getToolDurationMs：起点优先级与非法值兜底", () => {
  const { getToolStartedAt, getToolDurationMs } = loadTsModule(
    "src/renderer/src/components/session/TimelineFormat.ts",
  );
  const base = { id: "tool-1", agentId: "agent-1", role: "tool", text: "▶ powershell" };

  // 有 meta.startedAt 时必须用它（即使 timestamp 更晚 = 被 update 刷新过）
  assert.equal(getToolStartedAt({ ...base, timestamp: 9_000, meta: { startedAt: 5_000 } }), 5_000);
  // 缺失/非法时回退 timestamp（旧投影数据）
  assert.equal(getToolStartedAt({ ...base, timestamp: 9_000, meta: {} }), 9_000);
  assert.equal(getToolStartedAt({ ...base, timestamp: 9_000 }), 9_000);
  for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(
      getToolStartedAt({ ...base, timestamp: 9_000, meta: { startedAt: bad } }),
      9_000,
      `startedAt=${String(bad)} 不得参与计时`,
    );
  }

  // 终态耗时：只有有限非负数生效
  assert.equal(getToolDurationMs({ ...base, timestamp: 1, meta: { durationMs: 1_234.5 } }), 1_234.5);
  assert.equal(getToolDurationMs({ ...base, timestamp: 1, meta: { durationMs: 0 } }), 0);
  assert.equal(getToolDurationMs({ ...base, timestamp: 1, meta: {} }), undefined);
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1, "12"]) {
    assert.equal(
      getToolDurationMs({ ...base, timestamp: 1, meta: { durationMs: bad } }),
      undefined,
      `durationMs=${String(bad)} 不得参与展示`,
    );
  }
});
