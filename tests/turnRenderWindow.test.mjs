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

test("selectTimelineTurnWindow slices past the window turns regardless of following", () => {
  const items = runs("a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k");
  assert.equal(windowing.countAgentRunItems(items), 11);
  assert.equal(windowing.shouldWindowTimelineTurns(11, 10), true);
  assert.equal(windowing.shouldWindowTimelineTurns(11, 15), false);
  // 2026-08 治理：非贴底（上滚看历史）同样裁剪，只是窗口更大
  const scrolled = windowing.selectTimelineTurnWindow(items, 10);
  assert.equal(scrolled.length, 10);
  assert.equal(scrolled[0].id, "b");
  assert.equal(scrolled.at(-1).id, "k");
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

test("resolveTimelineTurnWindow accurately reports hiddenRunCount and hiddenItemCount", () => {
  // 5 个 run，窗口 3 轮：截断 2 轮
  const items5 = runs("r1", "r2", "r3", "r4", "r5");
  const resTurns = windowing.resolveTimelineTurnWindow(items5, 3, 200);
  assert.equal(resTurns.windowActive, true);
  assert.equal(resTurns.hiddenRunCount, 2);
  assert.equal(resTurns.hiddenItemCount, 2);

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
  assert.equal(resItems.hiddenRunCount, 0);
  assert.equal(resItems.hiddenItemCount > 0, true);
});

test("timeline wires the turn mount window helper", () => {
  const source = readFileSync("src/renderer/src/components/session/SessionMessageTimeline.tsx", "utf8");
  assert.match(source, /resolveTimelineTurnWindow/);
  assert.match(source, /controller\.scrolledWindowItems/);
  assert.match(source, /TIMELINE_MOUNTED_TURN_LIMIT/);
  assert.match(source, /TIMELINE_SCROLLED_MAX_ITEMS/);
  assert.match(source, /displayRuns\.map/);
  assert.match(source, /hiddenRunCount/);
});
