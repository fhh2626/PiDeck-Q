import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { connect } from "node:net";

/**
 * Mock Vite dev server for the dev-renderer proxy suite.
 *
 * The C++ backend relays bytes, so the mock has to speak both protocols for real:
 *  - HTTP: routes are matched on the exact request URL (path + query) and every request
 *    is recorded, which is how the tests prove the proxy's path mapping and what it did
 *    *not* forward (cookies/authorization must never reach the dev server);
 *  - WebSocket: a real `101` with a computed `Sec-WebSocket-Accept`, so a passing
 *    handshake proves the browser's key was forwarded rather than echoed back by us.
 *
 * Frames are relayed verbatim, so the codec here is deliberately explicit about masking:
 * a client frame must arrive masked, byte for byte, and a server frame must arrive
 * unmasked. "It works" via a re-framing proxy would not prove framing preservation.
 */

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** Deterministic client mask key; RFC 6455 allows any four bytes. */
export const TEST_MASK = Buffer.from([0x37, 0xa4, 0x11, 0xc9]);

/** Encode one frame. `mask` is a 4-byte key for client frames, `null` for server frames. */
export function encodeFrame(payload, { opcode = 0x1, mask = null } = {}) {
	const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), "utf8");
	const masked = Boolean(mask);
	const lengthBytes = [];
	if (body.length < 126) {
		lengthBytes.push((masked ? 0x80 : 0) | body.length);
	} else if (body.length < 65536) {
		lengthBytes.push((masked ? 0x80 : 0) | 126, (body.length >> 8) & 0xff, body.length & 0xff);
	} else {
		const length = Buffer.alloc(8);
		length.writeBigUInt64BE(BigInt(body.length));
		lengthBytes.push((masked ? 0x80 : 0) | 127, ...length);
	}
	const head = Buffer.from([0x80 | opcode, ...lengthBytes]);
	if (!masked) return Buffer.concat([head, body]);
	const key = Buffer.from(mask);
	const xored = Buffer.alloc(body.length);
	for (let index = 0; index < body.length; index += 1) xored[index] = body[index] ^ key[index % 4];
	return Buffer.concat([head, key, xored]);
}

/** Decode the first frame of `buffer`; `null` when it is still incomplete. */
export function decodeFrame(buffer) {
	if (buffer.length < 2) return null;
	const first = buffer[0];
	const second = buffer[1];
	const masked = (second & 0x80) !== 0;
	let length = second & 0x7f;
	let offset = 2;
	if (length === 126) {
		if (buffer.length < 4) return null;
		length = buffer.readUInt16BE(2);
		offset = 4;
	} else if (length === 127) {
		if (buffer.length < 10) return null;
		length = Number(buffer.readBigUInt64BE(2));
		offset = 10;
	}
	let maskKey = Buffer.alloc(0);
	if (masked) {
		if (buffer.length < offset + 4) return null;
		maskKey = Buffer.from(buffer.subarray(offset, offset + 4));
		offset += 4;
	}
	if (buffer.length < offset + length) return null;
	const payload = Buffer.from(buffer.subarray(offset, offset + length));
	if (masked) {
		for (let index = 0; index < payload.length; index += 1) {
			payload[index] ^= maskKey[index % 4];
		}
	}
	return {
		frame: { fin: (first & 0x80) !== 0, opcode: first & 0x0f, masked, maskKey, payload },
		consumed: offset + length,
	};
}

export function waitFor(predicate, { timeoutMs = 5_000, message = "condition", intervalMs = 10 } = {}) {
	return new Promise((resolve, reject) => {
		// One recursive timeout instead of `setInterval` + `setTimeout`: the old shape left
		// the interval running after a timeout, so a failing wait kept the event loop alive
		// forever and the surrounding `node --test` process never exited (a rejected promise
		// does not stop handles). Both paths now clear the single pending timer.
		let poll = null;
		let deadline = null;
		let settled = false;
		const settle = (error) => {
			if (settled) return;
			settled = true;
			if (poll !== null) clearTimeout(poll);
			if (deadline !== null) clearTimeout(deadline);
			poll = null;
			deadline = null;
			if (error) reject(error);
			else resolve();
		};
		const tick = () => {
			poll = null;
			let matched = false;
			try {
				matched = Boolean(predicate());
			} catch (error) {
				return settle(error);
			}
			if (matched) return settle(null);
			poll = setTimeout(tick, intervalMs);
		};
		deadline = setTimeout(
			() => settle(new Error(`timed out waiting for ${message}`)),
			timeoutMs,
		);
		tick();
	});
}

/** One HTTP + WebSocket listener standing in for `vite dev`. */
export class MockVite {
	/**
	 * `routes` maps an exact request URL (path plus query) to a response object, a function
	 * of the request, or `null` for the mock's own 404. A response object is either
	 *   - a normal reply: `{status, contentType, body, headers, contentLength, hangAfterHeaders}`,
	 *   - `{hang: true}`: accepted and never answered (the relay's deadline is the only exit),
	 *   - `{raw: <string|Buffer>}`: bytes written straight to the socket, which is how the
	 *     suite produces a malformed head or a body shorter than its `content-length`.
	 *
	 * `upgradeStatus` is a number, or a function of the upgrade request, so one mock can
	 * accept `/` and refuse a second path.
	 */
	constructor({ routes = {}, upgradeStatus = 101 } = {}) {
		this.routes = routes;
		this.upgradeStatus = upgradeStatus;
		this.requests = [];
		this.upgrades = [];
		this.sockets = new Set();
		this.server = null;
		this.port = 0;
		this.origin = "";
	}

	async start() {
		this.server = createServer((request, response) => {
			const record = { method: request.method, url: request.url, headers: request.headers };
			this.requests.push(record);
			request.resume();
			const pathname = new URL(request.url, "http://mock.invalid").pathname;
			const route = this.routes[request.url] ?? this.routes[pathname] ?? null;
			const reply = typeof route === "function" ? route(record) : route;
			if (!reply) {
				record.status = 404;
				response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
				response.end(`mock vite: no route for ${request.url}`);
				return;
			}
			if (reply.hang) {
				// Accepted but never answered: the proxy's head deadline is the only exit.
				record.hang = true;
				return;
			}
			if (reply.raw !== undefined) {
				// Raw bytes on purpose: a malformed head or a body shorter than its declared
				// `content-length` cannot be produced through `http.ServerResponse` (it always writes
				// a well-formed response), and those are exactly the upstream failures the relay
				// must bound.
				record.raw = true;
				request.socket.write(reply.raw);
				request.socket.end();
				return;
			}
			const status = reply.status ?? 200;
			record.status = status;
			const headers = {
				"content-type": reply.contentType ?? "text/plain; charset=utf-8",
				...(reply.headers ?? {}),
			};
			if (reply.contentLength !== false && reply.body !== undefined) {
				headers["content-length"] = String(Buffer.byteLength(reply.body));
			}
			response.writeHead(status, headers);
			if (reply.hangAfterHeaders) {
				// Head sent, body never finished: the browser must see a truncated body.
				response.write(reply.body ?? "");
				return;
			}
			response.end(reply.body ?? "");
		});
		this.server.on("upgrade", (request, socket, head) => this.handleUpgrade(request, socket, head));
		this.server.on("connection", (socket) => {
			this.sockets.add(socket);
			socket.on("close", () => this.sockets.delete(socket));
		});
		await new Promise((resolve) => this.server.listen(0, "127.0.0.1", resolve));
		this.port = this.server.address().port;
		this.origin = `http://127.0.0.1:${this.port}`;
		return this;
	}

	handleUpgrade(request, socket, head) {
		const record = {
			url: request.url,
			headers: request.headers,
			socket,
			received: Buffer.alloc(0),
			ended: false,
			closed: false,
			write: (bytes) => socket.write(bytes),
			destroy: () => socket.destroy(),
		};
		this.upgrades.push(record);
		socket.on("error", () => undefined);
		socket.on("end", () => {
			// Node's HTTP server creates its sockets with `allowHalfOpen`, so a peer FIN
			// leaves this side open. Tear it down: the relay half-closes when its own
			// side is done, and a lingering half-open socket would hide that from the test.
			record.ended = true;
			socket.destroy();
		});
		socket.on("close", () => {
			record.closed = true;
		});
		const upgradeStatus =
			typeof this.upgradeStatus === "function"
				? this.upgradeStatus(request)
				: this.upgradeStatus;
		if (upgradeStatus !== 101) {
			record.refused = upgradeStatus;
			socket.end(
				`HTTP/1.1 ${upgradeStatus} Refused\r\ncontent-length: 0\r\nconnection: close\r\n\r\n`,
			);
			return;
		}
		// A real accept hash: if the proxy replaced the client's key, this handshake would
		// not be valid for the client that sent it.
		const accept = createHash("sha1")
			.update(String(request.headers["sec-websocket-key"] ?? "") + WS_GUID)
			.digest("base64");
		socket.write(
			[
				"HTTP/1.1 101 Switching Protocols",
				"upgrade: websocket",
				"connection: Upgrade",
				`sec-websocket-accept: ${accept}`,
				"",
				"",
			].join("\r\n"),
		);
		const consume = (chunk) => {
			record.received = Buffer.concat([record.received, chunk]);
		};
		if (head?.length) consume(head);
		socket.on("data", consume);
	}

	async stop() {
		for (const socket of this.sockets) socket.destroy();
		this.sockets.clear();
		if (!this.server) return;
		const server = this.server;
		this.server = null;
		await new Promise((resolve) => server.close(resolve));
	}
}

/**
 * Raw WebSocket client: sends a handshake by hand so the test controls every header the
 * proxy sees (key, cookie, path) and can assert the bytes that come back.
 */
export class RawWebSocketClient {
	constructor(vite, { path = "/", headers = {}, key = "dGhlIHNhbXBsZSBub25jZQ==", connectTimeoutMs = 5_000 } = {}) {
		this.vite = vite;
		this.path = path;
		this.headers = headers;
		this.key = key;
		this.connectTimeoutMs = connectTimeoutMs;
		this.socket = null;
		this.raw = Buffer.alloc(0);
		this.headText = "";
		this.head = null;
		this.body = Buffer.alloc(0);
		this.closed = false;
		this.headWaiters = [];
	}

	connect(port) {
		return new Promise((resolve, reject) => {
			// Every wait in this harness is bounded: a handshake the backend drops (refused
			// upgrade, unauthorized connection) closes the socket without a response, which
			// must reject instead of leaving the promise and the test hanging.
			this.connectTimer = setTimeout(() => {
				this.socket?.destroy();
				reject(new Error(`websocket handshake to ${this.path} did not settle in ${this.connectTimeoutMs} ms`));
			}, this.connectTimeoutMs);
			this.socket = connect({ host: "127.0.0.1", port });
			this.socket.on("error", (error) => {
				this.closed = true;
				this.error = error;
				// A socket error after the handshake is an expected outcome (a refused
				// upgrade is closed by the proxy), not a test failure.
				if (!this.head) reject(error);
			});
			this.socket.on("close", () => {
				this.closed = true;
				if (!this.head && this.connectTimer) {
					clearTimeout(this.connectTimer);
					this.connectTimer = null;
					reject(new Error(`websocket closed before ${this.path} completed the handshake`));
				}
			});
			this.socket.on("connect", () => {
				const lines = [
					`GET ${this.path} HTTP/1.1`,
					`host: 127.0.0.1:${port}`,
					"upgrade: websocket",
					"connection: Upgrade",
					`sec-websocket-key: ${this.key}`,
					"sec-websocket-version: 13",
					"sec-websocket-protocol: vite-hmr",
					...(Object.entries(this.headers).map(([name, value]) => `${name}: ${value}`)),
					"",
					"",
				];
				this.socket.write(lines.join("\r\n"));
			});
			this.socket.on("data", (chunk) => this.consume(chunk));
			this.headWaiters.push({ resolve, reject });
		});
	}

	consume(chunk) {
		this.raw = Buffer.concat([this.raw, chunk]);
		if (this.head) {
			this.body = Buffer.concat([this.body, chunk]);
			return;
		}
		const end = this.raw.indexOf("\r\n\r\n");
		if (end < 0) return;
		this.headText = this.raw.subarray(0, end).toString("latin1");
		this.head = {};
		const lines = this.headText.split("\r\n");
		this.status = Number(lines[0].split(" ")[1]);
		this.reason = lines[0].split(" ").slice(2).join(" ");
		for (const line of lines.slice(1)) {
			const separator = line.indexOf(":");
			if (separator < 0) continue;
			this.head[line.slice(0, separator).trim().toLowerCase()] = line.slice(separator + 1).trim();
		}
		this.body = this.raw.subarray(end + 4);
		if (this.connectTimer) {
			clearTimeout(this.connectTimer);
			this.connectTimer = null;
		}
		for (const waiter of this.headWaiters.splice(0)) waiter.resolve(this);
	}

	waitForHead(timeoutMs = 5_000) {
		if (this.head) return Promise.resolve(this);
		return new Promise((resolve, reject) => {
			// Drop the waiter on timeout: the array is otherwise never pruned, so a refused
			// handshake would keep a dead resolver for the lifetime of the client object.
			const waiter = { resolve: null, reject: null };
			const timer = setTimeout(() => {
				const index = this.headWaiters.indexOf(waiter);
				if (index >= 0) this.headWaiters.splice(index, 1);
				reject(new Error("websocket handshake did not answer"));
			}, timeoutMs);
			waiter.resolve = (value) => {
				clearTimeout(timer);
				resolve(value);
			};
			waiter.reject = (error) => {
				clearTimeout(timer);
				reject(error);
			};
			this.headWaiters.push(waiter);
		});
	}

	/** Wait until at least `bytes` body bytes arrived after the head. */
	async waitForBody(bytes, timeoutMs = 5_000) {
		await waitFor(() => this.body.length >= bytes, { timeoutMs, message: `${bytes} frame bytes` });
		return this.body;
	}

	async waitForClose(timeoutMs = 5_000) {
		await waitFor(() => this.closed, { timeoutMs, message: "client socket close" });
	}

	write(bytes) {
		if (!this.socket) throw new Error("websocket client is not connected");
		this.socket.write(bytes);
	}

	destroy() {
		this.socket?.destroy();
	}
}
