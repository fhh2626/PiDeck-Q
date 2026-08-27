import assert from "node:assert/strict";
import test from "node:test";
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
