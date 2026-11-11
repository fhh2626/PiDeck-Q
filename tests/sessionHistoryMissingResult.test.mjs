/**
 * 分页 + 活动分支语义下的「结果未记录」判定。
 *
 * 关键回归：投影只看一页消息，但 toolResult 可能在别的页、或只在废弃分支上。
 * 只有「整条活动分支都没有该 toolCallId 的结果」才算孤儿，否则老页会凭空多出
 * 一张「未记录结果」卡片（假孤儿），或者当前分支的真实孤儿被废弃分支的结果洗白。
 */
import assert from "node:assert/strict";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

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
const { SessionHistoryReader } = loadTsCommonJs("src/main/pi/SessionHistoryReader.ts");

function translate(key) {
  return key === "session.summaryPlaceholder" ? "Summary unavailable." : key;
}

const projector = new AgentMessageProjector({ translate, isAskAborted: () => false });

function createReader() {
  return new SessionHistoryReader({
    toHostPath: (sessionPath) => sessionPath,
    // 走真实投影器：分页语义（knownToolResultIds）必须端到端可验证。
    convertMessages: (agentId, rawMessages, activeEntryIds, knownToolResultIds) =>
      projector.convert(agentId, rawMessages, activeEntryIds, knownToolResultIds),
    trimMessages: (messages) => messages,
    translate,
  });
}

function entry(id, parentId, message, extra = {}) {
  return JSON.stringify({ id, parentId, type: "message", message, ...extra });
}

function toolResult(toolCallId, toolName, text) {
  return {
    role: "toolResult",
    toolCallId,
    toolName,
    content: [{ type: "text", text }],
    timestamp: 9,
  };
}

/** VM 沙箱里产出的数组原型不同，统一用 Array.from 拷回宿主 realm 再比较。 */
function rows(messages) {
  return Array.from(messages, (message) => message.meta?.toolCallId ?? message.role);
}

function unknownRows(messages) {
  return Array.from(messages)
    .filter((message) => message.role === "tool" && message.meta?.status === "unknown")
    .map((message) => message.meta.toolCallId);
}

test("a result in a newer slice keeps the older slice free of fake orphans", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pideck-missing-result-page-"));
  const sessionPath = join(directory, "session.jsonl");
  try {
    await writeFile(sessionPath, [
      JSON.stringify({ id: "session", type: "session" }),
      entry("u1", "session", { role: "user", content: [{ type: "text", text: "first" }] }),
      entry("a1", "u1", {
        role: "assistant",
        timestamp: 2,
        content: [
          { type: "text", text: "running it" },
          { type: "toolCall", id: "call-x", name: "bash", arguments: { command: "ls" } },
        ],
      }),
      entry("u2", "a1", { role: "user", content: [{ type: "text", text: "second" }] }),
      // 结果落在新的一页里：老页（u1/a1）不能因此多出一张「未记录结果」卡片。
      entry("r-x", "u2", toolResult("call-x", "bash", "a.ts")),
      entry("a2", "r-x", {
        role: "assistant",
        timestamp: 5,
        content: [{ type: "toolCall", id: "call-y", name: "subagent", arguments: { task: "y" } }],
      }),
    ].join("\n"), "utf8");
    const reader = createReader();

    const newest = await reader.readSessionDisplayTurnPage(sessionPath, "viewer", undefined, 1);
    assert.deepEqual(rows(newest.messages), ["user", "call-x", "call-y"]);
    assert.deepEqual(unknownRows(newest.messages), ["call-y"]);
    // 原始索引口径不变：合成行不占 raw entry 槽位，也不改游标。
    assert.equal(newest.total, 5);
    assert.equal(newest.nextBefore, 2);

    const older = await reader.readSessionDisplayTurnPage(sessionPath, "viewer", newest.nextBefore, 1);
    assert.deepEqual(Array.from(older.messages, (message) => message.meta?.entryId), ["u1", "a1"]);
    assert.deepEqual(unknownRows(older.messages), [], "a result in another slice must not create a fake orphan");
    assert.equal(older.total, 5);
    assert.equal(older.nextBefore, null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a result on an abandoned branch does not mask an active-branch orphan", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pideck-missing-result-branch-"));
  const sessionPath = join(directory, "session.jsonl");
  try {
    await writeFile(sessionPath, [
      JSON.stringify({ id: "session", type: "session" }),
      entry("u1", "session", { role: "user", content: [{ type: "text", text: "go" }] }),
      entry("a1", "u1", {
        role: "assistant",
        timestamp: 2,
        content: [
          { type: "toolCall", id: "call-live", name: "bash", arguments: { command: "ls" } },
          { type: "toolCall", id: "call-abandoned", name: "read", arguments: { path: "x.ts" } },
        ],
      }),
      entry("r-live", "a1", toolResult("call-live", "bash", "a.ts")),
      // 废弃分支：它的 toolResult 不属于活动分支，不能用来判「结果已存在」。
      entry("r-abandoned", "a1", toolResult("call-abandoned", "read", "x.ts")),
      entry("a2", "r-live", {
        role: "assistant",
        timestamp: 6,
        content: [{ type: "text", text: "done" }],
      }),
    ].join("\n"), "utf8");
    const reader = createReader();

    const page = await reader.readSessionDisplayMessagePage(sessionPath, "viewer", undefined, 100);
    assert.deepEqual(rows(page.messages), ["user", "call-abandoned", "call-live", "assistant"]);
    assert.deepEqual(unknownRows(page.messages), ["call-abandoned"]);
    // 活动分支有 4 条消息（u1/a1/r-live/a2）；废弃分支的 r-abandoned 不计入。
    assert.equal(page.total, 4);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an appended result replaces an orphan after the cached index advances", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pideck-missing-result-append-"));
  const sessionPath = join(directory, "session.jsonl");
  try {
    await writeFile(sessionPath, entry("a", null, {
      role: "assistant", content: [{ type: "toolCall", id: "call", name: "subagent", arguments: {} }],
    }) + "\n", "utf8");
    const reader = createReader();
    const before = await reader.readSessionDisplayMessagePage(sessionPath, "viewer", undefined, 100);
    assert.deepEqual(unknownRows(before.messages), ["call"]);
    await appendFile(sessionPath, entry("r", "a", toolResult("call", "subagent", "actual result")) + "\n", "utf8");
    const after = await reader.readSessionDisplayMessagePage(sessionPath, "viewer", undefined, 100);
    assert.deepEqual(unknownRows(after.messages), []);
    assert.equal(after.messages.length, 1);
    assert.equal(after.messages[0].meta.status, "done");
    assert.equal(after.messages[0].meta.entryId, "r");
    assert.equal(after.total, 2);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("a custom entry containing result-shaped data is not an actual tool result", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pideck-missing-result-custom-"));
  const sessionPath = join(directory, "session.jsonl");
  try {
    await writeFile(sessionPath, [
      entry("a", null, { role: "assistant", content: [{ type: "toolCall", id: "call", name: "subagent", arguments: {} }] }),
      entry("custom", "a", toolResult("call", "subagent", "not a message"), { type: "custom" }),
    ].join("\n"), "utf8");
    const page = await createReader().readSessionDisplayMessagePage(sessionPath, "viewer", undefined, 100);
    assert.deepEqual(unknownRows(page.messages), ["call"]);
    assert.equal(page.total, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("compacted pages keep the same missing-result verdict as the active branch", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pideck-missing-result-compaction-"));
  const sessionPath = join(directory, "session.jsonl");
  try {
    await writeFile(sessionPath, [
      JSON.stringify({ id: "session", type: "session" }),
      entry("u1", "session", { role: "user", content: [{ type: "text", text: "archived" }] }),
      entry("a1", "u1", {
        role: "assistant",
        timestamp: 2,
        content: [{ type: "toolCall", id: "call-archived", name: "bash", arguments: { command: "ls" } }],
      }),
      entry("r-archived", "a1", toolResult("call-archived", "bash", "a.ts")),
      JSON.stringify({
        id: "c1",
        parentId: "r-archived",
        type: "compaction",
        summary: "compacted",
        timestamp: "2026-01-01T00:00:00.000Z",
        firstKeptEntryId: "u2",
      }),
      entry("u2", "c1", { role: "user", content: [{ type: "text", text: "kept" }] }),
      entry("a2", "u2", {
        role: "assistant",
        timestamp: 7,
        content: [{ type: "toolCall", id: "call-kept", name: "subagent", arguments: { task: "k" } }],
      }),
    ].join("\n"), "utf8");
    const reader = createReader();

    const page = await reader.readSessionDisplayTurnPage(sessionPath, "viewer", undefined, 1);
    assert.deepEqual(unknownRows(page.messages), ["call-kept"]);
    assert.equal(page.total, 5);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
