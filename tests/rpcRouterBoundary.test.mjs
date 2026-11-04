import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NativeRpcRouter } from "../src/main/transport/NativeRpcRouter.ts";
import { MAX_NATIVE_RPC_BODY_BYTES } from "../src/shared/desktop/nativeLimits.ts";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const TOKEN = "router-boundary-token";

test("RpcRouter contract is transport-neutral", () => {
	// 文本断言是对的工具：RpcRouter.ts 是纯接口契约，「不得提到 Electron/ipcMain」是静态分层规则，没有行为可测。
	const content = readFileSync("src/main/transport/RpcRouter.ts", "utf8");
	assert.doesNotMatch(content, /electron|ipcMain|BrowserWindow|webContents/i);
});

test("NativeRpcRouter registers, forwards arguments, returns values and propagates errors", async () => {
	const router = new NativeRpcRouter();
	let received;
	router.handle("test:channel", async (...args) => {
		received = args;
		return `${args[0]}-${args[1]}-${args[2]}`;
	});
	assert.equal(await router.invoke("test:channel", ["foo", 42, { ok: true }]), "foo-42-[object Object]");
	assert.deepEqual(received, ["foo", 42, { ok: true }]);
	router.handle("test:error", async () => { throw new Error("test error message"); });
	await assert.rejects(() => router.invoke("test:error", []), { message: "test error message" });
});

/** 启动真实 NativeRendererServer（仅环回、端口 0），router 里记录每次被调用的通道。
 *  node:http 只做一层透传包装，用来拿到真实监听的 http.Server 以检查实际绑定地址。 */
async function startServer(t) {
	const httpServers = [];
	const { NativeRendererServer } = loadTsCommonJs("src/native-node/transport/NativeRendererServer.ts", {
		stubs: {
			"node:http": {
				...http,
				createServer: (...args) => {
					const created = http.createServer(...args);
					httpServers.push(created);
					return created;
				},
			},
		},
	});
	const rendererRoot = mkdtempSync(join(tmpdir(), "pideck-router-boundary-"));
	writeFileSync(join(rendererRoot, "index.html"), "<html>native</html>");
	const router = new NativeRpcRouter();
	const invoked = [];
	router.handle("probe:echo", async (...args) => {
		invoked.push(args);
		return { echoed: args };
	});
	const server = new NativeRendererServer({
		router,
		token: TOKEN,
		rendererRoot,
		backgroundDirectory: rendererRoot,
		getBootstrap: async () => ({ clipboard: {}, settings: { zoomFactor: 1, memoryProfileEnabled: false } }),
	});
	const address = await server.start();
	t.after(() => {
		server.stop?.();
		rmSync(rendererRoot, { recursive: true, force: true });
	});
	return { address, invoked, httpServers };
}

/** 发一次请求并读完响应；declaredLength 允许声明一个比实际 body 大的 content-length。 */
function send(port, { method = "POST", path, headers = {}, body, declaredLength }) {
	return new Promise((resolve, reject) => {
		const payload = body === undefined ? undefined : JSON.stringify(body);
		const request = http.request({
			host: "127.0.0.1",
			port,
			path,
			method,
			headers: {
				...(payload === undefined ? {} : { "content-type": "application/json" }),
				...(declaredLength !== undefined
					? { "content-length": String(declaredLength) }
					: payload === undefined ? {} : { "content-length": Buffer.byteLength(payload) }),
				...headers,
			},
		}, (response) => {
			const chunks = [];
			response.on("data", (chunk) => chunks.push(chunk));
			response.on("end", () => {
				const text = Buffer.concat(chunks).toString("utf8");
				resolve({ status: response.statusCode, json: text.startsWith("{") ? JSON.parse(text) : undefined });
			});
			// 413 之类的提前响应后，声明了却未发送的 body 不会再来；主动断开避免挂起。
			if (declaredLength !== undefined) response.on("end", () => request.destroy());
		});
		request.once("error", reject);
		if (declaredLength === undefined) request.end(payload);
		else request.flushHeaders(); // 只发请求头：服务端必须仅凭声明长度就拒绝
	});
}

test("NativeRendererServer is actually bound to the IPv4 loopback address only", async (t) => {
	const { address, httpServers } = await startServer(t);
	assert.equal(address.host, "127.0.0.1");
	assert.ok(address.port > 0);
	// 检查真实监听 socket 的绑定地址，而不是只信返回值：绑到 0.0.0.0 会把渲染 RPC 暴露给局域网。
	assert.equal(httpServers.length, 1);
	const bound = httpServers[0].address();
	assert.equal(bound.address, "127.0.0.1");
	assert.equal(bound.family, "IPv4");
	assert.equal(bound.port, address.port);
});
test("POST /__pideck/rpc dispatches to the router for an authorized caller (header or query token)", async (t) => {
	const { address, invoked } = await startServer(t);
	const viaHeader = await send(address.port, {
		path: "/__pideck/rpc",
		headers: { "x-pideck-token": TOKEN },
		body: { channel: "probe:echo", args: ["a", 1] },
	});
	assert.equal(viaHeader.status, 200);
	assert.deepEqual(viaHeader.json, { ok: true, result: { echoed: ["a", 1] } });

	const viaQuery = await send(address.port, {
		path: `/__pideck/rpc?token=${TOKEN}`,
		body: { channel: "probe:echo", args: ["b"] },
	});
	assert.equal(viaQuery.status, 200);
	assert.deepEqual(invoked, [["a", 1], ["b"]]);
});

test("POST /__pideck/rpc rejects missing or wrong tokens without touching the router", async (t) => {
	const { address, invoked } = await startServer(t);
	for (const headers of [{}, { "x-pideck-token": "wrong" }]) {
		const response = await send(address.port, { path: "/__pideck/rpc", headers, body: { channel: "probe:echo", args: [] } });
		assert.equal(response.status, 401);
		assert.equal(response.json.ok, false);
	}
	const events = await send(address.port, { method: "GET", path: "/__pideck/events" });
	assert.equal(events.status, 401, "SSE 事件通道同样需要 token");
	assert.deepEqual(invoked, []);
});

test("POST /__pideck/rpc returns router errors as structured failures and rejects malformed requests", async (t) => {
	const { address } = await startServer(t);
	const unknown = await send(address.port, {
		path: "/__pideck/rpc",
		headers: { "x-pideck-token": TOKEN },
		body: { channel: "probe:missing", args: [] },
	});
	assert.equal(unknown.status, 200);
	assert.equal(unknown.json.ok, false);
	assert.equal(typeof unknown.json.error.message, "string");

	// 两个字段各自独立地缺失/类型错误都必须被拒绝（不能靠另一个字段的检查兜底）
	for (const body of [{ channel: 42, args: [] }, { channel: "probe:echo", args: "nope" }]) {
		const malformed = await send(address.port, { path: "/__pideck/rpc", headers: { "x-pideck-token": TOKEN }, body });
		assert.equal(malformed.status, 400);
	}
});

test("a request declaring a body above MAX_NATIVE_RPC_BODY_BYTES is refused with 413 before it is read", { timeout: 10000 }, async (t) => {
	const { address, invoked } = await startServer(t);
	const response = await send(address.port, {
		path: "/__pideck/rpc",
		headers: { "x-pideck-token": TOKEN },
		declaredLength: MAX_NATIVE_RPC_BODY_BYTES + 1,
	});
	assert.equal(response.status, 413);
	assert.deepEqual(invoked, []);
});
