import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { NativeRpcRouter } from "../src/main/transport/NativeRpcRouter.ts";
import { NativeRendererServer } from "../src/native-node/transport/NativeRendererServer.ts";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 回归：断层恢复链路上 review 发现的三个洞。
 * 1. 1 秒去重窗口内的第二次补发请求被直接丢弃，第二个断层连接永远拿不到补发帧；
 * 2. 补发范围按“近 30 秒有无下发”估计，断层更久时漏补；现在按断层起点时间精确判断；
 * 3. 事件通道持续连不上时页面静默失去实时更新，没有日志也没有提示。
 */

const { LiveResyncCoalescer } = loadTsCommonJs("src/native-node/transport/liveResyncCoalescer.ts");
const { advanceNativeHeartbeatRecovery, createNativeHeartbeatRecoveryState } = loadTsCommonJs(
	"src/native-node/transport/nativeHeartbeatRecovery.ts",
);

function waitMs(milliseconds) {
	return new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
}

function createManualTimers() {
	const timers = [];
	return {
		setTimer: (callback, delayMs) => {
			const timer = { callback, delayMs, cleared: false, unref: () => undefined };
			timers.push(timer);
			return timer;
		},
		clearTimer: (timer) => {
			timer.cleared = true;
		},
		fireNext: () => {
			const timer = timers.find((candidate) => !candidate.cleared && !candidate.fired);
			assert.ok(timer, "应有待触发的计时器");
			timer.fired = true;
			timer.callback();
		},
		pendingCount: () => timers.filter((timer) => !timer.cleared && !timer.fired).length,
	};
}

// ---- 1. 补发节流：窗口内请求合并为尾随补发，而不是丢弃 ----

test("窗口内的第二次补发请求不会丢失，而是在窗口结束时补发一次", () => {
	const timers = createManualTimers();
	const runs = [];
	const coalesced = [];
	const coalescer = new LiveResyncCoalescer({
		windowMs: 1_000,
		run: (request) => runs.push(request),
		onCoalesced: (request) => coalesced.push(request.reason),
		setTimer: timers.setTimer,
		clearTimer: timers.clearTimer,
	});
	coalescer.request({ reason: "event-history-truncated", lostSinceMs: 100 });
	assert.equal(runs.length, 1, "第一次请求立即执行");
	coalescer.request({ reason: "event-history-truncated", lostSinceMs: 200 });
	coalescer.request({ reason: "stalled-event-cursor", lostSinceMs: 50 });
	assert.equal(runs.length, 1, "窗口内不重复执行");
	assert.deepEqual(coalesced, ["event-history-truncated", "stalled-event-cursor"]);
	timers.fireNext();
	assert.equal(runs.length, 2, "窗口结束时必须补发一次");
	assert.equal(runs[1].lostSinceMs, 50, "合并后取最早的断层起点");
	assert.equal(timers.pendingCount(), 1, "尾随补发本身也开启新的节流窗口");
	timers.fireNext();
	assert.equal(runs.length, 2, "窗口内没有新请求时不额外补发");
});

test("合并的请求中任一断层起点未知，尾随补发按未知（全量）处理", () => {
	const timers = createManualTimers();
	const runs = [];
	const coalescer = new LiveResyncCoalescer({
		windowMs: 1_000,
		run: (request) => runs.push(request),
		setTimer: timers.setTimer,
		clearTimer: timers.clearTimer,
	});
	coalescer.request({ reason: "oversized-event", lostSinceMs: 10 });
	coalescer.request({ reason: "event-history-truncated" });
	coalescer.request({ reason: "event-history-truncated", lostSinceMs: 5 });
	timers.fireNext();
	assert.equal(runs.length, 2);
	assert.equal(runs[1].lostSinceMs, undefined);
});

test("dispose 后不再执行尾随补发", () => {
	const timers = createManualTimers();
	const runs = [];
	const coalescer = new LiveResyncCoalescer({
		windowMs: 1_000,
		run: (request) => runs.push(request),
		setTimer: timers.setTimer,
		clearTimer: timers.clearTimer,
	});
	coalescer.request({ reason: "event-history-truncated", lostSinceMs: 1 });
	coalescer.request({ reason: "event-history-truncated", lostSinceMs: 2 });
	coalescer.dispose();
	assert.equal(timers.pendingCount(), 0);
	coalescer.request({ reason: "event-history-truncated", lostSinceMs: 3 });
	assert.equal(runs.length, 1);
});

test("补发执行期间由补发自身引发的请求被忽略，不会形成每个窗口一次的无限重推", () => {
	const timers = createManualTimers();
	const runs = [];
	const ignored = [];
	let coalescer;
	coalescer = new LiveResyncCoalescer({
		windowMs: 1_000,
		// 模拟：补发推送的帧超出单帧上限被丢弃，同步又报告一次 oversized-event。
		run: (request) => {
			runs.push(request);
			coalescer.request({ reason: "oversized-event", lostSinceMs: 999 });
		},
		onReentrantIgnored: (request) => ignored.push(request.reason),
		setTimer: timers.setTimer,
		clearTimer: timers.clearTimer,
	});
	coalescer.request({ reason: "oversized-event", lostSinceMs: 1 });
	assert.equal(runs.length, 1);
	assert.deepEqual(ignored, ["oversized-event"]);
	timers.fireNext();
	assert.equal(runs.length, 1, "自身引发的请求不得排成尾随补发");
	assert.equal(timers.pendingCount(), 0, "没有待执行的补发时节流器应归于空闲");
	coalescer.request({ reason: "event-history-truncated", lostSinceMs: 2 });
	assert.equal(runs.length, 2, "外部的新请求照常立即执行");
});

test("补发抛错被收住并上报，不会成为未捕获异常，节流器继续可用", () => {
	const timers = createManualTimers();
	const errors = [];
	let attempts = 0;
	const coalescer = new LiveResyncCoalescer({
		windowMs: 1_000,
		run: () => {
			attempts += 1;
			throw new Error(`resync boom ${attempts}`);
		},
		onError: (error, request) => errors.push(`${request.reason}:${error.message}`),
		setTimer: timers.setTimer,
		clearTimer: timers.clearTimer,
	});
	assert.doesNotThrow(() => coalescer.request({ reason: "event-history-truncated", lostSinceMs: 1 }));
	coalescer.request({ reason: "stalled-event-cursor", lostSinceMs: 2 });
	// 尾随补发在定时器回调里执行：这里抛出就会让 sidecar 进程退出。
	assert.doesNotThrow(() => timers.fireNext());
	assert.deepEqual(errors, ["event-history-truncated:resync boom 1", "stalled-event-cursor:resync boom 2"]);
	timers.fireNext();
	coalescer.request({ reason: "oversized-event", lostSinceMs: 3 });
	assert.equal(attempts, 3, "出错后不能卡在 running 状态");
});

// ---- 2. 服务端给出断层起点时间（进程内单调时钟口径） ----

async function createServerFixture(overrides = {}) {
	const rendererRoot = mkdtempSync(resolve(tmpdir(), "pideck-resync-gap-"));
	writeFileSync(join(rendererRoot, "index.html"), "<html>native</html>");
	const server = new NativeRendererServer({
		router: new NativeRpcRouter(),
		token: "secret-token",
		rendererRoot,
		backgroundDirectory: rendererRoot,
		getBootstrap: async () => ({ clipboard: {}, settings: { zoomFactor: 1, memoryProfileEnabled: false } }),
		...overrides,
	});
	const address = await server.start();
	return { server, rendererRoot, address };
}

function connectClient(port, lastEventId) {
	return new Promise((resolveConnection, reject) => {
		const query = new URLSearchParams({ token: "secret-token", lastEventId: String(lastEventId) });
		const request = httpRequest({ host: "127.0.0.1", port, path: `/__pideck/events?${query}` }, (response) => {
			resolveConnection(response);
		});
		request.once("error", reject);
		request.end();
	});
}

test("getLostSinceMs 返回渲染层丢失的第一帧的产生时间；序号空间不符时返回 undefined", async () => {
	const { server, rendererRoot } = await createServerFixture();
	try {
		const before = performance.now();
		server.broadcast("test:a", [{}]); // seq 1
		await waitMs(20);
		const middle = performance.now();
		server.broadcast("test:b", [{}]); // seq 2
		const lostSince = server.getLostSinceMs(1);
		assert.ok(lostSince >= middle, "游标停在 1 时，丢失的是 seq 2，时间应晚于 seq 1");
		assert.ok(server.getLostSinceMs(0) >= before && server.getLostSinceMs(0) < middle);
		assert.equal(server.getLostSinceMs(2), undefined, "没有丢失任何帧");
		assert.equal(server.getLostSinceMs(1, "another-generation"), undefined, "旧序号空间的游标不可比较");
		assert.equal(server.getLostSinceMs(undefined), undefined);
	} finally {
		await server.stop();
		rmSync(rendererRoot, { recursive: true, force: true });
	}
});

test("历史被裁后带旧游标重连：onReplayGap 携带断层起点时间", async () => {
	const gaps = [];
	const { server, rendererRoot, address } = await createServerFixture({
		onReplayGap: (info) => gaps.push(info),
	});
	try {
		server.broadcast("test:first", [{}]); // seq 1
		await waitMs(20);
		const afterFirst = performance.now();
		for (let index = 0; index < 4_200; index += 1) server.broadcast("test:filler", [{ index }]);
		const response = await connectClient(address.port, 1);
		await waitMs(50);
		assert.equal(gaps.length, 1);
		assert.equal(gaps[0].reason, "event-history-truncated");
		assert.equal(typeof gaps[0].lostSinceMs, "number");
		assert.ok(gaps[0].lostSinceMs >= afterFirst, "断层起点应是 seq 2 的产生时间");
		response.destroy();
	} finally {
		await server.stop();
		rmSync(rendererRoot, { recursive: true, force: true });
	}
});

// ---- 心跳恢复：首次门槛跟随调用参数 ----

test("首次 resync 门槛跟随 reloadAfter 参数，而不是创建状态时的默认值", () => {
	let state = createNativeHeartbeatRecoveryState();
	const fired = [];
	for (let index = 0; index < 5; index += 1) {
		const result = advanceNativeHeartbeatRecovery(state, { lastEventSeq: 1 }, false, 5);
		state = result.state;
		fired.push(result.shouldResync);
	}
	assert.equal(JSON.stringify(fired), JSON.stringify([false, false, false, false, true]));
});

// ---- 3. 渲染层：事件通道持续连不上时上报，并在 CLOSED 后自行重连 ----

class FakeEventSource {
	static instances = [];
	constructor(url) {
		this.url = String(url);
		this.closed = false;
		this.readyState = 0;
		FakeEventSource.instances.push(this);
	}
	close() {
		this.closed = true;
		this.readyState = 2;
	}
	emit(channel, seq, args = []) {
		this.onmessage?.({ lastEventId: String(seq), data: JSON.stringify({ channel, args }) });
	}
	failFatally() {
		this.readyState = 2;
		this.onerror?.();
	}
}

const { NativeDesktopTransport } = loadTsCommonJs("src/renderer/src/native/NativeDesktopTransport.ts", {
	stubs: {
		"@shared/desktop/DesktopRpcTransport": {},
		"@shared/desktop/nativeLimits": { MAX_NATIVE_RPC_BODY_BYTES: 32 * 1024 * 1024 },
	},
	globals: { EventSource: FakeEventSource },
});

test("连续多次连接都未就绪时上报不健康，就绪后上报恢复，且各只上报一次", async () => {
	FakeEventSource.instances.length = 0;
	const health = [];
	const transport = new NativeDesktopTransport("http://127.0.0.1:43123/", "secret-token", {
		initialEventSeq: 0,
		readyTimeoutMs: 60_000,
		onEventChannelHealthChange: (healthy, info) => health.push({ healthy, failedAttempts: info.failedAttempts }),
	});
	try {
		transport.reconnect(); // 第 2 次
		assert.equal(health.length, 0, "一次重连不算不健康");
		transport.reconnect(); // 第 3 次
		transport.reconnect(); // 第 4 次：不重复上报
		assert.equal(JSON.stringify(health), JSON.stringify([{ healthy: false, failedAttempts: 2 }]));
		const latest = FakeEventSource.instances.at(-1);
		latest.emit("native.eventChannelReady", 0, [{ eventSeq: 0, eventSourceGeneration: "g" }]);
		assert.equal(JSON.stringify(health.at(-1)), JSON.stringify({ healthy: true, failedAttempts: 0 }));
		transport.reconnect();
		assert.equal(health.length, 2, "恢复后单次重连不再上报");
	} finally {
		transport.dispose();
	}
});

test("EventSource 进入 CLOSED（不会自动重试）后，transport 按退避自行重连", async () => {
	FakeEventSource.instances.length = 0;
	const transport = new NativeDesktopTransport("http://127.0.0.1:43123/", "secret-token", {
		initialEventSeq: 5,
		readyTimeoutMs: 60_000,
	});
	try {
		FakeEventSource.instances[0].failFatally();
		await waitMs(1_150); // 首次退避 1 秒
		assert.equal(FakeEventSource.instances.length, 2, "CLOSED 后必须重新建立连接");
		assert.match(FakeEventSource.instances[1].url, /lastEventId=5/, "重连要带上游标");
		// 非 CLOSED 的错误交给 EventSource 自己重试，不额外建连。
		FakeEventSource.instances[1].onerror?.();
		await waitMs(50);
		assert.equal(FakeEventSource.instances.length, 2);
	} finally {
		transport.dispose();
	}
});

test("dispose 会取消待执行的 CLOSED 重连", async () => {
	FakeEventSource.instances.length = 0;
	const transport = new NativeDesktopTransport("http://127.0.0.1:43123/", "secret-token", { readyTimeoutMs: 60_000 });
	FakeEventSource.instances[0].failFatally();
	transport.dispose();
	await waitMs(1_150);
	assert.equal(FakeEventSource.instances.length, 1);
});

test("断连提示不会自动消失：持续断连期间一直可见，恢复时显式关闭", async () => {
	const { readFileSync } = await import("node:fs");
	const main = readFileSync("src/renderer/src/main.tsx", "utf8");
	assert.match(main, /showNotice\(t\("app\.eventChannelLost"\), Number\.POSITIVE_INFINITY, "warning"\)/);
	assert.match(main, /if \(!detail\.healthy\) \{[\s\S]*?return;\s*\}\s*dismissNotice\(eventChannelNoticeId\);/);
	// 日志改由 initializeNativeDesktop 经 RPC 写入（见 initializeNativeDesktopBoot.test.mjs），入口不重复记录。
	assert.doesNotMatch(main, /Native event channel (unhealthy|recovered)/);
});
