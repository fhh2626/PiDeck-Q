import assert from "node:assert/strict";
import * as fsPromises from "node:fs/promises";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

// 摘要缓存写盘：快照在 await 前生成，写盘期间的修改必须保留到下一次写盘；
// 并发保存必须串行且不共用同一个 tmp 文件（否则会互相截断）。

/** 内存文件系统替身：writeFile 可被门控，以便在写盘途中插入修改。 */
function memoryFs() {
	const files = new Map();
	const writes = [];
	let active = 0;
	let maxActive = 0;
	let gate = null;
	return {
		files, writes,
		get maxActive() { return maxActive; },
		hold() { let release; gate = new Promise((resolve) => { release = resolve; }); return () => { gate = null; release(); }; },
		module: {
			...fsPromises,
			mkdir: async () => undefined,
			readFile: async (path) => {
				if (!files.has(path)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
				return files.get(path);
			},
			writeFile: async (path, data) => {
				active += 1; maxActive = Math.max(maxActive, active);
				writes.push(path);
				try {
					if (gate) await gate;
					files.set(path, String(data));
				} finally { active -= 1; }
			},
			rename: async (from, to) => {
				if (!files.has(from)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
				files.set(to, files.get(from));
				files.delete(from);
			},
			unlink: async (path) => { files.delete(path); },
		},
	};
}

function load(fs) {
	const { SessionSummaryCache } = loadTsCommonJs("src/main/sessions/sessionSummaryCache.ts", {
		stubs: { "node:fs/promises": fs.module },
	});
	return new SessionSummaryCache("cache.json", "/virtual");
}

const target = "/virtual/cache.json".replace(/\//g, process.platform === "win32" ? "\\" : "/");
const diskEntries = (fs) => Object.keys(JSON.parse(fs.files.get(target)).entries).sort();
const version = { mtimeMs: 1, size: 1 };

test("a change made while the cache is being written is persisted by the next save", async () => {
	const fs = memoryFs();
	const cache = load(fs);
	cache.set("a", version, "A");
	const release = fs.hold();
	const saving = cache.flush();
	await new Promise((resolve) => setImmediate(resolve));
	cache.set("b", version, "B");
	release();
	await saving;
	assert.deepEqual(diskEntries(fs), ["a"], "the in-flight write only contains the earlier snapshot");
	await cache.flush();
	assert.deepEqual(diskEntries(fs), ["a", "b"], "the later change must not be dropped as already saved");
});

test("concurrent saves are serialized onto distinct temporary files", async () => {
	const fs = memoryFs();
	const cache = load(fs);
	cache.set("a", version, "A");
	const release = fs.hold();
	const first = cache.flush();
	await new Promise((resolve) => setImmediate(resolve));
	cache.set("b", version, "B");
	const waiters = [cache.flush(), cache.flush(), cache.flush()];
	cache.set("c", version, "C");
	release();
	await Promise.all([first, ...waiters]);
	assert.equal(fs.maxActive, 1, "saves must not write concurrently");
	assert.equal(new Set(fs.writes).size, fs.writes.length, "each save needs its own temporary file");
	assert.deepEqual(diskEntries(fs), ["a", "b", "c"]);
	assert.deepEqual([...fs.files.keys()], [target], "no temporary files are left behind");
});
