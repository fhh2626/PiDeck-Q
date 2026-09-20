import assert from "node:assert/strict";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { SessionHistoryReader } = loadTsCommonJs(
  "src/main/pi/SessionHistoryReader.ts",
);

function textFromContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((item) => item?.type === "text")
    .map((item) => item.text ?? "")
    .join("");
}

function createReader(toHostPath) {
  return new SessionHistoryReader({
    toHostPath,
    convertMessages: (_agentId, rawMessages, entryIds = []) => rawMessages.map((message, index) => ({
      id: entryIds[index] ?? `message-${index}`,
      role: message.role,
      text: textFromContent(message.content),
    })),
    trimMessages: (messages) => messages,
    translate: () => "Summary unavailable.",
  });
}

test("SessionHistoryReader resolves the host path before loading a persisted Session", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pideck-history-reader-"));
  const hostPath = join(directory, "session.jsonl");
  const requestedPaths = [];
  try {
    await writeFile(hostPath, [
      JSON.stringify({ id: "session", type: "session" }),
      JSON.stringify({
        id: "message-1",
        parentId: "session",
        type: "message",
        message: { role: "user", content: [{ type: "text", text: "mapped host path" }] },
      }),
    ].join("\n"), "utf8");
    const reader = createReader((sessionPath) => {
      requestedPaths.push(sessionPath);
      return hostPath;
    });

    const messages = await reader.readSessionDisplayMessages("/root/.pi/session.jsonl");
    assert.deepEqual(requestedPaths, ["/root/.pi/session.jsonl"]);
    assert.equal(messages[0].text, "mapped host path");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("SessionHistoryReader pages only the active branch and tolerates malformed JSONL", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pideck-history-branch-"));
  const sessionPath = join(directory, "session.jsonl");
  try {
    await writeFile(sessionPath, [
      JSON.stringify({ id: "session", type: "session" }),
      JSON.stringify({
        id: "active-1",
        parentId: "session",
        type: "message",
        message: { role: "user", content: [{ type: "text", text: "active one" }] },
      }),
      "{ not valid json",
      JSON.stringify({
        id: "detached",
        parentId: "session",
        type: "message",
        message: { role: "assistant", content: [{ type: "text", text: "detached" }] },
      }),
      JSON.stringify({
        id: "active-2",
        parentId: "active-1",
        type: "message",
        message: { role: "assistant", content: [{ type: "text", text: "active two" }] },
      }),
    ].join("\n"), "utf8");
    const reader = createReader((path) => path);

    const page = await reader.readSessionDisplayMessagePage(sessionPath, "viewer", undefined, 100);
    assert.equal(page.total, 2);
    assert.deepEqual(Array.from(page.messages, (message) => message.text), ["active one", "active two"]);
    assert.equal(page.nextBefore, null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("SessionHistoryReader incremental index picks up appended JSONL rows without full rebuild", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pideck-history-append-"));
  const sessionPath = join(directory, "session.jsonl");
  try {
    const line = (id, parentId, role, text) => JSON.stringify({
      id,
      parentId,
      type: "message",
      message: { role, content: [{ type: "text", text }] },
    });
    await writeFile(sessionPath, [
      JSON.stringify({ id: "session", type: "session" }),
      line("e1", "session", "user", "first question"),
      line("e2", "e1", "assistant", "first answer"),
    ].join("\n") + "\n", "utf8");
    const reader = createReader((path) => path);

    // 第一页（2 轮）
    const first = await reader.readSessionDisplayTurnPage(sessionPath, "viewer", undefined, 3);
    assert.equal(first.total, 2);
    assert.equal(first.nextBefore, null);

    // 模拟 pi 运行中追加：新行 append 到文件尾部（行尾带 \n）
    // 注意：Windows 上 writeFile({flag:"a"}) 会覆盖而非追加，模拟 pi 追加必须用 appendFile
    await appendFile(sessionPath, [
      line("e3", "e2", "user", "second question"),
      line("e4", "e3", "assistant", "second answer"),
      line("e5", "e4", "user", "third question"),
      line("e6", "e5", "assistant", "third answer"),
    ].join("\n") + "\n", "utf8");

    // 增量索引：能从新文件状态分页出 6 条消息（全部可读，含 append 部分）
    const after = await reader.readSessionDisplayTurnPage(sessionPath, "viewer", undefined, 3);
    assert.equal(after.total, 6);
    const texts = after.messages.map((m) => m.text);
    // 跨 vm realm 的对象比较会误报，用 join 断言顺序与内容
    assert.equal(
      texts.join("|"),
      "first question|first answer|second question|second answer|third question|third answer",
    );

    // 旧分支节点仍然可被游标解析（增量链挂载正确）
    const e2Pos = await reader.resolveEntryPosition(sessionPath, "e2");
    assert.equal(e2Pos, 1);
    const e2Id = await reader.resolveEntryIdAtPosition(sessionPath, 1);
    assert.equal(e2Id, "e2");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("SessionHistoryReader locates message by messageId and reads its content for resend", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pideck-history-locate-"));
  const sessionPath = join(directory, "session.jsonl");
  try {
    await writeFile(sessionPath, [
      JSON.stringify({ id: "session", type: "session" }),
      JSON.stringify({
        id: "entry-1",
        parentId: "session",
        type: "message",
        message: { id: "msg-1", role: "user", content: "plain text user message" },
      }),
      JSON.stringify({
        id: "entry-2",
        parentId: "entry-1",
        type: "message",
        message: {
          id: "msg-2",
          role: "user",
          content: [
            { type: "text", text: "with image" },
            { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
          ],
        },
      }),
      JSON.stringify({
        id: "entry-3",
        parentId: "entry-2",
        type: "message",
        message: {
          id: "msg-3",
          role: "user",
          content: [
            { type: "text", text: "with flat pi image" },
            { type: "image", data: "BBBB", mimeType: "image/jpeg" },
          ],
        },
      }),
    ].join("\n"), "utf8");
    const reader = createReader((path) => path);

    const located = await reader.readMessageByMessageId(sessionPath, "msg-1");
    assert.equal(located.entryId, "entry-1");
    assert.equal(located.role, "user");
    assert.equal(located.text, "plain text user message");

    const withImage = await reader.readMessageByMessageId(sessionPath, "msg-2");
    assert.equal(withImage.entryId, "entry-2");
    assert.equal(withImage.text, "with image");
    assert.equal(withImage.images.length, 1);
    assert.equal(withImage.images[0].mimeType, "image/png");
    assert.equal(withImage.images[0].data, "AAAA");

    const withFlatImage = await reader.readMessageByMessageId(sessionPath, "msg-3");
    assert.equal(withFlatImage.entryId, "entry-3");
    assert.equal(withFlatImage.text, "with flat pi image");
    assert.equal(withFlatImage.images.length, 1);
    assert.equal(withFlatImage.images[0].mimeType, "image/jpeg");
    assert.equal(withFlatImage.images[0].data, "BBBB");

    const missing = await reader.readMessageByMessageId(sessionPath, "nope");
    assert.equal(missing, undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("SessionHistoryReader resolves synthetic rendered history ids for cache-miss file lookup", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pideck-history-locate-"));
  const sessionPath = join(directory, "session.jsonl");
  try {
    await writeFile(sessionPath, [
      JSON.stringify({ id: "session", type: "session" }),
      JSON.stringify({
        id: "entry-1",
        parentId: "session",
        type: "message",
        message: { id: "msg-1", role: "user", content: "plain text user message" },
      }),
      // 旧会话消息可能没有 message.id：渲染层合成 ID 仍应能定位
      JSON.stringify({
        id: "entry-2",
        parentId: "entry-1",
        type: "message",
        message: { role: "assistant", content: "no native id" },
      }),
    ].join("\n"), "utf8");
    const reader = createReader((path) => path);

    // 原生 message.id 仍可命中（回归）
    const byNative = await reader.readMessageByMessageId(sessionPath, "msg-1");
    assert.equal(byNative.entryId, "entry-1");
    // 渲染层合成 ID（agentId-history-entryId）→ 定位到真实条目
    const bySynthetic = await reader.readMessageByMessageId(sessionPath, "agent-1-history-entry-1");
    assert.equal(bySynthetic.entryId, "entry-1");
    assert.equal(bySynthetic.text, "plain text user message");
    // 无 message.id 的条目也能经合成 ID 命中
    const noNativeId = await reader.readMessageByMessageId(sessionPath, "agent-1-history-entry-2");
    assert.equal(noNativeId.entryId, "entry-2");
    assert.equal(noNativeId.text, "no native id");
    // 裸 entryId 也接受
    const byRaw = await reader.readMessageByMessageId(sessionPath, "entry-2");
    assert.equal(byRaw.entryId, "entry-2");
    // 完全无关的 ID → undefined
    assert.equal(await reader.readMessageByMessageId(sessionPath, "nope"), undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("SessionHistoryReader full-rebuilds instead of appending after a growing atomic rewrite", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pideck-history-rewrite-"));
  const sessionPath = join(directory, "session.jsonl");
  const line = (id, parentId, role, text) => JSON.stringify({
    id,
    parentId,
    type: "message",
    message: { role, content: [{ type: "text", text }] },
  });
  try {
    await writeFile(sessionPath, [
      JSON.stringify({ id: "session", type: "session" }),
      line("e1", "session", "user", "first question"),
      line("e2", "e1", "assistant", "first answer"),
    ].join("\n") + "\n", "utf8");
    const reader = createReader((path) => path);
    const first = await reader.readSessionDisplayTurnPage(sessionPath, "viewer", undefined, 3);
    assert.equal(first.total, 2);

    // 模拟 SessionFileEditor.atomicReplace：temp + rename 整文件重写，且首条文本变长（文件变大）
    const rewritten = [
      JSON.stringify({ id: "session", type: "session" }),
      line("e1", "session", "user", "first question edited and made much longer than before"),
      line("e2", "e1", "assistant", "first answer"),
      line("e3", "e2", "user", "second question"),
      line("e4", "e3", "assistant", "second answer"),
    ].join("\n") + "\n";
    const tempPath = join(directory, ".session.jsonl.tmp");
    await writeFile(tempPath, rewritten, "utf8");
    await rm(sessionPath, { force: true });
    const { rename } = await import("node:fs/promises");
    await rename(tempPath, sessionPath);

    // 增长型整文件重写必须触发全量重建：读出新内容且不抛解析错误
    const after = await reader.readSessionDisplayTurnPage(sessionPath, "viewer", undefined, 3);
    assert.equal(after.total, 4);
    assert.equal(
      after.messages.map((m) => m.text).join("|"),
      "first question edited and made much longer than before|first answer|second question|second answer",
    );
    assert.equal(await reader.resolveEntryPosition(sessionPath, "e4"), 3);

    // 真实 append 仍然走增量路径（[0, oldSize) 字节不变 → 探针校验通过）
    await appendFile(sessionPath, [
      line("e5", "e4", "user", "third question"),
      line("e6", "e5", "assistant", "third answer"),
    ].join("\n") + "\n", "utf8");
    const appended = await reader.readSessionDisplayTurnPage(sessionPath, "viewer", undefined, 3);
    assert.equal(appended.total, 6);
    assert.equal(appended.messages[appended.messages.length - 1].text, "third answer");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("compaction page paging stays in index space when conversion skips messages", async () => {
  // 回归（打开大会话起始页误显根因）：hasCompaction 分页曾用 readSessionDisplayMessages
  // 的全量数组按索引坐标 slice——转换跳过空消息（thinking-only/空 user）后数组比索引短，
  // slice 越界返回空页。修复后与 normal 分支同空间：索引切片 → 转换 → 页内补卡片。
  const directory = await mkdtemp(join(tmpdir(), "pideck-history-compact-page-"));
  const sessionPath = join(directory, "session.jsonl");
  const entry = (id, parentId, extra) => JSON.stringify({ id, parentId, type: "message", message: extra });
  try {
    const rows = [JSON.stringify({ id: "session", type: "session" })];
    let parent = "session";
    for (let i = 1; i <= 100; i++) {
      const id = `e${i}`;
      rows.push(entry(id, parent, {
        role: i % 2 ? "user" : "assistant",
        content: [{ type: "text", text: `m${i}` }],
      }));
      parent = id;
    }
    // compaction 条目：压缩点在 e101（firstKeptEntryId）；真实 pi 结构中
    // compaction 后的新消息 parentId 指向 compaction 条目本身（链在中间不断开）
    rows.push(JSON.stringify({
      id: "comp-1", parentId: "e100", type: "compaction",
      summary: "compacted summary", firstKeptEntryId: "e101", timestamp: "2026-08-01T00:00:00Z", tokensBefore: 8000,
    }));
    parent = "comp-1";
    for (let i = 101; i <= 150; i++) {
      const id = `e${i}`;
      const empty = i % 5 === 0; // 10 条空 content → 转换跳过
      rows.push(entry(id, parent, {
        role: i % 2 ? "user" : "assistant",
        content: empty ? [] : [{ type: "text", text: `m${i}` }],
      }));
      parent = id;
    }
    await writeFile(sessionPath, rows.join("\n") + "\n", "utf8");

    const reader = new SessionHistoryReader({
      toHostPath: (path) => path,
      // 与 AgentMessageProjector 一致：空 content 的消息被跳过
      convertMessages: (_agentId, rawMessages, entryIds = []) => rawMessages
        .filter((m) => {
          const c = m.content;
          const hasText = Array.isArray(c) ? c.some((b) => b?.type === "text" && b.text) : typeof c === "string" && c.trim();
          return hasText;
        })
        .map((m, i) => ({ id: entryIds[i] ?? `m${i}`, role: m.role, text: "x", meta: {} })),
      trimMessages: (msgs) => msgs,
      translate: () => "",
    });

    const page = await reader.readSessionDisplayMessagePage(sessionPath, "viewer", undefined, 100);
    assert.ok(page.messages.length > 0, "page must not be empty when conversion skips messages");
    assert.equal(page.total, 150);
    // 页内应含压缩卡片（插入点在 e101，位于本页）
    const card = page.messages.find((m) => m.meta?.type === "compaction");
    assert.ok(card, "compaction card must be inserted inside the page");
    assert.equal(card.role, "system");
    // 游标续页不重不漏：nextBefore 指向本页最旧条目
    assert.equal(page.nextBefore, 50);
    const p2 = await reader.readSessionDisplayMessagePage(sessionPath, "viewer", page.nextBefore, 100);
    assert.ok(p2.messages.length > 0);
    assert.equal(p2.nextBefore, null); // 剩余 50 条一页取完，到顶
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
