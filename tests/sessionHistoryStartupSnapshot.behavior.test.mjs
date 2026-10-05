import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "jotai/vanilla";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const require = createRequire(import.meta.url);
const atoms = loadTsCommonJs("src/renderer/src/atoms/session-atoms.ts");
const { hasMoreRuntimeHistory } = loadTsCommonJs("src/renderer/src/hooks/useSessionTimelineController.ts", {
  stubs: { react: {}, jotai: { atom: (value) => ({ value }) }, "jotai/utils": {}, "../atoms": atoms,
    "../desktopApi": {}, "../i18n": {}, "../utils/notice": {}, "../utils/sessionCommands": {},
    "../components/session/timeline/turnRenderWindow": {} },
});
const forbid = () => { throw new Error("Startup snapshot regression must not launch processes"); };

/** Public startup and real file reader; only Pi/process/config boundaries are replaced. */
async function startup(t, mutation) {
  const directory = await fs.mkdtemp(join(tmpdir(), "pideck-startup-snapshot-"));
  const path = join(directory, "session.jsonl");
  const entries = [];
  let parentId = "root";
  for (let turn = 1; turn <= 54; turn++) {
    if (turn === 53) {
      entries.push({ id: "compact-old", parentId, type: "compaction", summary: "Old summary", firstKeptEntryId: "u50", timestamp: "2026-01-01T00:00:00Z" });
      parentId = "compact-old";
    }
    for (const role of ["user", "assistant"]) {
      const id = `${role === "user" ? "u" : "a"}${turn}`;
      entries.push({ id, parentId, type: "message", message: { role, content: [{ type: "text", text: id }] } });
      parentId = id;
    }
  }
  // Exercise the real >5 MiB disk-startup decision without allocating giant message bodies.
  const padding = Array.from({ length: 20 }, () => JSON.stringify({ type: "fixture-padding", text: "p".repeat(300_000) }));
  await fs.writeFile(path, [...padding, JSON.stringify({ type: "session", id: "root" }), ...entries.map(JSON.stringify)].join("\n") + "\n");
  const original = await fs.stat(path);
  let opens = 0;
  let readAttempts = 0;
  let appended = false;
  let reachedBody;
  let releaseBody;
  const bodyReached = new Promise((resolve) => { reachedBody = resolve; });
  const bodyGate = new Promise((resolve) => { releaseBody = resolve; });
  let finishedStaleRead;
  const staleReadDone = new Promise((resolve) => { finishedStaleRead = resolve; });
  const tracedFs = { ...fs, async open(...args) {
    if (String(args[0]) === path && ++opens === 2) {
      if (mutation === "before-body") {
        appended = true;
        await fs.appendFile(path, JSON.stringify({ id: "model", parentId: "a54", type: "model_change", provider: "fixture", modelId: "fixture" }) + "\n");
      } else if (mutation === "rewrite-once") {
        appended = true;
        const content = await fs.readFile(path, "utf8");
        await fs.writeFile(path, content.replace('"text":"u1"', '"text":"v1"')
          + JSON.stringify({ id: "model", parentId: "a54", type: "model_change", provider: "fixture", modelId: "fixture" }) + "\n");
      } else if (mutation === "live-during-body") {
        reachedBody();
        await bodyGate;
      }
    }
    return fs.open(...args);
  } };
  const readerModule = loadTsCommonJs("src/main/pi/SessionHistoryReader.ts", { stubs: { "node:fs/promises": tracedFs } });
  const { SessionHistoryReader } = readerModule;
  class StartupReader extends SessionHistoryReader {
    async readRecentMessages(...args) {
      readAttempts++;
      if (mutation === "closed-failure" || mutation === "superseded-failure") {
        reachedBody();
        await bodyGate;
        finishedStaleRead();
        const error = new Error("session.historyChanged");
        error.code = "SESSION_HISTORY_CHANGED";
        throw error;
      }
      if (mutation === "fail-once-with-live" && readAttempts === 1) {
        reachedBody();
        await bodyGate;
      }
      if (((mutation === "fail-once" || mutation === "fail-once-with-live") && readAttempts === 1) || mutation === "fail-always") {
        const error = new Error("session.historyChanged");
        error.code = "SESSION_HISTORY_CHANGED";
        throw error;
      }
      const response = await super.readRecentMessages(...args);
      if (mutation === "after-body") {
        appended = true;
        await fs.appendFile(path, [
          { id: "u55", parentId: "a54", type: "message", message: { role: "user", content: "new question" } },
          { id: "a55", parentId: "u55", type: "message", message: { role: "assistant", content: "new answer" } },
          { id: "compact-new", parentId: "a55", type: "compaction", summary: "New summary", firstKeptEntryId: "u53", timestamp: "2026-01-02T00:00:00Z" },
        ].map(JSON.stringify).join("\n") + "\n");
      }
      return response;
    }
  }
  const instances = [];
  class FakePiProcess extends EventEmitter {
    constructor() {
      super();
      instances.push(this);
      this.client = { request: async ({ type }) => {
        if (type === "get_messages" && mutation === "superseded-failure") {
          return { success: true, data: { messages: entries.filter((row) => row.id === "u54" || row.id === "a54").map((row) => row.message) } };
        }
        assert.notEqual(type, "get_messages", "large history must not fall back to unbounded RPC");
        assert.notEqual(type, "get_entries", "file snapshot already owns its entry identities");
        return { success: true, data: type === "get_state" ? { sessionId: "fixture-pi", sessionFile: path } : {} };
      } };
    }
    async start() { return this.client; }
    isRunning() { return true; }
    getDiagnostics() { return { cwd: directory }; }
    stop() { this.emit("exit", { code: 0, signal: null }); }
  }
  const { AgentManager } = loadTsCommonJs("src/main/pi/AgentManager.ts", {
    stubs: { "./PiProcess": { PiProcess: FakePiProcess }, "./PiProcess.ts": { PiProcess: FakePiProcess },
      "./SessionHistoryReader": { ...readerModule, SessionHistoryReader: StartupReader }, "./SessionHistoryReader.ts": { ...readerModule, SessionHistoryReader: StartupReader },
      "node:child_process": { ...require("node:child_process"), spawn: forbid, exec: forbid, execFile: forbid },
      "node:os": { ...require("node:os"), homedir: () => directory } },
  });
  const warnings = [];
  let loaded;
  let failed;
  const completion = new Promise((resolve, reject) => { loaded = resolve; failed = reject; });
  const manager = new AgentManager(() => ({ id: "project", name: "Fixture", path: directory }), () => {},
    { get: () => ({ rpcTimeout: 1000 }) }, { ensureTrustedDirectory: async () => {} }, undefined,
    { info: (_scope, message) => { if (message === "Agent recent history loaded from file") loaded(); },
      warn: (_scope, message, detail) => { warnings.push(message); if (message === "Agent recent history file load failed") {
        if (mutation === "fail-always") loaded(); else failed(new Error(detail.error));
      } }, error: () => {} });
  const store = createStore();
  const sessionId = "fixture-catalog";
  const unsubscribe = manager.onOutput((channel, payload) => {
    if (channel === "agents:message") store.set(atoms.applySessionRuntimeEventAtom, {
      sessionId, agentId: payload.agentId, runtimeGeneration: 1, sourceChannel: channel, payload,
    });
  });
  t.after(async () => { releaseBody(); unsubscribe(); manager.stopAll(); await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  const tab = await manager.create({ projectId: "project", sessionPath: path });
  if (mutation === "live-during-body" || mutation === "fail-once-with-live") {
    await bodyReached;
    await manager.sendPrompt({ agentId: tab.id, message: "Live question" });
    instances[0].emit("event", { type: "agent_start" });
    instances[0].emit("event", { type: "message_start", message: { role: "assistant", content: [{ type: "text", text: "Live answer" }] } });
    instances[0].emit("event", { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Live answer" }] } });
    instances[0].emit("event", { type: "agent_settled" });
    releaseBody();
  }
  if (mutation === "closed-failure" || mutation === "superseded-failure") {
    await bodyReached;
    if (mutation === "closed-failure") manager.stop(tab.id);
    else await manager.loadMessages(tab.id, true);
    releaseBody();
    await staleReadDone;
    await new Promise((resolve) => setImmediate(resolve));
  } else {
    await completion;
  }
  const window = manager.getMessageWindow(tab.id);
  return { manager, path, tab, original, window, entry: store.get(atoms.sessionMessagesCacheAtom)[sessionId], warnings, appended, readAttempts };
}

test("normal model append during large-session startup cannot hide the fifty-turn history or its earlier-page cursor", async (t) => {
  const h = await startup(t, "before-body");
  assert.equal(h.appended, true);
  assert.deepEqual(h.warnings, []);
  assert.equal(h.window.messages.filter((row) => row.role === "user").length, 50);
  assert.equal(h.window.messages.find((row) => row.role === "user").meta.entryId, "u5");
  assert.equal(h.window.windowStartFilePos, 8);
  assert.equal(hasMoreRuntimeHistory(h.entry), true);
  const older = await h.manager.readSessionDisplayTurnPage(h.path, h.tab.id, h.window.windowStartFilePos, 50);
  assert.deepEqual(Array.from(older.messages.filter((row) => row.role === "user"), (row) => row.meta.entryId), ["u1", "u2", "u3", "u4"]);
  assert.equal(older.nextBefore, null);
});

test("one invalidated startup snapshot recovers without full-history RPC or losing pagination", async (t) => {
  const h = await startup(t, "fail-once");
  assert.equal(h.readAttempts, 2);
  assert.deepEqual(h.warnings, []);
  assert.equal(h.window.messages.filter((row) => row.role === "user").length, 50);
  assert.equal(h.window.windowStartFilePos, 8);
  assert.equal(hasMoreRuntimeHistory(h.entry), true);
});

test("an actual prefix rewrite invalidates the first startup read, then recovers from a coherent new file snapshot", async (t) => {
  const h = await startup(t, "rewrite-once");
  assert.equal(h.appended, true);
  assert.equal(h.readAttempts, 2);
  assert.deepEqual(h.warnings, []);
  assert.equal(h.window.windowStartFilePos, 8);
  assert.equal(hasMoreRuntimeHistory(h.entry), true);
  const current = await fs.stat(h.path);
  assert.equal(h.window.fileVersion, `${current.mtimeMs}:${current.size}`);
  const older = await h.manager.readSessionDisplayTurnPage(h.path, h.tab.id, h.window.windowStartFilePos, 50);
  assert.equal(older.messages.find((row) => row.meta?.entryId === "u1").text, "v1");
});

test("persistent startup failure stops retrying and emits a localized recoverable error, not silent success", async (t) => {
  const h = await startup(t, "fail-always");
  assert.equal(h.readAttempts, 2);
  assert.equal(h.warnings.length, 1);
  const error = h.window.messages.find((row) => row.meta?.historyLoading === "failed");
  assert.ok(error);
  assert.equal(error.role, "error");
  assert.equal(error.meta.i18nKey, "diagnostic.historyLoadFailed");
  assert.equal(h.window.windowStartFilePos, undefined, "failure must not fabricate a cursor");
  assert.equal(h.entry.history?.exhausted, undefined, "failure must not record archive exhaustion");
});

test("closing during a failed history read neither retries nor resurrects messages", async (t) => {
  const h = await startup(t, "closed-failure");
  assert.equal(h.readAttempts, 1);
  assert.deepEqual(h.warnings, []);
  assert.equal(h.window.messages.length, 0);
});

test("a newer history load prevents the older failure from retrying or adding an error", async (t) => {
  const h = await startup(t, "superseded-failure");
  assert.equal(h.readAttempts, 1);
  assert.deepEqual(h.warnings, []);
  assert.deepEqual(Array.from(h.window.messages.filter((row) => row.role === "user" || row.role === "assistant"), (row) => row.text), ["u54", "a54"]);
  assert.equal(h.window.messages.some((row) => row.role === "error"), false);
});

test("messages sent while the startup snapshot is in flight survive its later commit", async (t) => {
  const h = await startup(t, "live-during-body");
  assert.equal(h.window.messages.filter((row) => row.text === "Live question").length, 1);
  assert.equal(h.window.messages.filter((row) => row.text === "Live answer").length, 1);
  assert.equal(h.window.messages.filter((row) => row.role === "user").length, 50);
  assert.equal(h.window.messages.find((row) => row.role === "user").meta.entryId, "u6");
  assert.equal(h.window.windowStartFilePos, 10);
  assert.equal(hasMoreRuntimeHistory(h.entry), true);
});

test("messages arriving before a failed first attempt also survive the bounded recovery", async (t) => {
  const h = await startup(t, "fail-once-with-live");
  assert.equal(h.readAttempts, 2);
  assert.deepEqual(h.warnings, []);
  assert.equal(h.window.messages.filter((row) => row.text === "Live question").length, 1);
  assert.equal(h.window.messages.filter((row) => row.text === "Live answer").length, 1);
  assert.equal(h.window.messages.filter((row) => row.role === "user").length, 50);
  assert.equal(h.window.messages.find((row) => row.role === "user").meta.entryId, "u6");
  assert.equal(h.window.windowStartFilePos, 10);
  assert.equal(hasMoreRuntimeHistory(h.entry), true);
});

test("startup messages, file cursor, version and summary all come from one snapshot despite later writes", async (t) => {
  const h = await startup(t, "after-body");
  assert.equal(h.appended, true);
  assert.equal(h.window.windowStartFilePos, 8, "new file messages must not shift the old window head");
  assert.equal(h.window.fileVersion, `${h.original.mtimeMs}:${h.original.size}`);
  assert.equal(h.window.messages.at(-1).meta.entryId, "a54");
  const summaries = h.window.messages.filter((row) => row.meta?.type === "compaction");
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].meta.compactionId, "compact-old");
  assert.equal(summaries[0].meta.compactionCount, 1);
  assert.equal(h.window.messages.some((row) => row.meta?.entryId === "u55"), false);
  assert.equal(hasMoreRuntimeHistory(h.entry), true);
});
