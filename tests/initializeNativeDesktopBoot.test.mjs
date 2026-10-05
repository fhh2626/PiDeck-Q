import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * initializeNativeDesktop 的启动握手行为：
 * - /__pideck/bootstrap 无响应时必须在超时后失败（交给 showBootFailure），而不是永远停在启动画面；
 * - 事件通道就绪失败不再致命：工作台照常启动并主动重连；
 * - 事件通道健康度变化以 window 事件的形式交给入口统一提示。
 */

function createHarness({ fetchImpl, readyImpl }) {
	const transports = [];
	const dispatched = [];
	const timers = [];
	class FakeTransport {
		constructor(baseUrl, token, options) {
			this.options = options;
			this.reconnects = 0;
			this.disposed = false;
			this.invoked = [];
			transports.push(this);
		}
		ready() {
			return readyImpl();
		}
		reconnect() {
			this.reconnects += 1;
		}
		invoke(channel, ...args) {
			this.invoked.push([channel, ...args]);
			return Promise.resolve();
		}
		dispose() {
			this.disposed = true;
		}
		subscribe() {
			return () => undefined;
		}
		getLastEventSeq() {
			return 0;
		}
		getEventSourceGeneration() {
			return "";
		}
		handleHeartbeat() {}
		activateAfter() {}
	}
	class FakeCustomEvent {
		constructor(type, init) {
			this.type = type;
			this.detail = init?.detail;
		}
	}
	const window = {
		location: {
			href: "http://127.0.0.1:43123/?runtime=native&token=secret-token",
			search: "?runtime=native&token=secret-token",
			origin: "http://127.0.0.1:43123",
		},
		history: { replaceState: () => undefined },
		// 启动超时用可控计时器：测试显式触发，而不是真的等 15 秒。
		setTimeout: (callback, delayMs) => {
			timers.push({ callback, delayMs });
			return timers.length;
		},
		clearTimeout: () => undefined,
		setInterval: () => 1,
		clearInterval: () => undefined,
		addEventListener: () => undefined,
		dispatchEvent: (event) => dispatched.push(event),
	};
	const module = loadTsCommonJs("src/renderer/src/native/initializeNativeDesktop.ts", {
		stubs: {
			"@shared/desktop/createPiDesktopApi": { createPiDesktopApi: () => ({ fake: true }) },
			"./NativeDesktopSyncHost": { NativeDesktopSyncHost: class { update() {} } },
			"./NativeDesktopTransport": { NativeDesktopTransport: FakeTransport },
			"./nativeHeartbeat": { createNativeHeartbeatRequest: () => ({ run() {}, dispose() {} }) },
			"./nativeReloadUrl": { createNativeReloadUrl: (href) => href },
			"./rendererZoom": { applyRendererZoom: () => undefined },
		},
		globals: { window, fetch: fetchImpl, CustomEvent: FakeCustomEvent },
	});
	return { module, transports, dispatched, timers };
}

function okBootstrapResponse() {
	return { ok: true, status: 200, json: async () => ({ eventSeq: 7, clipboard: {}, settings: { zoomFactor: 1 } }) };
}

test("bootstrap 请求无响应时在超时后失败，而不是永远等待", async () => {
	let aborted = false;
	const harness = createHarness({
		fetchImpl: (_url, init) => new Promise((_resolve, reject) => {
			init.signal.addEventListener("abort", () => {
				aborted = true;
				reject(new Error("aborted"));
			});
		}),
		readyImpl: async () => undefined,
	});
	const pending = harness.module.initializeNativeDesktop();
	const bootstrapTimer = harness.timers.find((timer) => timer.delayMs === 15_000);
	assert.ok(bootstrapTimer, "bootstrap 必须设置超时");
	bootstrapTimer.callback();
	await assert.rejects(pending, (error) => /timed out after 15000ms/.test(error.message));
	assert.equal(aborted, true, "超时要真正中止请求");
	assert.equal(harness.transports.length, 0);
});

test("bootstrap 返回非 2xx 时以状态码失败", async () => {
	const harness = createHarness({
		fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }),
		readyImpl: async () => undefined,
	});
	await assert.rejects(harness.module.initializeNativeDesktop(), (error) => /\(503\)/.test(error.message));
});

test("事件通道就绪失败不再致命：工作台继续启动并主动重连", async () => {
	const harness = createHarness({
		fetchImpl: async () => okBootstrapResponse(),
		readyImpl: async () => {
			throw new Error("Native event channel timed out before becoming ready");
		},
	});
	const runtime = await harness.module.initializeNativeDesktop();
	assert.ok(runtime.api, "仍应返回可用的桌面 API");
	const [transport] = harness.transports;
	assert.equal(transport.reconnects, 1, "就绪失败后必须重连");
	assert.equal(transport.disposed, false, "不能把仍可恢复的 transport 释放掉");
	// 不再抛错后这里是唯一的留痕：必须经 RPC 直接写入日志文件（此时 desktopApi 仍是预览实现）。
	const logs = transport.invoked.filter(([channel]) => channel === "renderer:log");
	assert.equal(logs.length, 1);
	assert.equal(logs[0][1], "warn");
	assert.match(logs[0][3], /not ready during bootstrap/);
	assert.match(logs[0][4].error, /timed out before becoming ready/);
});

test("事件通道健康度变化以 window 事件派发给入口", async () => {
	const harness = createHarness({
		fetchImpl: async () => okBootstrapResponse(),
		readyImpl: async () => undefined,
	});
	await harness.module.initializeNativeDesktop();
	const [transport] = harness.transports;
	transport.options.onEventChannelHealthChange(false, { failedAttempts: 2 });
	transport.options.onEventChannelHealthChange(true, { failedAttempts: 0 });
	const events = harness.dispatched.filter((event) => event.type === harness.module.NATIVE_EVENT_CHANNEL_HEALTH_EVENT);
	assert.equal(
		JSON.stringify(events.map((event) => event.detail)),
		JSON.stringify([{ healthy: false, failedAttempts: 2 }, { healthy: true, failedAttempts: 0 }]),
	);
	// 健康度变化的日志同样经 RPC 写入，启动期也能进日志文件。
	const logs = transport.invoked
		.filter(([channel]) => channel === "renderer:log")
		.map(([, level, scope, message]) => `${level}|${scope}|${message}`);
	assert.deepEqual([...logs], [
		"warn|renderer|Native event channel unhealthy",
		"info|renderer|Native event channel recovered",
	]);
});
