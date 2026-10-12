import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
const { ScanReadQueue } = loadTsCommonJs("src/main/sessions/ScanReadQueue.ts");
function deferred() { let resolve; const promise = new Promise((yes) => { resolve = yes; }); return { promise, resolve }; }

test("scan reads preserve FIFO results with a shared concurrency bound", async () => {
  const queue = new ScanReadQueue(2); let active = 0; let maximum = 0;
  try {
    const values = await Promise.all(Array.from({ length: 20 }, (_, i) => queue.run(async () => {
      active++; maximum = Math.max(maximum, active);
      await new Promise(setImmediate); active--; return i;
    })));
    assert.deepEqual(values, Array.from({ length: 20 }, (_, i) => i)); assert.equal(maximum, 2);
  } finally { queue.dispose(); }
});

test("cancelling a queued read never invokes its I/O", async () => {
  const queue = new ScanReadQueue(1); const blocked = deferred(); const controller = new AbortController(); let started = false;
  const first = queue.run(() => blocked.promise);
  const next = queue.run(async () => { started = true; }, controller.signal);
  const rejected = assert.rejects(next, /cancelled/);
  controller.abort(); await rejected; blocked.resolve(1); await first;
  assert.equal(started, false); queue.dispose();
});

test("cancelled active I/O retains its slot until the actual operation settles", async () => {
  const queue = new ScanReadQueue(1); const blocked = deferred(); let started = false; let aborted;
  const first = queue.run((signal) => { aborted = signal; return blocked.promise; });
  const rejected = assert.rejects(first, /environment changed/); queue.cancel(); await rejected;
  const next = queue.run(async () => { started = true; return 2; });
  assert.equal(aborted.aborted, true); assert.equal(started, false);
  blocked.resolve(1); assert.equal(await next, 2); queue.dispose();
});

test("synchronous read errors release the slot and permit recovery", async () => {
  const queue = new ScanReadQueue(1);
  try {
    await assert.rejects(queue.run(() => { throw new Error("broken"); }), /broken/);
    assert.equal(await queue.run(async () => "ok"), "ok");
  } finally { queue.dispose(); }
});

test("disposal rejects all callers and refuses future work", async () => {
  const queue = new ScanReadQueue(1); const blocked = deferred();
  const active = assert.rejects(queue.run(() => blocked.promise), /disposed/);
  const pending = assert.rejects(queue.run(async () => "not started"), /disposed/);
  queue.dispose(); await Promise.all([active, pending]);
  await assert.rejects(queue.run(async () => "late"), /disposed/); blocked.resolve();
});
