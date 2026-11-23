import assert from "node:assert/strict";

import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

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
		this.emitRaw(seq, JSON.stringify({ channel, args }));
	}
	emitRaw(seq, data) {
		this.onmessage?.({ lastEventId: String(seq), data });
	}
}

const { NativeDesktopTransport, NATIVE_CLIPBOARD_SNAPSHOT_TIMEOUT_MS, nativeRpcTimeoutMs } = loadTsCommonJs("src/renderer/src/native/NativeDesktopTransport.ts", {
	stubs: {
		"@shared/desktop/DesktopRpcTransport": {},
		"@shared/desktop/nativeLimits": { MAX_NATIVE_RPC_BODY_BYTES: 32 * 1024 * 1024 },
	},
	globals: { EventSource: FakeEventSource },
});

function waitMs(milliseconds) {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

test("NativeDesktopTransport gives live clipboard snapshots a short read deadline", () => {
	assert.equal(NATIVE_CLIPBOARD_SNAPSHOT_TIMEOUT_MS, 5_000);
	assert.equal(nativeRpcTimeoutMs("native:clipboard-snapshot"), 5_000);
	assert.equal(nativeRpcTimeoutMs("files:read-content"), 60_000);
	assert.equal(nativeRpcTimeoutMs("sessions:send-prompt"), undefined);
});

test("NativeDesktopTransport aborts a stuck live clipboard snapshot at its deadline", async () => {
	const timers = [];
	const transportModule = loadTsCommonJs("src/renderer/src/native/NativeDesktopTransport.ts", {
		stubs: {
			"@shared/desktop/DesktopRpcTransport": {},
			"@shared/desktop/nativeLimits": { MAX_NATIVE_RPC_BODY_BYTES: 32 * 1024 * 1024 },
		},
		globals: {
			EventSource: FakeEventSource,
			setTimeout: (callback, delayMs) => {
				const timer = { callback, delayMs, cancelled: false };
				timers.push(timer);
				return timer;
			},
			clearTimeout: (timer) => {
				if (timer) timer.cancelled = true;
			},
			fetch: (_input, init = {}) => new Promise((_, reject) => {
				init.signal?.addEventListener("abort", () => reject(new Error("fetch aborted")), { once: true });
			}),
		},
	});
	FakeEventSource.instances.length = 0;
	const transport = new transportModule.NativeDesktopTransport(
		"http://127.0.0.1:43123/",
		"secret-token",
		{ readyTimeoutMs: 10_000 },
	);
	try {
		const pending = transport.invoke("native:clipboard-snapshot");
		const snapshotTimer = timers.at(-1);
		assert.equal(snapshotTimer?.delayMs, 5_000);
		snapshotTimer?.callback();
		await assert.rejects(pending, /timed out after 5000ms: native:clipboard-snapshot/i);
	} finally {
		transport.dispose();
	}
});

test("NativeDesktopTransport rejects startup after an errored event channel misses its deadline", async () => {
	FakeEventSource.instances.length = 0;
	const transport = new NativeDesktopTransport("http://127.0.0.1:43123/", "secret-token", {
		readyTimeoutMs: 20,
	});
	const ready = transport.ready();
	FakeEventSource.instances[0].onerror?.(new Error("connection refused"));
	try {
		await assert.rejects(ready, /failed before becoming ready/i);
	} finally {
		transport.dispose();
	}
});

test("NativeDesktopTransport rejects startup when no ready event arrives", async () => {
	FakeEventSource.instances.length = 0;
	const transport = new NativeDesktopTransport("http://127.0.0.1:43123/", "secret-token", {
		readyTimeoutMs: 20,
	});
	try {
		await assert.rejects(transport.ready(), /timed out before becoming ready/i);
	} finally {
		transport.dispose();
	}
});

test("NativeDesktopTransport does not advance replay cursor for malformed JSON", () => {
	FakeEventSource.instances.length = 0;
	const transport = new NativeDesktopTransport("http://127.0.0.1:43123/", "secret-token", {
		initialEventSeq: 10,
	});
	try {
		FakeEventSource.instances[0].emitRaw(11, "{malformed");
		transport.reconnect();
		assert.equal(new URL(FakeEventSource.instances[1].url).searchParams.get("lastEventId"), "10");
	} finally {
		transport.dispose();
	}
});

test("NativeDesktopTransport carries its replay cursor across manual reconnect", () => {
	FakeEventSource.instances.length = 0;
	const transport = new NativeDesktopTransport("http://127.0.0.1:43123/", "secret-token", {
		initialEventSeq: 10,
	});
	try {
		assert.equal(new URL(FakeEventSource.instances[0].url).searchParams.get("lastEventId"), "10");
		FakeEventSource.instances[0].emit("test:event", 11, [{ value: 1 }]);
		transport.reconnect();
		assert.equal(FakeEventSource.instances[0].closed, true);
		assert.equal(new URL(FakeEventSource.instances[1].url).searchParams.get("lastEventId"), "11");
	} finally {
		transport.dispose();
	}
});

test("NativeDesktopTransport gives an in-flight SSE event time to catch up", async () => {
	FakeEventSource.instances.length = 0;
	const transport = new NativeDesktopTransport("http://127.0.0.1:43123/", "secret-token", {
		initialEventSeq: 11,
	});
	try {
		FakeEventSource.instances[0].emit("native.eventChannelReady", 11, [{
			eventSeq: 11,
			eventSourceGeneration: "generation-a",
		}]);
		transport.handleHeartbeat({ eventSeq: 12, eventSourceGeneration: "generation-a" });
		assert.equal(FakeEventSource.instances.length, 1);
		FakeEventSource.instances[0].emit("test:event", 12, [{ value: 1 }]);
		await waitMs(450);
		assert.equal(FakeEventSource.instances.length, 1);
		assert.equal(FakeEventSource.instances[0].closed, false);
	} finally {
		transport.dispose();
	}
});

test("NativeDesktopTransport reconnects after a sequence stays behind the catch-up window", async () => {
	FakeEventSource.instances.length = 0;
	const transport = new NativeDesktopTransport("http://127.0.0.1:43123/", "secret-token", {
		initialEventSeq: 11,
	});
	try {
		FakeEventSource.instances[0].emit("native.eventChannelReady", 11, [{
			eventSeq: 11,
			eventSourceGeneration: "generation-a",
		}]);
		transport.handleHeartbeat({ eventSeq: 12, eventSourceGeneration: "generation-a" });
		transport.handleHeartbeat({ eventSeq: 13, eventSourceGeneration: "generation-a" });
		assert.equal(FakeEventSource.instances.length, 1);
		await waitMs(450);
		assert.equal(FakeEventSource.instances.length, 2);
		assert.equal(FakeEventSource.instances[0].closed, true);
	} finally {
		transport.dispose();
	}
});

test("NativeDesktopTransport reconnects immediately when the event source generation changes", () => {
	FakeEventSource.instances.length = 0;
	const transport = new NativeDesktopTransport("http://127.0.0.1:43123/", "secret-token", {
		initialEventSeq: 11,
	});
	try {
		FakeEventSource.instances[0].emit("native.eventChannelReady", 11, [{
			eventSeq: 11,
			eventSourceGeneration: "generation-a",
		}]);
		transport.handleHeartbeat({ eventSeq: 11, eventSourceGeneration: "generation-b" });
		assert.equal(transport.getLastEventSeq(), 0);
		assert.equal(FakeEventSource.instances.length, 2);
		assert.equal(FakeEventSource.instances[0].closed, true);
		assert.equal(new URL(FakeEventSource.instances[1].url).searchParams.get("lastEventId"), "0");
	} finally {
		transport.dispose();
	}
});
