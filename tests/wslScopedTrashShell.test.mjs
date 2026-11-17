import assert from "node:assert/strict";
import test from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";

// Execute the actual embedded Linux program locally. Never invoke a real WSL distro.
const git = process.platform === "win32" ? spawnSync("git", ["--exec-path"], { windowsHide: true, encoding: "utf8", timeout: 5000 }) : null;
const candidate = process.platform === "win32" && git?.status === 0 ? resolve(git.stdout.trim(), "../../../bin/bash.exe") : "/bin/sh";
const skip = process.platform === "darwin" || !existsSync(candidate) ? "Requires Linux /proc or local Git Bash" : false;
const source = readFileSync("native/backend/domain/sessions/SessionWslTrashScript.cpp", "utf8");
const match = source.match(/R"PIDECK_TRASH\(([\s\S]*?)\)PIDECK_TRASH"/);
assert.ok(match);
const program = match[1].replace(/\r\n/g, "\n");
const pinSource = readFileSync("native/backend/domain/sessions/SessionWslRootPin.cpp", "utf8");
const pinMatch = pinSource.match(/R"PIDECK_PIN\(([\s\S]*?)\)PIDECK_PIN"/);
assert.ok(pinMatch);
const pinProgram = pinMatch[1].replace(/\r\n/g, "\n");
const posix = (path) => process.platform === "win32" ? path.replaceAll("\\", "/").replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`) : path;
const bootstrap = 'set -eu; root=$(cd -P -- "$1" && pwd -P); exec 3<"$root"; identity=$(stat -Lc "%d:%i" -- /proc/self/fd/3); start=$(record=$(cat "/proc/$$/stat"); record=${record##*) }; set -f; set -- $record; printf "%s" "${20}"); shift; trap : 0; /usr/bin/sh "$PIDECK_TRASH_PROGRAM" "$root" "$identity" "$$" "$start" "$@"';
const supportsNoCopy = !skip && spawnSync(candidate, ["-c", "/usr/bin/mv --no-copy --help"], { windowsHide: true, env: { ...process.env, BASH_ENV: "", ENV: "" }, timeout: 5000 }).status === 0;
const nominalSkip = skip || (process.platform === "win32" && !supportsNoCopy ? "Git Bash mv lacks --no-copy; requires native Linux coreutils" : false);

/** A disposable real filesystem, with a pipe barrier immediately before GNU mv. */
function fixture(t, barrier = true) {
  const base = mkdtempSync(join(tmpdir(), "pideck-scoped-shell-"));
  let child, closed;
  t.after(async () => {
    if (child && !child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.end("go\n");
    if (closed) {
      const timer = setTimeout(() => child.kill(), 5000);
      try { await closed; } finally { clearTimeout(timer); }
    }
    await rm(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 });
  });
  const root = join(base, "root"), parent = join(root, "source [x]"), outside = join(base, "outside");
  const bin = join(base, "bin"), script = join(base, "program.sh");
  mkdirSync(parent, { recursive: true }); mkdirSync(outside); mkdirSync(bin);
  const name = "literal 中文 $ (x).jsonl", file = join(parent, name);
  writeFileSync(file, "owned"); writeFileSync(join(outside, name), "outside sentinel");
  mkdirSync(join(root, "source x")); writeFileSync(join(root, "source x", name), "glob decoy");
  writeFileSync(script, `${barrier ? 'PATH="$PIDECK_TRASH_BIN:/usr/bin:/bin"; export PATH\n' : ""}${program}`);
  writeFileSync(join(bin, "mv"), '#!/bin/sh\ncase "$*" in *--help*) exec /usr/bin/mv "$@";; esac\nprintf "ready\\n"\nIFS= read -r go\nexec /usr/bin/mv "$@"\n');
  chmodSync(join(bin, "mv"), 0o700);
  const env = { ...process.env, HOME: posix(base), BASH_ENV: "", ENV: "", PATH: `${barrier ? `${posix(bin)}:` : ""}/usr/bin:/bin`, PIDECK_TRASH_PROGRAM: posix(script), PIDECK_TRASH_BIN: posix(bin) };
  const args = ["-c", bootstrap, "pideck-trash-test", posix(root), `source [x]/${name}`, `.pideck-trash/one/${name}`];
  const run = async () => {
    child = spawn(candidate, args, { windowsHide: true, env, stdio: ["pipe", "pipe", "pipe"] });
    let stderr = ""; child.stderr.on("data", (data) => { stderr += data; });
    closed = new Promise((resolveClose, reject) => { child.once("close", resolveClose); child.once("error", reject); });
    const lines = createInterface({ input: child.stdout });
    await new Promise((resolveReady, reject) => {
      const timeout = setTimeout(() => reject(new Error(`move barrier not reached: ${stderr}`)), 5000);
      lines.once("line", (line) => { clearTimeout(timeout); assert.equal(line, "ready"); resolveReady(); });
      closed.then((code) => { clearTimeout(timeout); reject(new Error(stderr || `Scoped program exited ${code} without a move barrier`)); }, reject);
    });
    return async () => { child.stdin.end("go\n"); assert.equal(await closed, 0, stderr); lines.close(); };
  };
  return { base, root, parent, outside, name, file, args, env, run };
}

/** Run the actual holder program with a pipe lifetime, never a real WSL distro. */
async function pinnedFixture(t) {
  let child, closed;
  t.after(async () => {
    if (!child) return;
    child.stdin.end();
    const timer = setTimeout(() => child.kill(), 2000);
    try { await closed; } finally { clearTimeout(timer); }
  });
  const f = fixture(t, false), script = join(f.base, "pin.sh");
  writeFileSync(script, pinProgram);
  child = spawn(candidate, ["-c", 'exec /usr/bin/sh "$PIDECK_ROOT_PIN_PROGRAM" "$1"', "pideck-pin-test", posix(f.root)], {
    windowsHide: true, env: { ...f.env, PIDECK_ROOT_PIN_PROGRAM: posix(script) }, stdio: ["pipe", "pipe", "pipe"],
  });
  closed = new Promise((resolve, reject) => { child.once("close", resolve); child.once("error", reject); });
  const lines = createInterface({ input: child.stdout });
  t.after(() => lines.close());
  const header = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Linux root holder did not become ready")), 5000);
    lines.once("line", (line) => { clearTimeout(timer); resolve(line); });
    closed.then((code) => { clearTimeout(timer); reject(new Error(`Root holder exited ${code} before its handshake`)); }, reject);
  });
  assert.match(header, /^pideck-root-v1\t[0-9]+\t[0-9]+\t[0-9]+:[0-9]+$/);
  const [, pid, start, identity] = header.split("\t");
  return { ...f, pid, start, identity, release: async () => { child.stdin.end(); assert.equal(await closed, 0); } };
}

test("production Linux root holder is released by owner stdin EOF", { skip }, async (t) => {
  const f = await pinnedFixture(t);
  await f.release();
});

test("production WSL trash duplicates the original held root, not a replacement name", { skip: process.platform !== "linux" ? "Requires native Linux cross-process directory descriptors" : skip }, async (t) => {
  const f = await pinnedFixture(t);
  renameSync(f.root, `${f.root}.saved`);
  mkdirSync(f.root);
  const result = spawnSync(candidate, ["-c", 'exec /usr/bin/sh "$PIDECK_TRASH_PROGRAM" "$@"', "pideck-pin-transfer", posix(f.root), f.identity, f.pid, f.start, `source [x]/${f.name}`, `.pideck-trash/one/${f.name}`], {
    windowsHide: true, env: f.env, encoding: "utf8", timeout: 5000,
  });
  assert.notEqual(result.status, 0);
  assert.equal(readFileSync(join(`${f.root}.saved`, "source [x]", f.name), "utf8"), "owned");
  assert.deepEqual(readdirSync(f.root), []);
  await f.release();
});

test("production WSL trash program preserves literal names and a leaf link's referent", { skip: nominalSkip }, async (t) => {
  const f = fixture(t);
  unlinkSync(f.file); symlinkSync(f.outside, f.file, process.platform === "win32" ? "junction" : "dir");
  const finish = await f.run(); await finish();
  const moved = join(f.root, ".pideck-trash", "one", f.name);
  assert.equal(lstatSync(moved).isSymbolicLink(), true);
  assert.equal(readFileSync(join(f.outside, f.name), "utf8"), "outside sentinel");
});

// MSYS emulates cwd and /proc/fd with path strings. It can test quoting and
// refusal, but only the Linux kernel can validate the production WSL dirfd race.
for (const component of ["source", "destination"]) test(`production WSL trash stays bound after a late ${component} parent replacement`, { skip: process.platform !== "linux" ? "Requires native Linux cwd/dirfd semantics, not MSYS path emulation" : skip }, async (t) => {
  const f = fixture(t), finish = await f.run();
  const parent = component === "source" ? f.parent : join(f.root, ".pideck-trash", "one");
  renameSync(parent, `${parent}.saved`);
  symlinkSync(f.outside, parent, "dir");
  await finish();
  const destination = component === "destination" ? `${parent}.saved` : join(f.root, ".pideck-trash", "one");
  assert.equal(readFileSync(join(destination, f.name), "utf8"), "owned");
  assert.equal(readFileSync(join(f.outside, f.name), "utf8"), "outside sentinel");
  assert.deepEqual(readdirSync(f.outside), [f.name]);
});

test("production WSL program reports unsupported mv without a copy/unlink fallback", { skip }, (t) => {
  const f = fixture(t, supportsNoCopy);
  // Exercise the real older Git Bash tool when available, otherwise model only
  // its missing option. The production script and filesystem guards stay intact.
  if (supportsNoCopy) writeFileSync(join(f.base, "bin", "mv"), "#!/bin/sh\nexit 1\n");
  const result = spawnSync(candidate, f.args, { windowsHide: true, env: f.env, encoding: "utf8", timeout: 5000 });
  assert.equal(result.status, 42, result.stderr);
  assert.equal(readFileSync(f.file, "utf8"), "owned");
  assert.equal(readFileSync(join(f.outside, f.name), "utf8"), "outside sentinel");
});

test("production WSL trash rejects a preexisting linked trash directory before outside mutation", { skip }, (t) => {
  const f = fixture(t, false);
  symlinkSync(f.outside, join(f.root, ".pideck-trash"), process.platform === "win32" ? "junction" : "dir");
  const result = spawnSync(candidate, f.args, { windowsHide: true, env: f.env, encoding: "utf8", timeout: 5000 });
  assert.notEqual(result.status, 0, result.stderr);
  assert.equal(readFileSync(f.file, "utf8"), "owned");
  assert.deepEqual(readdirSync(f.outside), [f.name]);
});
