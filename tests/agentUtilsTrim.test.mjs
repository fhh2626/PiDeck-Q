import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { trimHistoryMessages, turnTrimStartIndex, countRoleMessagesBefore, contextTrimStartIndex } = loadTsCommonJs(
  "src/main/pi/agentUtils.ts",
);

const message = (role) => ({ role });

test("trimHistoryMessages default caps runtime cache at 50 turns (2026-12)", () => {
  // 51 轮输入 → 保留最近 50 轮（user 消息为轮起点）
  const input = [];
  for (let turn = 0; turn < 51; turn += 1) {
    input.push(message("user"), message("assistant"), message("tool"));
  }
  const trimmed = trimHistoryMessages(input);
  assert.equal(trimmed.length, 50 * 3);
  assert.equal(trimmed[0].role, "user");
});

test("trimHistoryMessages default keeps 50 turns intact without truncating (2026-12)", () => {
  // 50 轮输入：未超上限，整段保留（不得在 50 轮内提前裁剪）
  const input = [];
  for (let turn = 0; turn < 50; turn += 1) {
    input.push(message("user"), message("assistant"), message("tool"));
  }
  assert.equal(trimHistoryMessages(input).length, 50 * 3);
});

test("trimHistoryMessages default keeps a turn with multiple tool results intact (2026-12)", () => {
  // 第 51 轮含多条 toolResult：整轮必须完整保留，不能从工具调用中间截断
  const input = [];
  for (let turn = 1; turn <= 51; turn += 1) {
    input.push(message("user"), message("assistant"), message("toolResult"), message("toolResult"));
  }
  const trimmed = trimHistoryMessages(input);
  assert.equal(trimmed.length, 50 * 4);
  assert.equal(trimmed[0].role, "user");
  assert.equal(trimmed[trimmed.length - 1].role, "toolResult");
});

test("trimHistoryMessages counts dense tool traffic as one turn (2026-12)", () => {
  // 单轮内 150 条工具相关消息：工具不额外占轮数，整轮必须保留
  const input = [{ role: "user" }, { role: "assistant" }];
  for (let i = 0; i < 150; i += 1) input.push(message("toolResult"));
  input.push({ role: "assistant" });
  assert.equal(trimHistoryMessages(input).length, input.length);
});

test("trimHistoryMessages keeps the trailing unanswered user turn (2026-12)", () => {
  // 50 个完整轮次 + 第 51 轮用户提问（尚未回复）：最近 50 轮 = 第 2..50 轮 + 新提问
  const input = [];
  for (let turn = 1; turn <= 50; turn += 1) {
    input.push({ role: "user", text: `q${turn}` }, { role: "assistant", text: `a${turn}` });
  }
  input.push({ role: "user", text: "q51" });
  const trimmed = trimHistoryMessages(input);
  // 49 轮完整（q2..q50/a2..a50）+ 未回复的 q51 = 99 条
  assert.equal(trimmed.length, 49 * 2 + 1);
  assert.equal(trimmed[0].text, "q2");
  assert.equal(trimmed[trimmed.length - 1].text, "q51");
});

test("trimHistoryMessages keeps the tail intact and aligns to turn boundary", () => {
  const input = [
    { role: "system", text: "compaction summary" },
    { role: "user", text: "q1" },
    { role: "assistant", text: "a1" },
    { role: "user", text: "q2" },
    { role: "assistant", text: "a2" },
  ];
  const trimmed = trimHistoryMessages(input, 1);
  assert.deepEqual(trimmed.map((m) => m.role), ["user", "assistant"]);
  assert.equal(trimmed[0].text, "q2");
});

test("trimHistoryMessages keeps the last message batch when no user turn exists", () => {
  const input = Array.from({ length: 80 }, (_, i) => ({ role: "assistant", text: `a${i}` }));
  const trimmed = trimHistoryMessages(input, 12);
  assert.equal(trimmed.length, 50);
});

test("turnTrimStartIndex/countRoleMessagesBefore align entryId slots after trim", () => {
  // 53 轮 user/assistant → 默认 trim 到 50 轮：首条保留消息是 q4（0-based 下标 6）
  const input = [];
  for (let turn = 0; turn < 53; turn += 1) {
    input.push({ role: "user", text: `q${turn + 1}` });
    input.push({ role: "assistant", text: `a${turn + 1}` });
  }
  const start = turnTrimStartIndex(input);
  assert.equal(start, 6);
  assert.equal(input[start].text, "q4");
  // 被裁掉 6 个角色消息 → activeEntryIds 应从下标 6 起切，保留消息拿到 u4..a53
  const dropped = countRoleMessagesBefore(input, start);
  assert.equal(dropped, 6);
  const entryIds = Array.from({ length: 106 }, (_, i) => `e${i}`);
  assert.equal(entryIds.slice(dropped)[0], "e6");
  assert.equal(entryIds.slice(dropped).length, 100);
});

test("countRoleMessagesBefore ignores compaction summary and non-role entries", () => {
  const input = [
    { role: "compactionSummary", summary: "compacted" },
    { role: "system", text: "sys" },
    { role: "user", text: "q1" },
    { role: "assistant", text: "a1" },
    { role: "toolResult", toolCallId: "t1" },
    { role: "user", text: "q2" },
  ];
  // 只统计消费槽位的角色消息：compactionSummary/system 不消费
  assert.equal(countRoleMessagesBefore(input, 3), 1);
  assert.equal(countRoleMessagesBefore(input, 6), 4);
});

test("trim keeps a leading system summary card + last turns (compaction retention)", () => {
  const input = [
    { role: "system", text: "compacted", meta: { type: "compaction" } },
    { role: "user", text: "q1" },
    { role: "assistant", text: "a1" },
    { role: "user", text: "q2" },
    { role: "assistant", text: "a2" },
  ];
  // 卡片不是 user 轮次：trim 只按 user 计数，卡片本身被头部裁剪丢掉的场景
  // 由 trimRuntimeCache 的 leadingSummaryCards 重新 prepend（AgentManager 测试覆盖）。
  // 此处验证 turnTrimStartIndex 不会把卡片当作轮次起点。
  const start = turnTrimStartIndex(input, 1);
  assert.equal(input[start].text, "q2");
});

test("contextTrimStartIndex keeps the whole context below the 50-turn budget (2026-12)", () => {
  // 压缩后的保留段常以 assistant/toolResult 开头（首个 user 之前是模型续上下文）：
  // 不足 50 轮时不得按「首个 user」裁头，否则第一轮以外的保留消息全被丢掉。
  const input = [
    { role: "compactionSummary", summary: "compacted" },
    { role: "assistant", text: "carried-over reasoning" },
    { role: "toolResult", text: "carried-over tool output" },
    { role: "user", text: "q1" },
    { role: "assistant", text: "a1" },
  ];
  assert.equal(contextTrimStartIndex(input), 0);
  assert.equal(trimHistoryMessages(input).length, input.length);
  assert.equal(trimHistoryMessages(input)[0].role, "compactionSummary");
});

test("contextTrimStartIndex trims from the 51st user turn once the budget is exceeded (2026-12)", () => {
  const input = [
    { role: "assistant", text: "carried-over" },
    ...Array.from({ length: 51 }, (_, index) => [
      { role: "user", text: `q${index + 1}` },
      { role: "assistant", text: `a${index + 1}` },
    ]).flat(),
  ];
  const start = contextTrimStartIndex(input);
  // 51 个 user：裁到第 51 个 user（最近的 50 轮），首个 user 之前的保留段一并裁掉
  assert.equal(input[start].text, "q2");
  assert.equal(trimHistoryMessages(input)[0].text, "q2");
});

test("contextTrimStartIndex keeps the trailing 50 entries when no user turn exists (2026-12)", () => {
  const input = Array.from({ length: 80 }, (_, index) => ({ role: "assistant", text: `a${index}` }));
  assert.equal(contextTrimStartIndex(input), 30);
  assert.equal(trimHistoryMessages(input).length, 50);
});
