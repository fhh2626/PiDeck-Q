import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/** Deterministic timer boundary: no wall-clock threshold, and no real Pi process. */
function timerClock() {
  let now = 0;
  let sequence = 0;
  const jobs = new Map();
  return {
    setTimeout(callback, delay) { const id = ++sequence; jobs.set(id, { callback, at: now + delay }); return id; },
    clearTimeout(id) { jobs.delete(id); },
    drain() {
      for (let i = 0; jobs.size > 0; i++) {
        assert.ok(i < 100, "timer drain remains bounded");
        const [id, job] = [...jobs].sort((left, right) => left[1].at - right[1].at)[0];
        jobs.delete(id); now = job.at; job.callback();
      }
    },
    get pending() { return jobs.size; },
  };
}

/** Boot through public AgentManager.create; only process/network/config boundaries are substitutes. */
async function withLoggingAgents(count, run) {
  const directory = await mkdtemp(join(tmpdir(), "pideck-log-owner-"));
  const clock = timerClock();
  const instances = [];
  const batches = [];
  const { ipcChannels } = loadTsCommonJs("src/shared/ipc.ts");
  class FakePiProcess extends EventEmitter {
    constructor() {
      super(); instances.push(this);
      this.client = { request: async ({ type }) => ({ success: true, data: type === "get_messages" ? { messages: [] } : type === "get_entries" ? { entries: [] } : {} }) };
    }
    async start() { return this.client; }
    getDiagnostics() { return { cwd: directory }; }
    stop() { this.emit("exit", { code: 0, signal: null }); }
  }
  const { AgentManager } = loadTsCommonJs("src/main/pi/AgentManager.ts", {
    stubs: { "./PiProcess": { PiProcess: FakePiProcess }, "./PiProcess.ts": { PiProcess: FakePiProcess },
      "node:child_process": { spawn: () => { throw new Error("Real process forbidden in owner fixture"); }, execFile: () => { throw new Error("Real process forbidden in owner fixture"); } },
      "node:os": { homedir: () => directory, platform: () => process.platform, tmpdir: () => directory } },
    globals: { setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout },
  });
  const manager = new AgentManager(() => ({ id: "project", name: "Fixture", path: directory }),
    (channel, payload) => { if (channel === ipcChannels.agentsRpcLog) batches.push(payload); },
    { get: () => ({ rpcTimeout: 1000 }) }, { ensureTrustedDirectory: async () => {} });
  try {
    const tabs = [];
    for (let i = 0; i < count; i++) {
      const tab = await manager.create({ projectId: "project", noSession: true });
      assert.equal(tab.status, "idle");
      tabs.push(tab); manager.setRpcLogging(tab.id, true);
    }
    // Let background history promises finish before producing this test's RPC stream.
    await new Promise((resolve) => setImmediate(resolve));
    clock.drain(); batches.length = 0;
    const log = (index, sequence) => instances[index].emit("rpc-log", { direction: "receive", data: { type: "fixture", sequence } });
    await run({ manager, tabs, clock, batches, log });
  } finally {
    manager.stopAll();
    assert.equal(clock.pending, 0, "all owner timers are cleared at shutdown");
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

test("quiet RPC burst drains every bounded batch without requiring another event", async () => {
  await withLoggingAgents(1, async ({ clock, batches, log }) => {
    for (let i = 0; i < 205; i++) log(0, i);
    clock.drain();
    assert.deepEqual(batches.map((batch) => batch.entries.length), [100, 100, 5]);
    assert.deepEqual(batches.flatMap((batch) => batch.entries.map((entry) => entry.data.sequence)), Array.from({ length: 205 }, (_, i) => i));
  });
});

test("closing one agent drops only its pending logs and shutdown prevents late broadcast", async () => {
  await withLoggingAgents(2, async ({ manager, tabs, clock, batches, log }) => {
    log(0, 1); log(1, 2);
    await manager.stop(tabs[0].id);
    clock.drain();
    assert.equal(batches.length, 1);
    assert.equal(batches[0].agentId, tabs[1].id);
    assert.deepEqual(Array.from(batches[0].entries, (entry) => entry.data.sequence), [2]);
    log(1, 3);
    manager.stopAll(); clock.drain();
    assert.equal(batches.length, 1);
  });
});

test("RPC pending budget retains only the newest thousand entries in original order", async () => {
  await withLoggingAgents(1, async ({ clock, batches, log }) => {
    for (let i = 0; i < 1050; i++) log(0, i);
    clock.drain();
    assert.ok(batches.every((batch) => batch.entries.length <= 100));
    assert.deepEqual(batches.flatMap((batch) => batch.entries.map((entry) => entry.data.sequence)), Array.from({ length: 1000 }, (_, i) => i + 50));
  });
});
