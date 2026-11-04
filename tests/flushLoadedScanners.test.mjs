import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { flushLoadedScanners, loadSessionScanner } from "./helpers/loadSessionScanner.mjs";

/** 控制防抖定时器，磁盘读写仍用真实实现，不以固定 sleep 猜测写入已完成。 */
async function fixture() {
	const home = mkdtempSync(join(tmpdir(), "pideck-flush-scanners-"));
	const timers = new Map();
	const file = join(home, ".pi", "agent", "sessions", "--tmp-proj--", "s1.jsonl");
	const cache = join(home, ".pi-desktop", "session-summary-cache.json");
	const remove = () => rmSync(home, { recursive: true, force: true });
	try {
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, [
			{ type: "session", id: "s1", cwd: "/tmp/proj", timestamp: "2026-01-01T00:00:00.000Z" },
			{ type: "message", id: "m1", message: { role: "user", content: "hello" } },
		].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
		const { SessionScanner } = loadSessionScanner(home, {
			globals: {
				setTimeout: (fn, ms, ...args) => {
					if (ms !== 800) return setTimeout(fn, ms, ...args);
					const handle = { unref() {} };
					timers.set(handle, fn);
					return handle;
				},
				clearTimeout: (handle) => { if (!timers.delete(handle)) clearTimeout(handle); },
			},
		});
		const scanner = new SessionScanner(undefined, home);
		assert.equal((await scanner.list("/tmp/proj")).length, 1);
		assert.ok(timers.size > 0, "scanning must actually schedule a cache write");
	} catch (error) {
		await flushLoadedScanners();
		remove();
		throw error;
	}
	return {
		home, cache, remove, timers,
		async cleanup() { await flushLoadedScanners(); remove(); },
	};
}

test("flushLoadedScanners writes the cache and cancels every delayed write before home removal", async () => {
	const h = await fixture();
	try {
		await flushLoadedScanners();
		assert.equal(existsSync(h.cache), true, "flush must await disk persistence");
		assert.equal(h.timers.size, 0, "no delayed write may recreate the removed home");
		h.remove();
		assert.equal(existsSync(h.home), false);
	} finally {
		await h.cleanup();
	}
});

test("without flush a scheduled write recreates the removed home", async () => {
	const h = await fixture();
	try {
		h.remove();
		for (const fn of h.timers.values()) fn();
		h.timers.clear();
		// 对照组等待最终原子重命名，而非只等 mkdir，更不假设慢盘在 1100ms 内完成。
		const deadline = Date.now() + 5_000;
		while (!existsSync(h.cache) && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		assert.equal(existsSync(h.cache), true);
	} finally {
		await h.cleanup();
	}
});
