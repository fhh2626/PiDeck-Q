import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { trimHistoryMessages, turnTrimStartIndex, countRoleMessagesBefore } = loadTsCommonJs(
  "src/main/pi/agentUtils.ts",
);

const message = (role) => ({ role });

test("trimHistoryMessages default caps runtime cache at 20 turns (2026-12)", () => {
  // 21 轮输入 → 保留最近 20 轮（user 消息为轮起点）
  const input = [];
  for (let turn = 0; turn < 21; turn += 1) {
    input.push(message("user"), message("assistant"), message("tool"));
  }
  const trimmed = trimHistoryMessages(input);
  assert.equal(trimmed.length, 20 * 3);
  assert.equal(trimmed[0].role, "user");
});

test("trimHistoryMessages default keeps a turn with multiple tool results intact (2026-12)", () => {
  // 第 21 轮含多条 toolResult：整轮必须完整保留，不能从工具调用中间截断
  const input = [];
  for (let turn = 1; turn <= 21; turn += 1) {
    input.push(message("user"), message("assistant"), message("toolResult"), message("toolResult"));
  }
  const trimmed = trimHistoryMessages(input);
  assert.equal(trimmed.length, 20 * 4);
  assert.equal(trimmed[0].role, "user");
  assert.equal(trimmed[trimmed.length - 1].role, "toolResult");
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
  // 23 轮 user/assistant → 默认 trim 到 20 轮：首条保留消息是 q4（0-based 下标 6）
  const input = [];
  for (let turn = 0; turn < 23; turn += 1) {
    input.push({ role: "user", text: `q${turn + 1}` });
    input.push({ role: "assistant", text: `a${turn + 1}` });
  }
  const start = turnTrimStartIndex(input);
  assert.equal(start, 6);
  assert.equal(input[start].text, "q4");
  // 被裁掉 6 个角色消息 → activeEntryIds 应从下标 6 起切，保留消息拿到 u4..a23
  const dropped = countRoleMessagesBefore(input, start);
  assert.equal(dropped, 6);
  const entryIds = Array.from({ length: 46 }, (_, i) => `e${i}`);
  assert.equal(entryIds.slice(dropped)[0], "e6");
  assert.equal(entryIds.slice(dropped).length, 40);
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
