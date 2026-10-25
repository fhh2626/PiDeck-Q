import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

function loadModule() {
  const source = readFileSync("src/shared/sessionIdentity.ts", "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: "sessionIdentity.ts",
  }).outputText;
  const sandbox = { exports: {}, module: { exports: {} } };
  sandbox.exports = sandbox.module.exports;
  vm.runInNewContext(output, sandbox, { filename: "sessionIdentity.ts" });
  return sandbox.module.exports;
}

function loadAgentIdentity() {
  const identity = loadModule();
  const filePath = "src/main/pi/agentSessionIdentity.ts";
  const output = ts.transpileModule(readFileSync(filePath, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: filePath,
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(output, {
    module,
    exports: module.exports,
    require: (specifier) => {
      if (specifier === "../../shared/sessionIdentity") return identity;
      throw new Error(`Unexpected import: ${specifier}`);
    },
  }, { filename: filePath });
  return module.exports;
}

test("canonicalizes native session paths without collapsing WSL case", () => {
  const { canonicalizeSessionPath } = loadModule();
  assert.equal(
    canonicalizeSessionPath("C:\\Users\\Dev\\.pi\\sessions\\A.jsonl/", "native"),
    "c:/users/dev/.pi/sessions/a.jsonl",
  );
  assert.equal(
    canonicalizeSessionPath("/home/dev/.pi/sessions/Case.jsonl/", "wsl"),
    "/home/dev/.pi/sessions/Case.jsonl",
  );
});

test("keeps source and WSL identity in the session origin key", () => {
  const { buildSessionOriginKey } = loadModule();
  const native = buildSessionOriginKey({
    source: "pi",
    environment: "native",
    filePath: "C:\\Users\\Dev\\session.jsonl",
  });
  const wsl = buildSessionOriginKey({
    source: "pi",
    environment: "wsl",
    filePath: "/mnt/c/Users/Dev/session.jsonl",
    wslDistro: "Ubuntu",
    wslUser: "dev",
  });
  const imported = buildSessionOriginKey({
    source: "codex",
    environment: "native",
    filePath: "C:\\Users\\Dev\\session.jsonl",
    importedSourceId: "thread-1",
  });
  assert.notEqual(native, wsl);
  assert.notEqual(native, imported);
  assert.match(wsl, /^pi:wsl:Ubuntu:dev:/);
});

test("AgentManager keys preserve WSL case and identity at the process boundary", () => {
  const { buildAgentSessionKey } = loadAgentIdentity();
  const defaults = {
    environment: "wsl",
    wslDistro: "Ubuntu",
    wslUser: "dev",
  };
  const upper = buildAgentSessionKey({
    projectId: "project-1",
    sessionPath: "/home/dev/Case.jsonl",
  }, defaults);
  const lower = buildAgentSessionKey({
    projectId: "project-1",
    sessionPath: "/home/dev/case.jsonl",
  }, defaults);
  const otherDistro = buildAgentSessionKey({
    projectId: "project-1",
    sessionPath: "/home/dev/Case.jsonl",
    wslDistro: "Debian",
  }, defaults);
  assert.notEqual(upper, lower);
  assert.notEqual(upper, otherDistro);
});

const { AgentManager } = loadTsCommonJs("src/main/pi/AgentManager.ts");

/**
 * AgentManager 的“一个 sessionPath 只对应一个 Agent”去重必须使用 WSL 感知的会话身份键。
 * createUnlocked（真实拉起 pi 子进程）被替换为计数桩：测试只观察去重决策。
 */
function createDedupHarness({ wsl = true } = {}) {
  const manager = new AgentManager(
    () => ({ id: "project-1", name: "Project", path: "C:/project" }),
    () => null,
    { get: () => ({}) },
    {},
  );
  if (wsl) manager.configureWsl({ distro: "Ubuntu", user: "dev", linuxHome: "/home/dev", windowsHome: "C:\\Users\\dev" });
  const created = [];
  manager.createUnlocked = async (input) => {
    await new Promise((resolve) => setImmediate(resolve));
    const tab = { id: `agent-${created.length + 1}`, projectId: input.projectId, sessionPath: input.sessionPath };
    created.push(input.sessionPath);
    return tab;
  };
  return { manager, created };
}

test("AgentManager.create deduplicates concurrent creations of the same WSL session", async () => {
  const { manager, created } = createDedupHarness();
  const input = { projectId: "project-1", sessionPath: "/home/dev/Case.jsonl" };
  const [first, second] = await Promise.all([manager.create(input), manager.create({ ...input })]);
  assert.equal(first, second);
  assert.deepEqual(created, ["/home/dev/Case.jsonl"]);
});

test("AgentManager.create keeps WSL sessions that differ only by path case separate", async () => {
  const { manager, created } = createDedupHarness();
  await Promise.all([
    manager.create({ projectId: "project-1", sessionPath: "/home/dev/Case.jsonl" }),
    manager.create({ projectId: "project-1", sessionPath: "/home/dev/case.jsonl" }),
  ]);
  assert.deepEqual([...created].sort(), ["/home/dev/Case.jsonl", "/home/dev/case.jsonl"]);
});

test("AgentManager.create reuses a live runtime whose WSL identity matches exactly", async () => {
  const { manager, created } = createDedupHarness();
  const liveTab = {
    id: "live", projectId: "project-1", sessionPath: "/home/dev/Case.jsonl",
    sessionEnvironment: "wsl", sessionSource: "pi", wslDistro: "Ubuntu", wslUser: "dev",
  };
  manager.agents.set("live", { tab: liveTab });
  assert.equal(await manager.create({ projectId: "project-1", sessionPath: "/home/dev/Case.jsonl" }), liveTab);
  assert.deepEqual(created, []);
  // 大小写不同 = 不同文件（Linux 区分大小写），不能误复用
  await manager.create({ projectId: "project-1", sessionPath: "/home/dev/case.jsonl" });
  assert.deepEqual(created, ["/home/dev/case.jsonl"]);
});

test("AgentManager.create treats native paths differing only by case as one session", async () => {
  const { manager, created } = createDedupHarness({ wsl: false });
  const liveTab = {
    id: "live", projectId: "project-1", sessionPath: "C:\\Users\\Dev\\A.jsonl",
    sessionEnvironment: "native", sessionSource: "pi",
  };
  manager.agents.set("live", { tab: liveTab });
  assert.equal(await manager.create({ projectId: "project-1", sessionPath: "c:/users/dev/a.jsonl" }), liveTab);
  assert.deepEqual(created, []);
});

// ── toAbsoluteSessionPath（相对 sessionFile 归一化）──────────────
// 回归背景：pi 的 sessionDir 配置为 ".pi/sessions" 时，get_state 返回的
// sessionFile 是相对 cwd 的；原样写入 catalog 会与扫描器绝对路径构成同文件双记录
// （侧栏重复显示两个会话），且文件操作落到错误位置。

test("resolves a native relative sessionFile against the project path", () => {
  const { toAbsoluteSessionPath } = loadModule();
  assert.equal(
    toAbsoluteSessionPath(".pi\\sessions\\2026-08-08T10-47-19-239Z_abc.jsonl", "D:\\Project\\PiDeck", "native"),
    "D:\\Project\\PiDeck\\.pi\\sessions\\2026-08-08T10-47-19-239Z_abc.jsonl",
  );
});

test("resolves native relative paths with forward slashes and normalizes output to backslashes", () => {
  const { toAbsoluteSessionPath } = loadModule();
  assert.equal(
    toAbsoluteSessionPath(".pi/sessions/session.jsonl", "D:/Project/PiDeck", "native"),
    "D:\\Project\\PiDeck\\.pi\\sessions\\session.jsonl",
  );
});

test("passes through already-absolute native and WSL paths", () => {
  const { toAbsoluteSessionPath } = loadModule();
  assert.equal(
    toAbsoluteSessionPath("C:\\Users\\dev\\.pi\\sessions\\a.jsonl", "D:\\Project", "native"),
    "C:\\Users\\dev\\.pi\\sessions\\a.jsonl",
  );
  assert.equal(
    toAbsoluteSessionPath("/mnt/d/Project/.pi/sessions/a.jsonl", "D:\\Project", "wsl"),
    "/mnt/d/Project/.pi/sessions/a.jsonl",
  );
});

test("resolves a WSL relative sessionFile against the /mnt/<drive> project base", () => {
  const { toAbsoluteSessionPath } = loadModule();
  assert.equal(
    toAbsoluteSessionPath(".pi/sessions/session.jsonl", "D:\\Project\\PiDeck", "wsl"),
    "/mnt/d/Project/PiDeck/.pi/sessions/session.jsonl",
  );
});

test("relative and absolute forms canonicalize to the same origin key", () => {
  const { buildSessionOriginKey, toAbsoluteSessionPath } = loadModule();
  const relative = buildSessionOriginKey({
    source: "pi",
    environment: "native",
    filePath: toAbsoluteSessionPath(".pi/sessions/session.jsonl", "D:\\Project\\PiDeck", "native"),
  });
  const absolute = buildSessionOriginKey({
    source: "pi",
    environment: "native",
    filePath: "D:\\Project\\PiDeck\\.pi\\sessions\\session.jsonl",
  });
  assert.equal(relative, absolute);
});
