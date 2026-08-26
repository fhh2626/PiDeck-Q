import assert from "node:assert/strict";
import { createServer } from "node:net";
import test from "node:test";
import { HostBridge } from "../src/native-node/host/HostBridge.ts";

function listen(handler) {
	const server = createServer(handler);
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.removeListener("error", reject);
			const address = server.address();
			if (!address || typeof address === "string") {
				reject(new Error("test server did not expose a TCP address"));
				return;
			}
			resolve({ server, port: address.port });
		});
	});
}

function closeServer(server, sockets = []) {
	for (const socket of sockets) socket.destroy();
	return new Promise((resolve) => server.close(() => resolve()));
}

function sendFrame(socket, frame) {
	const payload = Buffer.from(JSON.stringify(frame), "utf8");
	const header = Buffer.alloc(4);
	header.writeUInt32LE(payload.length, 0);
	socket.write(Buffer.concat([header, payload]));
}

function respondToHello(socket, token) {
	let buffer = Buffer.alloc(0);
	socket.on("data", (chunk) => {
		buffer = Buffer.concat([buffer, chunk]);
		while (buffer.length >= 4) {
			const length = buffer.readUInt32LE(0);
			if (buffer.length < length + 4) return;
			const frame = JSON.parse(buffer.subarray(4, length + 4).toString("utf8"));
			buffer = buffer.subarray(length + 4);
			if (frame.type === "hello") sendFrame(socket, { type: "hello", ok: frame.token === token });
		}
	});
}

test("HostBridge rejects when the native host closes during hello", async () => {
	const sockets = [];
	const { server, port } = await listen((socket) => {
		sockets.push(socket);
		setImmediate(() => socket.destroy());
	});
	try {
		await assert.rejects(HostBridge.connect(port, "secret"), /connection closed|closed/i);
	} finally {
		await closeServer(server, sockets);
	}
});

test("HostBridge settles a hello that never receives a response", { timeout: 8_000 }, async () => {
	const sockets = [];
	const { server, port } = await listen((socket) => sockets.push(socket));
	const started = Date.now();
	try {
		await assert.rejects(HostBridge.connect(port, "secret"), /hello handshake timed out/i);
		assert.ok(Date.now() - started >= 4_000);
	} finally {
		await closeServer(server, sockets);
	}
});

test("HostBridge completes the authenticated hello handshake", async () => {
	const sockets = [];
	const { server, port } = await listen((socket) => {
		sockets.push(socket);
		respondToHello(socket, "secret");
	});
	try {
		const bridge = await HostBridge.connect(port, "secret");
		bridge.close();
	} finally {
		await closeServer(server, sockets);
	}
});
