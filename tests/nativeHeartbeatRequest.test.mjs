import assert from "node:assert/strict";
import test from "node:test";
import { createNativeHeartbeatRequest } from "../src/renderer/src/native/nativeHeartbeat.ts";

function scheduler() {
	let nextId = 0;
	const timers = new Map();
	return {
		setTimeout(callback, delayMs) {
			const id = ++nextId;
			timers.set(id, { callback, delayMs });
			return id;
		},
		clearTimeout(id) {
			timers.delete(id);
		},
		fireAll() {
			for (const { callback } of [...timers.values()]) callback();
		},
		pendingCount() {
			return timers.size;
		},
	};
}

function deferred() {
	let resolve;
	let reject;
	const promise = new Promise((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

test("native heartbeat request stays single-flight while an earlier request is pending", async () => {
	const clock = scheduler();
	const requests = [];
	const heartbeat = createNativeHeartbeatRequest(
		(signal) => {
			const pending = deferred();
			requests.push({ pending, signal });
			return pending.promise;
		},
		clock,
		10_000,
	);

	heartbeat.run();
	heartbeat.run();
	heartbeat.run();
	assert.equal(requests.length, 1);
	assert.equal(clock.pendingCount(), 1);

	requests[0].pending.resolve();
	await Promise.resolve();
	await Promise.resolve();
	assert.equal(clock.pendingCount(), 0);
	heartbeat.run();
	assert.equal(requests.length, 2);
	heartbeat.dispose();
});

test("native heartbeat request aborts on timeout and dispose", async () => {
	const clock = scheduler();
	const requests = [];
	const heartbeat = createNativeHeartbeatRequest(
		(signal) => {
			const pending = deferred();
			requests.push({ pending, signal });
			signal.addEventListener("abort", () => pending.reject(signal.reason), { once: true });
			return pending.promise;
		},
		clock,
		10_000,
	);

	heartbeat.run();
	assert.equal(requests.length, 1);
	assert.equal(requests[0].signal.aborted, false);
	clock.fireAll();
	assert.equal(requests[0].signal.aborted, true);
	assert.equal(clock.pendingCount(), 0);
	await Promise.resolve();
	await Promise.resolve();

	heartbeat.run();
	assert.equal(requests.length, 2);
	heartbeat.dispose();
	assert.equal(requests[1].signal.aborted, true);
	heartbeat.run();
	assert.equal(requests.length, 2);
});
