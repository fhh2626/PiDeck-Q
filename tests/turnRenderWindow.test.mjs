import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

function compile(filePath) {
  const output = ts.transpileModule(readFileSync(filePath, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(output, { module, exports: module.exports, require: () => ({}) });
  return module.exports;
}

const windowing = compile("src/renderer/src/components/session/timeline/turnRenderWindow.ts");

function runs(...ids) {
  return ids.map((id) => ({ kind: "agent-run", id, items: [] }));
}

/** 构造带内部条目的 run（items.length 决定 DOM 权重，用于条目预算测试）。 */
function heavyRun(id, itemCount) {
  return {
    kind: "agent-run",
    id,
    items: Array.from({ length: itemCount }, (_, i) => ({ kind: "message", id: `${id}-${i}` })),
  };
}

/** 真实轮次结构：userN 提问 + 其触发的 runN（窗口按 user 提问计轮）。 */
function conversationItems(turnCount) {
  const items = [];
  for (let i = 1; i <= turnCount; i += 1) {
    items.push({ kind: "message", message: { id: `user${i}`, role: "user" } });
    items.push({ kind: "agent-run", id: `run${i}`, items: [] });
  }
  return items;
}

test("sliceLastAgentRuns keeps only the trailing maxTurns agent-runs", () => {
  const items = [
    { kind: "message", id: "sys" },
    ...runs("r1", "r2", "r3", "r4", "r5"),
  ];
  const sliced = windowing.sliceLastAgentRuns(items, 3);
  assert.deepEqual(
    sliced.map((item) => item.id),
    ["r3", "r4", "r5"],
  );
});

test("sliceLastAgentRuns preserves trailing non-run items after the cut", () => {
  const items = [
    ...runs("r1", "r2", "r3"),
    { kind: "message", id: "diag" },
  ];
  const sliced = windowing.sliceLastAgentRuns(items, 2);
  assert.deepEqual(
    sliced.map((item) => item.id ?? item.kind),
    ["r2", "r3", "diag"],
  );
});

test("sliceLastAgentRuns returns same reference when under the limit", () => {
  const items = runs("r1", "r2");
  assert.equal(windowing.sliceLastAgentRuns(items, 10), items);
});

test("sliceLastAgentRuns counts each run once regardless of nested tool calls", () => {
  const items = [
    heavyRun("r1", 150),
    heavyRun("r2", 150),
    runs("r3")[0],
  ];
  const sliced = windowing.sliceLastAgentRuns(items, 3, 200);
  assert.equal(sliced, items);
});

test("sliceLastAgentRuns item budget keeps only trailing lightweight runs", () => {
  // 10 个轻量 run（各 1 条）：预算 5 时只保留尾部 5 个 run
  const items = runs("r1", "r2", "r3", "r4", "r5", "r6", "r7", "r8", "r9", "r10");
  const sliced = windowing.sliceLastAgentRuns(items, 100, 5);
  assert.deepEqual(
    sliced.map((item) => item.id),
    ["r6", "r7", "r8", "r9", "r10"],
  );
});

test("timeline turn window defaults keep the last 50 turns (2026-12)", () => {
  assert.equal(windowing.TIMELINE_MOUNTED_TURN_LIMIT, 50, "贴底挂载窗口 = 50 轮");
  assert.equal(windowing.TIMELINE_SCROLLED_TURN_LIMIT, 50, "上滚基础窗口 = 50 轮");
});

test("sliceLastAgentRuns keeps all 50 runs at the default mounted limit", () => {
  const items = Array.from({ length: 50 }, (_, i) => runs(`r${i + 1}`)[0]);
  const sliced = windowing.sliceLastAgentRuns(items, windowing.TIMELINE_MOUNTED_TURN_LIMIT);
  assert.equal(sliced, items);
});

test("sliceLastAgentRuns hides only the oldest run once the 51st appears", () => {
  const items = Array.from({ length: 51 }, (_, i) => runs(`r${i + 1}`)[0]);
  const sliced = windowing.sliceLastAgentRuns(items, windowing.TIMELINE_MOUNTED_TURN_LIMIT);
  assert.deepEqual(
    sliced.map((item) => item.id),
    Array.from({ length: 50 }, (_, i) => `r${i + 2}`),
  );
});

test("sliceLastAgentRuns keeps the user question preceding the 50th run", () => {
  // 顶层序列：userN 紧跟其触发的 runN。裁到 50 轮时必须从 user2 开始保留，
  // 不能把第 50 轮的用户提问单独裁掉（只显示回复不显示提问）。
  const items = [];
  for (let i = 1; i <= 51; i += 1) {
    items.push({ kind: "message", id: `user${i}` });
    items.push(runs(`run${i}`)[0]);
  }
  const userRun = (id) => ({ kind: "message", message: { id, role: "user" } });
  const real = items.map((item) => (item.kind === "message" ? userRun(item.id) : item));
  // MessageItem 的 id 在 message 内（与 groupToolMessages 产出的 RenderMessage 形状一致）
  const topId = (item) => item.id ?? item.message?.id;

  // 保留第 2..51 轮 = 100 条（每轮 user+run 相邻）：user2,run2,user3,run3,…,user51,run51
  const expected = [];
  for (let i = 2; i <= 51; i += 1) {
    expected.push(`user${i}`, `run${i}`);
  }

  // 贴底调用不传 maxItems
  const mounted = windowing.sliceLastAgentRuns(real, windowing.TIMELINE_MOUNTED_TURN_LIMIT);
  assert.deepEqual(mounted.map(topId), expected);
  // 上滚调用传 200 条目预算
  const scrolled = windowing.sliceLastAgentRuns(real, windowing.TIMELINE_MOUNTED_TURN_LIMIT, 200);
  assert.deepEqual(scrolled.map(topId), expected);
});

test("sliceLastAgentRuns includes the user and non-boundary system card preceding the cutoff run", () => {
  const items = [];
  for (let i = 1; i <= 51; i += 1) {
    items.push({ kind: "message", message: { id: `user${i}`, role: "user" } });
    if (i === 2) items.push({ kind: "message", message: { id: "ask-card", role: "system" } });
    items.push(runs(`run${i}`)[0]);
  }
  const sliced = windowing.sliceLastAgentRuns(items, 50, 200);
  assert.deepEqual(sliced.slice(0, 3).map((item) => item.id ?? item.message?.id), ["user2", "ask-card", "run2"]);
  assert.equal(windowing.countAgentRunItems(sliced), 50);
  assert.equal(sliced.length, 101);
});

test("sliceLastAgentRuns does not pair a run across a compaction boundary", () => {
  const items = [
    { kind: "message", message: { id: "old-user", role: "user" } },
    { kind: "message", message: { id: "summary", role: "system", meta: { type: "compaction" } } },
    ...runs("run1", "run2"),
  ];
  assert.deepEqual(
    windowing.sliceLastAgentRuns(items, 2).map((item) => item.id ?? item.message?.id),
    ["run1", "run2"],
  );
});

test("sliceLastAgentRuns keeps the item budget instead of orphaning the cutoff reply", () => {
  const items = [];
  for (let i = 1; i <= 51; i += 1) {
    items.push({ kind: "message", message: { id: `user${i}`, role: "user" } });
    if (i === 2) items.push({ kind: "message", message: { id: "ask-card", role: "system" } });
    items.push(runs(`run${i}`)[0]);
  }
  const sliced = windowing.sliceLastAgentRuns(items, 50, 100);
  assert.equal(sliced.length <= 100, true);
  assert.deepEqual(sliced.slice(0, 2).map((item) => item.id ?? item.message?.id), ["user3", "run3"]);
  assert.equal(windowing.countAgentRunItems(sliced), 49);
});

test("selectTimelineTurnWindow slices past the window user turns regardless of following", () => {
  const items = conversationItems(11);
  assert.equal(windowing.countAgentRunItems(items), 11);
  assert.equal(windowing.countUserTurnItems(items), 11);
  assert.equal(windowing.shouldWindowTimelineTurns(11, 10), true);
  assert.equal(windowing.shouldWindowTimelineTurns(11, 15), false);
  // 2026-08 治理：非贴底（上滚看历史）同样裁剪，只是窗口更大
  const scrolled = windowing.selectTimelineTurnWindow(items, 10);
  assert.equal(windowing.countUserTurnItems(scrolled), 10);
  // 第 1 轮的提问与回答一起隐藏，保留的第 1 条是第 2 轮提问
  assert.equal(scrolled[0].message?.id, "user2");
  assert.equal(scrolled.at(-1).id, "run11");
});

test("selectTimelineTurnWindow returns same reference when under the window", () => {
  const items = runs("a", "b", "c");
  assert.equal(windowing.selectTimelineTurnWindow(items, 15), items);
});

test("resolveTimelineTurnWindow ignores nested tool-call size", () => {
  const items = [heavyRun("r1", 150), heavyRun("r2", 150)];
  const resolved = windowing.resolveTimelineTurnWindow(items, 15, 200);
  assert.equal(resolved.windowActive, false);
  assert.equal(resolved.displayItems, items);
});

test("resolveTimelineTurnWindow reveals the next run after the item budget grows", () => {
  const items = [heavyRun("r1", 150), heavyRun("r2", 150)];
  const expanded = windowing.resolveTimelineTurnWindow(items, 15, 400);
  assert.equal(expanded.windowActive, false);
  assert.deepEqual(expanded.displayItems.map((item) => item.id), ["r1", "r2"]);
});

test("resolveTimelineTurnWindow stays inactive when nothing is hidden", () => {
  const items = runs("r1", "r2");
  const resolved = windowing.resolveTimelineTurnWindow(items, 15, 200);
  assert.equal(resolved.windowActive, false);
  assert.equal(resolved.displayItems, items);
});

test("resolveTimelineTurnWindow accurately reports hiddenTurnCount and hiddenItemCount", () => {
  // 5 轮（user+run 相邻），窗口 3 轮：截断 2 轮 = 4 个展示条目
  const items5 = conversationItems(5);
  const resTurns = windowing.resolveTimelineTurnWindow(items5, 3, 200);
  assert.equal(resTurns.windowActive, true);
  assert.equal(resTurns.hiddenTurnCount, 2);
  assert.equal(resTurns.hiddenItemCount, 4);

  // 1 个 run 加上 5 个普通消息，预算 3 个条目：run 保留，但前面普通消息被截断
  const itemsItems = [
    { kind: "message", id: "m1" },
    { kind: "message", id: "m2" },
    { kind: "message", id: "m3" },
    { kind: "message", id: "m4" },
    runs("r1")[0],
  ];
  const resItems = windowing.resolveTimelineTurnWindow(itemsItems, 10, 3);
  assert.equal(resItems.windowActive, true);
  assert.equal(resItems.hiddenTurnCount, 0);
  assert.equal(resItems.hiddenItemCount > 0, true);
});

// 前置内容（压缩摘要卡）+ N 轮完整对话：验证轮次恰好等于上限时前置内容不被裁掉。
function summaryThenTurns(turnCount) {
  const items = [
    { kind: "message", message: { id: "summary", role: "system", meta: { type: "compaction" } } },
  ];
  for (let i = 1; i <= turnCount; i += 1) {
    items.push({ kind: "message", message: { id: `u${i}`, role: "user" } });
    items.push(runs(`r${i}`)[0]);
  }
  return items;
}

test("sliceLastUserTurns keeps the pre-summary prefix at exactly the turn limit", () => {
  // 恰好 50 轮（未超限）：原样保留前置摘要，不裁任何内容
  const atLimit = summaryThenTurns(50);
  assert.equal(windowing.sliceLastUserTurns(atLimit, 50), atLimit);
  // 未超条目预算时同样保留（上滚路径传 maxItems=200：51 条目 < 200）
  const scrolled = windowing.sliceLastUserTurns(atLimit, 50, 200);
  assert.equal(scrolled, atLimit);
  const resolved = windowing.resolveTimelineTurnWindow(atLimit, 50, 200);
  assert.equal(resolved.windowActive, false);
  assert.equal(resolved.hiddenItemCount, 0);
  assert.equal(resolved.displayItems[0].message?.id, "summary");
  // 49 轮（低于上限）同样原样保留
  const underLimit = summaryThenTurns(49);
  assert.equal(windowing.sliceLastUserTurns(underLimit, 50), underLimit);
});

test("sliceLastUserTurns still trims the first turn once the 51st appears", () => {
  const overLimit = summaryThenTurns(51);
  const sliced = windowing.sliceLastUserTurns(overLimit, 50, 200);
  // 第 1 轮及其前置摘要被裁掉，保留完整的第 2..51 轮
  assert.equal(sliced[0].message?.id, "u2");
  assert.equal(windowing.countUserTurnItems(sliced), 50);
  assert.equal(windowing.countAgentRunItems(sliced), 50);
  // 前置摘要在窗口外：hiddenItemCount 至少包含摘要 + 第 1 轮的两条
  const resolved = windowing.resolveTimelineTurnWindow(overLimit, 50, 200);
  assert.equal(resolved.hiddenItemCount, 3);
  assert.equal(resolved.hiddenTurnCount, 1);
});

test("sliceLastUserTurns keeps the item budget over the turn limit for prefixes", () => {
  // 未超轮数上限但超条目预算：预算安全阀仍必须生效（不因恰好上限的早退被绕过）。
  // 50 轮 + 1 摘要 = 51 条目，maxItems=5：不能原样返回，必须裁到 <=5 条目。
  const items = summaryThenTurns(50);
  const sliced = windowing.sliceLastUserTurns(items, 50, 5);
  assert.ok(sliced.length <= 5, `预算应把 51 条裁到 <=5，实际 ${sliced.length}`);
  assert.notEqual(sliced, items, "超预算时不得原样返回");
  // 裁切点落在用户提问上，不产生孤立回答（首条不是 agent-run）
  assert.equal(sliced[0].kind, "message");
  assert.equal(sliced[0].message?.role, "user");
});

test("timeline wires the turn mount window helper", () => {
  const source = readFileSync("src/renderer/src/components/session/SessionMessageTimeline.tsx", "utf8");
  assert.match(source, /resolveTimelineTurnWindow/);
  assert.match(source, /controller\.scrolledWindowItems/);
  assert.match(source, /TIMELINE_MOUNTED_TURN_LIMIT/);
  assert.match(source, /TIMELINE_SCROLLED_MAX_ITEMS/);
  assert.match(source, /displayRuns\.map/);
  // 按钮文案按「隐藏的用户轮数」计算，不再按 agent-run 数
  assert.match(source, /hiddenTurnCount/);
  assert.doesNotMatch(source, /hiddenRunCount/);
});
