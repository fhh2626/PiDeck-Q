import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

// 真实加载 src/native-node/index.ts（宿主、渲染服务、后端为替身），用假时钟和被捕获的定时器
// 验证“心跳事件 / 可见性事件 / 3 秒定时器 -> 看门狗 -> window.reload”这条装配链，
// 替代此前对入口源码做正则匹配的做法。看门狗判定本身见 rendererCrashRecovery.test.mjs。

const WINDOW_MS = 15_000;
const ENV_KEYS = [
	"PIDECK_HOST_PORT", "PIDECK_HOST_TOKEN", "PIDECK_USER_DATA", "PIDECK_ARGV_JSON",
	"PIDECK_VERSION", "PIDECK_RENDERER_ROOT", "PIDECK_MEMORY_PROFILE",
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, timeoutMs = 2_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await sleep(5);
	}
	assert.fail("timed out waiting for the sidecar to finish booting");
}

/** 启动一个替身环境里的 Sidecar；返回可驱动的假时钟、被捕获的定时器和宿主事件入口。 */
async function bootSidecar(t, { watching = true, onDispose = () => undefined } = {}) {
	const previousEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
	Object.assign(process.env, {
		PIDECK_HOST_PORT: "43211",
		PIDECK_HOST_TOKEN: "heartbeat-wiring-token",
		PIDECK_USER_DATA: "C:/pideck-heartbeat-wiring",
		PIDECK_ARGV_JSON: "[]",
		PIDECK_VERSION: "0.0.0-test",
		PIDECK_RENDERER_ROOT: "C:/pideck-heartbeat-wiring-renderer",
	});
	delete process.env.PIDECK_MEMORY_PROFILE;

	let nowMs = 5_000_000;
	const intervals = [];
	const env = { host: undefined, server: undefined, reloads: [], reloadGate: undefined };

	let stopped = false;
	async function shutdown() {
		if (!env.host || stopped) return;
		const originalExit = process.exit;
		let exited = false;
		process.exit = () => { exited = true; };
		try {
			env.host.fatalListener(new Error("test teardown"));
			await waitFor(() => exited);
			stopped = true;
		} finally {
			process.exit = originalExit;
		}
	}
	// 启动失败也还原环境；正常测试可显式关闭以检查 dispose 时的状态。
	t.after(async () => {
		try {
			await shutdown();
		} finally {
			for (const [key, value] of previousEnv) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
	});

	class FakeHostBridge {
		static async connect() { env.host = new FakeHostBridge(); return env.host; }
		constructor() { this.listeners = new Map(); }
		on(name, listener) { this.listeners.set(name, listener); return () => this.listeners.delete(name); }
		onFatal(listener) { this.fatalListener = listener; return () => undefined; }
		request(method) {
			if (method !== "window.reload") return Promise.resolve(undefined);
			env.reloads.push(nowMs);
			return env.reloadGate ?? Promise.resolve(undefined);
		}
		emit() {}
		close() {}
		async closeGracefully() {}
	}
	class FakeRendererServer {
		constructor(deps) { this.deps = deps; env.server = this; }
		async start() { return { host: "127.0.0.1", port: 43_100 }; }
		getUrl() { return "http://127.0.0.1:43100/"; }
		getLostSinceMs() { return undefined; }
		broadcast() {}
		async stop() {}
	}
	class FakeNativeBackendHost {
		constructor() {
			this.mainWindowControls = { isMinimized: () => false, markCreated() {}, markDestroyed() {} };
		}
		setLogger() {}
		hasLiveWindow() { return true; }
		shouldWatchRendererHeartbeat() { return watching; }
		markWindowDestroyed() {}
		markWindowVisible() {}
		onWindowReady() {}
		focusSessionFromNotification() { return false; }
	}
	const fakeBackend = {
		settingsStore: { get: () => ({ zoomFactor: 1 }) },
		appLogger: { error: async () => undefined, warn: async () => undefined, info: async () => undefined, debug: async () => undefined },
		dispose: async () => { await onDispose(); },
		startAfterWindowCreated: () => undefined,
		resolveSessionIdForAgent: () => undefined,
		hasActiveStreaming: () => false,
		resyncLiveRendererState: () => undefined,
	};

	loadTsCommonJs("src/native-node/index.ts", {
		globals: {
			// 保留 Date 构造器与静态解析方法，仅控制看门狗使用的 now。
			Date: class extends Date { static now() { return nowMs; } },
			// 只截获看门狗的周期定时器（3 秒一次），其余 setInterval 用不到。
			setInterval: (callback, ms) => {
				const handle = { callback, ms, unref() { return handle; } };
				intervals.push(handle);
				return handle;
			},
			clearInterval: (handle) => { handle.cleared = true; },
		},
		stubs: {
			"../main/singleInstance": {
				acquireVersionSingleInstance: async () => ({ isPrimary: true, dispose: () => undefined }),
			},
			"../main/utils/focusTarget": { extractFocusTargetFromArgv: () => null },
			"../main/settings/startupPreferences": { readSingleInstancePreference: () => false },
			"../main/backend/createBackend": { createBackend: async () => fakeBackend },
			"../main/backgrounds/BackgroundPaths": { resolveBackgroundsDir: () => "C:/pideck-heartbeat-wiring-bg" },
			"../main/windowState": { readLastWindowBounds: () => null, saveLastWindowBounds: () => undefined },
			"../main/transport/NativeRpcRouter": { NativeRpcRouter: class { handle() {} } },
			"./host/HostBridge": { HostBridge: FakeHostBridge },
			"./host/NativeBackendHost": { NativeBackendHost: FakeNativeBackendHost },
			"./platform/createNativePlatformServices": {
				createNativePlatformServices: () => ({ paths: { userData: "C:/pideck-heartbeat-wiring" } }),
			},
			"./transport/NativeRendererServer": { NativeRendererServer: FakeRendererServer },
			"./diagnostics/NativeMemoryMonitor": { NativeMemoryMonitor: class {} },
			"./focusRequest": { resolveSecondaryFocusSessionId: () => null },
			"./loadFailureRecovery": { nextLoadFailureAction: () => ({ kind: "showError", delayMs: 0 }) },
			"./transport/nativeHeartbeatRecovery": {
				createNativeHeartbeatRecoveryState: () => ({}),
				advanceNativeHeartbeatRecovery: (state) => ({ state, shouldResync: false }),
			},
		},
	});
	await waitFor(() => intervals.length > 0 && env.server && env.host);
	const watchdogTimer = intervals.find((handle) => handle.ms === 3_000);
	assert.ok(watchdogTimer, "the sidecar registers its three-second watchdog timer");

	return {
		env,
		stop: shutdown,
		timerCleared: () => watchdogTimer.cleared === true,
		advance: (ms) => { nowMs += ms; },
		tick: () => watchdogTimer.callback(),
		timerMs: () => watchdogTimer.ms,
		heartbeat: () => env.server.deps.onHeartbeat({ lastEventSeq: 0, eventSourceGeneration: "g" }, { eventChannelHealthy: true }),
		visible: (value) => env.host.listeners.get("window.visibleChanged")(value),
	};
}

test("a renderer that stays silent for three windows is reloaded through the host", async (t) => {
	const sidecar = await bootSidecar(t);
	assert.equal(sidecar.timerMs(), 3_000, "the watchdog polls every three seconds");
	sidecar.advance(3 * WINDOW_MS - 1);
	sidecar.tick();
	assert.equal(sidecar.env.reloads.length, 0);
	sidecar.advance(1);
	sidecar.tick();
	assert.equal(sidecar.env.reloads.length, 1);
});

test("shutdown disables the watchdog before awaiting backend disposal", async (t) => {
	let duringDispose;
	const sidecar = await bootSidecar(t, {
		onDispose: async () => {
			sidecar.advance(10 * WINDOW_MS);
			// 即使已排队的 tick 仍然执行，也不能重载正在退出的窗口。
			sidecar.tick();
			duringDispose = { cleared: sidecar.timerCleared(), reloads: sidecar.env.reloads.length };
			await new Promise((resolve) => setImmediate(resolve));
		},
	});
	await sidecar.stop();
	assert.deepEqual(duringDispose, { cleared: true, reloads: 0 });
});

test("renderer heartbeats keep the watchdog from reloading", async (t) => {
	const sidecar = await bootSidecar(t);
	sidecar.advance(2 * WINDOW_MS);
	sidecar.heartbeat();
	sidecar.advance(2 * WINDOW_MS);
	sidecar.tick();
	assert.equal(sidecar.env.reloads.length, 0, "a heartbeat restarts the silence clock");
	sidecar.advance(WINDOW_MS);
	sidecar.tick();
	assert.equal(sidecar.env.reloads.length, 1, "silence after the heartbeat is still caught");
});

test("a window becoming visible gives the renderer a fresh grace period; hiding does not", async (t) => {
	const sidecar = await bootSidecar(t);
	sidecar.advance(2 * WINDOW_MS);
	sidecar.visible(true);
	sidecar.advance(2 * WINDOW_MS);
	sidecar.tick();
	assert.equal(sidecar.env.reloads.length, 0);

	sidecar.advance(2 * WINDOW_MS);
	sidecar.visible(false);
	sidecar.tick();
	assert.equal(sidecar.env.reloads.length, 1, "hiding the window is not a sign of life");
});

test("the watchdog stays quiet while the host says there is no window to watch", async (t) => {
	const sidecar = await bootSidecar(t, { watching: false });
	sidecar.advance(10 * WINDOW_MS);
	sidecar.tick();
	assert.equal(sidecar.env.reloads.length, 0);
});

test("a reload that is still in flight is never requested twice", async (t) => {
	const sidecar = await bootSidecar(t);
	let finish;
	sidecar.env.reloadGate = new Promise((resolve) => { finish = resolve; });
	sidecar.advance(5 * WINDOW_MS);
	sidecar.tick();
	sidecar.advance(5 * WINDOW_MS);
	sidecar.tick();
	assert.equal(sidecar.env.reloads.length, 1);

	finish();
	// reload 的 .finally 只需要几个微任务；让出事件循环一轮即可，不依赖真实时间。
	await new Promise((resolve) => setImmediate(resolve));
	sidecar.tick();
	assert.equal(sidecar.env.reloads.length, 1, "the finished reload restarts the grace period");
});