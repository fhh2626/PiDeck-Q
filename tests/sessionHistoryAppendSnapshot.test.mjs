import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/** Real disposable JSONL, with controllable I/O boundaries instead of simulated read errors. */
async function fixture(t, onBoundary = async () => {}) {
  const directory = await fs.mkdtemp(join(tmpdir(), "pideck-append-snapshot-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const path = join(directory, "session.jsonl");
  const rows = [{ id: "root", type: "session" }];
  let parentId = "root";
  for (let turn = 1; turn <= 3; turn++) {
    for (const role of ["user", "assistant"]) {
      const id = `${role === "user" ? "u" : "a"}${turn}`;
      rows.push({ id, parentId, type: "message", message: { id: `m-${id}`, role, content: `text-${id}` } });
      parentId = id;
    }
  }
  const initial = rows.map(JSON.stringify).join("\n") + "\n";
  await fs.writeFile(path, initial);
  let opens = 0;
  const metrics = { bytes: 0, largestRead: 0, fullReads: 0 };
  const tracedFs = { ...fs,
    async open(...args) {
      if (String(args[0]) !== path) return fs.open(...args);
      const number = ++opens;
      await onBoundary({ phase: "open", number, path, initial });
      const handle = await fs.open(...args);
      let reads = 0;
      return new Proxy(handle, { get(target, key) {
        if (key === "read") return async (...params) => {
          const result = await target.read(...params);
          metrics.bytes += result.bytesRead;
          metrics.largestRead = Math.max(metrics.largestRead, params[2]);
          await onBoundary({ phase: "read", number, reads: ++reads, path, initial });
          return result;
        };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      } });
    },
    async readFile(...args) { metrics.fullReads++; return fs.readFile(...args); },
  };
  const { SessionHistoryReader } = loadTsCommonJs("src/main/pi/SessionHistoryReader.ts", { stubs: { "node:fs/promises": tracedFs } });
  const { trimHistoryMessages } = loadTsCommonJs("src/main/pi/agentUtils.ts");
  const { AgentMessageProjector } = loadTsCommonJs("src/main/pi/AgentMessageProjector.ts");
  const projector = new AgentMessageProjector({ translate: (key) => key, isAskAborted: () => false });
  const reader = new SessionHistoryReader({ toHostPath: (value) => value, trimMessages: trimHistoryMessages,
    convertMessages: (...args) => projector.convert(...args), translate: (key) => key });
  return { reader, path, rows, metrics, initial };
}
const metadata = { id: "model", parentId: "a3", type: "model_change", provider: "fixture", modelId: "fixture" };
const append = (path, row) => fs.appendFile(path, JSON.stringify(row) + "\n");
const texts = (response) => Array.from(response.data.messages, (message) => message.content);

for (const boundary of ["index-read", "body-open", "body-read"]) {
  test(`normal metadata append at ${boundary} preserves the pinned recent-history snapshot`, async (t) => {
    let changed = false;
    const { reader, path, rows, initial, metrics } = await fixture(t, async ({ phase, number, path }) => {
      const hit = boundary === "index-read" ? phase === "read" && number === 1
        : boundary === "body-open" ? phase === "open" && number === 2
        : phase === "read" && number === 2;
      if (hit && !changed) { changed = true; await append(path, metadata); }
    });
    const response = await reader.readRecentMessages(path, 50);
    assert.equal(changed, true);
    assert.deepEqual(texts(response), rows.filter((row) => row.type === "message").map((row) => row.message.content));
    assert.equal((await fs.readFile(path)).subarray(0, Buffer.byteLength(initial)).toString(), initial);
    assert.equal(await reader.getActiveEntryCount(path), 6);
    assert.equal(metrics.fullReads, 0);
    assert.ok(metrics.bytes < 6 * Buffer.byteLength(initial) + 1024);
  });
}

test("append between stat and opening the index pins the opened descriptor version", async (t) => {
  let changed = false;
  const { reader, path } = await fixture(t, async ({ phase, number, path }) => {
    if (phase === "open" && number === 1 && !changed) { changed = true; await append(path, metadata); }
  });
  const original = await fs.stat(path);
  const page = await reader.readSessionDisplayTurnPage(path, "agent", undefined, 1);
  const current = await fs.stat(path);
  assert.equal(page.indexVersion, `${current.mtimeMs}:${current.size}`);
  assert.notEqual(page.indexVersion, `${original.mtimeMs}:${original.size}`);
  assert.equal(page.total, 6);
});

test("an appended user belongs to the next page version, not the pinned page or its cursor", async (t) => {
  let changed = false;
  const { reader, path } = await fixture(t, async ({ phase, number, path }) => {
    if (phase === "open" && number === 2 && !changed) {
      changed = true;
      await append(path, { id: "u4", parentId: "a3", type: "message", message: { role: "user", content: "new-question" } });
    }
  });
  const original = await fs.stat(path);
  const page = await reader.readSessionDisplayTurnPage(path, "agent", undefined, 2);
  assert.equal(page.total, 6);
  assert.equal(page.nextBefore, 2);
  assert.equal(page.nextBeforeEntryId, "u2");
  assert.equal(page.indexVersion, `${original.mtimeMs}:${original.size}`);
  assert.deepEqual(Array.from(page.messages, (row) => row.meta.entryId), ["u2", "a2", "u3", "a3"]);
  const next = await reader.readSessionDisplayTurnPage(path, "agent", undefined, 2);
  assert.equal(next.total, 7);
  assert.equal(next.messages.at(-1).meta.entryId, "u4");
  assert.notEqual(next.indexVersion, page.indexVersion);
});

test("recent startup metadata stays tied to the same bodies even when the file later grows", async (t) => {
  const { reader, path } = await fixture(t);
  const response = await reader.readRecentMessages(path, 2);
  const snapshot = reader.getRecentSnapshot(response, path);
  await append(path, { id: "u4", parentId: "a3", type: "message", message: { role: "user", content: "new-question" } });
  assert.equal(await reader.getActiveEntryCount(path), 7);
  assert.deepEqual(Array.from(snapshot.entryIds), ["u2", "a2", "u3", "a3"]);
  assert.deepEqual(Array.from(snapshot.entryPositions), [2, 3, 4, 5]);
  assert.equal(snapshot.total, 6);
  assert.equal(reader.getRecentSnapshot(response, `${path}.other`), undefined);
});

test("a complete no-LF final row stays readable when the next record is appended during body open", async (t) => {
  let changed = false;
  const nextRow = { id: "u4", parentId: "a3", type: "message", message: { role: "user", content: "new-question" } };
  const { reader, path, initial } = await fixture(t, async ({ phase, number, path }) => {
    if (phase === "open" && number === 2 && !changed) {
      changed = true;
      await fs.appendFile(path, "\n" + JSON.stringify(nextRow));
    }
  });
  await fs.writeFile(path, initial.slice(0, -1));
  const page = await reader.readSessionDisplayTurnPage(path, "agent", undefined, 1);
  assert.equal(page.total, 6);
  assert.deepEqual(Array.from(page.messages, (row) => row.meta.entryId), ["u3", "a3"]);
  const next = await reader.readSessionDisplayTurnPage(path, "agent", undefined, 1);
  assert.equal(next.total, 7);
  assert.equal(next.messages.at(-1).meta.entryId, "u4");
});

test("an incomplete appended row neither corrupts the pinned page nor becomes permanently unreadable", async (t) => {
  let changed = false;
  const text = JSON.stringify({ id: "u4", parentId: "a3", type: "message", message: { role: "user", content: "新问题" } });
  const split = text.length - 4;
  const { reader, path } = await fixture(t, async ({ phase, number, path }) => {
    if (phase === "open" && number === 2 && !changed) {
      changed = true;
      await fs.appendFile(path, text.slice(0, split));
    }
  });
  assert.equal((await reader.readSessionDisplayTurnPage(path, "agent", undefined, 1)).total, 6);
  assert.equal((await reader.readSessionDisplayTurnPage(path, "agent", undefined, 1)).total, 6);
  await fs.appendFile(path, text.slice(split));
  const completed = await reader.readSessionDisplayTurnPage(path, "agent", undefined, 1);
  assert.equal(completed.total, 7);
  assert.equal(completed.messages.at(-1).meta.entryId, "u4");
  assert.equal(completed.messages.at(-1).text, "新问题");
});

test("a newly appended branch affects only the next snapshot's parent chain", async (t) => {
  let changed = false;
  const { reader, path } = await fixture(t, async ({ phase, number, path }) => {
    if (phase === "open" && number === 2 && !changed) {
      changed = true;
      await append(path, { id: "fork-user", parentId: "a1", type: "message", message: { role: "user", content: "fork question" } });
    }
  });
  const pinned = await reader.readSessionDisplayTurnPage(path, "agent", undefined, 50);
  assert.deepEqual(Array.from(pinned.messages, (row) => row.meta.entryId), ["u1", "a1", "u2", "a2", "u3", "a3"]);
  const next = await reader.readSessionDisplayTurnPage(path, "agent", undefined, 50);
  assert.deepEqual(Array.from(next.messages, (row) => row.meta.entryId), ["u1", "a1", "fork-user"]);
  assert.equal(next.total, 3);
  assert.notEqual(next.indexVersion, pinned.indexVersion);
});

test("concurrent body consumers keep the same cached snapshot when append occurs after both select it", async (t) => {
  let releaseFirst;
  const secondReady = new Promise((resolve) => { releaseFirst = resolve; });
  const { reader, path } = await fixture(t, async ({ phase, number, path }) => {
    if (phase === "open" && number === 2) await secondReady;
    if (phase === "open" && number === 3) {
      await append(path, { id: "u4", parentId: "a3", type: "message", message: { role: "user", content: "new-question" } });
      releaseFirst();
    }
  });
  assert.equal(await reader.getActiveEntryCount(path), 6);
  const [first, second] = await Promise.all([
    reader.readSessionDisplayTurnPage(path, "first", undefined, 1),
    reader.readSessionDisplayTurnPage(path, "second", undefined, 2),
  ]);
  assert.equal(first.total, 6);
  assert.equal(second.total, 6);
  assert.equal(first.indexVersion, second.indexVersion);
  assert.deepEqual(Array.from(first.messages, (row) => row.meta.entryId), ["u3", "a3"]);
  assert.deepEqual(Array.from(second.messages, (row) => row.meta.entryId), ["u2", "a2", "u3", "a3"]);
  assert.equal(await reader.getActiveEntryCount(path), 7);
});

for (const mutation of ["rewrite", "rewrite-and-grow", "truncate"]) {
  test(`${mutation} between index and body read is rejected, not treated as safe append`, async (t) => {
    let changed = false;
    const { reader, path } = await fixture(t, async ({ phase, number, path, initial }) => {
      if (phase !== "open" || number !== 2 || changed) return;
      changed = true;
      const content = mutation === "truncate" ? initial.slice(0, 40)
        : initial.replace("text-a1", "evil-a1") + (mutation === "rewrite-and-grow" ? JSON.stringify(metadata) + "\n" : "");
      await fs.writeFile(path, content);
    });
    await assert.rejects(reader.readRecentMessages(path, 50), { code: "SESSION_HISTORY_CHANGED" });
    assert.equal(changed, true);
  });
}

test("growth during prefix verification cannot hide a rewrite of an unselected old row", async (t) => {
  let appended = false;
  let rewritten = false;
  const { reader, path } = await fixture(t, async ({ phase, number, reads, path, initial }) => {
    if (phase === "open" && number === 2 && !appended) {
      appended = true;
      await append(path, metadata);
    } else if (phase === "read" && number === 2 && reads === 1 && !rewritten) {
      // This prefix buffer already contains the original bytes. Change an older
      // row outside the requested turn and grow the tail before fstat returns.
      rewritten = true;
      await fs.writeFile(path, initial.replace("text-a1", "evil-a1") + JSON.stringify(metadata) + "\n"
        + JSON.stringify({ ...metadata, id: "model-2", parentId: "model" }) + "\n");
    }
  });
  await assert.rejects(reader.readSessionDisplayTurnPage(path, "agent", undefined, 1), { code: "SESSION_HISTORY_CHANGED" });
  assert.equal(rewritten, true);
});

test("an edit behind the final validation cursor is detected before publishing a page", async (t) => {
  const { reader, path } = await fixture(t, async ({ phase, number, reads, path, initial }) => {
    if (phase === "read" && number === 2 && reads === 1) await append(path, metadata);
    if (phase === "read" && number === 2 && reads === 2) {
      await fs.writeFile(path, initial.replace("text-a1", "evil-a1") + JSON.stringify(metadata) + "\n"
        + JSON.stringify({ ...metadata, id: "model-2", parentId: "model" }) + "\n");
    }
  });
  await assert.rejects(reader.readSessionDisplayTurnPage(path, "agent", undefined, 1), { code: "SESSION_HISTORY_CHANGED" });
});

test("continuous normal appends do not require a globally stable file version", async (t) => {
  let count = 0;
  const { reader, path, metrics, initial } = await fixture(t, async ({ phase, path }) => {
    if (phase === "read") {
      count++;
      await append(path, { ...metadata, id: `model-${count}`, parentId: count === 1 ? "a3" : `model-${count - 1}` });
    }
  });
  const page = await reader.readSessionDisplayTurnPage(path, "agent", undefined, 1);
  assert.equal(page.total, 6);
  assert.deepEqual(Array.from(page.messages, (row) => row.meta.entryId), ["u3", "a3"]);
  assert.ok(count >= 3);
  assert.ok(metrics.bytes < 8 * Buffer.byteLength(initial) + 1024);
});

test("rewrite of a selected row during body I/O cannot return mixed old/new content", async (t) => {
  let changed = false;
  const { reader, path } = await fixture(t, async ({ phase, number, path, initial }) => {
    if (phase === "read" && number === 2 && !changed) {
      changed = true;
      await fs.writeFile(path, initial.replace("text-a1", "evil-a1") + JSON.stringify(metadata) + "\n");
    }
  });
  await assert.rejects(reader.readRecentMessages(path, 50), { code: "SESSION_HISTORY_CHANGED" });
});
