import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 回归测试：create 阶段 get_state 失败后，进程可能仍存活（isRunning === true），
 * 但 runtime 从未就绪——AgentManager 必须报告「不可恢复」（isRecoverableErrorRuntime === false），
 * 协调器才会继续按启动失败处理（停止 + 不绑定），不能把半启动进程当作可继续使用的 error runtime。
 *
 * 背景：AgentManager.create 在 agents.set 之后才请求 get_state。
 * 若 get_state 超时，catch 只置 status = "error"，不杀进程。
 * 原 isRuntimeProcessAlive 只看进程存活，会把这种情况误判为可恢复。
 */

function createHarness({ getLocale, failGetState = true } = {}) {
  const processes = [];
  const sessionPath = join(process.cwd(), "test-session.jsonl");

  class MockPiProcess extends EventEmitter {
    constructor(_cwd, _settings, _unused, options) {
      super();
      this.options = options;
      this.started = false;
      this.client = {
        request: async ({ type }) => {
          if (type === "get_state" && failGetState) throw new Error("get_state timeout");
          return {
            success: true,
            data: type === "get_state"
              ? { sessionId: "pi-session", sessionFile: sessionPath }
              : { messages: [] },
          };
        },
      };
      processes.push(this);
    }
    async start() {
      this.started = true;
      return this.client;
    }
    isRunning() {
      return this.started;
    }
    getDiagnostics() {
      return { command: "pi", exitCode: null, stderr: [] };
    }
    stop() {
      this.started = false;
      this.removeAllListeners();
    }
  }

  const { AgentManager } = loadTsCommonJs("src/main/pi/AgentManager.ts", {
    stubs: {
      "./PiProcess": { PiProcess: MockPiProcess },
      "node:fs": { existsSync: () => false, statSync: () => ({ size: 0 }) },
      "node:fs/promises": { stat: async () => ({ size: 0, mtimeMs: 1 }) },
      "./SessionHistoryReader": {
        SessionHistoryReader: class {
          async getActiveEntryCount() { return 0; }
          async scanCompactions() { return { compactions: [] }; }
        },
      },
    },
  });

  const project = { id: "project", path: process.cwd(), name: "Test" };
  const manager = new AgentManager(
    () => project,
    () => {},
    { get: () => ({ rpcTimeout: 100, removedBuiltInExtensions: [] }) },
    { ensureTrustedDirectory: async () => {} },
    undefined, // rpcLogger
    undefined, // appLogger
    undefined, // sessionFileEditor
    () => "",  // translate
    undefined, // onBeforeAgentSpawn
    undefined, // securityStore
    undefined, // repairSessionFile
    undefined, // resolveSessionId
    getLocale ? { getLocale } : undefined, // platformDeps
  );
  return { manager, processes, sessionPath };
}

test("create with get_state failure: process is alive but runtime is not recoverable", async (t) => {
  const { manager, processes, sessionPath } = createHarness();
  t.after(() => manager.stopAll());

  const tab = await manager.create({
    projectId: "project",
    sessionPath,
    deckSessionId: "catalog-uuid",
  });

  assert.equal(tab.status, "error", "get_state failure must set error status");
  assert.equal(processes.length, 1, "one pi process was spawned");
  assert.equal(processes[0].isRunning(), true, "process is still alive after get_state failure");
  // 回归核心：启动失败 + 进程存活 ≠ 可恢复
  assert.equal(
    manager.isRecoverableErrorRuntime(tab.id),
    false,
    "startup-origin error must NOT be recoverable even when process is alive",
  );
});

test("create passes platform locale to PiProcess as uiLocale", async (t) => {
  const { manager, processes, sessionPath } = createHarness({
    getLocale: () => "en-US",
    failGetState: false,
  });
  t.after(() => manager.stopAll());

  await manager.create({ projectId: "project", sessionPath, deckSessionId: "catalog-uuid" });

  assert.equal(processes.length, 1, "one pi process spawned");
  assert.equal(
    processes[0].options.uiLocale,
    "en-US",
    "platformDeps.getLocale() must be passed as uiLocale to PiProcess",
  );
});
