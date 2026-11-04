import assert from "node:assert/strict";
import test from "node:test";
import { shouldReloadAfterMissedHeartbeats, shouldResetHeartbeatAfterSidecarSuspend } from "../src/native-node/transport/nativeHeartbeatWatchdog.ts";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { NativeBackendHost } = loadTsCommonJs("src/native-node/host/NativeBackendHost.ts", {
	stubs: {
		"../../shared/ipc": { ipcChannels: { appWindowMaximizedChanged: "window:maximized" } },
		"../../main/browser/externalLinks": { openExternalLink: async () => undefined },
	},
});

function createHost() {
	const listeners = new Map();
	return {
		on(name, listener) {
			listeners.set(name, listener);
			return () => listeners.delete(name);
		},
		request: async () => undefined,
		emit(name, payload) {
			listeners.get(name)?.(payload);
		},
	};
}

test("heartbeat watchdog tolerates two complete missed windows", () => {
	assert.equal(shouldReloadAfterMissedHeartbeats(15_000), false);
	assert.equal(shouldReloadAfterMissedHeartbeats(30_000), false);
	assert.equal(shouldReloadAfterMissedHeartbeats(44_999), false);
});

test("heartbeat watchdog reloads after three complete missed windows", () => {
	assert.equal(shouldReloadAfterMissedHeartbeats(45_000), true);
});

test("a recovered heartbeat resets the watchdog through a fresh elapsed duration", () => {
	assert.equal(shouldReloadAfterMissedHeartbeats(45_000), true);
	assert.equal(shouldReloadAfterMissedHeartbeats(0), false);
});

test("only a tick gap that covers a full reload window is treated as suspend", () => {
	assert.equal(shouldResetHeartbeatAfterSidecarSuspend(3_000), false);
	assert.equal(shouldResetHeartbeatAfterSidecarSuspend(10_001), false);
	assert.equal(shouldResetHeartbeatAfterSidecarSuspend(44_999), false);
	assert.equal(shouldResetHeartbeatAfterSidecarSuspend(45_000), true);
	assert.equal(shouldResetHeartbeatAfterSidecarSuspend(89_000), true);
});

test("NativeBackendHost enables the renderer watchdog only after Qt reports visibility", () => {
	const host = createHost();
	const rendererServer = { broadcast: () => undefined };
	const backendHost = new NativeBackendHost(host, rendererServer, () => ({
		showWindow: "Show",
		restart: "Restart",
		quit: "Quit",
	}));

	backendHost.markWindowCreated();
	assert.equal(backendHost.hasLiveWindow(), true);
	assert.equal(backendHost.shouldWatchRendererHeartbeat(), false);

	backendHost.markWindowVisible(true);
	assert.equal(backendHost.shouldWatchRendererHeartbeat(), true);
	backendHost.markWindowVisible(false);
	assert.equal(backendHost.shouldWatchRendererHeartbeat(), false);
});
