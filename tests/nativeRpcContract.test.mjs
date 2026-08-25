import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { request as httpRequest } from "node:http";
import test from "node:test";
import { NativeRpcRouter } from "../src/main/transport/NativeRpcRouter.ts";
import { NativeRendererServer } from "../src/native-node/transport/NativeRendererServer.ts";

function post(port, path, body, token) {
	return new Promise((resolveResponse, reject) => {
		const request = httpRequest({
			host: "127.0.0.1", port, path, method: "POST",
			headers: {
				"content-type": "application/json",
				"content-length": Buffer.byteLength(body),
				"x-pideck-token": token,
			},
		}, (response) => {
			const chunks = [];
			response.on("data", (chunk) => chunks.push(chunk));
			response.on("end", () => resolveResponse({ status: response.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
		});
		request.on("error", reject);
		request.end(body);
	});
}

test("NativeRpcRouter rejects duplicates and unknown channels", async () => {
	const router = new NativeRpcRouter();
	router.handle("test:echo", (value) => value);
	assert.equal(await router.invoke("test:echo", ["ok"]), "ok");
	assert.throws(() => router.handle("test:echo", () => undefined), /Duplicate RPC handler/);
	await assert.rejects(() => router.invoke("test:missing", []), /Unknown RPC channel/);
});

test("NativeRendererServer authenticates, dispatches RPC, serves bootstrap and protected backgrounds", async () => {
	const rendererRoot = mkdtempSync(resolve(tmpdir(), "pideck-native-renderer-"));
	const backgroundRoot = mkdtempSync(resolve(tmpdir(), "pideck-native-bg-"));
	try {
		writeFileSync(join(rendererRoot, "index.html"), "<html>native</html>");
		writeFileSync(join(backgroundRoot, "bg-test.png"), "png");
		const router = new NativeRpcRouter();
		router.handle("test:echo", (value) => ({ value }));
		const server = new NativeRendererServer({
			router,
			token: "secret-token",
			rendererRoot,
			backgroundDirectory: backgroundRoot,
			getBootstrap: async () => ({ clipboard: { text: "hello" }, settings: { zoomFactor: 1 } }),
		});
		const address = await server.start();
		const unauthorized = await post(address.port, "/__pideck/rpc", JSON.stringify({ channel: "test:echo", args: ["x"] }), "wrong");
		assert.equal(unauthorized.status, 401);
		const rpc = await post(address.port, "/__pideck/rpc", JSON.stringify({ channel: "test:echo", args: ["x"] }), "secret-token");
		assert.equal(rpc.status, 200);
		assert.deepEqual(JSON.parse(rpc.body), { ok: true, result: { value: "x" } });
		const bootstrap = await fetch(`http://127.0.0.1:${address.port}/__pideck/bootstrap?token=secret-token`);
		assert.deepEqual(await bootstrap.json(), { clipboard: { text: "hello" }, settings: { zoomFactor: 1 } });
		const background = await fetch(`http://127.0.0.1:${address.port}/__pideck/background/bg-test.png?token=secret-token`);
		assert.equal(background.status, 200);
		assert.equal(background.headers.get("content-type"), "image/png");
		const traversal = await fetch(`http://127.0.0.1:${address.port}/__pideck/background/${encodeURIComponent("../bg-test.png")}?token=secret-token`);
		assert.equal(traversal.status, 403);
		await server.stop();
	} finally {
		rmSync(rendererRoot, { recursive: true, force: true });
		rmSync(backgroundRoot, { recursive: true, force: true });
	}
});
