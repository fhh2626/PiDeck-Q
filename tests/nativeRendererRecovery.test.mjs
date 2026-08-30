import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

function waitMs(milliseconds) {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor(predicate, timeoutMs = 2_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await waitMs(10);
	}
	assert.fail("timed out waiting for native renderer recovery");
}

test("native renderer recovery reloads Qt before renderer.ready when liveWindow is false", async () => {
	const previousEnvironment = new Map([
		["PIDECK_HOST_PORT", process.env.PIDECK_HOST_PORT],
		["PIDECK_HOST_TOKEN", process.env.PIDECK_HOST_TOKEN],
		["PIDECK_USER_DATA", process.env.PIDECK_USER_DATA],
		["PIDECK_ARGV_JSON", process.env.PIDECK_ARGV_JSON],
		["PIDECK_VERSION", process.env.PIDECK_VERSION],
		["PIDECK_RENDERER_ROOT", process.env.PIDECK_RENDERER_ROOT],
		["PIDECK_MEMORY_PROFILE", process.env.PIDECK_MEMORY_PROFILE],
	]);
	process.env.PIDECK_HOST_PORT = "43210";
	process.env.PIDECK_HOST_TOKEN = "recovery-test-token";
	process.env.PIDECK_USER_DATA = "C:/pideck-recovery-test";
	process.env.PIDECK_ARGV_JSON = "[]";
	process.env.PIDECK_VERSION = "0.1.5";
	process.env.PIDECK_RENDERER_ROOT = "C:/pideck-recovery-renderer";
	delete process.env.PIDECK_MEMORY_PROFILE;

	let fakeHost;
	let fakeRendererServer;
	class FakeHostBridge {
		static async connect() {
			fakeHost = new FakeHostBridge();
			return fakeHost;
		}

		constructor() {
			this.listeners = new Map();
			this.requests = [];
			this.sent = [];
		}

		on(name, listener) {
			this.listeners.set(name, listener);
			return () => this.listeners.delete(name);
		}

		onFatal(listener) {
			this.fatalListener = listener;
			return () => {
				this.fatalListener = undefined;
			};
		}

		request(method, params) {
			this.requests.push({ method, params });
			return Promise.resolve(undefined);
		}

		emit(name, payload) {
			this.sent.push({ name, payload });
		}

		close() {}
		async closeGracefully() {}
	}

	class FakeRendererServer {
		constructor(deps) {
			this.deps = deps;
			this.startCount = 0;
			fakeRendererServer = this;
		}

		async start() {
			this.startCount += 1;
			return { host: "127.0.0.1", port: 43_000 + this.startCount };
		}

		getUrl() {
			return `http://127.0.0.1:${43_000 + this.startCount}/`;
		}

		broadcast() {}
		async stop() {}

		fail() {
			this.deps.onServerError?.(new Error("simulated renderer server failure"));
		}
	}

	class FakeNativeBackendHost {
		constructor() {
			this.mainWindowControls = {
				isMinimized: () => false,
				markCreated: () => undefined,
				markDestroyed: () => undefined,
			};
		}

		setLogger() {}
		hasLiveWindow() { return false; }
		shouldWatchRendererHeartbeat() { return false; }
		markWindowDestroyed() {}
		markWindowVisible() {}
		onWindowReady() {}
		focusSessionFromNotification() { return false; }
	}

	const fakeBackend = {
		settingsStore: { get: () => ({ zoomFactor: 1 }) },
		appLogger: { error: async () => undefined, warn: async () => undefined },
		dispose: async () => undefined,
		startAfterWindowCreated: () => undefined,
		resolveSessionIdForAgent: () => undefined,
		hasActiveStreaming: () => false,
	};

	try {
		loadTsCommonJs("src/native-node/index.ts", {
			stubs: {
				"../main/singleInstance": {
					acquireVersionSingleInstance: async () => ({ isPrimary: true, dispose: () => undefined }),
				},
				"../main/utils/focusTarget": { extractFocusTargetFromArgv: () => null },
				"../main/settings/startupPreferences": { readSingleInstancePreference: () => false },
				"../main/backend/createBackend": { createBackend: async () => fakeBackend },
				"../main/backgrounds/BackgroundPaths": { resolveBackgroundsDir: () => "C:/pideck-recovery-backgrounds" },
				"../main/windowState": {
					readLastWindowBounds: () => null,
					saveLastWindowBounds: () => undefined,
				},
				"../main/transport/NativeRpcRouter": { NativeRpcRouter: class { handle() {} } },
				"./host/HostBridge": { HostBridge: FakeHostBridge },
				"./host/NativeBackendHost": { NativeBackendHost: FakeNativeBackendHost },
				"./platform/createNativePlatformServices": {
					createNativePlatformServices: () => ({ paths: { userData: "C:/pideck-recovery-test" } }),
				},
				"./transport/NativeRendererServer": { NativeRendererServer: FakeRendererServer },
				"./diagnostics/NativeMemoryMonitor": { NativeMemoryMonitor: class {} },
				"./focusRequest": { resolveSecondaryFocusSessionId: () => null },
				"./loadFailureRecovery": {
					nextLoadFailureAction: () => ({ kind: "showError", delayMs: 0 }),
				},
				"./transport/nativeHeartbeatWatchdog": {
					shouldReloadAfterMissedHeartbeats: () => false,
				},
				"./transport/nativeHeartbeatRecovery": {
					createNativeHeartbeatRecoveryState: () => ({}),
					advanceNativeHeartbeatRecovery: (state) => ({ state, shouldReload: false }),
				},
			},
		});
		await waitFor(() => fakeRendererServer?.startCount === 1);
		await waitMs(20);
		assert.ok(fakeHost);
		assert.ok(fakeRendererServer);
		assert.equal(fakeHost.requests.some((request) => request.method === "window.load"), false);

		fakeRendererServer.fail();
		await waitFor(() => fakeHost.requests.some((request) => request.method === "window.load"));
		assert.equal(fakeRendererServer.startCount, 2);
		const reloadRequest = fakeHost.requests.find((request) => request.method === "window.load");
		assert.ok(reloadRequest);
		assert.match(reloadRequest.params.url, /:43002\/\?runtime=native&token=recovery-test-token/);

		const originalExit = process.exit;
		let fatalExitCode;
		try {
			process.exit = (code) => {
				fatalExitCode = code;
			};
			fakeHost.fatalListener(new Error("simulated host disconnect"));
			assert.equal(fatalExitCode, 1);
		} finally {
			process.exit = originalExit;
		}
	} finally {
		for (const [key, value] of previousEnvironment) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
});
