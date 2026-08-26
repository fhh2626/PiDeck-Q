import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { NativeRpcRouter } from "../src/main/transport/NativeRpcRouter.ts";
import { NativeRendererServer } from "../src/native-node/transport/NativeRendererServer.ts";

function connectEvents(port, token, lastEventId) {
	const headers = lastEventId === undefined ? {} : { "last-event-id": String(lastEventId) };
	return new Promise((resolveConnection, reject) => {
		const request = httpRequest({
			host: "127.0.0.1",
			port,
			path: `/__pideck/events?token=${encodeURIComponent(token)}`,
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

async function createServerFixture() {
	const rendererRoot = mkdtempSync(resolve(tmpdir(), "pideck-native-renderer-transport-"));
	writeFileSync(join(rendererRoot, "index.html"), "<html>native</html>");
	const server = new NativeRendererServer({
		router: new NativeRpcRouter(),
		token: "secret-token",
		rendererRoot,
		backgroundDirectory: rendererRoot,
		getBootstrap: async () => ({ clipboard: {}, settings: { zoomFactor: 1, memoryProfileEnabled: false } }),
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
		for (let index = 0; index < 20; index += 1) server.broadcast("test:heartbeat", [{ index }]);
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
