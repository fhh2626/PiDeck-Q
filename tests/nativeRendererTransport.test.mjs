import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { NativeRpcRouter } from "../src/main/transport/NativeRpcRouter.ts";
import { NativeRendererServer } from "../src/native-node/transport/NativeRendererServer.ts";
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

function connectEvents(port, token, lastEventId, useQuery = false) {
	const headers = lastEventId === undefined || useQuery ? {} : { "last-event-id": String(lastEventId) };
	const cursor = lastEventId === undefined || !useQuery ? "" : `&lastEventId=${encodeURIComponent(String(lastEventId))}`;
	return new Promise((resolveConnection, reject) => {
		const request = httpRequest({
			host: "127.0.0.1",
			port,
			path: `/__pideck/events?token=${encodeURIComponent(token)}${cursor}`,
			headers,
		}, (response) => {
			const events = [];
			let buffer = "";
			const waiters = [];
			const notify = () => {
				for (let index = waiters.length - 1; index >= 0; index -= 1) {
					const waiter = waiters[index];
					const match = events.find(waiter.predicate);
					if (!match) continue;
					waiters.splice(index, 1);
					waiter.resolve(match);
				}
			};
			response.setEncoding("utf8");
			response.on("data", (chunk) => {
				buffer += chunk;
				while (true) {
					const boundary = buffer.indexOf("\n\n");
					if (boundary < 0) break;
					const block = buffer.slice(0, boundary);
					buffer = buffer.slice(boundary + 2);
					const dataLine = block.split("\n").find((line) => line.startsWith("data: "));
					if (!dataLine) continue;
					const idLine = block.split("\n").find((line) => line.startsWith("id: "));
				events.push({
					id: idLine ? Number(idLine.slice(4)) : undefined,
					data: JSON.parse(dataLine.slice(6)),
				});
					notify();
				}
			});
			response.once("error", reject);
			response.once("close", () => {
				for (const waiter of waiters.splice(0)) waiter.reject(new Error("SSE response closed"));
			});
			resolveConnection({
				response,
				events,
				waitFor(predicate, timeoutMs = 2_000) {
					const existing = events.find(predicate);
					if (existing) return Promise.resolve(existing);
					return new Promise((resolveEvent, rejectEvent) => {
						const timer = setTimeout(() => {
							const index = waiters.findIndex((waiter) => waiter.resolve === resolveEvent);
							if (index >= 0) waiters.splice(index, 1);
							rejectEvent(new Error("Timed out waiting for SSE event"));
						}, timeoutMs);
						waiters.push({
							predicate,
							resolve: (value) => {
								clearTimeout(timer);
								resolveEvent(value);
							},
							reject: (error) => {
								clearTimeout(timer);
								rejectEvent(error);
							},
						});
					});
				},
				close() {
					response.destroy();
				},
			});
		});
		request.once("error", reject);
		request.end();
	});
}

function waitMs(milliseconds) {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function postHeartbeat(port, token, payload) {
	const body = JSON.stringify(payload);
	return new Promise((resolveResponse, reject) => {
		const request = httpRequest({
			host: "127.0.0.1",
			port,
			path: `/__pideck/heartbeat?token=${encodeURIComponent(token)}`,
			method: "POST",
			headers: {
				"content-type": "application/json",
				"content-length": Buffer.byteLength(body),
				"x-pideck-token": token,
			},
		}, (response) => {
			const chunks = [];
			response.on("data", (chunk) => chunks.push(chunk));
			response.on("end", () => resolveResponse({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }));
		});
		request.once("error", reject);
		request.end(body);
	});
}

async function createServerFixture(overrides = {}) {
	const rendererRoot = mkdtempSync(resolve(tmpdir(), "pideck-native-renderer-transport-"));
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

test("NativeRendererServer assigns event ids and replays events after Last-Event-ID", async () => {
	const { server, rendererRoot, address } = await createServerFixture();
	const first = await connectEvents(address.port, "secret-token");
	try {
		const ready = await first.waitFor((event) => event.data.channel === "native.eventChannelReady");
		server.broadcast("test:first", [{ value: 1 }]);
		const firstEvent = await first.waitFor((event) => event.data.channel === "test:first");
		first.close();
		server.broadcast("test:second", [{ value: 2 }]);
		const replay = await connectEvents(address.port, "secret-token", firstEvent.id);
		try {
			const second = await replay.waitFor((event) => event.data.channel === "test:second");
			const replayReady = await replay.waitFor((event) => event.data.channel === "native.eventChannelReady");
			assert.equal(second.data.args[0].value, 2);
			assert.ok(second.id > firstEvent.id);
			assert.equal(replayReady.data.args[0].eventSourceGeneration, ready.data.args[0].eventSourceGeneration);
			assert.equal(replayReady.id, second.id);
		} finally {
			replay.close();
		}
	} finally {
		first.close();
		await server.stop();
		rmSync(rendererRoot, { recursive: true, force: true });
	}
});

test("NativeRendererServer preserves every queued frame when drain blocks again", async () => {
	const { server, rendererRoot } = await createServerFixture();
	const response = new EventEmitter();
	response.destroyed = false;
	response.end = () => undefined;
	response.destroy = () => {
		response.destroyed = true;
	};
	const frames = [
		"id: 1\ndata: A\n\n",
		"id: 2\ndata: B\n\n",
		"id: 3\ndata: C\n\n",
	];
	const writes = [];
	let blockNextWrite = true;
	response.write = (frame) => {
		writes.push(frame);
		if (blockNextWrite) {
			blockNextWrite = false;
			return false;
		}
		return true;
	};
	const client = {
		response,
		blocked: true,
		pendingBytes: frames.reduce((sum, frame) => sum + Buffer.byteLength(frame), 0),
		pendingFrames: frames.slice(),
	};
	server.clients.add(client);
	try {
		server.flushClient(client);
		assert.deepEqual(writes, [frames[0]]);
		assert.deepEqual(client.pendingFrames, [frames[1], frames[2]]);
		response.emit("drain");
		assert.deepEqual(writes, frames);
		assert.deepEqual(client.pendingFrames, []);
	} finally {
		server.clients.delete(client);
		await server.stop();
		rmSync(rendererRoot, { recursive: true, force: true });
	}
});

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

test("NativeRendererServer replays an event emitted after bootstrap before SSE connects", async () => {
	const { server, rendererRoot, address } = await createServerFixture();
	try {
		const bootstrapResponse = await fetch(`${server.getUrl()}__pideck/bootstrap?token=secret-token`);
		const bootstrap = await bootstrapResponse.json();
		server.broadcast("test:between-bootstrap-and-sse", [{ value: 1 }]);
		const connection = await connectEvents(address.port, "secret-token", bootstrap.eventSeq, true);
		try {
			const event = await connection.waitFor((value) => value.data.channel === "test:between-bootstrap-and-sse");
			assert.equal(event.data.args[0].value, 1);
			assert.ok(event.id > bootstrap.eventSeq);
		} finally {
			connection.close();
		}
	} finally {
		await server.stop();
		rmSync(rendererRoot, { recursive: true, force: true });
	}
});

test("NativeRendererServer requests resync when Last-Event-ID is outside the replay ring", async () => {
	const { server, rendererRoot, address } = await createServerFixture();
	try {
		for (let index = 0; index < 4_100; index += 1) server.broadcast("test:bulk", [{ index }]);
		const connection = await connectEvents(address.port, "secret-token", 1);
		try {
			const resync = await connection.waitFor((event) => event.data.channel === "native.resyncRequired");
			assert.equal(resync.data.args[0].reason, "event-history-truncated");
		} finally {
			connection.close();
		}
	} finally {
		await server.stop();
		rmSync(rendererRoot, { recursive: true, force: true });
	}
});

test("NativeRendererServer truncates replay history by bytes as well as event count", async () => {
	const { server, rendererRoot, address } = await createServerFixture();
	try {
		const chunk = "x".repeat(1024 * 1024);
		for (let index = 0; index < 33; index += 1) server.broadcast("test:history-budget", [chunk]);
		const connection = await connectEvents(address.port, "secret-token", 0);
		try {
			const resync = await connection.waitFor((event) => event.data.channel === "native.resyncRequired");
			assert.equal(resync.data.args[0].reason, "event-history-truncated");
		} finally {
			connection.close();
		}
	} finally {
		await server.stop();
		rmSync(rendererRoot, { recursive: true, force: true });
	}
});

test("NativeRendererServer can restart after a fatal listening error", async () => {
	let activeServer;
	let resolveRestart;
	const restarted = new Promise((resolve) => {
		resolveRestart = resolve;
	});
	const fixture = await createServerFixture({
		onServerError: () => {
			void activeServer.start().then(() => resolveRestart(activeServer.getUrl()));
		},
	});
	activeServer = fixture.server;
	const previousUrl = activeServer.getUrl();
	activeServer.broadcast("test:before-server-failure", [{ value: 1 }]);
	try {
		activeServer.server.emit("error", new Error("simulated renderer server failure"));
		const nextUrl = await Promise.race([
			restarted,
			new Promise((_, reject) => setTimeout(() => reject(new Error("renderer server did not recover")), 2_000)),
		]);
		assert.notEqual(nextUrl, previousUrl);
		const bootstrap = await fetch(`${nextUrl}__pideck/bootstrap?token=secret-token`);
		assert.equal(bootstrap.status, 200);
		assert.equal((await bootstrap.json()).eventSeq, 0);
	} finally {
		await activeServer.stop();
		rmSync(fixture.rendererRoot, { recursive: true, force: true });
	}
});

test("NativeRendererServer ignores a stale error from the previous server generation", async () => {
	let activeServer;
	let resolveRecovery;
	const recovered = new Promise((resolve) => {
		resolveRecovery = resolve;
	});
	const fixture = await createServerFixture({
		onServerError: () => {
			void activeServer.start().then(resolveRecovery);
		},
	});
	activeServer = fixture.server;
	const oldServer = activeServer.server;
	try {
		oldServer.emit("error", new Error("first renderer server failure"));
		await Promise.race([
			recovered,
			new Promise((_, reject) => setTimeout(() => reject(new Error("renderer server did not recover")), 2_000)),
		]);
		const recoveredUrl = activeServer.getUrl();
		oldServer.emit("error", new Error("stale renderer server failure"));
		await waitMs(50);
		assert.equal(activeServer.getUrl(), recoveredUrl);
		const bootstrap = await fetch(`${recoveredUrl}__pideck/bootstrap?token=secret-token`);
		assert.equal(bootstrap.status, 200);
	} finally {
		await activeServer.stop();
		rmSync(fixture.rendererRoot, { recursive: true, force: true });
	}
});

test("NativeRendererServer disconnects an SSE client that exceeds the backpressure budget", async () => {
	const { server, rendererRoot, address } = await createServerFixture();
	const connection = await connectEvents(address.port, "secret-token");
	try {
		await connection.waitFor((event) => event.data.channel === "native.eventChannelReady");
		connection.response.pause();
		const closed = new Promise((resolve) => connection.response.once("close", resolve));
		const chunk = "x".repeat(128 * 1024);
		for (let index = 0; index < 64; index += 1) server.broadcast("test:backpressure", [chunk]);
		await Promise.race([
			closed,
			new Promise((_, reject) => setTimeout(() => reject(new Error("SSE client was not closed")), 2_000)),
		]);
	} finally {
		connection.close();
		await server.stop();
		rmSync(rendererRoot, { recursive: true, force: true });
	}
});

test("NativeRendererServer reports an unhealthy event channel when heartbeat sequence lags", async () => {
	const { server, rendererRoot, address } = await createServerFixture();
	const connection = await connectEvents(address.port, "secret-token");
	try {
		const ready = await connection.waitFor((event) => event.data.channel === "native.eventChannelReady");
		server.broadcast("test:heartbeat", [{ index: 0 }]);
		const heartbeat = await postHeartbeat(address.port, "secret-token", {
			lastEventSeq: ready.id,
			eventSourceGeneration: ready.data.args[0].eventSourceGeneration,
		});
		assert.equal(heartbeat.status, 200);
		assert.equal(heartbeat.body.eventChannelHealthy, false);
		assert.ok(heartbeat.body.eventSeq > ready.id);
	} finally {
		connection.close();
		await server.stop();
		rmSync(rendererRoot, { recursive: true, force: true });
	}
});
