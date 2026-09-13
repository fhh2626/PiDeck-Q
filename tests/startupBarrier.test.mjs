import assert from "node:assert/strict";
import test from "node:test";

import {
	createStartupBarrier,
	noopStartupBarrier,
} from "../src/main/utils/StartupBarrier.ts";

/**
 * StartupBarrier 语义契约：
 * - 首次 spawn 前必须等到已登记任务完成；
 * - 任务失败不能把等待方拖成 reject；
 * - 超时后必须放行（不能让 UNC 卡死的 WSL 永久阻塞 Agent 启动）；
 * - settle 后不重复等待（热路径开销）。
 */

test("wait resolves immediately when nothing was registered", async () => {
	const barrier = createStartupBarrier();
	assert.equal(await barrier.wait(50), true);
});

test("wait resolves after the registered task finishes", async () => {
	const barrier = createStartupBarrier();
	let done = false;
	barrier.add(
		new Promise((resolve) => {
			setTimeout(() => {
				done = true;
				resolve(undefined);
			}, 10);
		}),
	);
	assert.equal(done, false, "task must still be in flight before waiting");
	assert.equal(await barrier.wait(1_000), true);
	assert.equal(done, true);
	// 已 settle 的屏障不该再拖住后续 spawn
	assert.equal(await barrier.wait(10), true);
});

test("a rejecting task does not reject the barrier", async () => {
	const barrier = createStartupBarrier();
	barrier.add(Promise.reject(new Error("migration blew up")));
	assert.equal(await barrier.wait(1_000), true, "barrier must swallow task failures");
});

test("wait times out and reports false instead of blocking forever", async () => {
	const barrier = createStartupBarrier();
	// 模拟 UNC 指向被挂起的 WSL：这个 promise 永不 settle。
	barrier.add(new Promise(() => {}));
	const startedAt = Date.now();
	assert.equal(await barrier.wait(40), false, "timeout must return false so the caller can log and continue");
	assert.ok(Date.now() - startedAt >= 30, "must actually wait out the timeout window");
	// 超时后未 settle 的任务保留在名单里：下一次 spawn 仍会再等一轮。
	assert.equal(await barrier.wait(20), false);
});

test("wait covers every task registered before it", async () => {
	const barrier = createStartupBarrier();
	const finished = [];
	const settle = (name, ms) =>
		new Promise((resolve) => setTimeout(() => { finished.push(name); resolve(undefined); }, ms));
	barrier.add(settle("a", 15));
	barrier.add(settle("b", 5));
	assert.equal(await barrier.wait(1_000), true);
	assert.deepEqual(finished, ["b", "a"]);
});

test("noop barrier never blocks the spawn path", async () => {
	noopStartupBarrier.add(new Promise(() => {}));
	assert.equal(await noopStartupBarrier.wait(), true);
});
