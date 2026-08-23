import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve, join } from "node:path";
import ts from "typescript";
import vm from "node:vm";

const require = createRequire(import.meta.url);

/**
 * ElectronDownloads adapter 行为测试。
 *
 * 用 mock 的 electron.net.request + mock 的 createWriteStream 驱动真实 adapter，
 * 不访问真实网络 / 文件系统。覆盖：请求参数、redirect、非 2xx、content-length、
 * progress 累加、写入完成时机、backpressure、各类 error、最终返回值。
 *
 * adapter 的真实流程：
 *   req = net.request(opts) → 挂 req.on('redirect'/'error'/'response') → req.end()
 *   response 事件回调里：判断 statusCode，解析 content-length，createWriteStream，
 *     挂 output.on('error') / response.on('data'/'error'/'end') / output.on('finish')
 */

function transpile(source) {
	return ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
	}).outputText;
}

const moduleCache = new Map();
function buildRequire(importerDir, overrides) {
	return (id) => {
		for (const key of Object.keys(overrides)) {
			if (id.includes(key)) return overrides[key];
		}
		if (id.startsWith("./") || id.startsWith("../")) {
			let base = resolve(importerDir, id);
			if (existsSync(`${base}.ts`)) base = `${base}.ts`;
			else if (existsSync(join(base, "index.ts"))) base = join(base, "index.ts");
			else if (existsSync(`${base}.js`)) base = `${base}.js`;
			return loadTs(base, overrides);
		}
		return require(id);
	};
}
function loadTs(filePath, overrides = {}) {
	if (moduleCache.has(filePath)) return moduleCache.get(filePath);
	const source = readFileSync(filePath, "utf8");
	const sandbox = {
		clearTimeout,
		setTimeout,
		process,
		exports: {},
		require: buildRequire(dirname(filePath), overrides),
	};
	moduleCache.set(filePath, sandbox.exports);
	vm.runInNewContext(transpile(source), sandbox, { filename: filePath });
	return sandbox.exports;
}

/**
 * 构造一个可控的下载场景。
 * 返回 control 对象，测试按顺序触发：
 *   await control.start()            → 调用 downloadToFile 并返回 promise
 *   control.request                  → net.request 返回的 request mock
 *   control.fireRequest(event, ...)  → 触发 request 上的事件
 *   control.fireResponse(event, ...) → 触发 response 上的事件
 *   control.fireOutput(event, ...)   → 触发 output 上的事件
 *   control.response                 → adapter 实际拿到的 response 对象
 *   control.output                   → adapter 实际拿到的 output 流
 *   control.headersSet               → req.setHeader 记录
 *   control.written                  → 写入 output 的 chunks
 *   control.outputWriteReturn        → 控制 output.write 返回值（backpressure）
 */
function createHarness({
	statusCode = 200,
	headers = {},
	expectedBytes,
	onProgress,
	onRedirect,
	deferCloseCallback = false,
} = {}) {
	let netOpts;
	let outputWriteReturn = true;
	let savedCloseCallback;

	// response mock：adapter 在 response 事件里拿到它
	const response = {
		statusCode,
		headers,
		_on: new Map(),
		on(event, handler) {
			const list = response._on.get(event) ?? [];
			list.push(handler);
			response._on.set(event, list);
			return response;
		},
		pause: () => {
			response._paused = true;
		},
		resume: () => {
			response._resumed = true;
		},
	};

	// output mock：adapter 通过 createWriteStream 拿到它
	const written = [];
	const output = {
		_on: new Map(),
		write(chunk) {
			written.push(Buffer.from(chunk));
			return outputWriteReturn;
		},
		end() {
			output._ended = true;
		},
		close(cb) {
			output._closed = true;
			savedCloseCallback = cb;
			if (!deferCloseCallback) cb?.();
		},
		destroy() {
			output._destroyed = true;
		},
		on(event, handler) {
			const list = output._on.get(event) ?? [];
			list.push(handler);
			output._on.set(event, list);
			return output;
		},
		once(event, handler) {
			const list = output._on.get(event) ?? [];
			list.push(handler);
			output._on.set(event, list);
			return output;
		},
	};

	// request mock：net.request 返回它
	const headersSet = {};
	const request = {
		_on: new Map(),
		setHeader(k, v) {
			headersSet[k] = v;
		},
		on(event, handler) {
			const list = request._on.get(event) ?? [];
			list.push(handler);
			request._on.set(event, list);
			return request;
		},
		end() {
			request._ended = true;
		},
		followRedirect() {
			request._followed = true;
		},
	};

	const mockElectron = {
		net: {
			request: (opts) => {
				netOpts = opts;
				return request;
			},
		},
	};
	const createdStreams = [];
	const mockFs = {
		createWriteStream: (filePath) => {
			createdStreams.push(filePath);
			return output;
		},
	};

	const { ElectronDownloads } = loadTs(
		"src/main/platform/electron/ElectronDownloads.ts",
		{ electron: mockElectron, "node:fs": mockFs },
	);
	// 每个 harness 用独立的 mock，所以清除缓存避免复用前一个 harness 的 net/fs
	moduleCache.clear();
	const downloads = new ElectronDownloads();

	const fire = (obj, event, ...args) => {
		for (const h of obj._on.get(event) ?? []) h(...args);
	};

	const control = {
		downloads,
		netOpts: () => netOpts,
		request,
		response,
		output,
		headersSet,
		written: () => written,
		createdStreams: () => createdStreams,
		setOutputWriteReturn: (v) => {
			outputWriteReturn = v;
		},
		runCloseCallback: () => savedCloseCallback?.(),
		fireRequest: (event, ...args) => fire(request, event, ...args),
		fireResponse: (event, ...args) => fire(response, event, ...args),
		fireOutput: (event, ...args) => fire(output, event, ...args),
		start: () =>
			downloads.downloadToFile({
				url: "https://example.com/file.bin",
				filePath: "/tmp/out.bin",
				headers: { "User-Agent": "ua" },
				expectedBytes,
				onProgress,
				onRedirect,
			}),
	};
	return control;
}

/** 触发 response 事件，让 adapter 完成「挂 output 监听」阶段。 */
function respond(h) {
	h.fireRequest("response", h.response);
}

/** 触发 output finish（真实流里 end() 之后由底层 emit finish）。 */
function finishOutput(h) {
	h.fireOutput("finish");
}

test("ElectronDownloads request uses GET, url, headers and end()", async () => {
	const h = createHarness();
	const promise = h.start();
	assert.equal(h.netOpts().method, "GET");
	assert.equal(h.netOpts().url, "https://example.com/file.bin");
	assert.equal(h.headersSet["User-Agent"], "ua");
	assert.equal(h.request._ended, true);
	// 推到 resolve
	respond(h);
	h.fireResponse("end");
	finishOutput(h);
	const result = await promise;
	assert.equal(result.receivedBytes, 0);
	// 输出流必须写到 request 指定的目标路径，而不是其他位置。
	assert.deepEqual(h.createdStreams(), ["/tmp/out.bin"]);
});

test("ElectronDownloads redirect calls followRedirect and onRedirect", async () => {
	const redirects = [];
	const h = createHarness({ onRedirect: (u) => redirects.push(u) });
	const promise = h.start();
	h.fireRequest("redirect", 302, "GET", "https://cdn.example.com/file.bin");
	assert.equal(h.request._followed, true);
	assert.deepEqual(redirects, ["https://cdn.example.com/file.bin"]);
	respond(h);
	h.fireResponse("end");
	finishOutput(h);
	await promise;
});

test("ElectronDownloads non-2xx rejects with PlatformDownloadError and statusCode", async () => {
	const h = createHarness({ statusCode: 404, headers: {} });
	const promise = h.start();
	respond(h);
	await assert.rejects(promise, (err) => {
		assert.equal(err.name, "PlatformDownloadError");
		assert.equal(err.statusCode, 404);
		return true;
	});
	// 非 2xx 时绝不能提前创建输出流：否则会截断/占用已存在的同名安装包。
	assert.deepEqual(h.createdStreams(), [], "non-2xx must reject before creating the output stream");
});

test("ElectronDownloads 5xx (300+) also rejects as non-2xx", async () => {
	const h = createHarness({ statusCode: 500, headers: {} });
	const promise = h.start();
	respond(h);
	await assert.rejects(promise, (err) => err.statusCode === 500);
});

test("ElectronDownloads accumulates receivedBytes across data chunks (cumulative, not per-chunk)", async () => {
	const progress = [];
	const h = createHarness({ headers: {}, onProgress: (p) => progress.push(p) });
	const promise = h.start();
	respond(h);
	h.fireResponse("data", Buffer.from("aa")); // 2 bytes
	h.fireResponse("data", Buffer.from("bbb")); // 3 bytes
	assert.deepEqual(
		progress.map((p) => p.receivedBytes),
		[2, 5],
		"receivedBytes must be cumulative",
	);
	h.fireResponse("end");
	finishOutput(h);
	const result = await promise;
	assert.equal(result.receivedBytes, 5);
});

test("ElectronDownloads uses content-length header as totalBytes when present", async () => {
	const progress = [];
	const h = createHarness({
		statusCode: 200,
		headers: { "content-length": ["42"] },
		expectedBytes: 99,
		onProgress: (p) => progress.push(p),
	});
	const promise = h.start();
	respond(h);
	h.fireResponse("data", Buffer.from("x".repeat(10)));
	assert.equal(progress[0].totalBytes, 42, "valid content-length should override expectedBytes");
	h.fireResponse("end");
	finishOutput(h);
	const result = await promise;
	assert.equal(result.totalBytes, 42);
});

test("ElectronDownloads falls back to expectedBytes when content-length is absent or invalid", async () => {
	for (const headers of [{}, { "content-length": "not-a-number" }, { "content-length": "0" }]) {
		const progress = [];
		const h = createHarness({
			headers,
			expectedBytes: 77,
			onProgress: (p) => progress.push(p),
		});
		const promise = h.start();
		respond(h);
		h.fireResponse("data", Buffer.from("x"));
		assert.equal(progress[0].totalBytes, 77);
		h.fireResponse("end");
		finishOutput(h);
		const result = await promise;
		assert.equal(result.totalBytes, 77);
	}
});

test("ElectronDownloads leaves totalBytes undefined when no valid source exists", async () => {
	const progress = [];
	const h = createHarness({
		headers: { "content-length": "invalid" },
		onProgress: (p) => progress.push(p),
	});
	const promise = h.start();
	respond(h);
	h.fireResponse("data", Buffer.from("x"));
	assert.equal(progress[0].totalBytes, undefined);
	h.fireResponse("end");
	finishOutput(h);
	const result = await promise;
	assert.equal(result.totalBytes, undefined);
});

test("ElectronDownloads resolves only after output close callback executes", async () => {
	const h = createHarness({ deferCloseCallback: true });
	const promise = h.start();
	respond(h);
	h.fireResponse("data", Buffer.from("abc"));
	h.fireResponse("end"); // 触发 output.end()
	assert.equal(h.output._ended, true);

	let resolved = false;
	promise.then(() => {
		resolved = true;
	});
	await new Promise((r) => setImmediate(r));
	assert.equal(resolved, false, "must not resolve before finish");

	h.fireOutput("finish");
	assert.equal(h.output._closed, true, "finish must call output.close");
	await new Promise((r) => setImmediate(r));
	assert.equal(resolved, false, "must not resolve before the close callback executes");

	h.runCloseCallback();
	const result = await promise;
	assert.equal(result.receivedBytes, 3);
});

test("ElectronDownloads backpressure: output.write false pauses, drain resumes", async () => {
	const h = createHarness();
	const promise = h.start();
	respond(h);
	h.setOutputWriteReturn(false);
	h.fireResponse("data", Buffer.from("a"));
	assert.equal(h.response._paused, true, "should pause when write returns false");
	h.setOutputWriteReturn(true);
	h.fireOutput("drain");
	assert.equal(h.response._resumed, true, "should resume on drain");
	h.fireResponse("end");
	finishOutput(h);
	await promise;
});

test("ElectronDownloads request error rejects with the original error", async () => {
	const h = createHarness();
	const promise = h.start();
	const reqErr = new Error("request boom");
	h.fireRequest("error", reqErr);
	await assert.rejects(promise, (err) => err === reqErr);
});

test("ElectronDownloads response error destroys output and rejects", async () => {
	const h = createHarness();
	const promise = h.start();
	respond(h);
	const respErr = new Error("response boom");
	h.fireResponse("error", respErr);
	assert.equal(h.output._destroyed, true);
	await assert.rejects(promise, (err) => err === respErr);
});

test("ElectronDownloads output error rejects with the original error", async () => {
	const h = createHarness();
	const promise = h.start();
	respond(h);
	const outErr = new Error("output boom");
	h.fireOutput("error", outErr);
	await assert.rejects(promise, (err) => err === outErr);
});
