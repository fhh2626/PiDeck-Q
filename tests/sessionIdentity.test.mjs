import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
