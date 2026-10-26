import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import * as fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

// 每轮 list() 都强制刷新子代理运行记录快照（新建子代理会话必须及时被过滤），
// 但未变化的记录文件不应每轮都重新读取和解析：只重读 (mtimeMs, size) 变化的文件。

function load(onRead) {
	const stubs = {
		"node:fs/promises": {
			...fsPromises,
			readFile: async (path, options) => { onRead(String(path)); return fsPromises.readFile(path, options); },
		},
	};
	const { readSubagentRecords } = loadTsCommonJs("src/main/sessions/readSubagentRecords.ts", { stubs });
	const { ScanReadQueue } = loadTsCommonJs("src/main/sessions/ScanReadQueue.ts");
	return { readSubagentRecords, queue: new ScanReadQueue(4) };
}

const normalize = (path) => path.replace(/\\/g, "/").toLowerCase();

test("unchanged run records are served from the snapshot cache while changes stay fresh", async () => {
	const root = mkdtempSync(join(tmpdir(), "pideck-subagent-records-"));
	try {
		const runDir = join(root, "pi-subagents-run");
		mkdirSync(runDir, { recursive: true });
		const first = join(runDir, "a.json");
		const second = join(runDir, "b.json");
		writeFileSync(first, JSON.stringify({ sessionFile: "C:/s/one.jsonl" }));
		writeFileSync(second, JSON.stringify({ steps: [{ sessionFile: "C:/s/two.jsonl" }] }));
		const reads = [];
		const { readSubagentRecords, queue } = load((path) => reads.push(path));
		const cache = new Map();
		const snapshot = async () => [...await readSubagentRecords(root, undefined, normalize, queue, undefined, cache)].sort();

		assert.deepEqual(await snapshot(), ["c:/s/one.jsonl", "c:/s/two.jsonl"]);
		assert.equal(reads.length, 2);

		reads.length = 0;
		assert.deepEqual(await snapshot(), ["c:/s/one.jsonl", "c:/s/two.jsonl"]);
		assert.deepEqual(reads, [], "unchanged records must not be re-read");

		// A rewritten record (new size + mtime) is re-read; a new record appears immediately.
		writeFileSync(first, JSON.stringify({ sessionFile: "C:/s/one-renamed.jsonl" }));
		utimesSync(first, new Date(), new Date(Date.now() + 5000));
		writeFileSync(join(runDir, "c.json"), JSON.stringify({ sessionFile: "C:/s/three.jsonl" }));
		reads.length = 0;
		assert.deepEqual(await snapshot(), ["c:/s/one-renamed.jsonl", "c:/s/three.jsonl", "c:/s/two.jsonl"]);
		assert.equal(reads.length, 2, "only the changed and the new record are read");

		// Deleted records disappear from the snapshot and from the cache.
		unlinkSync(second);
		assert.deepEqual(await snapshot(), ["c:/s/one-renamed.jsonl", "c:/s/three.jsonl"]);
		assert.equal(cache.size, 2);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a record that fails to parse is retried instead of being cached", async () => {
	const root = mkdtempSync(join(tmpdir(), "pideck-subagent-records-"));
	try {
		const runDir = join(root, "pi-subagents-run");
		mkdirSync(runDir, { recursive: true });
		const record = join(runDir, "a.json");
		writeFileSync(record, '{"sessionFile":"C:/s/one.js');
		const reads = [];
		const { readSubagentRecords, queue } = load((path) => reads.push(path));
		const cache = new Map();
		assert.equal((await readSubagentRecords(root, undefined, normalize, queue, undefined, cache)).size, 0);
		assert.equal((await readSubagentRecords(root, undefined, normalize, queue, undefined, cache)).size, 0);
		assert.equal(reads.length, 2, "a half-written record must be read again next round");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
