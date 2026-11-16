import assert from "node:assert/strict";
import test from "node:test";
import { stopBackendProcess } from "./helpers/native2BackendHarness.mjs";
import { stopBackend } from "./helpers/native2RestartableBackend.mjs";

/** Deferred process streams reproduce the gap between exit and final handle release. */
function fixture() {
  let close;
  let fail;
  const closed = new Promise((resolve, reject) => { close = resolve; fail = reject; });
  const events = [];
  return {
    close, fail, events,
    backend: { child: { exitCode: 0 }, exited: Promise.resolve({ code: 0 }), closed, output: {} },
    host: { emit: () => events.push("quit"), stop: async () => { events.push("host closed"); } },
    stopped: false,
  };
}

test("backend teardown waits for inherited streams before closing the host", async () => {
  const state = fixture();
  let completed = false;
  const pending = stopBackendProcess(state.backend, state.host).then(() => { completed = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(completed, false);
  assert.deepEqual(state.events, []);
  state.close({ code: 0 });
  await pending;
  assert.deepEqual(state.events, ["host closed"]);
});

test("backend teardown closes its host even when process stream cleanup fails", async () => {
  const state = fixture();
  const pending = stopBackendProcess(state.backend, state.host);
  const rejected = assert.rejects(pending, /stream failure/);
  state.fail(new Error("stream failure"));
  await rejected;
  assert.deepEqual(state.events, ["host closed"]);
});

test("concurrent restartable stops both wait for stream closure", async () => {
  const state = fixture();
  let completed = 0;
  const first = stopBackend(state).then(() => { ++completed; });
  const second = stopBackend(state).then(() => { ++completed; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(completed, 0);
  assert.equal(state.stopped, false);
  state.close({ code: 0 });
  await Promise.all([first, second]);
  assert.equal(completed, 2);
  assert.equal(state.stopped, true);
  assert.deepEqual(state.events, ["host closed"]);
  await stopBackend(state);
  assert.deepEqual(state.events, ["host closed"]);
});
