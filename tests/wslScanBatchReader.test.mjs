import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { scanCommandClock } from "./helpers/scanCommandClock.mjs";

const { readWslScanBatches } = loadTsCommonJs("src/main/sessions/WslScanBatchReader.ts");
const MAX_BYTES = 64 * 1024 * 1024;

/** Exercise the batch reader's command boundary with independent per-file metadata/body outcomes. */
function fixture(files, options = {}) {
  const calls = [];
  const bodies = new Map(files.map((path, i) => [path, JSON.stringify({ id: `e${i}`, type: "message", message: { role: "user", content: `😀 ${path}` } }) + "\n"]));
  const execute = async (args, timeout, maxBuffer) => {
    calls.push({ args, timeout, maxBuffer });
    if (args[0] === "stat") {
      const paths = args[1] === "--printf" ? args.slice(4) : [args.at(-1)];
      if (paths.some((path) => path === options.missing)) throw new Error("ENOENT fixture");
      return args[1] === "--printf"
        ? paths.map((path) => `${path}\0${1700000000}\0${options.size ?? Buffer.byteLength(bodies.get(path))}\0`).join("")
        : `1700000000 ${Buffer.byteLength(bodies.get(paths[0]))}`;
    }
    if (args[0] === "sh") {
      const paths = args.slice(4);
      if (options.badFraming) return `${paths[0]}\0unexpected\0incomplete`;
      return paths.map((path) => `${path}\0${bodies.get(path)}\0${path === options.unreadable ? 1 : 0}\0`).join("");
    }
    if (args[0] === "cat") {
      if (args[1] === options.unreadable) throw new Error("unreadable fixture");
      return bodies.get(args[1]);
    }
    throw new Error("Unexpected fixture command");
  };
  return { calls, bodies, execute };
}

async function read(files, f, needsBody = () => true) {
  return readWslScanBatches({ files, signal: new AbortController().signal, execute: f.execute, needsBody,
    consume: async (path, value) => ({ path, version: value?.version,
      text: value?.body.status === "success" ? value.body.text : undefined, status: value?.body.status }) });
}

test("batched UTF-8 and quoted filenames retain exact per-file identity and order", async () => {
  const files = ["/sessions/a ' quote.jsonl", "/sessions/中文😀.jsonl", "/sessions/-option.jsonl"];
  const f = fixture(files), rows = await read(files, f);
  assert.deepEqual(Array.from(rows, (row) => row.path), files);
  for (const row of rows) {
    assert.equal(row.text, f.bodies.get(row.path));
    assert.equal(row.version.mtimeMs, 1700000000000);
  }
  assert.equal(f.calls.filter((call) => call.args[0] === "stat").length, 1);
  assert.equal(f.calls.filter((call) => call.args[0] === "sh").length, 1);
  assert.ok(f.calls.every((call) => call.timeout <= 10000));
});

test("failed stat and body records do not discard readable siblings", async () => {
  const files = ["/good.jsonl", "/missing.jsonl", "/unreadable.jsonl"];
  const f = fixture(files, { missing: files[1], unreadable: files[2] });
  const rows = await read(files, f);
  assert.equal(rows[0].text, f.bodies.get(files[0]));
  assert.equal(rows[1].version, undefined);
  assert.equal(rows[2].text, undefined);
  assert.equal(rows[2].status, "failed");
});

test("malformed NUL framing falls back to isolated cats rather than cross-file body slots", async () => {
  const files = ["/one.jsonl", "/two.jsonl"], f = fixture(files, { badFraming: true });
  const rows = await read(files, f);
  assert.deepEqual(Array.from(rows, (row) => row.text), files.map((path) => f.bodies.get(path)));
  assert.equal(f.calls.filter((call) => call.args[0] === "cat").length, 2);
});

test("aggregate size splits batches without reducing the 64 MiB per-file cat budget", async () => {
  const files = ["/large1.jsonl", "/large2.jsonl", "/large3.jsonl"];
  const f = fixture(files, { size: 40 * 1024 * 1024 });
  assert.equal((await read(files, f)).length, files.length);
  const cats = f.calls.filter((call) => call.args[0] === "cat");
  assert.equal(cats.length, files.length);
  assert.ok(cats.every((call) => call.maxBuffer === MAX_BYTES && call.timeout === 10000));
});

test("cancellation between metadata and bodies prevents any subsequent body process", async () => {
  const files = ["/one.jsonl", "/two.jsonl"], f = fixture(files);
  const controller = new AbortController();
  await assert.rejects(readWslScanBatches({ files, signal: controller.signal,
    execute: async (...args) => {
      const result = await f.execute(...args);
      controller.abort(new Error("environment changed fixture"));
      return result;
    }, needsBody: () => true, consume: async () => null }), /environment changed fixture/);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].args[0], "stat");
});

test("a valid nine-second batch retains the original ten-second command allowance", async () => {
  const clock = scanCommandClock();
  const module = loadTsCommonJs("src/main/sessions/WslScanBatchReader.ts", { globals: {
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    Date: class extends Date { static now() { return clock.time; } },
  } });
  const files = ["/one.jsonl", "/two.jsonl"], f = fixture(files);
  const rows = await clock.finish(module.readWslScanBatches({ files, deadline: 18000,
    signal: new AbortController().signal, needsBody: () => true, consume: async (_path, read) => read.body,
    execute: async (...args) => {
      if (args[0][0] === "sh") {
        assert.equal(args[1], 10000);
        await new Promise((resolve) => clock.command(resolve, 9000));
      }
      return f.execute(...args);
    },
  }));
  assert.ok(rows.every((body) => body.status === "success"));
  assert.equal(clock.time, 9000);
  assert.equal(f.calls.filter((call) => call.args[0] === "cat").length, 0);
});

test("timeout recovery is bounded by the remaining scan deadline and retains completed siblings", async () => {
  const clock = scanCommandClock();
  const module = loadTsCommonJs("src/main/sessions/WslScanBatchReader.ts", { globals: {
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    Date: class extends Date { static now() { return clock.time; } },
  } });
  const good = "/good.jsonl", stalled = "/stalled.jsonl", later = "/later-stalled.jsonl";
  const files = [good, stalled, later];
  let cats = 0, active = 0;
  const controller = new AbortController();
  const rows = await clock.finish(module.readWslScanBatches({ files, signal: controller.signal, deadline: 18000,
    needsBody: () => true, consume: async (path, read) => ({ path, body: read.body }),
    execute: (args, timeout, _maxBuffer, signal) => new Promise((resolve, reject) => {
      let output, error, delay = 200;
      if (args[0] === "stat") output = files.map((path) => `${path}\0${1700000000}\0${123}\0`).join("");
      if (args[0] === "sh") {
        delay = timeout;
        error = new module.WslScanCommandError(`${good}\0complete\0${0}\0${stalled}\0`, { killed: true, signal: "SIGTERM" });
      }
      if (args[0] === "cat") {
        cats++; assert.equal(args[1], later, "completed and in-progress batch files must not be repeated");
        delay = timeout; error = new Error("later timeout fixture");
      }
      active++;
      const finish = (abort) => {
        clock.clearTimeout(timer); signal?.removeEventListener("abort", onAbort); active--;
        if (abort ?? error) reject(abort ?? error); else resolve(output);
      };
      const onAbort = () => finish(new Error("local deadline fixture"));
      const timer = clock.command(() => finish(), delay);
      signal?.addEventListener("abort", onAbort, { once: true });
    }),
  }));
  assert.equal(rows[0].body.status, "success"); assert.equal(rows[0].body.text, "complete");
  assert.equal(rows[1].body.status, "failed"); assert.equal(rows[2].body.status, "failed");
  assert.equal(cats, 1); assert.equal(active, 0);
  assert.equal(clock.time, 17900);
  assert.equal(controller.signal.aborted, false, "local recovery expiry must not abort the whole scan");
});

test("timeout between records retains the complete prefix and resumes only untouched files", async () => {
  const module = loadTsCommonJs("src/main/sessions/WslScanBatchReader.ts");
  const files = ["/one.jsonl", "/two.jsonl"], f = fixture(files);
  const rows = await module.readWslScanBatches({ files, signal: new AbortController().signal,
    needsBody: () => true, consume: async (_path, read) => read.body,
    execute: async (...args) => {
      if (args[0][0] === "sh") throw new module.WslScanCommandError(`${files[0]}\0${f.bodies.get(files[0])}\0${0}\0`, { code: "ETIMEDOUT" });
      return f.execute(...args);
    },
  });
  assert.deepEqual(Array.from(rows, (row) => row.text), files.map((path) => f.bodies.get(path)));
  assert.deepEqual(f.calls.filter((call) => call.args[0] === "cat").map((call) => call.args[1]), [files[1]]);
});

test("ambiguous timeout stdout never starts a second full batch of reads", async () => {
  const module = loadTsCommonJs("src/main/sessions/WslScanBatchReader.ts");
  const files = ["/one.jsonl", "/two.jsonl"], f = fixture(files);
  const rows = await module.readWslScanBatches({ files, signal: new AbortController().signal,
    needsBody: () => true, consume: async (_path, read) => read.body,
    execute: async (...args) => {
      if (args[0][0] === "sh") throw new module.WslScanCommandError("", { code: "ETIMEDOUT" });
      return f.execute(...args);
    },
  });
  assert.ok(rows.every((row) => row.status === "failed"));
  assert.ok(f.calls.every((call) => call.args[0] === "stat"));
});

test("warm metadata needs no body process, and aborted scans do not start later batches", async () => {
  const files = ["/one.jsonl", "/two.jsonl"], f = fixture(files);
  await read(files, f, () => false);
  assert.ok(f.calls.every((call) => call.args[0] === "stat"));
  const controller = new AbortController(); controller.abort(new Error("cancel fixture"));
  let commands = 0;
  await assert.rejects(readWslScanBatches({ files, signal: controller.signal,
    execute: async () => { commands++; throw new Error("must not execute"); }, needsBody: () => true, consume: async () => null }), /cancel fixture/);
  assert.equal(commands, 0);
});
