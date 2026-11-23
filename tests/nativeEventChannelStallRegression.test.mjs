import assert from "node:assert/strict";

import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs"; // 超过大帧诊断阈值（256 KiB）

function waitMs(milliseconds) {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

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
