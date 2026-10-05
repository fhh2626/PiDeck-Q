import assert from "node:assert/strict";
import test from "node:test";
import {
	advanceNativeHeartbeatRecovery,
	createNativeHeartbeatRecoveryState,
} from "../src/native-node/transport/nativeHeartbeatRecovery.ts";

test("stale unhealthy heartbeat snapshots do not accumulate while the renderer cursor advances", () => {
	let recovery = createNativeHeartbeatRecoveryState();
	recovery = advanceNativeHeartbeatRecovery(recovery, { lastEventSeq: 100 }, false);
	recovery = advanceNativeHeartbeatRecovery(recovery.state, { lastEventSeq: 101 }, false);
	recovery = advanceNativeHeartbeatRecovery(recovery.state, { lastEventSeq: 102 }, false);

	assert.equal(recovery.state.consecutiveStalledHeartbeats, 0);
	assert.equal(recovery.shouldReload, false);
	assert.equal(recovery.shouldResync, false);
});

test("stalled unhealthy heartbeats request a state resync instead of a reload after three unchanged cursors", () => {
	let recovery = createNativeHeartbeatRecoveryState();
	recovery = advanceNativeHeartbeatRecovery(recovery, { lastEventSeq: 100 }, false);

	recovery = advanceNativeHeartbeatRecovery(recovery.state, { lastEventSeq: 100 }, false);
	assert.equal(recovery.state.consecutiveStalledHeartbeats, 2);
	assert.equal(recovery.shouldReload, false);
	assert.equal(recovery.shouldResync, false);

	recovery = advanceNativeHeartbeatRecovery(recovery.state, { lastEventSeq: 100 }, false);
	assert.equal(recovery.state.consecutiveStalledHeartbeats, 3);
	assert.equal(recovery.shouldReload, false);
	assert.equal(recovery.shouldResync, true);
});

test("a healthy heartbeat clears the stalled cursor count", () => {
	let recovery = createNativeHeartbeatRecoveryState();
	recovery = advanceNativeHeartbeatRecovery(recovery, { lastEventSeq: 100 }, false);
	recovery = advanceNativeHeartbeatRecovery(recovery.state, { lastEventSeq: 100 }, false);
	recovery = advanceNativeHeartbeatRecovery(recovery.state, { lastEventSeq: 100 }, true);

	assert.equal(recovery.state.consecutiveStalledHeartbeats, 0);
	assert.equal(recovery.shouldReload, false);
	assert.equal(recovery.shouldResync, false);
});

test("持续停滞时 resync 指数退避，不会每个心跳都触发", () => {
	let recovery = { state: createNativeHeartbeatRecoveryState() };
	const firedAtStalledCount = [];
	for (let heartbeat = 0; heartbeat < 60; heartbeat += 1) {
		recovery = advanceNativeHeartbeatRecovery(recovery.state, { lastEventSeq: 100 }, false);
		if (recovery.shouldResync) firedAtStalledCount.push(recovery.state.consecutiveStalledHeartbeats);
	}
	// 第一次沿用原有门槛（连续停滞 3 次），之后间隔逐步拉大并封顶，而不是 3,4,5,6…
	assert.equal(firedAtStalledCount[0], 3);
	const gaps = firedAtStalledCount.slice(1).map((value, index) => value - firedAtStalledCount[index]);
	assert.ok(gaps.every((gap, index) => index === 0 || gap >= gaps[index - 1]), `gaps should not shrink: ${gaps}`);
	assert.ok(gaps.every((gap) => gap >= 6), `gaps should back off: ${gaps}`);
	assert.ok(gaps.every((gap) => gap <= 20), `gaps should be capped: ${gaps}`);
	assert.ok(firedAtStalledCount.length <= 5, `too many resyncs: ${firedAtStalledCount}`);
});

test("游标重新推进后退避重置，下一次停滞又从原门槛开始", () => {
	let recovery = { state: createNativeHeartbeatRecoveryState() };
	let fired = false;
	for (let heartbeat = 0; heartbeat < 3; heartbeat += 1) {
		recovery = advanceNativeHeartbeatRecovery(recovery.state, { lastEventSeq: 100 }, false);
		fired ||= recovery.shouldResync;
	}
	assert.equal(fired, true);
	assert.equal(recovery.state.resyncAttempts, 1);

	recovery = advanceNativeHeartbeatRecovery(recovery.state, { lastEventSeq: 150 }, false);
	assert.equal(recovery.state.resyncAttempts, 0);
	assert.equal(recovery.state.nextResyncAtStalled, 3);

	let refiredAt = null;
	for (let heartbeat = 0; heartbeat < 5; heartbeat += 1) {
		recovery = advanceNativeHeartbeatRecovery(recovery.state, { lastEventSeq: 150 }, false);
		if (recovery.shouldResync && refiredAt === null) refiredAt = recovery.state.consecutiveStalledHeartbeats;
	}
	assert.equal(refiredAt, 3);
});
