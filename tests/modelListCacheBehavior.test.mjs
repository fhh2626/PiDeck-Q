import assert from "node:assert/strict";
import test from "node:test";
import { loadModelListCache } from "./helpers/loadModelListCache.mjs";

/**
 * 模型列表缓存的行为测试：通过公开的 fetch/refresh/invalidate/getCached，
 * 用假的 child_process 与 RPC 客户端驱动，断言“发生了几次进程调用、缓存里是什么、
 * 用了哪些参数”，而不是检查源码里是否含有某段文字。
 */

const OLD = [{ provider: "anthropic", id: "old", name: "Old" }];
const NEW = [{ provider: "anthropic", id: "new", name: "New" }];
const ids = (models) => Array.from(models ?? [], (model) => model.id);

const TABLE = [
	"provider  model  context  max-out  thinking  images",
	"anthropic  claude  200K  8K  yes  yes",
].join("\n");
/** 只有表头：文本回退“成功但没有模型”。 */
const EMPTY_TABLE = "provider  model  context  max-out  thinking  images\n";

const settingsOf = (overrides = {}) => ({
	customPiPath: "",
	wslEnabled: false,
	wslDistro: "",
	wslUser: "",
	piRuntimePreference: "auto",
	piTypescriptPath: "",
	piRustPath: "",
	piBoltPath: "",
	...overrides,
});

/** 让挂起的 RPC 响应可由测试放行。 */
function deferred() {
	let release;
	const promise = new Promise((resolve) => {
		release = resolve;
	});
	return { promise, release };
}

// ── 缓存与刷新 ─────────────────────────────────────────────────────

test("fetchModelList serves the cached list without starting another Pi process", async () => {
	const cache = loadModelListCache({ rpcResponses: [NEW] });
	const store = cache.settingsStore(settingsOf());

	const first = await cache.fetchModelList(cache.locator, store);
	const second = await cache.fetchModelList(cache.locator, store);

	assert.deepEqual(ids(first), ["new"]);
	assert.deepEqual(ids(second), ["new"]);
	assert.equal(cache.calls.spawn.length, 1);
});

test("concurrent fetchModelList calls share a single Pi process", async () => {
	const gate = deferred();
	const cache = loadModelListCache({ rpcResponses: [() => gate.promise] });
	const store = cache.settingsStore(settingsOf());

	const a = cache.fetchModelList(cache.locator, store);
	const b = cache.fetchModelList(cache.locator, store);
	gate.release(NEW);

	assert.deepEqual(ids(await a), ["new"]);
	assert.deepEqual(ids(await b), ["new"]);
	assert.equal(cache.calls.spawn.length, 1);
});

test("refreshModelList bypasses a warm cache and replaces it", async () => {
	const cache = loadModelListCache({ rpcResponses: [OLD, NEW] });
	const store = cache.settingsStore(settingsOf());
	await cache.fetchModelList(cache.locator, store);

	const refreshed = await cache.refreshModelList(cache.locator, store);

	assert.deepEqual(ids(refreshed), ["new"]);
	assert.deepEqual(ids(cache.getCachedModelList()), ["new"]);
	assert.equal(cache.calls.spawn.length, 2);
});

test("an empty result is retried once and the successful retry is cached", async () => {
	// 第一轮：RPC 空 → 文本回退也只有表头；第二轮（重试）：RPC 返回模型。
	const cache = loadModelListCache({ rpcResponses: [[], NEW], textOutputs: [EMPTY_TABLE] });
	const store = cache.settingsStore(settingsOf());

	const models = await cache.fetchModelList(cache.locator, store);

	assert.deepEqual(ids(models), ["new"]);
	assert.deepEqual(ids(cache.getCachedModelList()), ["new"]);
});

test("a result that stays empty is never cached, so the next fetch tries again", async () => {
	const cache = loadModelListCache({ rpcResponses: [[], [], NEW], textOutputs: [EMPTY_TABLE] });
	const store = cache.settingsStore(settingsOf());

	assert.deepEqual(ids(await cache.fetchModelList(cache.locator, store)), []);
	assert.equal(cache.getCachedModelList(), null);

	assert.deepEqual(ids(await cache.fetchModelList(cache.locator, store)), ["new"]);
	assert.deepEqual(ids(cache.getCachedModelList()), ["new"]);
});

test("refreshModelList retries an empty result once, waiting before the retry, and caches the retry", async () => {
	const cache = loadModelListCache({ rpcResponses: [[], NEW], textOutputs: [EMPTY_TABLE] });
	const store = cache.settingsStore(settingsOf());

	const models = await cache.refreshModelList(cache.locator, store);

	assert.deepEqual(ids(models), ["new"]);
	assert.deepEqual(ids(cache.getCachedModelList()), ["new"]);
	assert.ok(cache.calls.delays.includes(500), "the retry must wait 500ms instead of re-forking immediately");
});

test("refreshModelList that stays empty is not cached", async () => {
	const cache = loadModelListCache({ rpcResponses: [[], []], textOutputs: [EMPTY_TABLE] });
	const store = cache.settingsStore(settingsOf());

	assert.deepEqual(ids(await cache.refreshModelList(cache.locator, store)), []);
	assert.equal(cache.getCachedModelList(), null);
});

test("refreshModelList chained behind an in-flight request also retries an empty result", async () => {
	const gate = deferred();
	// 在途请求（旧配置）→ 链式 refresh 第一次为空 → 重试得到 NEW。
	const cache = loadModelListCache({ rpcResponses: [() => gate.promise, [], NEW], textOutputs: [EMPTY_TABLE] });
	const store = cache.settingsStore(settingsOf());

	const stale = cache.fetchModelList(cache.locator, store);
	cache.invalidateModelListCache();
	const refreshed = cache.refreshModelList(cache.locator, store);
	gate.release(OLD);
	await stale;

	assert.deepEqual(ids(await refreshed), ["new"]);
	assert.deepEqual(ids(cache.getCachedModelList()), ["new"]);
});
// ── 配置保存后的失效 ───────────────────────────────────────────────

test("invalidateModelListCache empties the cache immediately", async () => {
	const cache = loadModelListCache({ rpcResponses: [OLD] });
	await cache.fetchModelList(cache.locator, cache.settingsStore(settingsOf()));
	assert.deepEqual(ids(cache.getCachedModelList()), ["old"]);

	cache.invalidateModelListCache();

	assert.equal(cache.getCachedModelList(), null);
});

test("a refresh right after the config was saved (nothing in flight) reloads and writes its result to the cache", async () => {
	// 保存 models.json 之后的第一次刷新（生产里 invalidate 总是紧跟 refresh）：失效标记必须被复位，
	// 否则新列表永远进不了缓存（“新模型有时候没有”）。
	const cache = loadModelListCache({ rpcResponses: [OLD, NEW] });
	const store = cache.settingsStore(settingsOf());
	await cache.fetchModelList(cache.locator, store);

	cache.invalidateModelListCache();
	const models = await cache.refreshModelList(cache.locator, store);

	assert.deepEqual(ids(models), ["new"]);
	assert.deepEqual(ids(cache.getCachedModelList()), ["new"]);
});

test("a stale in-flight list does not overwrite the cache after the config was saved", async () => {
	const gate = deferred();
	const cache = loadModelListCache({ rpcResponses: [() => gate.promise] });
	const store = cache.settingsStore(settingsOf());

	const inFlight = cache.fetchModelList(cache.locator, store);
	cache.invalidateModelListCache(); // 保存 models.json：在途请求对应的是旧配置
	gate.release(OLD);

	assert.deepEqual(ids(await inFlight), ["old"], "the caller of the old request still gets its own result");
	assert.equal(cache.getCachedModelList(), null, "…but it must not become the cached list");
});

test("refreshModelList during an in-flight fetch reloads and ends with the new config's list", async () => {
	const gate = deferred();
	const cache = loadModelListCache({ rpcResponses: [() => gate.promise, NEW] });
	const store = cache.settingsStore(settingsOf());

	const stale = cache.fetchModelList(cache.locator, store);
	cache.invalidateModelListCache();
	const refreshed = cache.refreshModelList(cache.locator, store);
	gate.release(OLD);
	await stale;

	assert.deepEqual(ids(await refreshed), ["new"]);
	assert.deepEqual(ids(cache.getCachedModelList()), ["new"]);
	assert.equal(cache.calls.spawn.length, 2, "the refresh forks again instead of reusing the stale request");
});

// ── 参数与实现选择 ─────────────────────────────────────────────────

test("the RPC model query uses the neutral argument set", async () => {
	const cache = loadModelListCache({ rpcResponses: [NEW] });

	await cache.fetchModelList(cache.locator, cache.settingsStore(settingsOf()));

	assert.deepEqual(cache.calls.spawn[0].args, Array.from(cache.MODEL_LIST_RPC_ARGS));
});

test("the Pi-Bolt path and runtime preference reach the locator", async () => {
	const cache = loadModelListCache({ rpcResponses: [NEW] });
	const settings = settingsOf({ piRuntimePreference: "bolt", piBoltPath: "C:\\Pi-Bolt\\pi-bolt.exe", piRustPath: "R" });

	await cache.fetchModelList(cache.locator, cache.settingsStore(settings));

	const args = cache.calls.resolveCommand[0];
	assert.equal(args[4], "bolt");
	assert.equal(args[6], "R");
	assert.equal(args[7], "C:\\Pi-Bolt\\pi-bolt.exe");
});

for (const preference of ["typescript", "bolt"]) {
	test(`${preference}: the text fallback tries --offline first, then the neutral set if that finds nothing`, async () => {
		// RPC 失败 → 文本回退；第一组参数（含 --offline）无模型，第二组参数有模型。
		const cache = loadModelListCache({ rpcResponses: [new Error("rpc unavailable")], textOutputs: [EMPTY_TABLE, TABLE] });

		const models = await cache.fetchModelList(cache.locator, cache.settingsStore(settingsOf({ piRuntimePreference: preference })));

		assert.deepEqual(ids(models), ["claude"]);
		assert.equal(cache.calls.execFile.length, 2);
		assert.ok(cache.calls.execFile[0].args.includes("--offline"));
		assert.ok(!cache.calls.execFile[1].args.includes("--offline"));
	});

	test(`${preference}: the text fallback resolves the CLI with the configured Pi-Bolt path`, async () => {
		const cache = loadModelListCache({ rpcResponses: [new Error("rpc unavailable")], textOutputs: [TABLE] });
		const settings = settingsOf({ piRuntimePreference: preference, piBoltPath: "C:\\Pi-Bolt\\pi-bolt.exe" });

		await cache.fetchModelList(cache.locator, cache.settingsStore(settings));

		// resolveCommand 先为 RPC 调用一次，再为文本回退调用一次；两次都必须带上 bolt 路径。
		assert.equal(cache.calls.resolveCommand.length, 2);
		for (const args of cache.calls.resolveCommand) assert.equal(args[7], "C:\\Pi-Bolt\\pi-bolt.exe");
	});

	test(`${preference}: a successful --offline text query is the only text query`, async () => {
		const cache = loadModelListCache({ rpcResponses: [new Error("rpc unavailable")], textOutputs: [TABLE] });

		await cache.fetchModelList(cache.locator, cache.settingsStore(settingsOf({ piRuntimePreference: preference })));

		assert.equal(cache.calls.execFile.length, 1);
		assert.ok(cache.calls.execFile[0].args.includes("--offline"));
	});
}

for (const preference of ["auto", "rust"]) {
	test(`${preference}: the text fallback never passes --offline (Rust CLI does not know it)`, async () => {
		const cache = loadModelListCache({ rpcResponses: [new Error("rpc unavailable")], textOutputs: [TABLE] });

		await cache.fetchModelList(cache.locator, cache.settingsStore(settingsOf({ piRuntimePreference: preference })));

		assert.equal(cache.calls.execFile.length, 1);
		assert.ok(!cache.calls.execFile[0].args.includes("--offline"));
		assert.ok(cache.calls.execFile[0].args.includes("--list-models"));
	});
}
