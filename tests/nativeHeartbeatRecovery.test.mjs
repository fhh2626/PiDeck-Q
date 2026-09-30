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
