import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs/promises";
import { withHistoryFixture } from "./helpers/performanceFixtures.mjs";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

for (const size of [2, 10]) {
  test(`${size} MiB stable recent/count/compaction reads share one cold scan`, async () => {
    await withHistoryFixture(size, async ({ reader, path, metrics, fileBytes, count }) => {
      const response = await reader.readRecentMessages(path, 3);
      assert.equal(response.success, true);
      assert.equal(await reader.getActiveEntryCount(path), count);
      assert.equal((await reader.scanCompactions(path)).compactions.length, 0);
      assert.ok(metrics.bytes <= fileBytes + 512 * 1024, `read ${metrics.bytes} for ${fileBytes}`);
    });
  });
}

test("warm index reads a small full-text entry without rereading unrelated history", async () => {
  await withHistoryFixture(2, async ({ reader, path, metrics, body }) => {
    await reader.getActiveEntryCount(path);
    metrics.bytes = metrics.fullReads = metrics.opens = 0;
    assert.equal((await reader.readMessageFullText(path, "m0", "e0")).text, body);
    assert.ok(metrics.bytes < 64 * 1024, `read ${metrics.bytes} for a small entry`);
    assert.equal(metrics.fullReads, 0);
  });
});

test("concurrent cold pages share the same file scan", async () => {
  await withHistoryFixture(2, async ({ reader, path, metrics, fileBytes }) => {
    const pages = await Promise.all([reader.readSessionDisplayTurnPage(path, "a", undefined, 3), reader.readSessionDisplayTurnPage(path, "b", undefined, 3)]);
    assert.equal(pages[0].total, pages[1].total);
    assert.ok(metrics.bytes < fileBytes + 512 * 1024, `read ${metrics.bytes} for ${fileBytes}`);
  });
});

test("warm append preserves complete JSON records without a final newline", async () => {
  await withHistoryFixture(1, async ({ reader, path }) => {
    await fs.writeFile(path, JSON.stringify({ id: "root", type: "session" }) + "\n");
    await reader.getActiveEntryCount(path);
    const rows = [
      { id: "u", parentId: "root", type: "message", message: { id: "mu", role: "user", content: "question" } },
      { id: "a", parentId: "u", type: "message", message: { id: "ma", role: "assistant", content: "valid tail 😀" } },
    ];
    await fs.appendFile(path, rows.map(JSON.stringify).join("\n"));
    assert.equal((await reader.readMessageFullText(path, "ma", "a")).text, "valid tail 😀");
    assert.deepEqual(JSON.parse(JSON.stringify((await reader.readRecentMessages(path, 3)).data.messages)), rows.map((row) => row.message));
    assert.equal(await reader.getActiveEntryCount(path), 2);
    // A subsequent newline must not duplicate the previously accepted final record.
    await fs.appendFile(path, "\n");
    assert.equal(await reader.getActiveEntryCount(path), 2);
  });
});

test("unfinished append rows remain retryable when their JSON is completed", async () => {
  await withHistoryFixture(1, async ({ reader, path }) => {
    await fs.writeFile(path, JSON.stringify({ id: "root", type: "session" }) + "\n");
    await reader.getActiveEntryCount(path);
    const first = { id: "u", parentId: "root", type: "message", message: { id: "mu", role: "user", content: "question" } };
    const tail = JSON.stringify({ id: "a", parentId: "u", type: "message", message: { id: "ma", role: "assistant", content: "completed" } });
    await fs.appendFile(path, JSON.stringify(first) + "\n" + tail.slice(0, -3));
    assert.equal(await reader.getActiveEntryCount(path), 1);
    await fs.appendFile(path, tail.slice(-3));
    assert.equal((await reader.readMessageFullText(path, "ma", "a")).text, "completed");
    assert.equal(await reader.getActiveEntryCount(path), 2);
  });
});

test("growing in-place rewrite cannot reuse stale middle parent links", async () => {
  await withHistoryFixture(1, async ({ reader, path }) => {
    const rows = [
      { id: "root", type: "session" },
      ...[0, 1, 2].map((i) => ({ id: `e${i}`, parentId: i ? `e${i - 1}` : "root", type: "message",
        message: { role: i ? "assistant" : "user", content: `text${i}` } })),
    ];
    await fs.writeFile(path, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
    assert.equal(await reader.getActiveEntryCount(path), 3);
    // Same-width middle edit preserves first/last row offsets and IDs; ID probes alone are unsafe.
    rows[2].parentId = "zz";
    rows.push({ id: "e3", parentId: "e2", type: "message", message: { role: "assistant", content: "tail" } });
    await fs.writeFile(path, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
    assert.equal(await reader.getActiveEntryCount(path), 3);
  });
});

test("indexed compactions preserve physical records and explicit-content legacy semantics", async () => {
  await withHistoryFixture(1, async ({ reader, path }) => {
    const rows = [
      { id: "root", type: "session" },
      { id: "old", parentId: "root", type: "compaction", summary: "abandoned", timestamp: "2026-01-01" },
      { type: "compaction", summary: "legacy", timestamp: "2026-01-02" },
      { id: "leaf", parentId: "root", type: "message", message: { role: "user", content: "active" } },
    ];
    const content = rows.map((row) => JSON.stringify(row)).join("\r\n");
    await fs.writeFile(path, content);
    const normalize = (value) => JSON.parse(JSON.stringify(value));
    assert.deepEqual(normalize(await reader.scanCompactions(path)), normalize(await reader.scanCompactions(path, content)));
  });
});

test("short reads preserve long UTF-8 rows, CRLF, physical-first duplicate IDs and legacy messages", async () => {
  await withHistoryFixture(1, async ({ reader, path }) => {
    const text = "😀中文".repeat(9000);
    const rows = [
      { type: "message", message: { id: "legacy", role: "user", content: "no entry id" } },
      { id: "same", type: "message", message: { id: "shared", role: "user", content: text } },
      { id: "same", type: "message", message: { id: "shared", role: "user", content: "new branch" } },
    ];
    await fs.writeFile(path, rows.map((row) => JSON.stringify(row)).join("\r\n"));
    assert.equal((await reader.readMessageFullText(path, "shared", "same")).text, text);
    assert.equal((await reader.readMessageFullText(path, "shared")).text, text);
    assert.equal((await reader.readMessageFullText(path, "legacy")).text, "no entry id");
    assert.equal(await reader.getActiveEntryCount(path), 1);
  }, { maxReadBytes: 127 });
});

test("recent metadata selection preserves production trimming for full turns and no-user histories", async () => {
  const { trimHistoryMessages } = loadTsCommonJs("src/main/pi/agentUtils.ts");
  await withHistoryFixture(1, async ({ reader, path }) => {
    for (const spacing of [3, 1000]) {
      const messages = Array.from({ length: 60 }, (_, i) => ({ role: spacing === 3 && i % spacing === 1 ? "user" : "assistant", content: `body${i}` }));
      const rows = messages.map((message, i) => ({ id: `entry${i}`, parentId: i ? `entry${i - 1}` : null, type: "message", message }));
      await fs.writeFile(path, rows.map((row) => JSON.stringify(row)).join("\n"));
      for (const turns of [1, 3, 50]) {
        const response = await reader.readRecentMessages(path, turns);
        assert.deepEqual(JSON.parse(JSON.stringify(response.data.messages)), trimHistoryMessages(messages, turns));
      }
    }
  });
});

test("path replacement during a selected read rejects the outdated descriptor at the filesystem boundary", async () => {
  let replace;
  let replacedPath;
  await withHistoryFixture(1, async ({ reader, path }) => {
    await reader.getActiveEntryCount(path);
    const next = `${path}.next`;
    await fs.writeFile(next, JSON.stringify({ id: "changed", type: "message", message: { id: "m0", role: "user", content: "new" } }));
    // Windows locks this open file against rename. Model POSIX's replaced path through stat,
    // while the actual descriptor still reads the old fixture; do not pretend this is native smoke.
    replace = () => { replace = undefined; replacedPath = next; };
    await assert.rejects(reader.readMessageFullText(path, "m0", "e0"), { code: "SESSION_HISTORY_CHANGED", message: "fixture" });
  }, { beforeRead: async () => { replace?.(); }, statPath: (path) => replacedPath ?? path });
});
