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
      if (specifier === "./SessionHistoryReader") return { SessionHistoryReader: class {} };
      if (specifier === "./AgentMessageProjector") {
        return {
          AgentMessageProjector: class {},
          buildActiveBranchEntryIds: () => [],
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
