import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createFakePiManager, loadAgentManagerWithFakePi } from "./helpers/l4_agentManagerHarness.mjs";
import { startCreateBackendHarness } from "./helpers/l4_createBackendHarness.mjs";
import { loadPiProcess } from "./helpers/loadPiProcess.mjs";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

// 纯函数模块（零依赖）直接编译加载
const { isLegacySessionNameEntry, isLegacySessionNameLine, stripLegacySessionNameLine, tryRestorePathGluedHeader } =
  loadTsCommonJs("src/main/sessions/sessionNameLine.ts");

// SessionScanner 依赖 electron（仅 app.getPath / shell），构造期需要桩
const { SessionScanner } = loadTsCommonJs("src/main/sessions/SessionScanner.ts", {
  stubs: {
    electron: {
      app: { getPath: () => tmpdir() },
      shell: {},
    },
  },
});

const SESSION_HEADER = JSON.stringify({
  type: "session",
  version: 3,
  id: "019fb217-0707-7853-a111-eabbfaceceb4",
  timestamp: "2026-07-30T08:14:41.416Z",
  cwd: "C:\\workspace",
});
const LEGACY_NAME_LINE = JSON.stringify({ sessionName: "你是什么模型123", ts: 1785405142248 });
const MESSAGE_LINE = JSON.stringify({
  type: "message",
  id: "aa192fae",
  parentId: null,
  timestamp: "2026-07-30T08:14:57.481Z",
  message: { role: "user", content: [{ type: "text", text: "你是什么模型" }] },
});

function damagedSessionText() {
  return [LEGACY_NAME_LINE, SESSION_HEADER, MESSAGE_LINE].join("\n") + "\n";
}

function healthySessionText() {
  return [SESSION_HEADER, MESSAGE_LINE].join("\n") + "\n";
}

// ── 纯函数：识别与剔除 ─────────────────────────────────────────

test("isLegacySessionNameEntry 识别旧版私有行（有 sessionName 且无 type）", () => {
  assert.equal(isLegacySessionNameEntry({ sessionName: "x", ts: 1 }), true);
  // pi 原生记录一律有 type，即使带 sessionName 也不算私有行
  assert.equal(isLegacySessionNameEntry({ type: "session_info", name: "x" }), false);
  assert.equal(isLegacySessionNameEntry({ type: "session", id: "abc" }), false);
  assert.equal(isLegacySessionNameEntry(null), false);
  assert.equal(isLegacySessionNameEntry("str"), false);
  assert.equal(isLegacySessionNameEntry([{ sessionName: "x" }]), false);
  // sessionName 非字符串不算
  assert.equal(isLegacySessionNameEntry({ sessionName: 123 }), false);
});

test("isLegacySessionNameLine 容忍不可解析的行", () => {
  assert.equal(isLegacySessionNameLine('{"sessionName":"x","ts":1}'), true);
  assert.equal(isLegacySessionNameLine("not json at all"), false);
  assert.equal(isLegacySessionNameLine(""), false);
});

test("stripLegacySessionNameLine 剔除私有行并保留其余内容与顺序", () => {
  const stripped = stripLegacySessionNameLine(damagedSessionText());
  assert.equal(stripped, healthySessionText());
});

test("stripLegacySessionNameLine 处理 CRLF、空行与不可解析行", () => {
  const raw = [
    "",
    LEGACY_NAME_LINE,
    SESSION_HEADER,
    "broken line without json",
    MESSAGE_LINE,
    "",
  ].join("\r\n") + "\r\n";
  const stripped = stripLegacySessionNameLine(raw);
  assert.deepEqual(stripped.split("\n").filter((line) => line), [
    SESSION_HEADER,
    "broken line without json",
    MESSAGE_LINE,
  ]);
});

test("stripLegacySessionNameLine 全私有行文件返回空串", () => {
  assert.equal(stripLegacySessionNameLine(LEGACY_NAME_LINE + "\n"), "");
  assert.equal(stripLegacySessionNameLine(""), "");
});

// ── SessionScanner.repairLegacySessionNameLine ──────────────────

function withTempSessionFile(content) {
  const dir = mkdtempSync(join(tmpdir(), "pideck-session-repair-"));
  const filePath = join(dir, "session.jsonl");
  writeFileSync(filePath, content, "utf8");
  return { dir, filePath };
}

test("repairCorruptSessionHeader 修复被私有头行破坏的会话文件", async () => {
  const scanner = new SessionScanner();
  const { dir, filePath } = withTempSessionFile(damagedSessionText());
  try {
    assert.equal(await scanner.repairCorruptSessionHeader(filePath), true, "应报告已修复");
    assert.equal(readFileSync(filePath, "utf8"), healthySessionText());
  } finally {
    // 清理临时目录（rmSync 在 node 18+ 可用）
    const { rmSync } = await import("node:fs");
    rmSync(dir, { recursive: true, force: true });
  }
});

test("repairCorruptSessionHeader 健康文件不落盘、返回 false", async () => {
  const scanner = new SessionScanner();
  const { dir, filePath } = withTempSessionFile(healthySessionText());
  try {
    assert.equal(await scanner.repairCorruptSessionHeader(filePath), false);
    assert.equal(readFileSync(filePath, "utf8"), healthySessionText(), "内容不得被改写");
  } finally {
    const { rmSync } = await import("node:fs");
    rmSync(dir, { recursive: true, force: true });
  }
});

test("repairCorruptSessionHeader 头部大行不误判（首条为正常 session 头）", async () => {
  const scanner = new SessionScanner();
  // 模拟超长首条记录（接近/超过 4KB 探测窗口）：必须是可解析 JSON，且不是私有行
  const longHeader = JSON.stringify({
    type: "session",
    version: 3,
    id: "long-header-session",
    timestamp: "2026-07-30T08:14:41.416Z",
    cwd: "x".repeat(6000),
  });
  const { dir, filePath } = withTempSessionFile(`${longHeader}\n${MESSAGE_LINE}\n`);
  try {
    assert.equal(await scanner.repairCorruptSessionHeader(filePath), false);
  } finally {
    const { rmSync } = await import("node:fs");
    rmSync(dir, { recursive: true, force: true });
  }
});

test("repairCorruptSessionHeader 文件不存在时抛错（由 PiProcess 启动预检捕获）", async () => {
  const scanner = new SessionScanner();
  await assert.rejects(
    () => scanner.repairCorruptSessionHeader(join(tmpdir(), "no-such-pideck-session.jsonl")),
  );
});

// ── 首行路径粘连修复（2026-08 现场：路径与 session header 无换行粘连）──

function gluedFirstLineSessionText() {
  // 完整复刻用户现场：首行 = 文件路径 + session header 无换行，其后是正常记录
  return [
    `C:\\Users\\14012\\.pi\\agent\\sessions\\--D--project-github-pi-desktop--\\2026-08-12T03-52-21-371Z_019ff419-867b-7ae0-bb91-d0a31638a319.jsonl${SESSION_HEADER}`,
    MESSAGE_LINE,
  ].join("\n") + "\n";
}

test("tryRestorePathGluedHeader 剥离路径前缀并校验 session header", () => {
  const head = gluedFirstLineSessionText();
  assert.equal(tryRestorePathGluedHeader(head), SESSION_HEADER);
  // 非粘连（正常首行）不命中
  assert.equal(tryRestorePathGluedHeader(healthySessionText()), null);
  // 有 .jsonl{ 但 JSON 不是 session 头（如消息记录）不命中
  assert.equal(tryRestorePathGluedHeader(`C:\\x.jsonl${MESSAGE_LINE}\n`), null);
  // JSON 不完整（4KB 窗口截断）不命中
  assert.equal(tryRestorePathGluedHeader(`C:\\x.jsonl{"type":"session","id":"abc",`), null);
});

test("repairCorruptSessionHeader 修复首行路径粘连文件", async () => {
  const scanner = new SessionScanner();
  const { dir, filePath } = withTempSessionFile(gluedFirstLineSessionText());
  try {
    assert.equal(await scanner.repairCorruptSessionHeader(filePath), true, "应报告已修复");
    assert.equal(readFileSync(filePath, "utf8"), [SESSION_HEADER, MESSAGE_LINE].join("\n") + "\n");
  } finally {
    const { rmSync } = await import("node:fs");
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 装配链路（行为）──────────────────────────────────────────────

function createPiLocator(command = "/usr/bin/pi") {
  return {
    resolveCommand: () => command,
    createInvocation: (_command, args) => ({ command, args: [...args], shell: false }),
    createProcessEnv: () => ({}),
  };
}

test("PiProcess 在 spawn 前调用修复回调（带会话路径）", async () => {
  const spawnCalls = [];
  const events = [];
  const { PiProcess } = loadPiProcess(spawnCalls);
  const pi = new PiProcess("/tmp/project", {}, createPiLocator(), {
    repairSessionFileBeforeStart: async (sessionPath) => {
      // 记录回调触发时已发生的 spawn 数：必须为 0，才算“spawn 之前”
      events.push({ sessionPath, spawnedBefore: spawnCalls.length });
      return true;
    },
  });
  await pi.start("/tmp/project/.pi/sessions/a.jsonl");
  assert.deepEqual(events, [{ sessionPath: "/tmp/project/.pi/sessions/a.jsonl", spawnedBefore: 0 }]);
  assert.equal(spawnCalls.length, 1, "修复之后仍必须 spawn");
});

test("PiProcess 修复回调失败不阻塞启动", async () => {
  const spawnCalls = [];
  const { PiProcess } = loadPiProcess(spawnCalls);
  const pi = new PiProcess("/tmp/project", {}, createPiLocator(), {
    repairSessionFileBeforeStart: async () => {
      throw new Error("disk is read-only");
    },
  });
  await pi.start("/tmp/project/.pi/sessions/a.jsonl");
  assert.equal(spawnCalls.length, 1, "预检失败后仍要 spawn，让 pi 自己的报错进入诊断");
});

test("PiProcess 无会话路径或 noSession 时不调用修复回调", async () => {
  for (const [sessionPath, noSession] of [[undefined, false], ["/tmp/project/a.jsonl", true]]) {
    const spawnCalls = [];
    const repairs = [];
    const { PiProcess } = loadPiProcess(spawnCalls);
    const pi = new PiProcess("/tmp/project", {}, createPiLocator(), {
      repairSessionFileBeforeStart: async (path) => {
        repairs.push(path);
        return false;
      },
    });
    await pi.start(sessionPath, undefined, noSession);
    assert.deepEqual(repairs, [], `sessionPath=${sessionPath} noSession=${noSession}`);
    assert.equal(spawnCalls.length, 1);
  }
});

test("AgentManager 把修复回调注入每条 spawn 路径的 PiProcess", async () => {
  const repaired = [];
  const harness = loadAgentManagerWithFakePi();
  const manager = createFakePiManager(harness, {
    repairSessionFile: async (sessionPath) => {
      repaired.push(sessionPath);
      return true;
    },
  });
  await manager.create({ projectId: "p1" });
  await manager.cloneSessionFile("p1", "/proj/s.jsonl");
  assert.equal(harness.constructed.length >= 2, true, "create 与 clone 各构造一个 PiProcess");
  for (const { options } of harness.constructed) {
    assert.equal(typeof options.repairSessionFileBeforeStart, "function");
    await options.repairSessionFileBeforeStart("/x.jsonl");
  }
  assert.equal(repaired.length, harness.constructed.length, "注入的是装配时传入的同一个回调");
});

test("createBackend 把 SessionScanner.repairCorruptSessionHeader 装配为 AgentManager 的修复回调", async () => {
  const harness = await startCreateBackendHarness();
  try {
    assert.equal(harness.agentManagerArgs.length, 1);
    // 第 11 个构造参数 = repairSessionFile（见 AgentManager 构造函数）
    const repairSessionFile = harness.agentManagerArgs[0][10];
    assert.equal(typeof repairSessionFile, "function");
    assert.equal(await repairSessionFile("/p/s.jsonl"), true);
    assert.deepEqual(harness.scanners[0].repairCalls, ["/p/s.jsonl"]);
  } finally {
    await harness.dispose();
  }
});

test("rename 与修复共用同一剔除判定：重命名同样清掉旧版私有行", async () => {
  const scanner = new SessionScanner();
  const { dir, filePath } = withTempSessionFile(damagedSessionText());
  try {
    await scanner.rename(filePath, "新名字");
    const lines = readFileSync(filePath, "utf8").split("\n").filter((line) => line);
    assert.equal(lines.some((line) => isLegacySessionNameLine(line)), false, "私有 sessionName 行必须被剔除");
    assert.deepEqual(lines.slice(0, 2), [SESSION_HEADER, MESSAGE_LINE], "其余记录与顺序保持不变");
    const info = JSON.parse(lines[2]);
    assert.equal(info.type, "session_info");
    assert.equal(info.name, "新名字");
  } finally {
    const { rmSync } = await import("node:fs");
    rmSync(dir, { recursive: true, force: true });
  }
});