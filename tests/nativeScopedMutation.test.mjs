import assert from "node:assert/strict";
import test from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { childPathEnvironment, environmentPath, qtBinDirectory } from "./helpers/native2BackendHarness.mjs";
import { nativeBuildPaths } from "./helpers/nativeBuildPaths.mjs";

const candidates = nativeBuildPaths("PiDeck-ScopedMutationTest", { pinned: process.env.PIDECK_SCOPED_MUTATION_TEST_EXECUTABLE });
const sources = ["xmake.lua", "native/tests/ScopedMutationTest.cpp", "native/src/NativeFileShell.cpp", "native/src/NativeFileShell.h",
  "native/common/ScopedMutation.cpp", "native/common/ScopedMutation.h", "native/common/ScopedMutationPosix.cpp", "native/backend/domain/fs/EntryLink.cpp"];
const executable = candidates.find((candidate) => existsSync(candidate) && sources.every((source) => statSync(candidate).mtimeMs >= statSync(source).mtimeMs));
if (!executable && process.env.PIDECK_REQUIRE_BACKEND_TESTS === "1") throw new Error("Build PiDeck-ScopedMutationTest before required native tests");
const env = childPathEnvironment(process.env, [qtBinDirectory(), environmentPath()].filter(Boolean).join(process.platform === "win32" ? ";" : ":"));

/** Every native operation and link points exclusively inside this disposable fixture. */
async function fixture(t, mode, { empty = false, configuredLink = false } = {}) {
  const base = mkdtempSync(join(tmpdir(), "pideck-scoped-"));
  const root = join(base, "root"), parent = join(root, "artifacts"), outside = join(base, "outside");
  mkdirSync(parent, { recursive: true }); mkdirSync(outside);
  const target = join(parent, "item.jsonl");
  const physicalTarget = join(realpathSync(parent), "item.jsonl");
  if (!empty) writeFileSync(target, "owned");
  writeFileSync(join(outside, "item.jsonl"), "outside sentinel");
  const alias = join(base, "configured-root");
  if (configuredLink) symlinkSync(root, alias, process.platform === "win32" ? "junction" : "dir");
  const child = spawn(executable, [mode, configuredLink ? alias : root, configuredLink ? join(alias, "artifacts", "item.jsonl") : target], { env: { ...env, HOME: base, XDG_DATA_HOME: join(base, "trash-data") }, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  const lines = [], waiting = [];
  const reader = createInterface({ input: child.stdout });
  reader.on("line", (line) => { const waiter = waiting.shift(); if (waiter) waiter(line); else lines.push(line); });
  let stderr = ""; child.stderr.on("data", (data) => { stderr += data; });
  const closed = new Promise((resolve, reject) => { child.once("close", resolve); child.once("error", reject); });
  const line = () => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`native operation stalled: ${stderr}`)), 5000);
    if (lines.length) { clearTimeout(timer); resolve(lines.shift()); }
    else waiting.push((value) => { clearTimeout(timer); resolve(value); });
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await closed; reader.close();
    await rm(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 });
  });
  const finish = async () => { child.stdin.end("go\n"); const result = await line(); assert.equal(await closed, 0, stderr); return result; };
  const release = async () => { child.stdin.write("go\n"); assert.equal(await line(), "released"); };
  const close = async () => { child.stdin.end("done\n"); assert.equal(await closed, 0, stderr); };
  assert.equal(await line(), "ready");
  return { base, root, parent, outside, target, physicalTarget, finish, release, close };
}
const skip = !executable;
test("native mutation refuses an ambiguous dot-dot source instead of guessing a lexical entry", { skip }, async (t) => {
  const base = mkdtempSync(join(tmpdir(), "pideck-scoped-dot-"));
  t.after(() => rm(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 }));
  const root = join(base, "root"), outside = join(base, "outside");
  mkdirSync(root); mkdirSync(join(outside, "deep"), { recursive: true });
  symlinkSync(join(outside, "deep"), join(root, "alias"), process.platform === "win32" ? "junction" : "dir");
  const decoy = join(root, "item.jsonl"), referent = join(outside, "item.jsonl");
  writeFileSync(decoy, "lexical decoy"); writeFileSync(referent, "outside sentinel");
  const result = spawnSync(executable, ["remove", root, `${root}/alias/../item.jsonl`], {
    env, windowsHide: true, input: "go\n", encoding: "utf8", timeout: 5000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(decoy), true, "must not remove the lexical decoy");
  assert.equal(readFileSync(referent, "utf8"), "outside sentinel");
  assert.match(result.stdout, /rejected/);
});

test("an explicitly configured root link retains its captured physical authority", { skip }, async (t) => {
  const f = await fixture(t, "remove", { configuredLink: true });
  assert.equal(await f.finish(), "removed");
  assert.equal(existsSync(f.target), false);
  assert.equal(readFileSync(join(f.outside, "item.jsonl"), "utf8"), "outside sentinel");
});
for (const mode of ["trash", "remove"]) test(`native ${mode} rejects a late parent link without touching its referent`, { skip }, async (t) => {
  const f = await fixture(t, mode);
  renameSync(f.parent, `${f.parent}.saved`);
  symlinkSync(f.outside, f.parent, process.platform === "win32" ? "junction" : "dir");
  assert.equal(await f.finish(), "rejected");
  assert.equal(readFileSync(join(f.outside, "item.jsonl"), "utf8"), "outside sentinel");
  assert.equal(readFileSync(join(`${f.parent}.saved`, "item.jsonl"), "utf8"), "owned");
});

test("native operation rejects replacement of the captured physical root", { skip }, async (t) => {
  const f = await fixture(t, "trash");
  renameSync(f.root, `${f.root}.saved`);
  mkdirSync(join(f.root, "artifacts"), { recursive: true });
  writeFileSync(f.target, "replacement sentinel");
  assert.equal(await f.finish(), "rejected");
  assert.equal(readFileSync(f.target, "utf8"), "replacement sentinel");
});

test("Windows guards deny both rename and in-place junction conversion, then release handles", { skip: skip || process.platform !== "win32" }, async (t) => {
  const f = await fixture(t, "hold", { empty: true });
  assert.throws(() => renameSync(f.parent, `${f.parent}.saved`), { code: /EPERM|EACCES|EBUSY/ });
  const attempt = () => spawnSync(executable, ["reparse", f.outside, f.parent], { env, windowsHide: true, encoding: "utf8", timeout: 5000 });
  const denied = attempt(); assert.equal(denied.status, 0); assert.equal(denied.stdout.trim(), "blocked");
  await f.release();
  const allowed = attempt(); assert.equal(allowed.status, 0); assert.equal(allowed.stdout.trim(), "changed");
  await f.close();
});

for (const mode of ["remove", "trash"]) test(`POSIX ${mode} cannot be redirected after descriptor admission`, { skip: skip || process.platform === "win32" }, async (t) => {
  const f = await fixture(t, `held-${mode}`);
  renameSync(f.parent, `${f.parent}.saved`); symlinkSync(f.outside, f.parent, "dir");
  assert.equal(await f.finish(), mode === "trash" ? "trashed" : "removed");
  assert.equal(existsSync(join(`${f.parent}.saved`, "item.jsonl")), false);
  assert.equal(readFileSync(join(f.outside, "item.jsonl"), "utf8"), "outside sentinel");
  if (mode === "trash") {
    const trash = process.platform === "darwin" ? join(f.base, ".Trash") : join(f.base, "trash-data", "Trash", "files");
    const names = readdirSync(trash);
    assert.equal(names.length, 1);
    assert.equal(readFileSync(join(trash, names[0]), "utf8"), "owned");
    if (process.platform !== "darwin") {
      const metadata = readFileSync(join(f.base, "trash-data", "Trash", "info", `${names[0]}.trashinfo`), "utf8");
      assert.ok(metadata.startsWith("[Trash Info]\n"));
      assert.equal(decodeURIComponent(metadata.split("\n").find((line) => line.startsWith("Path=")).slice(5)), f.physicalTarget);
    }
  }
});

test("native permanent removal deletes a directory link entry, not the outside tree", { skip }, async (t) => {
  const f = await fixture(t, "remove", { empty: true });
  symlinkSync(f.outside, f.target, process.platform === "win32" ? "junction" : "dir");
  assert.equal(await f.finish(), "removed");
  assert.equal(existsSync(f.target), false);
  assert.equal(readFileSync(join(f.outside, "item.jsonl"), "utf8"), "outside sentinel");
});
