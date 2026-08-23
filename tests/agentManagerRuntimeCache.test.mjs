import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { AgentManager } = loadTsCommonJs("src/main/pi/AgentManager.ts");

const entryLine = (id, parentId, role, text) => JSON.stringify({
  id, parentId, type: "message",
  message: { id: `m-${id}`, role, content: [{ type: "text", text }] },
});

function deferred() {
  let resolve;
  const promise = new Promise((nextResolve) => { resolve = nextResolve; });
  return { promise, resolve };
}

/** 6 轮 × 每条 user/assistant，尾部 3 轮（e7..e12）在运行时缓存中。 */
async function createHarness() {
  const directory = await mkdtemp(join(tmpdir(), "pideck-runtime-cache-"));
  const sessionPath = join(directory, "session.jsonl");
  const ids = ["e1", "e2", "e3", "e4", "e5", "e6", "e7", "e8", "e9", "e10", "e11", "e12"];
  const lines = [];
  let parent = null;
  for (const id of ids) {
    lines.push(entryLine(id, parent, id.endsWith("e1") || id.endsWith("e3") || id.endsWith("e5") || id.endsWith("e7") || id.endsWith("e9") || id.endsWith("e11") ? "user" : "assistant", `${id} text`));
    parent = id;
  }
  await writeFile(sessionPath, lines.join("\n") + "\n", "utf8");

  const runtime = {
    tab: {
      id: "agent-1",
      projectId: "project-1",
      cwd: "C:/project",
      title: "Session",
      status: "idle",
      sessionPath,
      sessionEnvironment: "native",
      sessionSource: "pi",
      createdAt: 1,
    },
    process: { client: { request: async () => ({ success: true, data: {} }) } },
  };
  const manager = new AgentManager(
    () => ({ id: "project-1", name: "Project", path: "C:/project" }),
    () => null,
    { get: () => ({}) },
    {},
  );
  manager.agents.set("agent-1", runtime);
  // 运行时缓存 = 尾部 5 轮（e4..e12 = 9 条），模拟运行中 12 轮窗口的一部分；
  // 文件里完整 6 轮（e1..e12），缓存只覆盖尾部——翻历史时 e7 之前的 e4..e6 可从缓存命中
  manager.messages.set("agent-1", ["e4", "e5", "e6", "e7", "e8", "e9", "e10", "e11", "e12"].map((id) => ({
    id: `m-${id}`,
    agentId: "agent-1",
    role: id.endsWith("4") || id.endsWith("6") || id.endsWith("8") || id.endsWith("10") || id.endsWith("12") ? "user" : "assistant",
    text: `${id} text`,
    timestamp: 1,
    meta: { entryId: id },
  })));
  return { manager, sessionPath, directory };
}

test("tryReadRuntimeTurnPage serves cache-resident turns without reading the file", async () => {
  const { manager, sessionPath, directory } = await createHarness();
  try {
    // 请求 e7（运行时窗口首条）之前的 3 轮 → 命中缓存：返回 e4..e6（文件里存在但缓存没有的部分）
    const page = await manager.tryReadRuntimeTurnPage(sessionPath, "agent-1", {
      beforeEntryId: "e7",
      turnCount: 3,
    });
    assert.ok(page, "cache hit expected");
    assert.equal(page.messages.length, 3);
    assert.equal(page.messages[0].meta.entryId, "e4");
    assert.equal(page.messages[2].meta.entryId, "e6");
    // 游标换算回文件下标空间：e4 在文件里的位置 = 3
    assert.equal(page.nextBefore, 3);
    assert.equal(page.nextBeforeEntryId, "e4");
    assert.equal(page.total, 12);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("tryReadRuntimeTurnPage misses when anchor is outside the runtime cache", async () => {
  const { manager, sessionPath, directory } = await createHarness();
  try {
    // e2 不在缓存中 → 未命中，调用方回退读文件
    const miss = await manager.tryReadRuntimeTurnPage(sessionPath, "agent-1", {
      beforeEntryId: "e2",
      turnCount: 3,
    });
    assert.equal(miss, null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("tryReadRuntimeTurnPage misses for inactive agents (history viewer path)", async () => {
  const { manager, sessionPath, directory } = await createHarness();
  try {
    manager.agents.delete("agent-1");
    const miss = await manager.tryReadRuntimeTurnPage(sessionPath, "agent-1", {
      beforeEntryId: "e7",
      turnCount: 3,
    });
    assert.equal(miss, null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("tryReadRuntimeTurnPage misses when the runtime switched to another session", async () => {
  const { manager, sessionPath, directory } = await createHarness();
  try {
    // 运行时已切到别的会话（替换/重绑）：不得用其缓存应答本会话翻页
    const otherPath = join(directory, "other.jsonl");
    await writeFile(otherPath, "{}", "utf8");
    manager.agents.get("agent-1").tab.sessionPath = otherPath;
    const miss = await manager.tryReadRuntimeTurnPage(sessionPath, "agent-1", {
      beforeEntryId: "e7",
      turnCount: 3,
    });
    assert.equal(miss, null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("tryReadRuntimeTurnPage cache pages carry the file indexVersion and cursor equivalence", async () => {
  const { manager, sessionPath, directory } = await createHarness();
  try {
    const version = await stat(sessionPath);
    const page = await manager.tryReadRuntimeTurnPage(sessionPath, "agent-1", {
      beforeEntryId: "e7",
      turnCount: 3,
    });
    assert.ok(page, "cache hit expected");
    // 与文件路径同口径的版本串：渲染层据此检测压缩/外部改写
    assert.equal(page.indexVersion, `${version.mtimeMs}:${version.size}`);
    // 数值游标（文件消息下标）与 entryId 游标解析到同一页；
    // 注意：before 落在缓存最旧条目（pos===0）时正确行为是返回 null 交给文件路径。
    const byBefore = await manager.tryReadRuntimeTurnPage(sessionPath, "agent-1", {
      before: 5,
      turnCount: 3,
    });
    assert.ok(byBefore, "numeric cursor cache hit expected");
    assert.equal(byBefore.messages[0].meta.entryId, "e4");
    const byEntryId = await manager.tryReadRuntimeTurnPage(sessionPath, "agent-1", {
      beforeEntryId: "e6",
      turnCount: 3,
    });
    assert.ok(byEntryId);
    assert.deepEqual(
      byBefore.messages.map((m) => m.meta.entryId),
      byEntryId.messages.map((m) => m.meta.entryId),
    );
    assert.equal(byBefore.nextBefore, byEntryId.nextBefore);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("tryReadRuntimeTurnPage misses instead of claiming the top when the cache page has no entryId", async () => {
  const { manager, sessionPath, directory } = await createHarness();
  try {
    const list = manager.messages.get("agent-1").map((message) => (
      message.meta.entryId === "e7"
        ? message
        : { ...message, meta: {} }
    ));
    manager.messages.set("agent-1", list);
    const page = await manager.tryReadRuntimeTurnPage(sessionPath, "agent-1", {
      beforeEntryId: "e7",
      turnCount: 3,
    });
    assert.equal(page, null, "cache pages without entryId must not emit a runtime-index cursor");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("tryReadRuntimeTurnPage misses instead of claiming the top when the file cursor cannot be resolved", async () => {
  const { manager, sessionPath, directory } = await createHarness();
  try {
    manager.sessionHistoryReader.resolveEntryPosition = async () => undefined;
    const page = await manager.tryReadRuntimeTurnPage(sessionPath, "agent-1", {
      beforeEntryId: "e7",
      turnCount: 3,
    });
    assert.equal(page, null, "unresolved file cursor must fall back to the disk path, not nextBefore=null");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("cache-miss edit/delete/resend locate the file entry via synthetic ids and restore the text draft", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pideck-runtime-cache-miss-"));
  const sessionPath = join(directory, "session.jsonl");
  try {
    const lines = [];
    let parent = null;
    for (const id of ["e1", "e2", "e3", "e4", "e5", "e6"]) {
      lines.push(entryLine(id, parent, id.endsWith("1") || id.endsWith("3") || id.endsWith("5") ? "user" : "assistant", `${id} text`));
      parent = id;
    }
    await writeFile(sessionPath, lines.join("\n") + "\n", "utf8");

    const runtime = {
      tab: {
        id: "agent-1",
        projectId: "project-1",
        cwd: "C:/project",
        title: "Session",
        status: "idle",
        sessionPath,
        sessionEnvironment: "native",
        sessionSource: "pi",
        createdAt: 1,
      },
      process: { client: { request: async () => ({ success: true, data: {} }) } },
    };
    const calls = [];
    const editorStub = {
      editMessage: async (input) => { calls.push(["edit", input.target]); return {}; },
      deleteMessage: async (input) => { calls.push(["delete", input.target]); return {}; },
      truncateForResend: async (input) => { calls.push(["resend", input.target]); return {}; },
    };
    const manager = new AgentManager(
      () => ({ id: "project-1", name: "Project", path: "C:/project" }),
      () => null,
      { get: () => ({}) },
      {},
      undefined,
      undefined,
      editorStub,
    );
    manager.agents.set("agent-1", runtime);
    // 运行时缓存只覆盖尾部 e4..e6 → e1 全部走缓存未命中文件定位
    manager.messages.set("agent-1", ["e4", "e5", "e6"].map((id) => ({
      id: `m-${id}`,
      agentId: "agent-1",
      role: id.endsWith("4") || id.endsWith("6") ? "user" : "assistant",
      text: `${id} text`,
      timestamp: 1,
      meta: { entryId: id },
    })));
    manager.loadMessages = async () => {}; // 文件编辑后的重载不属于本测试范围

    await manager.editMessage("agent-1", "agent-1-history-e1", "edited");
    assert.equal(calls[0][0], "edit");
    assert.equal(calls[0][1].entryId, "e1", "synthetic id must resolve to the real file entry");

    await manager.deleteMessage("agent-1", "agent-1-history-e1");
    assert.equal(calls[1][0], "delete");
    assert.equal(calls[1][1].entryId, "e1");

    // 纯文本 cache-miss 重发：截断前必须把草稿完整取回（修复前返回空文本）
    const draft = await manager.prepareResendFromMessage("agent-1", "agent-1-history-e1");
    assert.equal(calls[2][0], "resend");
    assert.equal(calls[2][1].entryId, "e1");
    assert.equal(draft.text, "e1 text");
    assert.equal(draft.images, undefined);

    // 缓存命中重发仍走缓存草稿
    const hit = await manager.prepareResendFromMessage("agent-1", "m-e4");
    assert.equal(hit.text, "e4 text");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("loadMessages aligns trimmed runtime messages with their real entry ids", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pideck-runtime-cache-align-"));
  const sessionPath = join(directory, "session.jsonl");
  try {
    await writeFile(sessionPath, "{}", "utf8");
    const messages = [];
    const entries = [];
    let parent = null;
    for (let i = 1; i <= 15; i += 1) {
      const uid = `u${i}`;
      const aid = `a${i}`;
      messages.push({ role: "user", content: [{ type: "text", text: `q${i}` }], id: `msg-u${i}` });
      entries.push({ id: uid, parentId: parent, type: "message", message: { role: "user", id: `msg-u${i}` } });
      parent = uid;
      messages.push({ role: "assistant", content: [{ type: "text", text: `a${i}` }], id: `msg-a${i}` });
      entries.push({ id: aid, parentId: parent, type: "message", message: { role: "assistant", id: `msg-a${i}` } });
      parent = aid;
    }
    const runtime = {
      tab: {
        id: "agent-1",
        projectId: "project-1",
        cwd: "C:/project",
        title: "Session",
        status: "idle",
        sessionPath,
        sessionEnvironment: "native",
        sessionSource: "pi",
        createdAt: 1,
      },
      process: {
        client: {
          request: async ({ type }) => type === "get_entries"
            ? { success: true, data: { entries, leafId: "a15" } }
            : { success: true, data: { messages } },
        },
      },
    };
    const manager = new AgentManager(
      () => ({ id: "project-1", name: "Project", path: "C:/project" }),
      () => null,
      { get: () => ({}) },
      {},
    );
    manager.agents.set("agent-1", runtime);
    const payloads = [];
    manager.onOutput((channel, payload) => {
      if (channel === "agents:message") payloads.push(payload);
    });

    await manager.loadMessages("agent-1");
    const cached = manager.messages.get("agent-1");
    // 15 轮裁到 12 轮：首条保留 q4，其 entryId 必须是 u4（修复前被错配成 u1）
    assert.equal(cached[0].text, "q4");
    assert.equal(cached[0].meta.entryId, "u4");
    assert.equal(cached[cached.length - 1].meta.entryId, "a15");
    // 全量 flush 携带 windowStartFilePos：窗口首条（q13）的文件消息下标 = 24
    const full = payloads.find((p) => p.windowStart !== undefined);
    assert.ok(full, "windowed full flush expected");
    assert.equal(full.windowStart, 18);
    assert.equal(full.windowStartFilePos, 24);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("loadMessages ignores an older snapshot that resolves after a newer load", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pideck-runtime-cache-sequence-"));
  const sessionPath = join(directory, "session.jsonl");
  try {
    await writeFile(sessionPath, "{}", "utf8");
    const runtime = {
      tab: {
        id: "agent-sequence",
        projectId: "project-1",
        cwd: "C:/project",
        title: "Session",
        status: "idle",
        sessionPath,
        sessionEnvironment: "native",
        sessionSource: "pi",
        createdAt: 1,
      },
      process: { client: { request: async () => ({ success: true, data: {} }) } },
    };
    const manager = new AgentManager(
      () => ({ id: "project-1", name: "Project", path: "C:/project" }),
      () => null,
      { get: () => ({}) },
      {},
    );
    manager.agents.set("agent-sequence", runtime);

    const older = deferred();
    const newer = deferred();
    const oldLoad = manager.loadMessages("agent-sequence", true, older.promise);
    const newLoad = manager.loadMessages("agent-sequence", true, newer.promise);

    newer.resolve({
      success: true,
      data: { messages: [{ role: "assistant", content: [{ type: "text", text: "new" }] }] },
    });
    await newLoad;
    older.resolve({
      success: true,
      data: { messages: [{ role: "assistant", content: [{ type: "text", text: "old" }] }] },
    });
    await oldLoad;

    assert.equal(manager.messages.get("agent-sequence")[0].text, "new");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("loadMessages stat error in older load does not delete sessionFileVersion of newer load", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pideck-runtime-cache-stat-"));
  const sessionPath = join(directory, "session.jsonl");
  try {
    await writeFile(sessionPath, "{}", "utf8");
    const runtime = {
      tab: {
        id: "agent-stat-race",
        projectId: "project-1",
        cwd: "C:/project",
        title: "Session",
        status: "idle",
        sessionPath,
        sessionEnvironment: "native",
        sessionSource: "pi",
        createdAt: 1,
      },
      process: { client: { request: async () => ({ success: true, data: {} }) } },
    };
    const manager = new AgentManager(
      () => ({ id: "project-1", name: "Project", path: "C:/project" }),
      () => null,
      { get: () => ({}) },
      {},
    );
    manager.agents.set("agent-stat-race", runtime);

    const older = deferred();
    const newer = deferred();
    const oldLoad = manager.loadMessages("agent-stat-race", true, older.promise);
    const newLoad = manager.loadMessages("agent-stat-race", true, newer.promise);

    newer.resolve({
      success: true,
      data: { messages: [{ role: "assistant", content: [{ type: "text", text: "new" }] }] },
    });
    await newLoad;
    assert.ok(manager.sessionFileVersionByAgent.has("agent-stat-race"));
    const currentVersion = manager.sessionFileVersionByAgent.get("agent-stat-race");

    // 现在让旧 load 的 RPC 完成，但临时把 sessionPath 删掉或者让其 stat 出错
    await rm(sessionPath);
    older.resolve({
      success: true,
      data: { messages: [{ role: "assistant", content: [{ type: "text", text: "old" }] }] },
    });
    await oldLoad;

    assert.equal(manager.sessionFileVersionByAgent.get("agent-stat-race"), currentVersion, "stale load stat failure must not delete newer version");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("trimRuntimeCache keeps leading compaction summary cards", async () => {
  const { manager, sessionPath, directory } = await createHarness();
  try {
    const many = [];
    for (let i = 1; i <= 15; i += 1) {
      many.push({ id: `m-u${i}`, agentId: "agent-1", role: "user", text: `q${i}`, timestamp: 1, meta: { entryId: `u${i}` } });
      many.push({ id: `m-a${i}`, agentId: "agent-1", role: "assistant", text: `a${i}`, timestamp: 1, meta: { entryId: `a${i}` } });
    }
    manager.messages.set("agent-1", [
      { id: "sum-1", agentId: "agent-1", role: "system", text: "compacted", timestamp: 1, meta: { type: "compaction" } },
      ...many,
    ]);
    const payloads = [];
    manager.onOutput((channel, payload) => {
      if (channel === "agents:message") payloads.push(payload);
    });
    manager.trimRuntimeCache("agent-1");
    const after = manager.messages.get("agent-1");
    // 卡片保留在头部且不重复；尾部保留最近 12 轮（24 条）
    assert.equal(after.filter((m) => m.role === "system").length, 1);
    assert.equal(after[0].meta.type, "compaction");
    assert.equal(after.length, 25);
    assert.equal(after[1].text, "q4");
    assert.equal(after[24].text, "a15");
    // 数值游标不被卡片污染：窗口首条 q13 的文件消息下标 = 24（headOffset 只按角色消息递增）
    const full = payloads.find((p) => p.windowStart !== undefined);
    assert.ok(full, "windowed full flush expected");
    assert.equal(full.windowStart, 19);
    assert.equal(full.windowStartFilePos, 24);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("trimRuntimeCache slides out the old window head and keeps anonymous headOffset at -1 (H2+M2 regression)", async () => {
  const { manager, sessionPath, directory } = await createHarness();
  try {
    const many = [];
    for (let i = 1; i <= 15; i += 1) {
      many.push({ id: `m-u${i}`, agentId: "agent-1", role: "user", text: `q${i}`, timestamp: 1, meta: { entryId: `u${i}` } });
      many.push({ id: `m-a${i}`, agentId: "agent-1", role: "assistant", text: `a${i}`, timestamp: 1, meta: { entryId: `a${i}` } });
    }
    manager.messages.set("agent-1", many);
    // 旧窗口 = q10 起（旧空间下标 18）；trim 后窗口 = q13 起 → 滑出 [q10..a12]（3 轮 6 条）
    manager.displayWindowStartByAgent.set("agent-1", 18);
    // 匿名会话（无文件路径/无 entryId 映射）：headOffset 未知 = -1，trim 后必须保持 -1（M2）
    manager.messageHeadOffsetByAgent.set("agent-1", -1);
    const payloads = [];
    manager.onOutput((channel, payload) => {
      if (channel === "agents:message") payloads.push(payload);
    });
    manager.trimRuntimeCache("agent-1");
    // H2：滑出轮随全量 flush 下发（渲染层并入历史前缀，锚点轮不消失）
    const slidePayload = payloads.find((p) => p.slideOut !== undefined);
    assert.ok(slidePayload, "full flush must carry slideOut");
    assert.deepEqual(
      Array.from(slidePayload.slideOut, (m) => m.meta.entryId),
      ["u10", "a10", "u11", "a11", "u12", "a12"],
    );
    assert.equal(slidePayload.windowStart, 18, "trim 后窗口 = q13 起（新空间下标 18）");
    assert.equal(slidePayload.messages[0].meta.entryId, "u13");
    assert.equal(manager.pendingSlideOutByAgent.get("agent-1"), undefined, "flush 后待发滑出已清空");
    // M2：-1 保持 -1（修复前被递增成 5 的伪造游标）
    assert.equal(manager.messageHeadOffsetByAgent.get("agent-1"), -1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("trimRuntimeCache appends window slide-out onto an existing pending slideOut", async () => {
  const { manager, directory } = await createHarness();
  try {
    const many = [];
    for (let i = 1; i <= 15; i += 1) {
      many.push({ id: `m-u${i}`, agentId: "agent-1", role: "user", text: `q${i}`, timestamp: 1, meta: { entryId: `u${i}` } });
      many.push({ id: `m-a${i}`, agentId: "agent-1", role: "assistant", text: `a${i}`, timestamp: 1, meta: { entryId: `a${i}` } });
    }
    manager.messages.set("agent-1", many);
    manager.displayWindowStartByAgent.set("agent-1", 18);
    manager.pendingSlideOutByAgent.set("agent-1", [
      { id: "pending-old", agentId: "agent-1", role: "assistant", text: "pending-old", timestamp: 1, meta: { entryId: "pending-old" } },
    ]);
    const payloads = [];
    manager.onOutput((channel, payload) => {
      if (channel === "agents:message") payloads.push(payload);
    });
    manager.trimRuntimeCache("agent-1");
    const slidePayload = payloads.find((p) => p.slideOut !== undefined);
    assert.ok(slidePayload, "full flush must carry the combined slideOut");
    assert.deepEqual(
      Array.from(slidePayload.slideOut, (m) => m.meta.entryId),
      ["pending-old", "u10", "a10", "u11", "a11", "u12", "a12"],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("trimRuntimeCache increments headOffset for file-backed sessions only (M2 regression)", async () => {
  const { manager, sessionPath, directory } = await createHarness();
  try {
    const many = [];
    for (let i = 1; i <= 15; i += 1) {
      many.push({ id: `m-u${i}`, agentId: "agent-1", role: "user", text: `q${i}`, timestamp: 1, meta: { entryId: `u${i}` } });
      many.push({ id: `m-a${i}`, agentId: "agent-1", role: "assistant", text: `a${i}`, timestamp: 1, meta: { entryId: `a${i}` } });
    }
    manager.messages.set("agent-1", many);
    manager.messageHeadOffsetByAgent.set("agent-1", 0);
    const payloads = [];
    manager.onOutput((channel, payload) => {
      if (channel === "agents:message") payloads.push(payload);
    });
    manager.trimRuntimeCache("agent-1");
    // 被裁 q1..a3 = 6 条角色消息 → 数值游标前移 6；窗口首条 u13 的文件下标 = 6 + 18 = 24
    assert.equal(manager.messageHeadOffsetByAgent.get("agent-1"), 6);
    const full = payloads.find((p) => p.windowStart !== undefined);
    assert.ok(full, "windowed full flush expected");
    assert.equal(full.windowStart, 18);
    assert.equal(full.windowStartFilePos, 24);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("cache-miss delete of a message absent from the file rejects with Message not found", async () => {
  const { manager, sessionPath, directory } = await createHarness();
  try {
    manager.loadMessages = async () => {};
    await assert.rejects(
      manager.deleteMessage("agent-1", "agent-1-history-nope"),
      /Message not found/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("manual compact uses the RPC customInstructions field and always returns to idle", async () => {
  const requests = [];
  const runtime = {
    tab: {
      id: "agent-compact",
      projectId: "project-1",
      cwd: "C:/project",
      title: "Session",
      status: "idle",
      createdAt: 1,
    },
    process: {
      client: {
        request: async (command) => {
          requests.push(command);
          return { success: true, data: {} };
        },
      },
      isRunning: () => true,
    },
  };
  const manager = new AgentManager(
    () => ({ id: "project-1", name: "Project", path: "C:/project" }),
    () => null,
    { get: () => ({}) },
    {},
  );
  manager.agents.set("agent-compact", runtime);
  manager.loadMessages = async () => {};
  manager.getRuntimeState = async () => ({});

  await manager.compact("agent-compact", " keep the important decisions ");

  assert.equal(requests[0].type, "compact");
  assert.equal(requests[0].customInstructions, "keep the important decisions");
  assert.equal(runtime.tab.status, "idle");
  assert.equal(manager.compactingAgents.has("agent-compact"), false);
  assert.equal(manager.rpcCompactingAgents.has("agent-compact"), false);
});

test("manual compact ignores a late compaction_end reload after RPC reload", async () => {
  const runtime = {
    tab: {
      id: "agent-compact-late-end",
      projectId: "project-1",
      cwd: "C:/project",
      title: "Session",
      status: "idle",
      createdAt: 1,
    },
    process: {
      client: { request: async () => ({ success: true, data: {} }) },
      isRunning: () => true,
    },
  };
  const manager = new AgentManager(
    () => ({ id: "project-1", name: "Project", path: "C:/project" }),
    () => null,
    { get: () => ({}) },
    {},
  );
  manager.agents.set("agent-compact-late-end", runtime);
  let reloads = 0;
  let resolveLoad;
  const loadStarted = new Promise((resolve) => { resolveLoad = resolve; });
  manager.loadMessages = async () => {
    reloads += 1;
    resolveLoad();
    await new Promise((resolve) => setImmediate(resolve));
  };
  manager.getRuntimeState = async () => ({});

  const compacting = manager.compact("agent-compact-late-end");
  await loadStarted;
  manager.handlePiEvent("agent-compact-late-end", { type: "compaction_end" });
  await compacting;
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(reloads, 1, "compaction_end during RPC reload must not start a second load");
});

test("manual compact failure does not leave the runtime stuck in compacting", async () => {
  const runtime = {
    tab: {
      id: "agent-compact-failure",
      projectId: "project-1",
      cwd: "C:/project",
      title: "Session",
      status: "idle",
      createdAt: 1,
    },
    process: {
      client: {
        request: async () => ({ success: false, error: "nothing to compact" }),
      },
      isRunning: () => true,
    },
  };
  const manager = new AgentManager(
    () => ({ id: "project-1", name: "Project", path: "C:/project" }),
    () => null,
    { get: () => ({}) },
    {},
  );
  manager.agents.set("agent-compact-failure", runtime);
  manager.getRuntimeState = async () => ({});

  await assert.rejects(
    manager.compact("agent-compact-failure"),
    /nothing to compact/,
  );
  assert.equal(runtime.tab.status, "idle");
  assert.equal(manager.compactingAgents.has("agent-compact-failure"), false);
  assert.equal(manager.rpcCompactingAgents.has("agent-compact-failure"), false);
});

test("manual compact does not idle a queued follow-up that starts before RPC cleanup", async () => {
  let resolveRequest;
  const request = new Promise((resolve) => { resolveRequest = resolve; });
  const runtime = {
    tab: {
      id: "agent-compact-follow-up",
      projectId: "project-1",
      cwd: "C:/project",
      title: "Session",
      status: "idle",
      createdAt: 1,
    },
    process: {
      client: { request: async () => request },
      isRunning: () => true,
    },
  };
  const manager = new AgentManager(
    () => ({ id: "project-1", name: "Project", path: "C:/project" }),
    () => null,
    { get: () => ({}) },
    {},
  );
  manager.agents.set("agent-compact-follow-up", runtime);
  manager.loadMessages = async () => {};
  manager.getRuntimeState = async () => ({});

  const compacting = manager.compact("agent-compact-follow-up");
  await Promise.resolve();
  manager.handlePiEvent("agent-compact-follow-up", { type: "agent_start" });
  resolveRequest({ success: true, data: {} });
  await compacting;

  assert.equal(runtime.tab.status, "running");
  assert.equal(manager.compactingAgents.has("agent-compact-follow-up"), false);
  assert.equal(manager.manualCompactionFollowUpAgents.has("agent-compact-follow-up"), true);
});

test("manual compact owns the reload while compaction_end is in flight", () => {
  const runtime = {
    tab: {
      id: "agent-compact-reload",
      projectId: "project-1",
      cwd: "C:/project",
      title: "Session",
      status: "running",
      createdAt: 1,
    },
    process: { client: { request: async () => ({ success: true, data: {} }) } },
  };
  const manager = new AgentManager(
    () => ({ id: "project-1", name: "Project", path: "C:/project" }),
    () => null,
    { get: () => ({}) },
    {},
  );
  manager.agents.set("agent-compact-reload", runtime);
  let reloads = 0;
  manager.loadMessages = async () => { reloads += 1; };
  manager.getRuntimeState = async () => ({});
  manager.compactingAgents.add("agent-compact-reload");

  manager.handlePiEvent("agent-compact-reload", { type: "compaction_end" });
  assert.equal(reloads, 0);

  manager.compactingAgents.delete("agent-compact-reload");
  manager.handlePiEvent("agent-compact-reload", { type: "compaction_end" });
  assert.equal(reloads, 1);
});

test("manual compact claim is consumed by delayed compaction_end and cleared after load", async () => {
  const runtime = {
    tab: {
      id: "agent-compact-claim",
      projectId: "project-1",
      cwd: "C:/project",
      title: "Session",
      status: "running",
      createdAt: 1,
    },
    process: { client: { request: async () => ({ success: true, data: {} }) } },
  };
  const manager = new AgentManager(
    () => ({ id: "project-1", name: "Project", path: "C:/project" }),
    () => null,
    { get: () => ({}) },
    {},
  );
  manager.agents.set("agent-compact-claim", runtime);
  let reloads = 0;
  let resolveLoad;
  const loadStarted = new Promise((resolve) => { resolveLoad = resolve; });
  manager.loadMessages = async () => {
    reloads += 1;
    resolveLoad();
    await new Promise((resolve) => setImmediate(resolve));
  };
  manager.getRuntimeState = async () => ({});

  const compacting = manager.compact("agent-compact-claim");
  await loadStarted;
  manager.handlePiEvent("agent-compact-claim", { type: "compaction_end" });
  await compacting;
  assert.equal(reloads, 1, "RPC reload owns the in-flight compaction_end");

  manager.handlePiEvent("agent-compact-claim", { type: "compaction_end" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reloads, 2, "automatic compaction after the claim window must reload");
});

test("automatic compaction reload preserves history and sticky flags", () => {
  const runtime = {
    tab: {
      id: "agent-auto-compact-reload",
      projectId: "project-1",
      cwd: "C:/project",
      title: "Session",
      status: "running",
      createdAt: 1,
    },
    process: { client: { request: async () => ({ success: true, data: {} }) } },
  };
  const manager = new AgentManager(
    () => ({ id: "project-1", name: "Project", path: "C:/project" }),
    () => null,
    { get: () => ({}) },
    {},
  );
  manager.agents.set("agent-auto-compact-reload", runtime);
  let loadOptions;
  manager.loadMessages = async (_agentId, _skipEntries, _early, options) => {
    loadOptions = options;
  };

  manager.handlePiEvent("agent-auto-compact-reload", { type: "compaction_end" });

  return new Promise((resolve, reject) => {
    setImmediate(() => {
      try {
        assert.equal(loadOptions?.preserveHistory, true);
        assert.equal(loadOptions?.stickyHistory, true);
        resolve();
      } catch (error) {
        reject(error);
      }
    });
  });
});
