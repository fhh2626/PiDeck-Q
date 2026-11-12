import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

// findTurnPageStart：轮次分页起点（2026-08 激活分页）。
// 核心契约：页边界永远对齐完整轮次（user 消息为轮次起点），
// 字节预算只从旧侧整轮丢弃，最新一轮永不拆分。

function loadFindTurnPageStart() {
  const source = readFileSync("src/main/pi/SessionHistoryReader.ts", "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: "SessionHistoryReader.ts",
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(output, {
    module,
    exports: module.exports,
    require: () => ({}),
  }, { filename: "SessionHistoryReader.ts" });
  return module.exports.findTurnPageStart;
}

const findTurnPageStart = loadFindTurnPageStart();

// 构造测试数据：role 序列 + 每条 100 字节
function entries(roles, byteLength = 100) {
  return roles.map((role) => ({ role, byteLength }));
}

test("pages align to whole turns: Nth user message from the end becomes the page start", () => {
  // user@0 (0-2), user@3 (3-5), user@6 (6-9) 共 3 轮
  const e = entries(["user", "assistant", "assistant", "user", "assistant", "tool", "user", "assistant", "assistant", "assistant"]);
  assert.equal(findTurnPageStart(e, 10, 2, 1_000_000), 3, "last 2 turns start at the 2nd user from end");
  assert.equal(findTurnPageStart(e, 10, 3, 1_000_000), 0, "3 turns = whole session");
  assert.equal(findTurnPageStart(e, 10, 1, 1_000_000), 6, "single turn page");
});

test("fewer turns than requested falls back to session head", () => {
  const e = entries(["user", "assistant", "user", "assistant"]);
  assert.equal(findTurnPageStart(e, 4, 5, 1_000_000), 0);
});

test("leading non-user fragments attach to the first turn", () => {
  // system 碎片在首个 user 之前：翻到最后时整体归首轮
  const e = entries(["system", "user", "assistant", "user", "assistant"]);
  assert.equal(findTurnPageStart(e, 5, 2, 1_000_000), 0);
});

test("byte budget drops oldest whole turns but never splits one", () => {
  // 3 轮 × 3 条 × 100B = 900B；预算 650B → 丢最旧一轮（300B）剩 600B
  const e = entries(["user", "assistant", "assistant", "user", "assistant", "assistant", "user", "assistant", "assistant"]);
  assert.equal(findTurnPageStart(e, 9, 3, 650), 3, "oldest turn dropped wholesale");
  // 预算 550B → 再丢一轮，只剩最新一轮 300B
  assert.equal(findTurnPageStart(e, 9, 3, 550), 6);
});

test("newest turn is kept whole even when it alone exceeds the budget", () => {
  // 最新一轮 5 条 × 200B = 1000B 超 256B 预算：仍整轮保留（宁超预算不拆轮）
  const e = entries(["user", "assistant", "user", "assistant", "assistant", "assistant", "assistant"], 200);
  assert.equal(findTurnPageStart(e, 7, 2, 256), 2);
});

test("degenerate inputs return session head", () => {
  const e = entries(["user", "assistant"]);
  assert.equal(findTurnPageStart(e, 0, 3, 1000), 0);
  assert.equal(findTurnPageStart(e, 2, 0, 1000), 0);
});

test("visible task cards start a turn even though their projected role is not user", () => {
  // goal 卡片在桌面投影为 system，但它是独立只读轮次；文件索引用 turnBoundary 标记。
  const e = [
    { role: "user", byteLength: 100 },
    { role: "assistant", byteLength: 100 },
    { role: "custom", byteLength: 100, turnBoundary: true },
    { role: "assistant", byteLength: 100 },
    { role: "user", byteLength: 100 },
    { role: "assistant", byteLength: 100 },
  ];
  assert.equal(findTurnPageStart(e, 6, 1, 1_000_000), 4, "last turn starts at the real user message");
  assert.equal(findTurnPageStart(e, 6, 2, 1_000_000), 2, "the task card is the previous turn start");
  assert.equal(findTurnPageStart(e, 6, 3, 1_000_000), 0);
});
