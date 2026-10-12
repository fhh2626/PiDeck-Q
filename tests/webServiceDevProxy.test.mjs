/**
 * WebServiceManager dev 代理回归测试：模块请求绝不回退/转发 HTML。
 *
 * 背景（issue：web 服务打开后白屏，控制台报 "Failed to load module script:
 * ... MIME type of text/html"）：
 * 1. vite 对不存在的路径按 SPA fallback 返回 200 + index.html；
 * 2. vite 对 deps 重新优化期间的旧 URL 返回 504 Outdated Optimize Dep。
 * 旧实现把这两种响应都原样转发/回退成 HTML 页面，浏览器按 module script
 * 解析 HTML 即报 MIME 错误、整页白屏。修复后：模块/资源请求只接受 JS 类
 * 响应（非 200 透传状态、200+HTML 判 404），仅文档请求允许回退 A1 内嵌页。
 */
import assert from "node:assert/strict";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import test from "node:test";

import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

function loadWebServiceManager() {
	return loadTsCommonJs("src/main/web/WebServiceManager.ts", {
		// VM 沙箱默认没有 fetch（Node 18+ 全局），dev 代理测试需要它
		globals: {
			fetch: globalThis.fetch,
			Response: globalThis.Response,
			ReadableStream: globalThis.ReadableStream,
		},
	}).WebServiceManager;
}

/** 起一个可控响应内容的假 vite dev server */
async function startMockVite(handler) {
	const server = createHttpServer((req, res) => handler(req, res));
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = server.address().port;
	return {
		url: `http://127.0.0.1:${port}`,
		close: () => new Promise((resolve) => server.close(resolve)),
	};
}

const DEV_TEST_TOKEN = "d".repeat(43);

/** 带 Bearer 令牌的请求；dev 代理路径同样受访问令牌保护。 */
function authFetch(url, init = {}) {
	return fetch(url, { ...init, headers: { ...(init.headers ?? {}), authorization: `Bearer ${DEV_TEST_TOKEN}` } });
}

/** 精简 deps：dev 代理路径只触及 subscribePiEvents（start 时绑定）与 devRendererUrl */
function makeDeps(devRendererUrl) {
	return {
		subscribePiEvents: () => () => undefined,
		devRendererUrl,
	};
}

async function withManager(devRendererUrl, run) {
	const WebServiceManager = loadWebServiceManager();
	const manager = new WebServiceManager(makeDeps(devRendererUrl));
	await manager.start("127.0.0.1", 0, DEV_TEST_TOKEN);
	try {
		await run(`http://127.0.0.1:${manager.current.port}`);
	} finally {
		await manager.stop();
	}
}

test("dev 代理：模块请求遇 vite 504（deps 重新优化）→ 透传 504，不回退 HTML", async () => {
	const vite = await startMockVite((req, res) => {
		// vite 对旧 hash deps URL 的真实响应：504 + 空 body
		res.writeHead(504, { "content-type": "text/plain" });
		res.end();
	});
	try {
		await withManager(vite.url, async (baseUrl) => {
			const res = await authFetch(
				`${baseUrl}/@fs/C:/proj/node_modules/.vite/deps/@ai-sdk_react.js?v=stale-hash`,
			);
			assert.equal(res.status, 504, "应透传上游 504");
			const type = res.headers.get("content-type") ?? "";
			assert.ok(!type.includes("text/html"), "模块请求绝不能拿到 HTML（MIME 白屏根因）");
		});
	} finally {
		await vite.close();
	}
});

test("dev 代理：模块请求遇 vite SPA fallback（200+HTML，资源不存在）→ 返回 404", async () => {
	const vite = await startMockVite((req, res) => {
		// vite 对不存在的路径返回 200 + index.html
		res.writeHead(200, { "content-type": "text/html" });
		res.end("<!doctype html><html><body>vite index fallback</body></html>");
	});
	try {
		await withManager(vite.url, async (baseUrl) => {
			const res = await authFetch(`${baseUrl}/src/ghost-module.tsx`);
			assert.equal(res.status, 404, "模块请求拿到 HTML 应判定资源不存在");
			assert.ok(!(res.headers.get("content-type") ?? "").includes("text/html"));
		});
	} finally {
		await vite.close();
	}
});

test("dev 代理：/@vite/client 等 vite 内部模块（无扩展名）遇 504 → 透传而非按文档回退", async () => {
	const vite = await startMockVite((req, res) => {
		res.writeHead(504, { "content-type": "text/plain" });
		res.end();
	});
	try {
		await withManager(vite.url, async (baseUrl) => {
			const res = await authFetch(`${baseUrl}/@vite/client`);
			assert.equal(res.status, 504, "/@* 是模块请求，应透传上游状态");
		});
	} finally {
		await vite.close();
	}
});

test("dev 代理：文档请求（/web.html）正常转发上游 HTML", async () => {
	const vite = await startMockVite((req, res) => {
		assert.equal(req.url, "/web.html");
		res.writeHead(200, { "content-type": "text/html" });
		res.end("<!doctype html><html><body>A2 web page</body></html>");
	});
	try {
		await withManager(vite.url, async (baseUrl) => {
			const res = await authFetch(`${baseUrl}/web.html`);
			assert.equal(res.status, 200);
			assert.ok((res.headers.get("content-type") ?? "").includes("text/html"));
			assert.ok((await res.text()).includes("A2 web page"));
		});
	} finally {
		await vite.close();
	}
});

test("dev 代理：文档请求上游非 200 → 回退 A1 内嵌页（保持兼容）", async () => {
	const vite = await startMockVite((req, res) => {
		res.writeHead(404, { "content-type": "text/html" });
		res.end("not found");
	});
	try {
		await withManager(vite.url, async (baseUrl) => {
			const res = await authFetch(`${baseUrl}/web.html`);
			assert.equal(res.status, 200);
			const body = await res.text();
			assert.ok(body.includes("PiDeck-Q Web Service"), "应回退 PiDeck-Q 内嵌页");
		});
	} finally {
		await vite.close();
	}
});

test("dev 代理：dev server 未就绪 → 文档回退 A1、模块请求 503", async () => {
	// 先占一个端口再释放，之后请求同一端口必然 ECONNREFUSED
	const probe = await startMockVite((req, res) => res.end());
	const deadUrl = probe.url;
	await probe.close();
	await withManager(deadUrl, async (baseUrl) => {
		const doc = await authFetch(`${baseUrl}/`);
		assert.equal(doc.status, 200);
		assert.ok((await doc.text()).includes("PiDeck-Q Web Service"));
		const mod = await authFetch(`${baseUrl}/src/web-main.tsx`);
		assert.equal(mod.status, 503, "模块请求应 503 而非 HTML");
		assert.ok(!(mod.headers.get("content-type") ?? "").includes("text/html"));
	});
});

/**
 * 支持 WebSocket upgrade 的假 vite：记录收到的 upgrade 请求，回 101。
 * 升级后的 socket 不受 server.close() 管理，需手动登记并销毁，避免测试挂起。
 */
async function startMockViteWithUpgrade() {
	const upgradeHits = [];
	const sockets = new Set();
	const server = createHttpServer((req, res) => {
		res.writeHead(404);
		res.end();
	});
	server.on("upgrade", (req, socket) => {
		upgradeHits.push(req.url);
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
		socket.on("error", () => undefined);
		socket.write(
			"HTTP/1.1 101 Switching Protocols\r\n" +
			"Upgrade: websocket\r\n" +
			"Connection: Upgrade\r\n\r\n",
		);
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	return {
		url: `http://127.0.0.1:${server.address().port}`,
		upgradeHits,
		close: () => {
			for (const socket of sockets) socket.destroy();
			return new Promise((resolve) => server.close(() => resolve()));
		},
	};
}

/**
 * 向 Web 服务发起一次 WebSocket upgrade 请求。
 * keepOpen=false：拿到 101 后立即断开客户端 socket；
 * keepOpen=true：保留 socket（模拟浏览器一直开着 dev 页面），通过结果的 socket 字段返回。
 * 结果：{ kind: "upgraded", statusCode, socket } 或 { kind: "rejected" }。
 */
function attemptUpgrade(baseUrl, extraHeaders = {}, { keepOpen = false } = {}) {
	const target = new URL(baseUrl);
	return new Promise((resolve) => {
		const req = httpRequest({
			hostname: target.hostname,
			port: target.port,
			path: "/__vite_hmr",
			method: "GET",
			headers: {
				connection: "Upgrade",
				upgrade: "websocket",
				"sec-websocket-version": "13",
				"sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
				...extraHeaders,
			},
		});
		let settled = false;
		const finish = (result) => {
			if (settled) return;
			settled = true;
			resolve(result);
		};
		req.on("upgrade", (response, socket) => {
			socket.on("error", () => undefined);
			if (!keepOpen) socket.destroy();
			finish({ kind: "upgraded", statusCode: response.statusCode, socket });
		});
		// 鉴权失败时服务端直接 socket.destroy()：客户端表现为 socket hang up / ECONNRESET
		req.on("error", () => finish({ kind: "rejected" }));
		req.on("response", (response) => {
			response.resume();
			finish({ kind: "rejected" });
		});
		req.end();
	});
}

test("dev 代理：未授权的 HMR upgrade 被直接断开，且不会转发到 dev server", async () => {
	const vite = await startMockViteWithUpgrade();
	try {
		await withManager(vite.url, async (baseUrl) => {
			const result = await attemptUpgrade(baseUrl);
			assert.equal(result.kind, "rejected");
			assert.deepEqual(vite.upgradeHits, [], "未授权 upgrade 不得到达 dev server");
		});
	} finally {
		await vite.close();
	}
});

test("dev 代理：畸形 Host 的 HMR upgrade 被拒绝且服务继续可用", async () => {
	const vite = await startMockViteWithUpgrade();
	try {
		await withManager(vite.url, async (baseUrl) => {
			const result = await attemptUpgrade(baseUrl, { host: "[" });
			assert.equal(result.kind, "rejected");
			assert.deepEqual(vite.upgradeHits, [], "畸形 Host 不得到达 dev server");
			const health = await fetch(`${baseUrl}/api/health`);
			assert.equal(health.status, 200, "拒绝畸形 upgrade 后服务仍须可用");
		});
	} finally {
		await vite.close();
	}
});

test("dev 代理：携带访问 Cookie 的 HMR upgrade 被转发并返回 101", async () => {
	const vite = await startMockViteWithUpgrade();
	// 不用 withManager：它的 finally 里 stop() 无超时，缺陷回归时会把整个文件挂死；
	// 这里手动管理并对收尾限时，使回归表现为可断言的失败（由下一条测试断言）而非进程挂起。
	const WebServiceManager = loadWebServiceManager();
	const manager = new WebServiceManager(makeDeps(vite.url));
	await manager.start("127.0.0.1", 0, DEV_TEST_TOKEN);
	const port = String(manager.current.port);
	try {
		const result = await attemptUpgrade(`http://127.0.0.1:${port}`, {
			cookie: `pideck_web_token_${port}=${DEV_TEST_TOKEN}`,
		});
		assert.equal(result.kind, "upgraded");
		assert.equal(result.statusCode, 101);
		assert.deepEqual(vite.upgradeHits, ["/__vite_hmr"]);
	} finally {
		// 收尾顺序关键：先关 vite（销毁上游 socket，连锁关闭服务端残留的已升级连接，
		// 让 stop() 有机会完成），再对 stop() 限时等待，避免收尾本身挂住测试进程。
		await vite.close();
		const stopped = manager.stop().then(() => "stopped");
		let timer;
		try {
			const outcome = await Promise.race([
				stopped,
				new Promise((resolve) => {
					timer = setTimeout(() => resolve("STOP-TIMEOUT"), 3000);
				}),
			]);
			assert.equal(outcome, "stopped", "HMR upgrade 收尾时 stop() 必须能返回");
		} finally {
			clearTimeout(timer);
		}
	}
});

test("dev 代理：HMR 连接存活时 stop() 仍能返回，并断开该连接", async () => {
	const vite = await startMockViteWithUpgrade();
	const WebServiceManager = loadWebServiceManager();
	const manager = new WebServiceManager(makeDeps(vite.url));
	let clientSocket;
	let stopPromise;
	let stopTimer;
	let closeTimer;
	try {
		await manager.start("127.0.0.1", 0, DEV_TEST_TOKEN);
		const port = String(manager.current.port);
		const result = await attemptUpgrade(
			`http://127.0.0.1:${port}`,
			{ cookie: `pideck_web_token_${port}=${DEV_TEST_TOKEN}` },
			{ keepOpen: true },
		);
		clientSocket = result.socket;
		assert.equal(result.kind, "upgraded");
		assert.equal(clientSocket.destroyed, false, "stop() 前 HMR 客户端连接应保持活动");
		const clientClosed = new Promise((resolve) => clientSocket.once("close", resolve));
		// 回归点：stop() 必须结束且主动断开已升级的客户端；两项都限时，
		// 避免任何一个行为退化时把整个测试文件挂住。
		stopPromise = manager.stop();
		const stopOutcome = await Promise.race([
			stopPromise.then(() => "stopped"),
			new Promise((resolve) => {
				stopTimer = setTimeout(() => resolve("STOP-TIMEOUT"), 3000);
			}),
		]);
		clearTimeout(stopTimer);
		assert.equal(stopOutcome, "stopped", "HMR 连接存活时 stop() 必须能返回");
		const closeOutcome = await Promise.race([
			clientClosed.then(() => "closed"),
			new Promise((resolve) => {
				closeTimer = setTimeout(() => resolve("CLOSE-TIMEOUT"), 3000);
			}),
		]);
		clearTimeout(closeTimer);
		assert.equal(closeOutcome, "closed", "stop() 必须断开 HMR 客户端连接");
	} finally {
		clearTimeout(stopTimer);
		clearTimeout(closeTimer);
		clientSocket?.destroy();
		await vite.close();
		await (stopPromise ?? manager.stop());
	}
});
