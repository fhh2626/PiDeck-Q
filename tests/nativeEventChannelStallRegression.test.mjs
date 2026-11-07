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
 * 回归：流式输出时事件通道反复断档（stalled-event-cursor / event-history-truncated）。
 * 循环：断层补发全部 Agent 的 MB 级全量窗口 → 背压掐断 SSE / 渲染层落后后主动重连 → 再次断层。
 * 这里锁住：大帧与背压掐断必须留痕；渲染层在游标仍推进时不重连。
 * （补发范围的回归在 agentResyncScope.test.mjs。）
 */

const BIG_PAYLOAD = "x".repeat(1_200_000); // 超过大帧诊断阈值（256 KiB）

function waitMs(milliseconds) {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function createServerFixture(overrides = {}) {
	const rendererRoot = mkdtempSync(resolve(tmpdir(), "pideck-event-stall-"));
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

test("大帧与背压掐断都会上报诊断，且不携带载荷内容", async () => {
	const diagnostics = [];
	const { server, rendererRoot } = await createServerFixture({
		onEventChannelDiagnostic: (event) => diagnostics.push(event),
	});
	try {
		server.broadcast("test:big", [{ data: BIG_PAYLOAD }]);
		const large = diagnostics.find((event) => event.kind === "large-frame");
		assert.ok(large, "大帧应产生诊断");
		assert.equal(large.channel, "test:big");
		assert.ok(large.bytes > 1_000_000);
		assert.ok(!JSON.stringify(large).includes("xxxx"));

		let destroyed = false;
		const response = {
			destroyed: false,
			write: () => true,
			once: () => undefined,
			destroy: () => {
				destroyed = true;
				response.destroyed = true;
			},
		};
		const client = {
			response,
			blocked: true,
			pendingBytes: 65 * 1024 * 1024,
			pendingFrames: [],
		};
		server.clients.add(client);
		server.writeToClient(client, "id: 9\ndata: " + "y".repeat(100) + "\n\n");
		assert.equal(destroyed, true);
		const dropped = diagnostics.find((event) => event.kind === "client-backpressure-dropped");
		assert.ok(dropped, "背压掐断必须留痕");
		assert.ok(dropped.pendingBytes > 0 && dropped.frameBytes > 0);
	} finally {
		await server.stop();
		rmSync(rendererRoot, { recursive: true, force: true });
	}
});

// ---- 渲染层：游标仍在推进时不因“落后”重连 ----

class FakeEventSource {
	static instances = [];
	constructor(url) {
		this.url = String(url);
		this.closed = false;
		FakeEventSource.instances.push(this);
	}
	close() {
		this.closed = true;
	}
	emit(channel, seq, args = []) {
		this.onmessage?.({ lastEventId: String(seq), data: JSON.stringify({ channel, args }) });
	}
}

const { NativeDesktopTransport } = loadTsCommonJs("src/renderer/src/native/NativeDesktopTransport.ts", {
	stubs: {
		"@shared/desktop/DesktopRpcTransport": {},
		"@shared/desktop/nativeLimits": { MAX_NATIVE_RPC_BODY_BYTES: 32 * 1024 * 1024 },
	},
	globals: { EventSource: FakeEventSource },
});

/** 建立一个暂停读取的 SSE 连接（模拟渲染层正忙于解析上一帧）。 */
function connectPausedClient(port, lastEventId) {
	return new Promise((resolveConnection, reject) => {
		const query = new URLSearchParams({ token: "secret-token" });
		if (lastEventId !== undefined) query.set("lastEventId", String(lastEventId));
		const request = httpRequest({ host: "127.0.0.1", port, path: `/__pideck/events?${query}` }, (response) => {
			response.pause();
			const state = { closed: false, response };
			response.once("close", () => {
				state.closed = true;
			});
			resolveConnection(state);
		});
		request.once("error", reject);
		request.end();
	});
}

test("连续两个大于旧上限的全量帧不会掐断 SSE 客户端（回归：一次 flush 多个会话即断连）", async () => {
	const diagnostics = [];
	const { server, rendererRoot, address } = await createServerFixture({
		onEventChannelDiagnostic: (event) => diagnostics.push(event),
	});
	try {
		const client = await connectPausedClient(address.port);
		await waitMs(100);
		const big = "x".repeat(6_000_000); // 单帧远大于旧的 4 MiB 积压上限
		server.broadcast("agents:message", [{ agentId: "A", data: big }]);
		server.broadcast("agents:message", [{ agentId: "B", data: big }]);
		await waitMs(300);
		assert.equal(client.closed, false, "大帧自身不得触发背压掐断");
		assert.equal(server.clients.size, 1);
		assert.ok(!diagnostics.some((event) => event.kind === "client-backpressure-dropped"));
		client.response.destroy();
	} finally {
		await server.stop();
		rmSync(rendererRoot, { recursive: true, force: true });
	}
});

test("历史里含多个大帧时，带游标重连必须能完整重放而不是被再次掐断", async () => {
	const { server, rendererRoot, address } = await createServerFixture();
	try {
		const big = "x".repeat(6_000_000);
		server.broadcast("test:before", [{}]); // seq 1
		server.broadcast("agents:message", [{ agentId: "A", data: big }]); // seq 2
		server.broadcast("agents:message", [{ agentId: "B", data: big }]); // seq 3
		const client = await connectPausedClient(address.port, 1);
		await waitMs(300);
		assert.equal(client.closed, false, "重放两个大帧不应使连接再次被掐断");
		client.response.destroy();
	} finally {
		await server.stop();
		rmSync(rendererRoot, { recursive: true, force: true });
	}
});

test("连续大帧的诊断被限频，被抑制的次数随下一条上报", async () => {
	const diagnostics = [];
	const { server, rendererRoot } = await createServerFixture({
		onEventChannelDiagnostic: (event) => diagnostics.push(event),
	});
	try {
		for (let index = 0; index < 5; index += 1) server.broadcast("test:big", [{ data: BIG_PAYLOAD }]);
		const large = diagnostics.filter((event) => event.kind === "large-frame");
		assert.equal(large.length, 1, "5 秒窗口内只应上报一次");
		assert.equal(large[0].suppressedSinceLast, 0);
		assert.equal(server.suppressedLargeFrames, 4);
	} finally {
		await server.stop();
		rmSync(rendererRoot, { recursive: true, force: true });
	}
});

test("事件游标仍在向前推进时，心跳落后不会触发重连（避免打断进行中的大帧）", async () => {
	FakeEventSource.instances.length = 0;
	const transport = new NativeDesktopTransport("http://127.0.0.1:43123/", "secret-token", { initialEventSeq: 11 });
	try {
		const source = FakeEventSource.instances[0];
		source.emit("native.eventChannelReady", 11, [{ eventSeq: 11, eventSourceGeneration: "generation-a" }]);
		source.emit("test:event", 12, [{}]); // 游标推进到 12
		transport.handleHeartbeat({ eventSeq: 14, eventSourceGeneration: "generation-a" });
		await waitMs(900); // 超过两个 400ms 追赶窗口
		assert.equal(FakeEventSource.instances.length, 1, "仍在推进时不得重连");
		assert.equal(source.closed, false);
		source.emit("test:event", 14, [{}]); // 追上后应取消恢复计时
		await waitMs(500);
		assert.equal(FakeEventSource.instances.length, 1);
	} finally {
		transport.dispose();
	}
});

// ---- 渲染层：重放/重复投递的事件必须按序号去重 ----
// 服务端每次 SSE 连接都按 Last-Event-ID 重放 eventHistory；游标落后时旧的全量
// 消息快照会被再次应用，渲染层把「快照里没有的尾部消息」当成被删除而滑出，
// 表现为发送后信息流回滚一条。

test("已应用过的序号不再重复派发（重放的旧全量快照被丢弃）", () => {
	FakeEventSource.instances.length = 0;
	const transport = new NativeDesktopTransport("http://127.0.0.1:43123/", "secret-token", { initialEventSeq: 10 });
	const seen = [];
	transport.subscribe("agents:message", (payload) => seen.push(payload));
	try {
		transport.activateAfter(10);
		const source = FakeEventSource.instances[0];
		source.emit("native.eventChannelReady", 10, [{ eventSeq: 10, eventSourceGeneration: "generation-a" }]);
		source.emit("agents:message", 11, [{ totalLength: 2 }]);
		// 重连后服务端从游标 10 重放：11 已经应用过，不得再次派发。
		source.emit("agents:message", 11, [{ totalLength: 2 }]);
		source.emit("agents:message", 10, [{ totalLength: 1 }]);
		source.emit("agents:message", 12, [{ totalLength: 3 }]);
		assert.deepEqual(seen.map((payload) => payload.totalLength), [2, 3]);
	} finally {
		transport.dispose();
	}
});

test("resyncRequired 控制帧即使序号已应用也必须放行", () => {
	FakeEventSource.instances.length = 0;
	const resyncs = [];
	const transport = new NativeDesktopTransport("http://127.0.0.1:43123/", "secret-token", {
		initialEventSeq: 10,
		onResyncRequired: (payload) => resyncs.push(payload),
	});
	try {
		transport.activateAfter(10);
		const source = FakeEventSource.instances[0];
		source.emit("native.eventChannelReady", 10, [{ eventSeq: 10, eventSourceGeneration: "generation-a" }]);
		source.emit("native.resyncRequired", 10, [{ reason: "event-history-truncated" }]);
		assert.equal(resyncs.length, 1, "补发信号不能被去重吞掉");
	} finally {
		transport.dispose();
	}
});

test("首次心跳早于 eventChannelReady 时不把代次当成变更而重置游标", () => {
	FakeEventSource.instances.length = 0;
	const transport = new NativeDesktopTransport("http://127.0.0.1:43123/", "secret-token");
	try {
		assert.equal(FakeEventSource.instances.length, 1);
		// 本地代次还是空串：只补登，不重连、不把游标清零（清零会让服务端重放全部历史）。
		transport.handleHeartbeat({ eventSeq: 0, eventSourceGeneration: "generation-a" });
		assert.equal(FakeEventSource.instances.length, 1, "首次代次同步不得触发重连");
		assert.equal(transport.getEventSourceGeneration(), "generation-a");
		// 真正的代次变更仍然要重连（新服务端是新序号命名空间）。
		transport.handleHeartbeat({ eventSeq: 0, eventSourceGeneration: "generation-b" });
		assert.equal(FakeEventSource.instances.length, 2, "代次变更必须重连");
	} finally {
		transport.dispose();
	}
});

test("无 id 的事件帧不参与序号去重（不会被当成 seq 0 丢掉）", () => {
	FakeEventSource.instances.length = 0;
	const transport = new NativeDesktopTransport("http://127.0.0.1:43123/", "secret-token", { initialEventSeq: 10 });
	const seen = [];
	transport.subscribe("agents:message", (payload) => seen.push(payload));
	try {
		transport.activateAfter(10);
		const source = FakeEventSource.instances[0];
		source.emit("native.eventChannelReady", 10, [{ eventSeq: 10, eventSourceGeneration: "generation-a" }]);
		// 没有 `id:` 行：lastEventId 是空串，Number("") === 0。若参与去重会被丢弃。
		source.onmessage?.({ lastEventId: "", data: JSON.stringify({ channel: "agents:message", args: [{ totalLength: 7 }] }) });
		assert.deepEqual(seen.map((payload) => payload.totalLength), [7]);
	} finally {
		transport.dispose();
	}
});

test("启动握手带上代次时，首次心跳不会重置游标", () => {
	FakeEventSource.instances.length = 0;
	const transport = new NativeDesktopTransport("http://127.0.0.1:43123/", "secret-token", {
		initialEventSeq: 42,
		initialEventSourceGeneration: "generation-a",
	});
	try {
		transport.handleHeartbeat({ eventSeq: 42, eventSourceGeneration: "generation-a" });
		assert.equal(FakeEventSource.instances.length, 1, "同代次心跳不得重连");
		assert.equal(transport.getLastEventSeq(), 42, "游标不得被重置为 0");
	} finally {
		transport.dispose();
	}
});
