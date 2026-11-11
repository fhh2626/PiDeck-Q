import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

// entryId 对齐用真实实现：桩成旧算法会让「合成行不占槽位」的回归用例失去意义。
const realSessionEntryIds = loadTsCommonJs("src/main/pi/sessionEntryIds.ts");

const { AgentMessageProjector } = loadTsCommonJs("src/main/pi/AgentMessageProjector.ts", {
  stubs: {
    "./messageContent": {
      extractMessageText: (content) => Array.isArray(content)
        ? content
          .filter((item) => item?.type === "text")
          .map((item) => item.text ?? "")
          .join("\n")
        : typeof content === "string" ? content : "",
    },
    "./sessionEntryIds": {
      takeActiveEntryId: realSessionEntryIds.takeActiveEntryId,
      buildActiveBranchEntryIds: realSessionEntryIds.buildActiveBranchEntryIds,
    },
  },
});

function translate(key, params = {}) {
  if (key === "session.imagePlaceholder") return "[image]";
  if (key === "mainTool.truncated") return `[truncated ${params.omitted}/${params.total}]`;
  if (key === "mainTool.unknown") return "No result recorded";
  if (key === "mainTool.status") return `Status: ${params.status}`;
  return key;
}

function createProjector() {
  return new AgentMessageProjector({ translate, isAskAborted: () => false });
}

function toolCall(id, name, args = {}) {
  return { type: "toolCall", id, name, arguments: args };
}

/** 结果缺失的工具行必须同时满足：中性状态、无 entryId、无成败、无耗时。 */
function assertUnknownToolRow(message, { toolCallId, toolName }) {
  assert.equal(message.role, "tool");
  assert.equal(message.meta.status, "unknown");
  assert.equal(message.meta.toolCallId, toolCallId);
  assert.equal(message.meta.toolName, toolName);
  assert.equal(message.meta.entryId, undefined, "synthetic rows must not claim the assistant entry identity");
  assert.equal(message.meta.isError, undefined);
  assert.equal(message.meta.result, undefined);
  assert.equal(message.meta.durationMs, undefined);
  assert.equal(message.meta.startedAt, undefined);
  assert.equal(message.meta._askCard, undefined);
  assert.doesNotMatch(message.text, /[✓✗]/u, "an unknown outcome must not claim success or failure");
  assert.match(message.meta.detailText, /No result recorded/);
}

test("an assistant tool call without a result keeps a neutral unknown tool row", () => {
  const messages = createProjector().convert("agent", [
    { role: "user", content: [{ type: "text", text: "delegate" }], timestamp: 1 },
    {
      role: "assistant",
      timestamp: 2,
      content: [toolCall("sub-1", "subagent", { task: "inspect" })],
    },
  ], ["entry-user", "entry-assistant"]);

  assert.deepEqual(messages.map((message) => message.role), ["user", "tool"]);
  assertUnknownToolRow(messages[1], { toolCallId: "sub-1", toolName: "subagent" });
  assert.equal(messages[1].id, "agent-toolcall-sub-1");
  assert.equal(messages[1].meta.sourceEntryId, "entry-assistant");
  assert.match(messages[1].meta.args, /inspect/);
});

test("every tool name keeps its call record when the result is missing", () => {
  for (const toolName of ["bash", "read", "write", "web_search", "mcp__fixture__inspect", "ask_question"]) {
    const messages = createProjector().convert("agent", [
      { role: "assistant", timestamp: 2, content: [toolCall(`call-${toolName}`, toolName, { task: "x" })] },
    ]);
    assert.equal(messages.length, 1, `${toolName} must keep its call record`);
    assertUnknownToolRow(messages[0], { toolCallId: `call-${toolName}`, toolName });
  }
});

test("parallel calls keep declaration order and thinking stays on the assistant row", () => {
  const messages = createProjector().convert("agent", [
    { role: "user", content: [{ type: "text", text: "go" }], timestamp: 1 },
    {
      role: "assistant",
      timestamp: 2,
      content: [
        { type: "thinking", thinking: "plan two calls" },
        toolCall("call-a", "read", { path: "a.ts" }),
        toolCall("call-b", "subagent", { task: "b" }),
      ],
    },
    { role: "user", content: [{ type: "text", text: "next" }], timestamp: 3 },
  ], ["entry-user", "entry-assistant", "entry-next"]);

  assert.deepEqual(messages.map((message) => message.role), ["user", "assistant", "tool", "tool", "user"]);
  assert.equal(messages[1].thinking, "plan two calls");
  assert.equal(messages[1].meta.entryId, "entry-assistant");
  assert.deepEqual(messages.slice(2, 4).map((message) => message.meta.toolCallId), ["call-a", "call-b"]);
  // 合成行不消费 entryId 槽位：后面的 user 仍绑定 entry-next，而不是被整体前移。
  assert.deepEqual(messages.map((message) => message.meta.entryId), [
    "entry-user", "entry-assistant", undefined, undefined, "entry-next",
  ]);
});

test("a result later in the same batch suppresses the synthetic row", () => {
  const messages = createProjector().convert("agent", [
    {
      role: "assistant",
      timestamp: 2,
      content: [toolCall("call-1", "bash", { command: "ls" })],
    },
    {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "bash",
      content: [{ type: "text", text: "a.ts" }],
      timestamp: 3,
    },
  ], ["entry-assistant", "entry-result"]);

  assert.equal(messages.length, 1);
  assert.equal(messages[0].meta.status, "done");
  assert.equal(messages[0].meta.entryId, "entry-result");
  assert.match(messages[0].text, /^✓/u);
});

test("a result outside the projected slice suppresses the synthetic row", () => {
  const messages = createProjector().convert("agent", [
    {
      role: "assistant",
      timestamp: 2,
      content: [toolCall("call-old", "bash", { command: "ls" })],
    },
  ], ["entry-assistant"], new Set(["call-old"]));

  // 结果在别的分页片里：调用不是孤儿，不能凭空多一张「未记录结果」卡片。
  assert.deepEqual(messages, []);
});

test("small pages probe the cached result set instead of scanning all historical results", () => {
  const known = new Set(["call-known"]);
  known[Symbol.iterator] = () => { throw new Error("full branch iteration is unnecessary for one page"); };
  const messages = createProjector().convert("agent", [
    { role: "assistant", content: [toolCall("call-known", "subagent")] },
  ], ["entry-call"], known);
  assert.deepEqual(messages, []);
});

test("a result on another branch does not mask an active-branch orphan", () => {
  const messages = createProjector().convert("agent", [
    {
      role: "assistant",
      timestamp: 2,
      content: [toolCall("call-live", "bash", { command: "ls" })],
    },
  ], ["entry-assistant"], new Set(["call-other-branch"]));

  assert.equal(messages.length, 1);
  assertUnknownToolRow(messages[0], { toolCallId: "call-live", toolName: "bash" });
});

test("completed calls still emit exactly one result row next to an orphan", () => {
  const messages = createProjector().convert("agent", [
    {
      role: "assistant",
      timestamp: 2,
      content: [toolCall("call-done", "read", { path: "a.ts" }), toolCall("call-lost", "read", { path: "b.ts" })],
    },
    {
      role: "toolResult",
      toolCallId: "call-done",
      toolName: "read",
      content: [{ type: "text", text: "file" }],
      timestamp: 3,
    },
  ], ["entry-assistant", "entry-result"]);

  // 合成行紧跟声明它的 assistant（保持 toolCall 声明顺序），真实结果行仍在
  // 它原本的 JSONL 位置：两条都在，且都只出现一次。
  assert.deepEqual(messages.map((message) => message.meta.toolCallId), ["call-lost", "call-done"]);
  assertUnknownToolRow(messages[0], { toolCallId: "call-lost", toolName: "read" });
  assert.equal(messages[1].meta.status, "done");
  assert.equal(messages[1].meta.entryId, "entry-result");
});

test("duplicate declarations of one tool call produce a single synthetic row", () => {
  const messages = createProjector().convert("agent", [
    { role: "assistant", timestamp: 2, content: [toolCall("call-dup", "bash", { command: "ls" })] },
    { role: "assistant", timestamp: 3, content: [toolCall("call-dup", "bash", { command: "ls" })] },
  ]);

  assert.equal(messages.length, 1);
  assert.equal(messages[0].meta.toolCallId, "call-dup");
});
