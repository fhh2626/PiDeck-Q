import assert from "node:assert/strict";
import { createServer } from "node:net";
import test from "node:test";
import { httpRequest } from "./helpers/native2BackendHarness.mjs";

async function responsePeer(t, response) {
	const sockets = new Set();
	const server = createServer((socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
		socket.on("error", () => {});
		socket.once("data", () => socket.end(response));
	});
	t.after(async () => {
		for (const socket of sockets) socket.destroy();
		await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
	});
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});
	return `http://127.0.0.1:${server.address().port}/api/health`;
}

async function withDeadline(pending) {
	let timer;
	try {
		return await Promise.race([
			pending,
			new Promise((_, reject) => {
				timer = setTimeout(() => reject(new Error("HTTP response remained pending after the peer closed")), 1_000);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

test("HTTP requests reject when a content-length response is truncated", async (t) => {
	const url = await responsePeer(t, "HTTP/1.1 200 OK\r\nContent-Length: 10\r\nConnection: close\r\n\r\nx");
	await assert.rejects(withDeadline(httpRequest(url)), { code: "ECONNRESET" });
});

test("HTTP requests reject when a chunked response ends before its final chunk", async (t) => {
	const url = await responsePeer(t, "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n3\r\none\r\n");
	await assert.rejects(withDeadline(httpRequest(url)), { code: "ECONNRESET" });
});

test("HTTP requests preserve complete status, headers, and UTF-8 bodies when the peer closes", async (t) => {
	const body = "完整响应";
	const url = await responsePeer(t, `HTTP/1.1 503 Unavailable\r\nContent-Length: ${Buffer.byteLength(body)}\r\nX-Test: complete\r\nConnection: close\r\n\r\n${body}`);
	const response = await withDeadline(httpRequest(url));
	assert.equal(response.status, 503);
	assert.equal(response.headers["x-test"], "complete");
	assert.equal(response.body, body);
});

test("HTTP requests accept complete responses whose body is delimited by connection close", async (t) => {
	const url = await responsePeer(t, "HTTP/1.0 200 OK\r\nConnection: close\r\n\r\ncomplete");
	const response = await withDeadline(httpRequest(url));
	assert.equal(response.status, 200);
	assert.equal(response.body, "complete");
});
