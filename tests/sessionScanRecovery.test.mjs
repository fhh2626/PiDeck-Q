import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { loadSessionScanner } from "./helpers/loadSessionScanner.mjs";
import { scanCommandClock } from "./helpers/scanCommandClock.mjs";

/** Exercise public scans with disposable data and no real WSL/agent subprocess. */
async function fixture(run) {
  const home = await fs.mkdtemp(join(tmpdir(), "pideck-scan-recovery-"));
  try { await run(home); }
  finally { await fs.rm(home, { recursive: true, force: true }); }
}

for (const stalledFirst of [false, true]) {
  test(`one stalled WSL body preserves its readable sibling (${stalledFirst ? "first" : "last"} in batch)`, async () => fixture(async (home) => {
    const clock = scanCommandClock();
    const root = "/home/dev/.pi/agent/sessions";
    const good = `${root}/good.jsonl`, stalled = `${root}/stalled.jsonl`;
    const files = stalledFirst ? [stalled, good] : [good, stalled];
    const text = (path) => JSON.stringify({ type: "session", id: path, cwd: "/project" }) + "\n";
    let active = 0, maximum = 0, batchCommands = 0, stalledCats = 0;
    const { SessionScanner } = loadSessionScanner(home, {
      globals: { setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
        Date: class extends Date { static now() { return clock.time; } } },
      stubs: { "node:os": { homedir: () => home, tmpdir: () => home } },
      childProcess: { execFile(_command, args, options, callback) {
        active++; maximum = Math.max(maximum, active);
        const command = args[4]; let output = "", error = null, delay = 200;
        if (command === "find") output = files.join("\n");
        if (command === "stat") output = args[5] === "--printf"
          ? args.slice(8).map((path) => `${path}\0${1700000000}\0${Buffer.byteLength(text(path))}\0`).join("")
          : `1700000000 ${Buffer.byteLength(text(args.at(-1)))}`;
        if (command === "sh" && args[7] === "pideck-scan-read") {
          batchCommands++; delay = options.timeout;
          // The real shell prints each path before cat. Preserve the completed prefix and
          // the in-progress path just as execFile's timeout callback preserves stdout.
          output = stalledFirst ? `${stalled}\0` : `${good}\0${text(good)}\0${0}\0${stalled}\0`;
          error = Object.assign(new Error("ETIMEDOUT: fixture batch"), { killed: true, signal: "SIGTERM" });
        }
        if (command === "cat" && args.at(-1).endsWith(".jsonl")) {
          output = text(args.at(-1));
          if (args.at(-1) === stalled) { stalledCats++; delay = options.timeout; error = new Error("ETIMEDOUT: fixture cat"); }
        }
        let settled = false;
        const finish = (abort) => {
          if (settled) return; settled = true;
          clock.clearTimeout(timer); options.signal?.removeEventListener("abort", onAbort);
          active--; callback(abort ?? error, output);
        };
        const onAbort = () => finish(new Error("aborted"));
        const timer = clock.command(() => finish(), delay);
        options.signal?.addEventListener("abort", onAbort, { once: true });
        return { kill() { onAbort(); } };
      } },
    });
    const scanner = new SessionScanner(undefined, home, undefined, undefined, home);
    await scanner.configureWsl({ distro: "Ubuntu", user: "dev", linuxHome: "/home/dev", windowsHome: home });
    try {
      const rows = await clock.finish(scanner.list("/project"));
      assert.deepEqual(Array.from(rows, (row) => row.filePath), [good]);
      assert.ok(clock.time <= 11000, "the stalled body must not consume a second full 10s timeout");
      assert.equal(batchCommands, 1);
      assert.equal(stalledCats, 0, "the timed-out in-progress file must not be cat-read again");
      assert.ok(maximum <= 4);
      assert.equal(active, 0);
    } finally { scanner.dispose(); await scanner.summaryCache.flush(); }
  }));
}

test("a failed single-file WSL prefetch is not repeated by readSummary", async () => fixture(async (home) => {
  let cats = 0;
  const path = "/home/dev/.pi/agent/sessions/one.jsonl";
  const { SessionScanner } = loadSessionScanner(home, { stubs: {
    "node:os": { homedir: () => home, tmpdir: () => home },
  }, childProcess: { execFile(_command, args, _options, callback) {
    const command = args[4]; let output = "", error = null;
    if (command === "find") output = path;
    if (command === "stat") output = `${path}\0${1700000000}\0${123}\0`;
    if (command === "cat" && args.at(-1) === path) { cats++; error = new Error("unreadable fixture"); }
    queueMicrotask(() => callback(error, output));
    return { kill() {} };
  } } });
  const scanner = new SessionScanner(undefined, home, undefined, undefined, home);
  await scanner.configureWsl({ distro: "Ubuntu", user: "dev", linuxHome: "/home/dev", windowsHome: home });
  try {
    assert.equal((await scanner.list("/project")).length, 0);
    assert.equal(cats, 1);
    // Failures must not become a permanent negative summary: a later scan retries once.
    assert.equal((await scanner.list("/project")).length, 0);
    assert.equal(cats, 2);
  } finally { scanner.dispose(); await scanner.summaryCache.flush(); }
}));

test("failed parent-cwd prefetch neither re-reads nor caches negative membership", async () => fixture(async (home) => {
  const path = "/home/dev/.pi/agent/sessions/one.jsonl";
  const body = [
    { type: "session", id: "s", cwd: "/project" },
    { type: "message", id: "m", message: { role: "user", content: "work in /project/subproject" } },
  ].map(JSON.stringify).join("\n") + "\n";
  let readable = true, cats = 0;
  const { SessionScanner } = loadSessionScanner(home, { stubs: {
    "node:os": { homedir: () => home, tmpdir: () => home },
  }, childProcess: { execFile(_command, args, _options, callback) {
    const command = args[4]; let output = "", error = null;
    if (command === "find") output = path;
    if (command === "stat") output = `${path}\0${1700000000}\0${Buffer.byteLength(body)}\0`;
    if (command === "cat" && args.at(-1) === path) {
      cats++; if (readable) output = body; else error = new Error("unreadable fixture");
    }
    queueMicrotask(() => callback(error, output)); return { kill() {} };
  } } });
  const scanner = new SessionScanner(undefined, home, undefined, undefined, home);
  await scanner.configureWsl({ distro: "Ubuntu", user: "dev", linuxHome: "/home/dev", windowsHome: home });
  try {
    assert.equal((await scanner.list("/project")).length, 1);
    readable = false; cats = 0;
    assert.equal((await scanner.list("/project/subproject")).length, 0);
    assert.equal(cats, 1);
    readable = true; cats = 0;
    assert.equal((await scanner.list("/project/subproject")).length, 1);
    assert.equal(cats, 1, "failed membership must be retried when I/O recovers");
  } finally { scanner.dispose(); await scanner.summaryCache.flush(); }
}));

test("restart reparses legacy persisted parent grouping without changing session files", async () => fixture(async (home) => {
  const project = join(home, "project"), root = join(project, "sessions");
  const parent = join(root, "parent.jsonl"), child = join(root, "parent", "child.jsonl");
  await fs.mkdir(join(project, ".pi"), { recursive: true });
  await fs.mkdir(join(root, "parent"), { recursive: true });
  await fs.writeFile(join(project, ".pi", "settings.json"), JSON.stringify({ sessionDir: "sessions" }));
  await fs.writeFile(parent, JSON.stringify({ type: "session", id: "p", cwd: project }) + "\n");
  await fs.writeFile(child, [
    { type: "session", id: "c", cwd: project, parentSession: "../parent.jsonl" },
    { type: "custom", id: "marker", customType: "fixture.child-session" },
  ].map(JSON.stringify).join("\n") + "\n");
  const { SessionScanner } = loadSessionScanner(home, { stubs: {
    "node:os": { homedir: () => home, tmpdir: () => home },
    "node:child_process": { execFile() { throw new Error("Forbidden real process"); } },
  } });
  const initial = new SessionScanner(undefined, home, undefined, undefined, home);
  await initial.list(project); await initial.summaryCache.flush(); initial.dispose();
  const cachePath = join(home, "session-summary-cache.json");
  const persisted = JSON.parse(await fs.readFile(cachePath, "utf8"));
  persisted.version = 3; // Released format, with a wrong derived parent from the old concurrent-roots bug.
  delete persisted.entries[child].value.parentSessionPath;
  await fs.writeFile(cachePath, JSON.stringify(persisted));
  const before = await fs.stat(child);
  const restarted = new SessionScanner(undefined, home, undefined, undefined, home);
  try {
    const rows = await restarted.list(project);
    assert.equal(rows.find((row) => row.filePath === child)?.parentSessionPath, parent);
    await restarted.summaryCache.flush();
    const repaired = JSON.parse(await fs.readFile(cachePath, "utf8"));
    assert.equal(repaired.entries[child].value.parentSessionPath, parent);
    const after = await fs.stat(child);
    assert.equal(after.size, before.size); assert.equal(after.mtimeMs, before.mtimeMs);
  } finally { restarted.dispose(); await restarted.summaryCache.flush(); }
  // Repaired, current-generation summaries must still survive restart without full-body rereads.
  let bodyReads = 0;
  const { SessionScanner: WarmScanner } = loadSessionScanner(home, { stubs: {
    "node:os": { homedir: () => home, tmpdir: () => home },
    "node:fs/promises": { ...fs, async readFile(path, ...args) {
      if (String(path).endsWith(".jsonl")) bodyReads++;
      return fs.readFile(path, ...args);
    } },
  } });
  const warm = new WarmScanner(undefined, home, undefined, undefined, home);
  try {
    assert.equal((await warm.list(project)).find((row) => row.filePath === child)?.parentSessionPath, parent);
    assert.equal(bodyReads, 0);
  } finally { warm.dispose(); await warm.summaryCache.flush(); }
}));
