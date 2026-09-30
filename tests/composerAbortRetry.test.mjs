import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

const nodeRequire = createRequire(import.meta.url);

function compileModule(filePath, imports = {}) {
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
    require: (specifier) => imports[specifier] ?? nodeRequire(specifier),
    console,
    Date,
  }, { filename: filePath });
  return module.exports;
}

const { resolveAbortRetry, toSessionRuntimeTarget } = compileModule(
  "src/renderer/src/utils/sessionCommands.ts",
  { "../i18n": { t: (key) => key } },
);

// vm realm 里的对象原型与字面量不同，deepStrictEqual 会误判，逐字段断言。
function assertTarget(actual, expected) {
  assert.ok(actual, "必须返回可派发 target");
  assert.equal(actual.sessionId, expected.sessionId);
  assert.equal(actual.agentId, expected.agentId);
  assert.equal(actual.runtimeGeneration, expected.runtimeGeneration);
}

const first = { sessionId: "session-a", agentId: "agent-a", runtimeGeneration: 1 };

/**
 * abort 命中断代后的重试规则（composer 停止按钮「点了没反应」修复）：
 * 点击到命令到达之间 runtime 可能已换绑，旧 target 被拒时 AgentManager.abort
 * 根本不会执行。只对「代际确实变了」这一种原因重试一次。
 */
test("resolveAbortRetry: 非 SESSION_RUNTIME_CHANGED 一律不重试", () => {
  const latest = { agentId: "agent-b", runtimeGeneration: 2 };
  for (const code of [
    undefined,
    "SESSION_NOT_FOUND",
    "SESSION_RUNTIME_UNAVAILABLE",
    "SESSION_RUNTIME_BUSY",
    "SESSION_COMMAND_FAILED",
    "SESSION_MODEL_NOT_FOUND",
    "MESSAGE_NOT_FOUND",
  ]) {
    assert.equal(
      resolveAbortRetry(code, first, latest, "session-a"),
      undefined,
      `code=${String(code)} 不得自动重试`,
    );
  }
});

test("resolveAbortRetry: 断代但拿不到新绑定时不重试（避免空转）", () => {
  assert.equal(resolveAbortRetry("SESSION_RUNTIME_CHANGED", first, undefined, "session-a"), undefined);
  // 只有 agentId 或只有 generation 都不构成可派发的 target。
  assert.equal(
    resolveAbortRetry("SESSION_RUNTIME_CHANGED", first, { agentId: "agent-b" }, "session-a"),
    undefined,
  );
  assert.equal(
    resolveAbortRetry("SESSION_RUNTIME_CHANGED", first, { runtimeGeneration: 2 }, "session-a"),
    undefined,
  );
});

test("resolveAbortRetry: 代际与 agent 都没变则不重试（不撞同一结果）", () => {
  assert.equal(
    resolveAbortRetry(
      "SESSION_RUNTIME_CHANGED",
      first,
      { agentId: "agent-a", runtimeGeneration: 1 },
      "session-a",
    ),
    undefined,
  );
});

test("resolveAbortRetry: 代际推进时返回最新绑定，并沿用调用方 sessionId", () => {
  const retried = resolveAbortRetry(
    "SESSION_RUNTIME_CHANGED",
    first,
    { agentId: "agent-b", runtimeGeneration: 2 },
    "session-a",
  );
  assertTarget(retried, {
    sessionId: "session-a",
    agentId: "agent-b",
    runtimeGeneration: 2,
  });

  // 同一 agent 换绑（重启后 agentId 可能复用，generation 递增）也必须能重试。
  const sameAgent = resolveAbortRetry(
    "SESSION_RUNTIME_CHANGED",
    first,
    { agentId: "agent-a", runtimeGeneration: 2 },
    "session-a",
  );
  assertTarget(sameAgent, {
    sessionId: "session-a",
    agentId: "agent-a",
    runtimeGeneration: 2,
  });
});

test("toSessionRuntimeTarget: 缺 agentId/generation 时不产出可派发目标", () => {
  assert.equal(toSessionRuntimeTarget("session-a", undefined), undefined);
  assertTarget(toSessionRuntimeTarget("session-a", { agentId: "a", runtimeGeneration: 0 }), {
    sessionId: "session-a",
    agentId: "a",
    runtimeGeneration: 0,
  });
});
