import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

// Exercise the real embedded POSIX program, not only the fake distribution's model.
// Git Bash is a local Windows shell. Never fall back to bash.exe/WSL from WindowsApps.
const git = process.platform === "win32" ? spawnSync("git", ["--exec-path"], { windowsHide: true, encoding: "utf8", timeout: 5000 }) : null;
const candidate = process.platform === "win32" && git?.status === 0
  ? resolve(git.stdout.trim(), "../../../bin/bash.exe") : "/bin/sh";
const shell = existsSync(candidate) ? candidate : "";
const source = readFileSync("native/backend/domain/runtime/DeletionIdentity.cpp", "utf8");
const declaration = source.match(/const QString IDENTITY_SCRIPT = QStringLiteral\(([\s\S]*?)\);\s*\n/);
assert.ok(declaration, "The embedded identity program must be available for executable regression coverage");
const script = [...declaration[1].matchAll(/"(?:[^"\\]|\\.)*"/g)].map(([literal]) => JSON.parse(literal)).join("");
const posixPath = (path) => process.platform === "win32"
  ? path.replaceAll("\\", "/").replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`) : path;

/** Run the production program with literal argv and inspect its NUL-framed identities. */
function identities(paths) {
  const result = spawnSync(shell, ["-c", script, "pideck-delete-identities", ...paths.map(posixPath)], { windowsHide: true, encoding: "utf8", timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  const fields = result.stdout.split("\0");
  assert.equal(fields.length, paths.length * 2 + 1);
  return paths.map((path, index) => {
    assert.equal(fields[index * 2], posixPath(path));
    return fields[index * 2 + 1];
  });
}

/** Each program invocation owns a disposable directory with no real session data. */
function directory(t) {
  const root = mkdtempSync(join(tmpdir(), "pideck-identity-shell-"));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  return root;
}

const skip = shell ? false : "A local POSIX shell with GNU realpath/stat is unavailable";
test("production identity script distinguishes missing leaves, unknown ancestors and dangling links", { skip }, (t) => {
  const root = directory(t);
  const file = join(root, "中文 $ (literal).jsonl"); writeFileSync(file, "data");
  const missing = join(root, "missing.jsonl"), unknown = join(root, "missing-parent", "unknown.jsonl");
  const answers = identities([file, missing, unknown]);
  assert.equal(answers[0], posixPath(file));
  assert.equal(answers[1], posixPath(missing));
  assert.equal(answers[2], "");
  const target = join(root, "target"), dangling = join(root, "dangling");
  mkdirSync(target); symlinkSync(target, dangling, process.platform === "win32" ? "junction" : "dir");
  rmSync(target, { recursive: true });
  assert.equal(identities([dangling])[0], "");
});

test("production identity script preserves newlines in symlink-resolved target names", { skip }, (t) => {
  const root = directory(t), target = join(root, "tail\n"), alias = join(root, "alias");
  try { mkdirSync(target); } catch (error) {
    if (process.platform === "win32" && error.code === "EINVAL") {
      t.skip("Windows filesystem rejects newline names; backend framing regression covers the synthetic WSL identity");
      return;
    }
    throw error;
  }
  symlinkSync(target, alias, process.platform === "win32" ? "junction" : "dir");
  assert.equal(identities([alias])[0], posixPath(target));
});

test("production identity script never treats permission-denied lookup as a missing leaf", {
  skip: skip || (process.platform === "win32" || process.getuid?.() === 0
    ? "Requires non-root POSIX directory search permissions" : false),
}, (t) => {
  const root = directory(t), restricted = join(root, "restricted"), target = join(root, "target.jsonl");
  mkdirSync(restricted); writeFileSync(target, "data");
  const alias = join(restricted, "alias.jsonl"); symlinkSync(target, alias);
  chmodSync(restricted, 0o000);
  try { assert.equal(identities([alias])[0], ""); }
  finally { chmodSync(restricted, 0o700); }
});
