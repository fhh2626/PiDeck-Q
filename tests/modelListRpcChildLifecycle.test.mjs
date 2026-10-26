import assert from "node:assert/strict";
import test from "node:test";
import { loadModelListCache } from "./helpers/loadModelListCache.mjs";

/**
 * 模型列表 RPC 子进程的生命周期：spawn 失败、提前退出、stdin 断管都必须
 * 立即让请求失败并回退文本路径，而不是等满 20s 超时或把 error 事件升级成未捕获异常。
 * 只替换 child_process 边界，使用真实 PiRpcClient。
 */

const TABLE = [
	"provider  model  context  max-out  thinking  images",
	"anthropic  claude  200K  8K  yes  yes",
].join("\n");

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

/** 在限定时间内完成，否则说明请求挂到了 20s RPC 超时。 */
function within(ms, promise) {
	let timer;
	return Promise.race([
		promise.finally(() => clearTimeout(timer)),
		new Promise((_resolve, reject) => {
			timer = setTimeout(() => reject(new Error(`did not settle within ${ms}ms`)), ms);
		}),
	]);
}

test("a spawn error fails the RPC query immediately and falls back to the text listing", async () => {
	const cache = loadModelListCache({
		realRpcClient: true,
		textOutputs: [TABLE],
		onSpawn: (child) => setImmediate(() => child.emit("error", new Error("spawn pi ENOENT"))),
	});
	const models = await within(2_000, cache.fetchModelList(cache.locator, cache.settingsStore(settingsOf())));
	assert.deepEqual(Array.from(models, (model) => model.id), ["claude"]);
	assert.equal(cache.calls.execFile.length, 1, "text fallback must run after the spawn error");
});

test("an early exit fails the RPC query immediately instead of waiting for the timeout", async () => {
	const cache = loadModelListCache({
		realRpcClient: true,
		textOutputs: [TABLE],
		onSpawn: (child) => setImmediate(() => child.emit("exit", 1, null)),
	});
	const models = await within(2_000, cache.fetchModelList(cache.locator, cache.settingsStore(settingsOf())));
	assert.deepEqual(Array.from(models, (model) => model.id), ["claude"]);
});

test("a broken stdin pipe does not escape as an uncaught error", async () => {
	const cache = loadModelListCache({
		realRpcClient: true,
		textOutputs: [TABLE],
		onSpawn: (child) => setImmediate(() => {
			child.stdin.emit("error", new Error("write EPIPE"));
			child.emit("exit", null, "SIGTERM");
		}),
	});
	const models = await within(2_000, cache.fetchModelList(cache.locator, cache.settingsStore(settingsOf())));
	assert.equal(models.length, 1);
});

test("a successful query still terminates the child it started", async () => {
	const cache = loadModelListCache({
		realRpcClient: true,
		onSpawn: (child) => {
			child.stdin.on("data", (chunk) => {
				const request = JSON.parse(String(chunk));
				child.stdout.write(`${JSON.stringify({
					type: "response",
					id: request.id,
					command: request.type,
					success: true,
					data: { models: [{ provider: "anthropic", id: "rpc-model", name: "RPC" }] },
				})}\n`);
			});
		},
	});
	const models = await within(2_000, cache.fetchModelList(cache.locator, cache.settingsStore(settingsOf())));
	assert.deepEqual(Array.from(models, (model) => model.id), ["rpc-model"]);
	assert.equal(cache.calls.spawn[0].child.killed, true);
});

// ── A3: 模型列表子进程与 Agent 进程使用同一离线策略 ──────────────────

test("the RPC model-list child runs offline unless piRpcOffline is explicitly false", async () => {
	for (const [piRpcOffline, expected] of [[undefined, "1"], [true, "1"], [false, undefined]]) {
		const cache = loadModelListCache({ rpcResponses: [[{ provider: "a", id: "m", name: "M" }]] });
		await cache.fetchModelList(cache.locator, cache.settingsStore(settingsOf({ piRpcOffline })));
		assert.equal(cache.calls.spawn[0].options.env.PI_OFFLINE, expected, `piRpcOffline=${piRpcOffline}`);
	}
});

test("PI_OFFLINE is registered in WSLENV for WSL model-list children", async () => {
	const cache = loadModelListCache({ rpcResponses: [[{ provider: "a", id: "m", name: "M" }]] });
	const wslLocator = {
		...cache.locator,
		createInvocation: (command, args) => ({
			command: "wsl.exe",
			args: ["-d", "Ubuntu", "-u", "dev", "pi", ...args],
			shell: false,
			wsl: { distro: "Ubuntu", user: "dev", piCommand: "pi" },
		}),
		createProcessEnv: () => ({ WSLENV: "USERPROFILE/p" }),
	};
	await cache.fetchModelList(wslLocator, cache.settingsStore(settingsOf({ wslEnabled: true })));
	const env = cache.calls.spawn[0].options.env;
	assert.equal(env.PI_OFFLINE, "1");
	assert.equal(env.WSLENV, "USERPROFILE/p:PI_OFFLINE");
});
