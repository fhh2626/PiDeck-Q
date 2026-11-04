import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { NativeRpcRouter } from "../src/main/transport/NativeRpcRouter.ts";
import { NativeRendererServer } from "../src/native-node/transport/NativeRendererServer.ts";

// Frame sizes drive the replay-history byte budget and the per-client backpressure
// budget. They are derived from the already-measured payload, so multi-byte content
// must still be counted in UTF-8 bytes, not characters.
const MULTIBYTE = "中文🙂é".repeat(1000);

async function withServer(action) {
	const rendererRoot = mkdtempSync(resolve(tmpdir(), "pideck-frame-bytes-"));
	writeFileSync(join(rendererRoot, "index.html"), "<html>native</html>");
	const server = new NativeRendererServer({
		router: new NativeRpcRouter(),
		token: "secret-token",
		rendererRoot,
		backgroundDirectory: rendererRoot,
		getBootstrap: async () => ({ clipboard: {}, settings: { zoomFactor: 1, memoryProfileEnabled: false } }),
	});
	await server.start();
	try {
		await action(server);
	} finally {
		await server.stop();
		rmSync(rendererRoot, { recursive: true, force: true });
	}
}

test("replay history records the exact UTF-8 size of multi-byte frames", async () => {
	await withServer((server) => {
		for (let index = 0; index < 12; index++) {
			server.broadcast("test:frame", [{ text: index % 2 === 0 ? MULTIBYTE : "ascii" }]);
		}
		const records = server.eventHistory;
		// Cross the 9 -> 10 sequence boundary: ASCII header length is not constant.
		for (const record of records) assert.equal(record.bytes, Buffer.byteLength(record.frame));
		assert.equal(server.eventHistoryBytes, records.reduce((sum, record) => sum + Buffer.byteLength(record.frame), 0));
	});
});

test("a blocked client queues live frames using their UTF-8 size", async () => {
	await withServer((server) => {
		const response = { destroyed: false, write: () => true, once: () => undefined, destroy() {}, end() {} };
		const client = { response, blocked: true, pendingBytes: 0, pendingFrames: [] };
		server.clients.add(client);
		server.broadcast("test:queued", [{ text: MULTIBYTE }]);
		assert.equal(client.pendingFrames.length, 1);
		assert.equal(client.pendingBytes, Buffer.byteLength(client.pendingFrames[0]));
	});
});

/** Capture expensive UTF-8 payload scans only while the synchronous broadcast runs. */
function countPayloadScans(action) {
	const original = Buffer.byteLength;
	let scans = 0;
	try {
		Buffer.byteLength = (value, encoding) => {
			if (typeof value === "string" && value.includes("byte-scan-sentinel")) scans++;
			return original(value, encoding);
		};
		action();
		return scans;
	} finally {
		Buffer.byteLength = original;
	}
}

test("broadcast scans a multi-byte payload once, independent of ready and blocked client count", async () => {
	await withServer((server) => {
		const clients = [];
		for (const blocked of [false, false, true, true]) {
			const response = new EventEmitter();
			response.destroyed = false;
			response.frames = [];
			response.write = (frame) => { response.frames.push(frame); return true; };
			response.end = () => {};
			const client = { response, blocked, pendingBytes: 0, pendingFrames: [] };
			clients.push(client);
			server.clients.add(client);
		}
		const scans = countPayloadScans(() => {
			server.broadcast("test:scan", [{ tag: "byte-scan-sentinel", text: MULTIBYTE }]);
		});
		// This guards linear cost per event instead of per receiver; timing thresholds
		// would be flaky on CI. Response sinks substitute only the network boundary.
		assert.equal(scans, 1, "reuse the validated payload size for replay storage and client queues");
		const expected = server.eventHistory[0].frame;
		for (const client of clients) {
			if (client.blocked) {
				assert.deepEqual(client.pendingFrames, [expected]);
				assert.equal(client.pendingBytes, Buffer.byteLength(expected));
			} else assert.deepEqual(client.response.frames, [expected]);
		}
	});
});
