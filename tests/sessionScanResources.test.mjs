import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { loadSessionScanner } from "./helpers/loadSessionScanner.mjs";
import { scanCommandClock } from "./helpers/scanCommandClock.mjs";

/** Only the isolated fixture directory can be scanned as temporary subagent storage. */
async function fixture(run) {
  const home = await fsp.mkdtemp(join(tmpdir(), "pideck-scan-resource-"));
  try { await run(home); }
  finally { await fsp.rm(home, { recursive: true, force: true }); }
}

test("warm parent-cwd membership avoids synchronous and repeated full-text reads", async () => fixture(async (home) => {
  const root = join(home, ".pi", "agent", "sessions");
  await fsp.mkdir(root, { recursive: true });
  const project = join(home, "work"); let syncReads = 0; let reads = 0;
  for (let i = 0; i < 3; i++) await fsp.writeFile(join(root, `${i}.jsonl`), [
    JSON.stringify({ type: "session", id: `s${i}`, cwd: home }),
    JSON.stringify({ type: "message", id: `m${i}`, message: { role: "user", content: project.replace(/\\/g, "/") } }),
  ].join("\n") + "\n");
  const { SessionScanner } = loadSessionScanner(home, { stubs: {
    "node:os": { homedir: () => home, tmpdir: () => home },
    "node:fs": { ...fs, readFileSync(path, ...args) { if (String(path).endsWith(".jsonl")) syncReads++; return fs.readFileSync(path, ...args); } },
    "node:fs/promises": { ...fsp, async readFile(path, ...args) { if (String(path).endsWith(".jsonl")) reads++; return fsp.readFile(path, ...args); } },
  } });
  const scanner = new SessionScanner(undefined, home, undefined, undefined, home);
  try {
    assert.equal((await scanner.list(project)).length, 3);
    reads = syncReads = 0;
    assert.equal((await scanner.list(project)).length, 3);
    assert.equal(syncReads, 0);
    assert.equal(reads, 0);
    await fsp.writeFile(join(root, "0.jsonl"), JSON.stringify({ type: "session", id: "changed", cwd: home }) + "\n");
    assert.equal((await scanner.list(project)).length, 2);
  } finally { await scanner.summaryCache.flush(); scanner.dispose?.(); }
}));

test("concurrent custom-root scans preserve each child's parent and warm grouping", async () => fixture(async (home) => {
  const projects = [join(home, "A"), join(home, "B")];
  for (const project of projects) {
    await fsp.mkdir(join(project, ".pi"), { recursive: true });
    await fsp.mkdir(join(project, "sessions"), { recursive: true });
    await fsp.writeFile(join(project, ".pi", "settings.json"), JSON.stringify({ sessionDir: "sessions" }));
  }
  const root = join(projects[0], "sessions"), parent = join(root, "parent.jsonl");
  const child = join(root, "parent", "child.jsonl");
  const headerChild = join(root, "header-child.jsonl");
  await fsp.mkdir(join(root, "parent"));
  await fsp.writeFile(parent, JSON.stringify({ type: "session", id: "p", cwd: projects[0] }) + "\n");
  await fsp.writeFile(child, [
    { type: "session", id: "c", cwd: projects[0], parentSession: "../parent.jsonl" },
    { type: "custom", id: "mark", parentId: "c", customType: "fixture.child-session" },
  ].map(JSON.stringify).join("\n") + "\n");
  await fsp.writeFile(headerChild, [
    { type: "session", id: "h", cwd: projects[0], parentSession: "parent.jsonl" },
    { type: "custom", id: "header-mark", parentId: "h", customType: "fixture.child-session" },
  ].map(JSON.stringify).join("\n") + "\n");
  let release, entered, blocked = 0;
  const holding = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { entered = resolve; });
  const { SessionScanner } = loadSessionScanner(home, { stubs: {
    "node:os": { homedir: () => home, tmpdir: () => home },
    "node:fs/promises": { ...fsp, async readFile(path, ...args) {
      if ([child, headerChild].includes(String(path))) {
        if (++blocked === 2) entered();
        await holding;
      }
      return fsp.readFile(path, ...args);
    } },
  } });
  const scanner = new SessionScanner(undefined, home, undefined, undefined, home);
  const pending = scanner.list(projects[0]);
  try {
    await started;
    await scanner.list(projects[1]);
    release();
    for (const rows of [await pending, await scanner.list(projects[0])]) {
      assert.equal(rows.find((row) => row.filePath === child)?.parentSessionPath, parent);
      assert.equal(rows.find((row) => row.filePath === headerChild)?.parentSessionPath, parent);
    }
  } finally { release(); await pending.catch(() => {}); await scanner.summaryCache.flush(); scanner.dispose(); }
}));

test("concurrent WSL custom roots keep path and header parents inside their own scan", async () => fixture(async (home) => {
  const root = "/project-a/sessions", parent = `${root}/parent.jsonl`;
  const child = `${root}/parent/child.jsonl`, headerChild = `${root}/header-child.jsonl`;
  const bodies = new Map([
    [parent, JSON.stringify({ type: "session", id: "p", cwd: "/project-a" }) + "\n"],
    ...[child, headerChild].map((path) => [path, [
      { type: "session", id: path, cwd: "/project-a", parentSession: path === child ? "../parent.jsonl" : "parent.jsonl" },
      { type: "custom", id: `${path}-mark`, customType: "fixture.child-session" },
    ].map(JSON.stringify).join("\n") + "\n"]),
  ]);
  let release, entered;
  const hold = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { entered = resolve; });
  const { SessionScanner } = loadSessionScanner(home, { stubs: {
    "node:os": { homedir: () => home, tmpdir: () => home },
  }, childProcess: { execFile(_command, args, _options, callback) {
    const command = args[4]; let output = "";
    if (command === "cat" && args.at(-1).endsWith("settings.json")) output = JSON.stringify({ sessionDir: "sessions" });
    if (command === "find" && args[5] === root) output = [...bodies.keys()].join("\n");
    if (command === "stat") output = args.slice(8).map((path) => `${path}\0${1700000000}\0${Buffer.byteLength(bodies.get(path))}\0`).join("");
    if (command === "head") output = bodies.get(args.at(-1)) ?? "";
    if (command === "cat" && bodies.has(args.at(-1))) output = bodies.get(args.at(-1));
    if (command === "sh" && args[7] === "pideck-scan-read") {
      output = args.slice(8).map((path) => `${path}\0${bodies.get(path)}\0${0}\0`).join("");
      entered();
      void hold.then(() => callback(null, output));
    } else queueMicrotask(() => callback(null, output));
    return { kill() {} };
  } } });
  const scanner = new SessionScanner(undefined, home, undefined, undefined, home);
  await scanner.configureWsl({ distro: "Ubuntu", user: "dev", linuxHome: "/home/dev", windowsHome: home });
  const pending = scanner.list("/project-a");
  try {
    await started; await scanner.list("/project-b"); release();
    const rows = await pending;
    for (const path of [child, headerChild]) assert.equal(rows.find((row) => row.filePath === path)?.parentSessionPath, parent);
  } finally { release(); await pending.catch(() => {}); await scanner.summaryCache.flush(); scanner.dispose(); }
}));

test("local subagent snapshots never synchronously traverse run-record directories", async () => fixture(async (home) => {
  const directory = join(home, "pi-subagents-fixture");
  await fsp.mkdir(directory); await fsp.writeFile(join(directory, "run.json"), JSON.stringify({ nested: [{ sessionFile: "C:/sessions/child.jsonl" }] }));
  let synchronous = 0;
  const { SessionScanner } = loadSessionScanner(home, { stubs: {
    "node:os": { homedir: () => home, tmpdir: () => home },
    "node:fs": { ...fs,
      readdirSync(...args) { synchronous++; return fs.readdirSync(...args); },
      readFileSync(...args) { synchronous++; return fs.readFileSync(...args); },
    },
  } });
  const scanner = new SessionScanner(undefined, home, undefined, undefined, home);
  try {
    const snapshot = await scanner.loadKnownSubagentSessionFiles(false, undefined, true);
    assert.ok(snapshot.has("c:/sessions/child.jsonl"));
    assert.equal(synchronous, 0);
  } finally { scanner.dispose?.(); }
}));

test("WSL custom-session root probes obey the same shared pool across projects", async () => fixture(async (home) => {
  let active = 0; let maximum = 0;
  const { SessionScanner } = loadSessionScanner(home, { childProcess: {
    execFile(_command, args, options, callback) {
      active++; maximum = Math.max(maximum, active);
      const command = args[4];
      const output = command === "cat" ? JSON.stringify({ sessionDir: "/custom/sessions" }) : "";
      const timer = setTimeout(() => { active--; callback(null, output); }, command === "test" ? 10 : 1);
      const onAbort = () => { clearTimeout(timer); active--; callback(new Error("aborted"), ""); };
      options.signal?.addEventListener("abort", onAbort, { once: true });
      return { kill() {} };
    },
  } });
  const scanner = new SessionScanner(undefined, home, undefined, undefined, home);
  await scanner.configureWsl({ distro: "Ubuntu", user: "dev", linuxHome: "/home/dev", windowsHome: home });
  try {
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => scanner.list(`/project${i}`)));
    assert.ok(results.every((result) => result.length === 0));
    assert.ok(maximum <= 4, `custom-root active commands ${maximum}`);
  } finally { await scanner.summaryCache.flush(); scanner.dispose(); }
}));

test("200-file slow WSL scans finish within the unchanged watchdog across concurrent projects", async (t) => fixture(async (home) => {
  const clock = scanCommandClock();
  const paths = Array.from({ length: 200 }, (_, i) => `/home/dev/.pi/agent/sessions/${i}.jsonl`);
  let active = 0, maximum = 0, metadataCommands = 0, bodyCommands = 0;
  const text = (path) => JSON.stringify({ type: "session", id: path, cwd: "/project" }) + "\n";
  const { SessionScanner } = loadSessionScanner(home, {
    globals: { setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout },
    stubs: { "node:os": { homedir: () => home, tmpdir: () => home } },
    childProcess: { execFile(_command, args, options, callback) {
      active++; maximum = Math.max(maximum, active);
      const command = args[4]; let output = "";
      if (command === "find") output = paths.join("\n");
      if (command === "stat") {
        metadataCommands++;
        output = args[5] === "--printf"
          ? args.slice(8).map((path) => `${path}\0${1700000000}\0${Buffer.byteLength(text(path))}\0`).join("")
          : `1700000000 ${Buffer.byteLength(text(args.at(-1)))}`;
      }
      if (command === "cat" && args.at(-1).endsWith(".jsonl")) { bodyCommands++; output = text(args.at(-1)); }
      if (command === "sh" && args[7] === "pideck-scan-read") {
        bodyCommands++;
        output = args.slice(8).map((path) => `${path}\0${text(path)}\0${0}\0`).join("");
      }
      let settled = false;
      const finish = (error) => {
        if (settled) return; settled = true;
        clock.clearTimeout(timer); options.signal?.removeEventListener("abort", onAbort);
        active--; callback(error, output);
      };
      const onAbort = () => finish(new Error("aborted"));
      const timer = clock.command(() => finish(null), 200);
      options.signal?.addEventListener("abort", onAbort, { once: true });
      return { kill() { onAbort(); } };
    } },
  });
  const scanner = new SessionScanner(undefined, home, undefined, undefined, home);
  await scanner.configureWsl({ distro: "Ubuntu", user: "dev", linuxHome: "/home/dev", windowsHome: home });
  try {
    const cold = await clock.finish(Promise.all([scanner.list("/project"), scanner.list("/project/subproject")]));
    assert.equal(cold[0].length, 200);
    // Parent-cwd membership remains false: this fixture never mentions the child project.
    assert.equal(cold[1].length, 0);
    assert.ok(clock.time < 18000, "normal reads must finish, not relax the 18s watchdog");
    assert.ok(maximum <= 4);
    assert.ok(metadataCommands < 20, "metadata must be batched, not 400 individual stat starts");
    assert.ok(bodyCommands < 50, "cold summaries and parent checks must not start a process per file");
    bodyCommands = 0;
    const warm = await clock.finish(scanner.list("/project"));
    assert.equal(warm.length, 200);
    assert.equal(bodyCommands, 0);
    t.diagnostic(`virtual 200ms commands: cold+warm=${clock.time}ms, maxActive=${maximum}, metadata=${metadataCommands}`);
  } finally { await scanner.summaryCache.flush(); scanner.dispose(); }
}));

test("200-file WSL cold and warm scans share a bounded command pool across projects", async () => fixture(async (home) => {
  const paths = Array.from({ length: 200 }, (_, i) => `/home/dev/.pi/agent/sessions/${i}.jsonl`);
  let active = 0; let maximum = 0; let stats = 0; let cats = 0;
  const { SessionScanner } = loadSessionScanner(home, { childProcess: {
    execFile(_command, args, options, callback) {
      active++; maximum = Math.max(maximum, active);
      const command = args[4]; let output = "";
      if (command === "find") output = paths.join("\n");
      if (command === "stat") {
        stats++;
        output = args[5] === "--printf"
          ? args.slice(8).map((path) => `${path}\0${1700000000}\0${1234}\0`).join("")
          : "1700000000 1234";
      }
      if (command === "cat" && args.at(-1).endsWith(".jsonl")) {
        cats++; output = JSON.stringify({ type: "session", id: args.at(-1), cwd: "/project" }) + "\n";
      }
      if (command === "sh" && args[7] === "pideck-scan-read") {
        cats++;
        output = args.slice(8).map((path) => `${path}\0${JSON.stringify({ type: "session", id: path, cwd: "/project" })}\n\0${0}\0`).join("");
      }
      const timer = setTimeout(() => { active--; callback(null, output); }, 2);
      options.signal?.addEventListener("abort", () => { clearTimeout(timer); active--; callback(new Error("aborted"), ""); }, { once: true });
      return { kill() {} };
    },
  } });
  const scanner = new SessionScanner(undefined, home, undefined, undefined, home);
  await scanner.configureWsl({ distro: "Ubuntu", user: "dev", linuxHome: "/home/dev", windowsHome: home });
  try {
    const results = await Promise.all([scanner.list("/project"), scanner.list("/project")]);
    assert.equal(results[0].length, 200); assert.equal(results[1].length, 200);
    assert.ok(maximum <= 4, `active commands ${maximum}`);
    maximum = stats = cats = 0;
    assert.equal((await scanner.list("/project")).length, 200);
    assert.equal(cats, 0); assert.equal(stats, Math.ceil(paths.length / 64));
    assert.ok(maximum <= 4);
  } finally { await scanner.summaryCache.flush(); scanner.dispose?.(); }
}));
