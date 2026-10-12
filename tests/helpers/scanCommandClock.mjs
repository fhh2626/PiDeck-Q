import assert from "node:assert/strict";

/** Virtual child-process latency and watchdog clock; no CI wall-clock threshold or real WSL. */
export function scanCommandClock() {
  let time = 0, sequence = 0;
  const jobs = new Map();
  const schedule = (callback, delay, command) => {
    const id = ++sequence;
    jobs.set(id, { callback, at: time + delay, command });
    return id;
  };
  return {
    setTimeout: (callback, delay) => schedule(callback, delay, false),
    command: (callback, delay) => schedule(callback, delay, true),
    clearTimeout: (id) => jobs.delete(id),
    get time() { return time; },
    async finish(promise) {
      let settled = false;
      const outcome = promise.then((value) => { settled = true; return value; }, (error) => { settled = true; throw error; });
      // Attach immediately: virtual aborts must not create unhandled rejection windows.
      outcome.catch(() => {});
      for (let step = 0; !settled; step++) {
        assert.ok(step < 10000, "scan/clock must settle");
        await new Promise(setImmediate);
        if (settled) break;
        // Real disposable-fixture I/O must finish before advancing the scan watchdog.
        if (![...jobs.values()].some((job) => job.command)) continue;
        const [id, job] = [...jobs].sort((a, b) => a[1].at - b[1].at)[0];
        jobs.delete(id); time = job.at; job.callback();
      }
      return outcome;
    },
  };
}
