import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { ipcChannels } = loadTsCommonJs("src/shared/ipc.ts");
const { SettingsStore } = loadTsCommonJs("src/main/settings/SettingsStore.ts");
const { SessionHistoryReader } = loadTsCommonJs("src/main/pi/SessionHistoryReader.ts");
const { RpcLogger } = loadTsCommonJs("src/main/logging/RpcLogger.ts");
const logger = { info() {}, warn() {}, error() {} };

/** Isolated, automatically cleaned fixtures; no user settings or repositories are touched. */
async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), "pideck-review-regression-"));
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}

for (const [legacyPx, expectedPct] of [[800, 60], [1400, 84], [1800, 100]]) {
  test(`legacy width ${legacyPx}px migrates to ${expectedPct}% and persists`, () => fixture(async root => {
    const desktopSettingsFile = join(root, "settings.json");
    await writeFile(desktopSettingsFile, JSON.stringify({ contentMaxWidth: legacyPx }));
    const store = new SettingsStore({ desktopSettingsFile, piAgentSettingsFile: join(root, "missing") });
    await store.load();
    assert.equal(store.get().chatContentWidthPct, expectedPct);
    // A public queued update waits for all migration writes and proves restart compatibility.
    await store.update({ language: "en-US" });
    assert.equal(JSON.parse(await readFile(desktopSettingsFile, "utf8")).chatContentWidthPct, expectedPct);
  }));
}

test("width migration preserves an explicit percentage and the fresh-install default", () => fixture(async root => {
  for (const [data, expected] of [[{ contentMaxWidth: 800, chatContentWidthPct: 91 }, 91], [{}, 80]]) {
    const desktopSettingsFile = join(root, `${expected}.json`);
    await writeFile(desktopSettingsFile, JSON.stringify(data));
    const store = new SettingsStore({ desktopSettingsFile, piAgentSettingsFile: join(root, "missing") });
    await store.load();
    assert.equal(store.get().chatContentWidthPct, expected);
    await store.update({ language: "en-US" });
  }
}));

function historyReader() {
  return new SessionHistoryReader({ toHostPath: x => x, convertMessages: () => [], trimMessages: x => x, translate: x => x });
}
const messageLine = (id, text, messageId = "msg") => JSON.stringify({ type: "message", id, parentId: null, message: { id: messageId, role: "toolResult", content: [{ type: "text", text }] } }) + "\n";

test("full text reloads same-sized edits with the same message identity", () => fixture(async root => {
  const file = join(root, "session.jsonl");
  await writeFile(file, messageLine("entry", "before"));
  const reader = historyReader();
  assert.equal((await reader.readMessageFullText(file, "msg", "entry")).text, "before");
  await writeFile(file, messageLine("entry", "after!"));
  // Avoid relying on filesystem timestamp granularity in a fast test.
  const changed = new Date(Date.now() + 2000);
  await utimes(file, changed, changed);
  assert.equal((await reader.readMessageFullText(file, "msg", "entry")).text, "after!");
}));

test("full text does not return a cached deleted message", () => fixture(async root => {
  const file = join(root, "session.jsonl");
  await writeFile(file, messageLine("entry", "before"));
  const reader = historyReader();
  await reader.readMessageFullText(file, "msg", "entry");
  await writeFile(file, "");
  await assert.rejects(reader.readMessageFullText(file, "msg", "entry"), /not found/);
}));

test("full text entry anchors take precedence over a shared message id", () => fixture(async root => {
  const file = join(root, "session.jsonl");
  await writeFile(file, messageLine("one", "first") + messageLine("two", "second"));
  const reader = historyReader();
  assert.equal((await reader.readMessageFullText(file, "msg", "one")).text, "first");
  assert.equal((await reader.readMessageFullText(file, "msg", "two")).text, "second");
}));

const logEntry = (id, time, agentId = "agent-1") => ({ id, time, agentId, direction: "recv", summary: id });

test("RPC history includes yesterday after automatic gzip", () => fixture(async root => {
  const logs = new RpcLogger({ directory: root });
  const now = Date.now();
  await logs.appendEntries([logEntry("yesterday", now - 86400000), logEntry("today", now)]);
  const entries = await logs.getFromFile({ agentId: "agent-1", days: 7 });
  assert.deepEqual(Array.from(entries, x => x.id), ["today", "yesterday"]);
}));

test("RPC history applies day range, agent filter and global newest-first limit", () => fixture(async root => {
  const logs = new RpcLogger({ directory: root });
  const now = Date.now();
  await logs.appendEntries([
    logEntry("expired", now - 10 * 86400000),
    logEntry("recent", now - 86400000),
    logEntry("newer", now, "agent-a"),
    logEntry("newest", now + 10, "agent-z"),
  ]);
  assert.deepEqual(Array.from(await logs.getFromFile({ days: 7, limit: 2 }), x => x.id), ["newest", "newer"]);
  assert.deepEqual(Array.from(await logs.getFromFile({ agentId: "agent-1", days: 7 }), x => x.id), ["recent"]);
}));

function gitHandlers(gitService, roots, stubs = {}) {
  const { registerGitIpc } = loadTsCommonJs("src/main/ipc/gitIpc.ts", { stubs });
  const handlers = new Map();
  const dispose = registerGitIpc({ handle: (k, fn) => handlers.set(k, fn) }, {
    appLogger: logger, mainCopy: x => x, getLocale: () => "en-US", gitService,
    projectStore: { get: id => id === "p" ? { id, path: roots[0] } : undefined, list: () => roots.map((path, i) => ({ id: String(i), path })) },
    settingsStore: { get: () => ({ maxEditorFileSizeMB: 5 }) }, piLocator: {}, worktreeService: {},
    getAuthorizedRoots: () => roots,
  });
  return { invoke: (channel, ...args) => handlers.get(channel)(...args), dispose };
}

test("Git HEAD read rejects an unregistered path before querying Git", () => fixture(async root => {
  const allowed = join(root, "allowed"); await mkdir(allowed);
  const outside = join(root, "secret.txt"); await writeFile(outside, "secret");
  const api = gitHandlers({ getOriginalContent: async () => "secret" }, [allowed]);
  await assert.rejects(api.invoke(ipcChannels.gitOriginalContent, outside), e => e.code === "FILE_PATH_NOT_AUTHORIZED");
}));

test("Git HEAD read rejects non-string input", () => fixture(async root => {
  const api = gitHandlers({ getOriginalContent: async () => "secret" }, [root]);
  await assert.rejects(api.invoke(ipcChannels.gitOriginalContent, 42), /non-empty string/);
}));

test("Git HEAD read permits an authorized existing or deleted file", () => fixture(async root => {
  const file = join(root, "tracked.txt"); await writeFile(file, "working copy");
  const api = gitHandlers({ getOriginalContent: async () => "HEAD text" }, [root]);
  assert.equal(await api.invoke(ipcChannels.gitOriginalContent, file), "HEAD text");
  await rm(file);
  assert.equal(await api.invoke(ipcChannels.gitOriginalContent, file), "HEAD text");
}));

test("Git HEAD read rejects an intermediate symlink escaping the project", () => fixture(async root => {
  const allowed = join(root, "project"); const outside = join(root, "outside");
  await mkdir(allowed); await mkdir(outside); await writeFile(join(outside, "secret.txt"), "secret");
  await symlink(outside, join(allowed, "link"), process.platform === "win32" ? "junction" : "dir");
  const api = gitHandlers({ getOriginalContent: async () => "secret" }, [allowed]);
  await assert.rejects(api.invoke(ipcChannels.gitOriginalContent, join(allowed, "link", "secret.txt")), e => e.code === "FILE_PATH_NOT_AUTHORIZED");
}));

test("Git init IPC stays pending until initialization finishes", () => fixture(async root => {
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  const api = gitHandlers({ init: () => pending }, [root], { "node:child_process": { execFile: () => new EventEmitter() } });
  let settled = false;
  const result = api.invoke(ipcChannels.gitInit, "p").then(() => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  finish(); await result; assert.equal(settled, true);
}));

test("Git init propagates service failure", () => fixture(async root => {
  const api = gitHandlers({ init: async () => { throw new Error("init failed"); } }, [root], { "node:child_process": { execFile: () => new EventEmitter() } });
  await assert.rejects(api.invoke(ipcChannels.gitInit, "p"), /init failed/);
}));

test("GitService init returns only when a real temporary repository is usable", () => fixture(async root => {
  const { GitService } = loadTsCommonJs("src/main/git/GitService.ts");
  const service = new GitService();
  await service.init(root);
  assert.equal(await service.isGitRepo(root), true);
}));

test("GitService init rejects a missing working directory", () => fixture(async root => {
  const { GitService } = loadTsCommonJs("src/main/git/GitService.ts");
  await assert.rejects(new GitService().init(join(root, "missing")));
}));

test("RPC history ignores malformed rows and damaged gzip without hiding valid files", () => fixture(async root => {
  const now = Date.now();
  const d = new Date(now);
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  await writeFile(join(root, `rpc-broken-${date}.jsonl.gz`), "not a gzip stream");
  await writeFile(join(root, `rpc-valid-${date}.jsonl`), "{bad json}\n" + JSON.stringify(logEntry("valid", now, "valid")) + "\n");
  const entries = await new RpcLogger({ directory: root }).getFromFile({ days: 7 });
  assert.deepEqual(Array.from(entries, x => x.id), ["valid"]);
}));

test("RPC history fails explicitly on an oversized line instead of allocating an archive", () => fixture(async root => {
  const d = new Date();
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  await writeFile(join(root, `rpc-agent-${date}.jsonl`), "x".repeat(4 * 1024 * 1024 + 1));
  await assert.rejects(new RpcLogger({ directory: root }).getFromFile(), e => e.code === "RPC_LOG_HISTORY_LIMIT_EXCEEDED");
}));

test("full text rejects a missing entry anchor instead of matching another message id", () => fixture(async root => {
  const file = join(root, "session.jsonl");
  await writeFile(file, messageLine("one", "first"));
  await assert.rejects(historyReader().readMessageFullText(file, "msg", "missing"), /not found/);
}));
