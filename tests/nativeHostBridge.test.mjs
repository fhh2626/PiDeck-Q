import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
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

test("HostBridge disconnects when a native host peer stops reading beyond the write budget", async () => {
	const sockets = [];
	const { server, port } = await listen((socket) => {
		sockets.push(socket);
		let buffer = Buffer.alloc(0);
		const onData = (chunk) => {
			buffer = Buffer.concat([buffer, chunk]);
			if (buffer.length < 4) return;
			const length = buffer.readUInt32LE(0);
			if (buffer.length < length + 4) return;
			const frame = JSON.parse(buffer.subarray(4, length + 4).toString("utf8"));
			if (frame.type !== "hello") return;
			sendFrame(socket, { type: "hello", ok: true });
			socket.removeListener("data", onData);
			socket.pause();
		};
		socket.on("data", onData);
	});
	try {
		const bridge = await HostBridge.connect(port, "secret");
		const chunk = "x".repeat(256 * 1024);
		assert.throws(() => {
			for (let index = 0; index < 64; index += 1) bridge.emit("test:backpressure", { chunk, index });
		}, /backpressure limit exceeded/i);
		bridge.close();
	} finally {
		await closeServer(server, sockets);
	}
});

test("HostBridge reports an unexpected disconnect after authentication as fatal", async () => {
	const sockets = [];
	let hostSocket;
	const { server, port } = await listen((socket) => {
		sockets.push(socket);
		hostSocket = socket;
		respondToHello(socket, "secret");
	});
	try {
		const bridge = await HostBridge.connect(port, "secret");
		const fatal = new Promise((resolve) => bridge.onFatal(resolve));
		hostSocket.destroy();
		const error = await fatal;
		assert.match(error.message, /connection closed/i);
	} finally {
		await closeServer(server, sockets);
	}
});

test("HostBridge flushes a queued readyToExit event before graceful close", async () => {
	class FakeSocket extends EventEmitter {
		writes = [];
		ended = false;
		destroyed = false;
		write(packet) {
			this.writes.push(Buffer.from(packet));
			return this.writes.length > 1;
		}
		end() {
			this.ended = true;
			this.emit("close");
		}
		destroy() {
			this.destroyed = true;
		}
	}

	const bridge = new HostBridge("secret");
	const socket = new FakeSocket();
	bridge.socket = socket;
	bridge.authenticated = true;
	let fatalCount = 0;
	bridge.onFatal(() => {
		fatalCount += 1;
	});
	bridge.emit("test:before-close", { value: 1 });
	bridge.emit("application.readyToExit", {});
	const closing = bridge.closeGracefully();
	await Promise.resolve();
	assert.equal(socket.ended, false, "close must wait while the custom write queue is blocked");

	socket.emit("drain");
	await closing;
	assert.equal(socket.ended, true);
	assert.equal(fatalCount, 0, "intentional graceful close must not be reported as fatal");
	assert.equal(socket.writes.length, 2);
	const readyPacket = JSON.parse(socket.writes[1].subarray(4).toString("utf8"));
	assert.equal(readyPacket.type, "event");
	assert.equal(readyPacket.name, "application.readyToExit");
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
