import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

function waitMs(milliseconds) {
	return new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
}

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
