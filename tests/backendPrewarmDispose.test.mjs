import assert from "node:assert/strict";
import test from "node:test";
import { runBackendRpcWiring } from "./helpers/l3_ipcHarness.mjs";

// 启动预扫描的延迟定时器与已排队任务必须随 registerBackendRpc 的 disposer 一起释放：
// 后端释放（或重建）后，旧服务不能再扫描会话、写 catalog。

function wire() {
	const timers = [];
	const clearedTimers = [];
	const scheduled = [];
	let coordinatorDisposals = 0;
	const wiring = runBackendRpcWiring({
		timers,
		clearedTimers,
	});
	const scope = wiring.captured.get("session").deps.catalogScans;
	scope.schedule = (projectId, task) => { scheduled.push({ projectId, task }); return true; };
	const disposeScope = scope.dispose.bind(scope);
	scope.dispose = () => { coordinatorDisposals++; disposeScope(); };
	const settingsReads = [];
	wiring.services.settingsStore.get = () => { settingsReads.push(1); return {}; };
	wiring.services.sessionScanner.list = async () => [];
	wiring.services.sessionCatalog.mergeScanned = async () => {};
	return { ...wiring, timers, clearedTimers, scheduled, settingsReads, coordinatorDisposals: () => coordinatorDisposals };
}

test("dispose clears pending startup timers and its own catalog scan coordinator", () => {
	const harness = wire();
	assert.ok(harness.timers.length >= 1, "startup prewarm must be deferred onto a timer");
	const pending = [...harness.timers];
	harness.dispose();
	assert.deepEqual(harness.clearedTimers.map((handle) => handle.callback), pending, "every unfired startup timer is cleared");
	assert.equal(harness.coordinatorDisposals(), 1);
	// 即使宿主定时器实现没有真正撤销回调，迟到的回调也不能再调度扫描。
	for (const fire of pending) fire();
	assert.deepEqual(harness.scheduled, []);
});

test("per-project prewarm timers created before dispose do not schedule scans afterwards", () => {
	const harness = wire();
	harness.timers.splice(0).forEach((fire) => fire());
	const projectTimers = harness.timers.splice(0);
	assert.equal(projectTimers.length, 1, "one staggered timer per project");
	harness.dispose();
	assert.ok(harness.clearedTimers.some((handle) => handle.callback === projectTimers[0]));
	projectTimers[0]();
	assert.deepEqual(harness.scheduled, []);
});

test("a prewarm task already queued in the coordinator returns without scanning after dispose", async () => {
	const harness = wire();
	harness.timers.splice(0).forEach((fire) => fire());
	harness.timers.splice(0).forEach((fire) => fire());
	assert.equal(harness.scheduled.length, 1);
	harness.dispose();
	await harness.scheduled[0].task();
	assert.deepEqual(harness.settingsReads, [], "disposed backend must not read settings or scan");
});

test("an already running prewarm cannot merge into a disposed catalog", async () => {
	const harness = wire();
	harness.timers.splice(0).forEach((fire) => fire());
	harness.timers.splice(0).forEach((fire) => fire());
	let release;
	harness.services.sessionScanner.list = () => new Promise((resolve) => { release = resolve; });
	let merges = 0;
	harness.services.sessionCatalog.mergeScanned = async () => { merges++; };
	const task = harness.scheduled[0].task();
	harness.dispose();
	release([]);
	await task;
	assert.equal(merges, 0);
});

test("a prewarm task queued before dispose still scans while the backend is alive", async () => {
	const harness = wire();
	harness.timers.splice(0).forEach((fire) => fire());
	harness.timers.splice(0).forEach((fire) => fire());
	await harness.scheduled[0].task();
	assert.equal(harness.settingsReads.length, 1);
	harness.dispose();
});
