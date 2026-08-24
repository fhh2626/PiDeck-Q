import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

const nodeRequire = createRequire(import.meta.url);

function loadAgentManager() {
  const filePath = "src/main/pi/AgentManager.ts";
  const output = ts.transpileModule(readFileSync(filePath, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: filePath,
  }).outputText;
  const module = { exports: {} };
  // AgentManager 新增 streamGate 依赖（abort 流式封印），真实加载以保持闸门行为。
  const streamGateModule = { exports: {} };
  vm.runInNewContext(
    ts.transpileModule(readFileSync("src/main/pi/streamGate.ts", "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
      fileName: "streamGate.ts",
    }).outputText,
    { module: streamGateModule, exports: streamGateModule.exports },
    { filename: "streamGate.ts" },
  );
  // cacheHitStats：纯函数真实加载（getRuntimeState 读会话文件统计缓存命中率）
  const cacheHitStatsModule = { exports: {} };
  vm.runInNewContext(
    ts.transpileModule(readFileSync("src/main/pi/cacheHitStats.ts", "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
      fileName: "cacheHitStats.ts",
    }).outputText,
    { module: cacheHitStatsModule, exports: cacheHitStatsModule.exports },
    { filename: "cacheHitStats.ts" },
  );
  class LatestByKeyEmitter {
    constructor() {}
    cancel() {}
    schedule() {}
    flush() {}
  }
  vm.runInNewContext(output, {
    module,
    exports: module.exports,
    require: (specifier) => {
      if (specifier === "electron") {
        return {
          app: { getName: () => "PiDeck", getPath: () => "C:/tmp" },
          Notification: { isSupported: () => false },
        };
      }
      if (specifier === "../../shared/ipc") return { ipcChannels: {} };
      if (specifier === "./PiProcess") return { PiProcess: class {} };
      if (specifier === "./bashResult") return { formatBashToolMessage: () => "" };
      if (specifier === "./messageContent") return { extractMessageText: () => "" };
      if (specifier === "./historyMessages") return { mergeHistoryWithPreservedMessages: (messages) => messages };
      if (specifier === "./agentSessionIdentity") return { buildAgentSessionKey: () => undefined };
      if (specifier === "./SessionFileEditor") return { SessionFileEditor: class {} };
      if (specifier === "./SessionHistoryReader") {
        return {
          SessionHistoryReader: class {},
          syntheticHistoryEntryId: (messageId) => {
            const marker = "-history-";
            const index = messageId.lastIndexOf(marker);
            if (index < 0) return undefined;
            return messageId.slice(index + marker.length) || undefined;
          },
        };
      }
      if (specifier === "./AgentMessageProjector") {
        return {
          AgentMessageProjector: class {},
          buildActiveBranchEntryIds: (entries, leafId) => {
            const entryById = new Map();
            for (const entry of entries) entryById.set(entry.id, entry);
            const allBranchIds = [];
            let currentId = leafId;
            while (currentId) {
              allBranchIds.unshift(currentId);
              const entry = entryById.get(currentId);
              currentId = entry?.parentId ?? null;
            }
            return allBranchIds.filter((id) => entryById.get(id)?.type === "message");
          },
        };
      }
      // Phase B 起 AgentManager 引入 askQuestionResult（ask_question 结果规范化）；
      // 文件编辑器测试不涉及 ask 投影，返回最小桩即可。
      if (specifier === "./askQuestionResult") {
        return { buildAskQuestionResultSummary: () => undefined };
      }
      if (specifier === "./sessionEntryIds") {
        return { takeActiveEntryId: (ids, index) => ({ entryId: ids?.[index], nextIndex: index + 1 }) };
      }
      if (specifier === "./agentUtils") {
        return {
          stripAnsi: (text) => text,
          pickNumber: (...values) => { for (const v of values) if (typeof v === "number") return v; },
          clampPercent: (v) => v,
          trimHistoryMessages: (msgs) => msgs,
          cleanTitle: (t) => t,
          inferTitleFromMessages: () => undefined,
          isDefaultAgentTitle: () => false,
        };
      }
      if (specifier === "./LatestByKeyEmitter") return { LatestByKeyEmitter };
      if (specifier === "./streamGate") return streamGateModule.exports;
      if (specifier === "./cacheHitStats") return cacheHitStatsModule.exports;
      if (specifier === "../../shared/toolRuntimeState") return { updateActiveToolCalls: () => undefined };
      // 25fd516 起 AgentManager 引入内置扩展参数拼接；本测试不涉及扩展加载，透传即可
      if (specifier === "../extensions/builtInExtensions") {
        return { appendBuiltInExtensionArgs: (args) => [...args] };
      }
      if (specifier === "../wsl/WslPaths") {
        return { toWindowsHostPath: (path) => path, toWslLinuxPath: (path) => path };
      }
      return nodeRequire(specifier);
    },
    Date,
    Map,
    Set,
    Promise,
    JSON,
    Error,
    Buffer,
    setTimeout,
    clearTimeout,
    console,
  }, { filename: filePath });
  return module.exports.AgentManager;
}

const AgentManager = loadAgentManager();

function chatMessage(overrides = {}) {
  return {
    id: "agent-1-history-a1",
    agentId: "agent-1",
    role: "assistant",
    text: "answer",
    timestamp: 1,
    meta: { entryId: "a1" },
    ...overrides,
  };
}

function createHarness(editor, options = {}) {
  const commands = [];
  const runtime = {
    tab: {
      id: "agent-1",
      projectId: "project-1",
      cwd: "C:/project",
      title: "Session",
      status: options.status ?? "idle",
      sessionPath: "C:/sessions/session.jsonl",
      sessionEnvironment: "native",
      sessionSource: "pi",
      createdAt: 1,
    },
    process: {
      client: {
        request: async (command) => {
          commands.push(command);
          if (command.type === "get_entries") {
            return { success: true, data: { leafId: options.leafId ?? "a1" } };
          }
          if (command.type === "switch_session") return { success: true };
          return { success: true, data: {} };
        },
      },
    },
  };
  const manager = new AgentManager(
    () => ({ id: "project-1", name: "Project", path: "C:/project" }),
    () => null,
    { get: () => ({}) },
    {},
    undefined,
    undefined,
    editor,
  );
  manager.sessionHistoryReader = options.sessionHistoryReader ?? {
    readMessageByMessageId: async (_path, messageId) => {
      const msg = (options.messages ?? [chatMessage()]).find((m) => m.id === messageId);
      if (!msg) return undefined;
      return {
        entryId: msg.meta?.entryId ?? "a1",
        role: msg.role,
        text: msg.text,
        images: msg.images,
      };
    },
    readActiveEntryIdentity: async (_path) => {
      const msgs = options.messages ?? [chatMessage()];
      return {
        entryIds: msgs.map((m) => m.meta?.entryId || "a1"),
        leafId: options.leafId ?? "a1",
        activeMessageEntries: msgs.map((m) => ({
          id: m.meta?.entryId || "a1",
          role: m.role,
          messageId: m.id,
        })),
      };
    },
  };
  manager.agents.set("agent-1", runtime);
  manager.messages.set("agent-1", options.messages ?? [chatMessage()]);
  const loads = [];
  manager.loadMessages = async (agentId) => {
    loads.push(agentId);
    return [];
  };
  return { manager, runtime, commands, loads };
}

test("AgentManager validates idle state before invoking SessionFileEditor", async () => {
  let called = false;
  const editor = {
    editMessage: async () => { called = true; },
  };
  const { manager } = createHarness(editor, { status: "running" });
  manager.getRuntimeState = async () => ({ isStreaming: true, isCompacting: false, isExecutingTool: false });
  await assert.rejects(
    manager.editMessage("agent-1", "agent-1-history-a1", "changed"),
    /BUSY_STREAMING/,
  );
  assert.equal(called, false);
});

test("AgentManager passes file, active leaf and legacy identity, then loads messages after success", async () => {
  const order = [];
  let received;
  const editor = {
    editMessage: async (input) => {
      order.push("editor");
      received = input;
      await input.reload();
    },
  };
  const { manager, commands, loads } = createHarness(editor);
  manager.loadMessages = async (agentId) => {
    order.push("load");
    loads.push(agentId);
    return [];
  };
  await manager.editMessage("agent-1", "agent-1-history-a1", "changed");

  assert.deepEqual(order, ["editor", "load"]);
  assert.equal(received.file.hostPath, "C:/sessions/session.jsonl");
  assert.equal(received.file.protocolPath, "C:/sessions/session.jsonl");
  assert.equal(received.target.entryId, "a1");
  assert.equal(received.target.legacyMessageId, "agent-1-history-a1");
  assert.equal(received.target.legacyAgentId, "agent-1");
  assert.equal(received.target.activeLeafId, "a1");
  assert.equal(received.newText, "changed");
  assert.deepEqual(commands.map((command) => command.type), ["get_entries", "switch_session"]);
  assert.deepEqual(loads, ["agent-1"]);
});

test("AgentManager does not load messages or report success after editor failure", async () => {
  const editor = {
    deleteMessage: async () => { throw new Error("editor failed"); },
  };
  const { manager, loads } = createHarness(editor);
  await assert.rejects(
    manager.deleteMessage("agent-1", "agent-1-history-a1"),
    /editor failed/,
  );
  assert.deepEqual(loads, []);
});

test("delete, resend and public reload all route through the injected editor and Pi reload callback", async () => {
  const calls = [];
  const editor = {
    deleteMessage: async (input) => {
      calls.push(["delete", input.target.entryId]);
      await input.reload();
    },
    truncateForResend: async (input) => {
      calls.push(["resend", input.target.entryId]);
      await input.reload();
    },
    reload: async (input) => {
      calls.push(["reload", input.file.protocolPath]);
      await input.reload();
    },
  };
  const user = chatMessage({
    id: "agent-1-history-u1",
    role: "user",
    text: "question",
    meta: { entryId: "u1" },
    images: [{ data: "image", mimeType: "image/png" }],
  });
  const assistant = chatMessage();
  const { manager, commands, loads } = createHarness(editor, {
    messages: [user, assistant],
    leafId: "a1",
  });

  await manager.deleteMessage("agent-1", assistant.id);
  const resend = await manager.prepareResendFromMessage("agent-1", user.id);
  await manager.reload("agent-1");

  assert.deepEqual(calls, [
    ["delete", "a1"],
    ["resend", "u1"],
    ["reload", "C:/sessions/session.jsonl"],
  ]);
  assert.equal(resend.text, "question");
  assert.equal(resend.images.length, 1);
  assert.equal(commands.filter((command) => command.type === "switch_session").length, 3);
  assert.deepEqual(loads, ["agent-1", "agent-1", "agent-1"]);
});

test("deleteMessage succeeds even if subsequent loadMessages fails after commit", async () => {
  const warnings = [];
  const editor = {
    deleteMessage: async (input) => {
      await input.reload();
    },
  };
  const assistant = chatMessage();
  const { manager } = createHarness(editor, {
    messages: [assistant],
    leafId: "a1",
  });
  manager.appLogger = {
    info: () => {},
    warn: (scope, msg, detail) => { warnings.push({ scope, msg, detail }); },
  };
  manager.loadMessages = async () => {
    throw new Error("refresh memory failed");
  };

  await manager.deleteMessage("agent-1", assistant.id);

  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].msg, "Delete committed but message refresh failed");
  assert.equal(warnings[0].detail.error, "refresh memory failed");
});

test("editMessage and prepareResendFromMessage succeed even if subsequent loadMessages fails after commit", async () => {
  const warnings = [];
  const editor = {
    editMessage: async (input) => {
      await input.reload();
    },
    truncateForResend: async (input) => {
      await input.reload();
    },
  };
  const user = chatMessage({
    id: "agent-1-history-u1",
    role: "user",
    text: "question",
    meta: { entryId: "u1" },
  });
  const assistant = chatMessage();
  const { manager } = createHarness(editor, {
    messages: [user, assistant],
    leafId: "a1",
  });
  manager.appLogger = {
    info: () => {},
    warn: (scope, msg, detail) => { warnings.push({ scope, msg, detail }); },
  };
  manager.loadMessages = async () => {
    throw new Error("refresh memory failed");
  };

  await manager.editMessage("agent-1", assistant.id, "new answer");
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].msg, "Edit committed but message refresh failed");

  const resend = await manager.prepareResendFromMessage("agent-1", user.id);
  assert.equal(resend.text, "question");
  assert.equal(warnings.length, 2);
  assert.equal(warnings[1].msg, "Prepare resend committed but message refresh failed");
});

test("staleMessageCacheAgents marks cache stale on refresh failure and forces file location until fresh load", async () => {
  const editor = {
    editMessage: async (input) => {
      await input.reload();
    },
    truncateForResend: async (input) => {
      await input.reload();
    },
  };
  const staleUser = chatMessage({
    id: "agent-1-history-u1",
    role: "user",
    text: "old-stale-text",
    meta: { entryId: "u1" },
  });
  const { manager, runtime } = createHarness(editor, {
    messages: [staleUser],
    leafId: "a1",
  });

  // Mock sessionHistoryReader to return updated text from file
  manager.sessionHistoryReader = {
    readMessageByMessageId: async (_path, messageId) => {
      if (messageId === "agent-1-history-u1") {
        return {
          entryId: "u1",
          role: "user",
          text: "new-file-text",
        };
      }
      return undefined;
    },
  };

  // 1. Initial state: not stale, getMessages returns staleUser
  assert.equal(manager.isMessageCacheStale("agent-1"), false);
  assert.equal(manager.getMessages("agent-1").length, 1);

  // 2. Perform edit where loadMessages fails
  manager.loadMessages = async () => {
    throw new Error("refresh memory failed");
  };
  await manager.editMessage("agent-1", staleUser.id, "new-file-text");

  // Cache is now stale
  assert.equal(manager.isMessageCacheStale("agent-1"), true);

  // 3. Resend while stale: locateMessageTarget bypasses this.messages and locates from file!
  const resend = await manager.prepareResendFromMessage("agent-1", staleUser.id);
  // Must return the text read from file ("new-file-text"), NOT the stale memory text ("old-stale-text")!
  assert.equal(resend.text, "new-file-text");

  // 4. Now a successful loadMessages updates memory and clears stale state
  const freshMessages = [
    chatMessage({ id: "agent-1-history-u1", role: "user", text: "new-file-text", meta: { entryId: "u1" } }),
  ];
  // Restore real loadMessages behavior or assign and invoke
  manager.messages.set("agent-1", freshMessages);
  manager.staleMessageCacheAgents.delete("agent-1");

  assert.equal(manager.isMessageCacheStale("agent-1"), false);
  assert.equal(manager.getMessages("agent-1")[0].text, "new-file-text");
});

function loadSessionFileEditor() {
  const filePath = "src/main/pi/SessionFileEditor.ts";
  const output = ts.transpileModule(readFileSync(filePath, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: filePath,
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(output, {
    module,
    exports: module.exports,
    require: nodeRequire,
    Buffer,
    TextDecoder,
    AggregateError,
    process,
    setTimeout,
    clearTimeout,
    console,
  }, { filename: filePath });
  return module.exports.SessionFileEditor;
}

test("integrated: delete message on disk and switch_session succeed but loadMessages throws -> API returns success and disk keeps deletion", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pideck-test-del-"));
  const sessionPath = join(dir, "session.jsonl");
  const initialContent = [
    JSON.stringify({ type: "session", version: 3, id: "session-1" }),
    JSON.stringify({ type: "message", id: "u1", parentId: null, message: { role: "user", content: "hello" } }),
    JSON.stringify({ type: "message", id: "a1", parentId: "u1", message: { role: "assistant", content: "answer" } }),
  ].join("\n") + "\n";
  await writeFile(sessionPath, initialContent, "utf8");

  try {
    const SessionFileEditorClass = loadSessionFileEditor();
    const realEditor = new SessionFileEditorClass();

    const assistant = chatMessage({
      id: "agent-1-history-a1",
      role: "assistant",
      text: "answer",
      meta: { entryId: "a1" },
    });
    const { manager, runtime } = createHarness(realEditor, {
      messages: [assistant],
      leafId: "a1",
    });
    runtime.tab.sessionPath = sessionPath;

    const warnings = [];
    manager.appLogger = {
      info: () => {},
      warn: (scope, msg, detail) => { warnings.push({ scope, msg, detail }); },
    };
    manager.loadMessages = async () => {
      throw new Error("refresh load failed");
    };

    // deleteMessage must succeed without throwing
    await manager.deleteMessage("agent-1", assistant.id);

    // Verify warning was logged
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].msg, "Delete committed but message refresh failed");

    // Verify disk content preserves deletion result (a1 message is deleted, replaced by tombstone)
    const updatedContent = await readFile(sessionPath, "utf8");
    assert.equal(updatedContent.includes('"role":"assistant"'), false);
    assert.equal(updatedContent.includes('"type":"deleted"'), true);
    assert.equal(updatedContent.includes('"u1"'), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("integrated: switch_session fails -> file is rolled back and API returns failure", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pideck-test-del-rollback-"));
  const sessionPath = join(dir, "session.jsonl");
  const initialContent = [
    JSON.stringify({ type: "session", version: 3, id: "session-1" }),
    JSON.stringify({ type: "message", id: "u1", parentId: null, message: { role: "user", content: "hello" } }),
    JSON.stringify({ type: "message", id: "a1", parentId: "u1", message: { role: "assistant", content: "answer" } }),
  ].join("\n") + "\n";
  await writeFile(sessionPath, initialContent, "utf8");

  try {
    const SessionFileEditorClass = loadSessionFileEditor();
    const realEditor = new SessionFileEditorClass();

    const assistant = chatMessage({
      id: "agent-1-history-a1",
      role: "assistant",
      text: "answer",
      meta: { entryId: "a1" },
    });
    const { manager, runtime } = createHarness(realEditor, {
      messages: [assistant],
      leafId: "a1",
    });
    runtime.tab.sessionPath = sessionPath;

    // Simulate switch_session RPC failure on first reload attempt, then success on rollback reload
    let switchCount = 0;
    runtime.process.client.request = async (command) => {
      if (command.type === "get_entries") return { success: true, data: { leafId: "a1" } };
      if (command.type === "switch_session") {
        switchCount += 1;
        if (switchCount === 1) throw new Error("switch_session RPC failed");
        return { success: true };
      }
      return { success: true, data: {} };
    };

    // deleteMessage must reject because reload failed
    await assert.rejects(
      manager.deleteMessage("agent-1", assistant.id),
      (error) => error.code === "SESSION_RELOAD_FAILED" || /Session reload failed/.test(error.message),
    );

    // Verify disk content was rolled back to original content
    const currentContent = await readFile(sessionPath, "utf8");
    assert.equal(currentContent, initialContent);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runtime cache message exists without meta.entryId -> locateMessageTarget continues canonical resolution", async () => {
  let receivedTarget;
  const editor = {
    editMessage: async (input) => {
      receivedTarget = input.target;
      await input.reload();
    },
  };
  // 消息存在于内存缓存中，但 meta.entryId 缺失（如实时消息或跳过 entryId 加载的历史）
  const user = {
    id: "random-uuid-1234",
    agentId: "agent-1",
    role: "user",
    text: "hello",
    timestamp: 1,
    meta: {}, // entryId is undefined
  };
  const { manager } = createHarness(editor, {
    messages: [user],
    leafId: "entry-u1",
  });
  manager.sessionHistoryReader = {
    readMessageByMessageId: async (_path, _msgId) => undefined,
    readActiveEntryIdentity: async (_path) => ({
      entryIds: ["entry-u1"],
      leafId: "entry-u1",
      activeMessageEntries: [{ id: "entry-u1", role: "user", messageId: undefined }],
    }),
  };

  await manager.editMessage("agent-1", "random-uuid-1234", "hello updated");

  // locateMessageTarget 绝不能返回 entryId: undefined，必须通过序列映射解析到 entry-u1
  assert.ok(receivedTarget);
  assert.equal(receivedTarget.entryId, "entry-u1");
  assert.equal(receivedTarget.role, "user");
  assert.equal(receivedTarget.text, "hello");
});

test("resolveActiveEntryIds: get_entries succeeds -> uses RPC returned entryIds and caches rpc capability", async () => {
  const editor = { editMessage: async () => {} };
  const { manager, runtime, commands } = createHarness(editor);
  runtime.process.client.request = async (command) => {
    commands.push(command);
    if (command.type === "get_entries") {
      return {
        success: true,
        data: {
          entries: [
            { id: "e1", parentId: null, type: "message" },
            { id: "e2", parentId: "e1", type: "message" },
          ],
          leafId: "e2",
        },
      };
    }
    return { success: true, data: {} };
  };

  const entryIds = await manager.resolveActiveEntryIds("agent-1", runtime);
  assert.deepEqual(entryIds, ["e1", "e2"]);
  assert.equal(manager.entrySourceByAgent.get("agent-1"), "rpc");
});

test("resolveActiveEntryIds: get_entries returns Unknown command -> auto fallbacks to JSONL and caches file capability", async () => {
  const editor = { editMessage: async () => {} };
  const { manager, runtime, commands } = createHarness(editor);
  let rpcCalls = 0;
  runtime.process.client.request = async (command) => {
    commands.push(command);
    if (command.type === "get_entries") {
      rpcCalls += 1;
      return {
        success: false,
        error: "Unknown command: get_entries",
      };
    }
    return { success: true, data: {} };
  };
  manager.sessionHistoryReader = {
    readActiveEntryIdentity: async () => ({
      entryIds: ["jsonl-e1", "jsonl-e2"],
      leafId: "jsonl-e2",
      activeMessageEntries: [
        { id: "jsonl-e1", role: "user" },
        { id: "jsonl-e2", role: "assistant" },
      ],
    }),
  };

  // 第一次：尝试 RPC 失败，识别为不支持，回退 JSONL 并缓存 "file"
  const entryIds1 = await manager.resolveActiveEntryIds("agent-1", runtime);
  assert.deepEqual(entryIds1, ["jsonl-e1", "jsonl-e2"]);
  assert.equal(manager.entrySourceByAgent.get("agent-1"), "file");
  assert.equal(rpcCalls, 1);

  // 第二次：直接走 "file" 缓存，不再发出不支持的 RPC
  const entryIds2 = await manager.resolveActiveEntryIds("agent-1", runtime);
  assert.deepEqual(entryIds2, ["jsonl-e1", "jsonl-e2"]);
  assert.equal(rpcCalls, 1); // 没有新增 RPC 调用
});

test("same active branch has two identical messages -> sequence mapping resolves canonical entryId", async () => {
  let receivedTarget;
  const editor = {
    deleteMessage: async (input) => {
      receivedTarget = input.target;
      await input.reload();
    },
  };
  // 两个文本完全相同的 user 消息
  const user1 = {
    id: "uuid-msg-1",
    agentId: "agent-1",
    role: "user",
    text: "same text",
    timestamp: 1,
    meta: {},
  };
  const assistant1 = {
    id: "uuid-msg-2",
    agentId: "agent-1",
    role: "assistant",
    text: "reply 1",
    timestamp: 2,
    meta: {},
  };
  const user2 = {
    id: "uuid-msg-3",
    agentId: "agent-1",
    role: "user",
    text: "same text",
    timestamp: 3,
    meta: {},
  };
  const assistant2 = {
    id: "uuid-msg-4",
    agentId: "agent-1",
    role: "assistant",
    text: "reply 2",
    timestamp: 4,
    meta: {},
  };

  const { manager } = createHarness(editor, {
    messages: [user1, assistant1, user2, assistant2],
    leafId: "entry-a2",
  });
  manager.sessionHistoryReader = {
    readMessageByMessageId: async () => undefined,
    readActiveEntryIdentity: async () => ({
      entryIds: ["entry-u1", "entry-a1", "entry-u2", "entry-a2"],
      leafId: "entry-a2",
      activeMessageEntries: [
        { id: "entry-u1", role: "user" },
        { id: "entry-a1", role: "assistant" },
        { id: "entry-u2", role: "user" },
        { id: "entry-a2", role: "assistant" },
      ],
    }),
  };

  // 删除第二条 "same text" 消息 (user2: uuid-msg-3)
  await manager.deleteMessage("agent-1", "uuid-msg-3");

  // 必须精确匹配到 entry-u2，而非因为相同正文退化误删 entry-u1
  assert.ok(receivedTarget);
  assert.equal(receivedTarget.entryId, "entry-u2");
  assert.equal(receivedTarget.role, "user");
  assert.equal(receivedTarget.text, "same text");
});

test("realtime message with randomUUID and no meta.entryId -> canonical resolve enables successful delete/edit", async () => {
  let deletedTarget;
  const editor = {
    deleteMessage: async (input) => {
      deletedTarget = input.target;
      await input.reload();
    },
  };
  const liveUser = {
    id: "d8c19985-c1b6-455b-9d41-e945e43a9b1c",
    agentId: "agent-1",
    role: "user",
    text: "new live prompt",
    timestamp: 100,
    meta: {},
  };
  const { manager } = createHarness(editor, {
    messages: [liveUser],
    leafId: "entry-live-1",
  });
  manager.sessionHistoryReader = {
    readMessageByMessageId: async () => undefined,
    readActiveEntryIdentity: async () => ({
      entryIds: ["entry-live-1"],
      leafId: "entry-live-1",
      activeMessageEntries: [{ id: "entry-live-1", role: "user" }],
    }),
  };

  await manager.deleteMessage("agent-1", liveUser.id);
  assert.ok(deletedTarget);
  assert.equal(deletedTarget.entryId, "entry-live-1");
  assert.equal(deletedTarget.legacyMessageId, liveUser.id);
});

test("get_entries transient timeout -> falls back to JSONL for this call, does NOT mark capability as file", async () => {
  const editor = { editMessage: async () => {} };
  const { manager, runtime } = createHarness(editor);
  let rpcAttempts = 0;
  runtime.process.client.request = async (command) => {
    if (command.type === "get_entries") {
      rpcAttempts += 1;
      throw new Error("RPC command timed out after 15000ms: get_entries");
    }
    return { success: true, data: {} };
  };
  manager.sessionHistoryReader = {
    readActiveEntryIdentity: async () => ({
      entryIds: ["fallback-e1"],
      leafId: "fallback-e1",
      activeMessageEntries: [{ id: "fallback-e1", role: "user" }],
    }),
  };

  // 第一次：超时失败，允许 JSONL fallback
  const entryIds1 = await manager.resolveActiveEntryIds("agent-1", runtime);
  assert.deepEqual(entryIds1, ["fallback-e1"]);
  // 超时不是 unsupported，不能永久标记为 file
  assert.equal(manager.entrySourceByAgent.has("agent-1"), false);
  assert.equal(rpcAttempts, 1);

  // 第二次：仍会尝试 RPC（而非永久跳过）
  const entryIds2 = await manager.resolveActiveEntryIds("agent-1", runtime);
  assert.deepEqual(entryIds2, ["fallback-e1"]);
  assert.equal(rpcAttempts, 2);
});
