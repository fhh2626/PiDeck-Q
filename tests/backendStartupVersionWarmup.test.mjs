import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";
import { trackedTempDirs } from "./helpers/trackedTempDirs.mjs";

const require = createRequire(import.meta.url);
const makeTempDir = trackedTempDirs();

/**
 * 启动任务必须预热 pi --version 缓存：否则首个 Agent 启动时（自动模式）拿不到实现类型，
 * Pi-Bolt / 独立二进制会漏掉 --offline 与独立运行时标记，显式模式则要同步等待一次探测。
 * 只替换 PiProcess 边界，观察启动任务是否以当前设置与共享定位器触发预热。
 */
function loadStartupTasks(overrides) {
	const cache = new Map();
	const load = (filePath) => {
		if (cache.has(filePath)) return cache.get(filePath);
		const outputText = ts.transpileModule(readFileSync(filePath, "utf8"), {
			compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
		}).outputText;
		const sandbox = {
			clearTimeout,
			setTimeout,
			setImmediate,
			console: { log() {}, warn() {}, error() {} },
			process,
			exports: {},
			require: (id) => {
				for (const [key, value] of overrides) {
					if (id === key || id.endsWith(`/${key}`)) return value;
				}
				if (id.startsWith("./") || id.startsWith("../")) {
					let base = resolve(dirname(filePath), id);
					if (existsSync(`${base}.ts`)) base = `${base}.ts`;
					else if (existsSync(join(base, "index.ts"))) base = join(base, "index.ts");
					return load(base);
				}
				return require(id);
			},
		};
		cache.set(filePath, sandbox.exports);
		vm.runInNewContext(outputText, sandbox, { filename: filePath });
		return sandbox.exports;
	};
	return load(resolve("src/main/backend/backendStartupTasks.ts"));
}

function startWith({ piLocator, warmVersionCache }) {
	const home = makeTempDir("pideck-startup-warm-");
	const settings = { wslEnabled: false, externalEditors: {}, removedBuiltInExtensions: [], piRuntimePreference: "bolt" };
	const overrides = new Map([
		["../editors/EditorDetector", { detectExternalEditors: async () => [], mergeDetectedExternalEditors: (c) => c }],
		["../pi/PiProcess", { PiProcess: { warmVersionCache } }],
	]);
	const { startBackendStartupTasks } = loadStartupTasks(overrides);
	const logger = {
		entries: [],
		info(scope, message) { this.entries.push({ level: "info", scope, message }); },
		warn(scope, message) { this.entries.push({ level: "warn", scope, message }); },
		error(scope, message) { this.entries.push({ level: "error", scope, message }); },
	};
	const noopWsl = { configureWsl: () => undefined };
	startBackendStartupTasks({
		paths: { home, userData: home, appPath: home, resourcesPath: home },
		host: { sendToRenderer: () => undefined },
		appVersion: "0.0.0-test",
		startupBarrier: { add: () => undefined },
		services: {
			projectStore: { list: () => [] },
			sessionScanner: { configureWsl: async () => undefined, clearWsl: () => undefined },
			configManager: noopWsl,
			promptManager: noopWsl,
			xuePromptManager: noopWsl,
			skillManager: noopWsl,
			extensionManager: noopWsl,
			webServiceManager: { applySettings: async () => undefined },
			appLogger: logger,
			piLocator,
			settingsStore: {
				get: () => settings,
				update: async (patch) => Object.assign(settings, patch),
				ensureRpcTimeoutMinimum: async () => undefined,
			},
		},
	});
	return { settings, logger };
}

/** 启动任务是 fire-and-forget；轮询到条件满足为止，不赌时序。 */
async function until(predicate, timeoutMs = 3_000) {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error("condition not reached");
		await new Promise((resolveWait) => setTimeout(resolveWait, 10));
	}
}

test("startup warms the pi version cache with current settings and the shared locator", async () => {
	const calls = [];
	const piLocator = { check: async () => ({ version: "1.4.0" }) };
	const { settings } = startWith({
		piLocator,
		warmVersionCache: (settingsArg, locatorArg) => {
			calls.push({ settingsArg, locatorArg });
			return Promise.resolve(true);
		},
	});
	await until(() => calls.length > 0);
	assert.equal(calls.length, 1);
	assert.equal(calls[0].settingsArg.piRuntimePreference, settings.piRuntimePreference);
	assert.equal(calls[0].locatorArg, piLocator, "the warm-up must reuse the backend's locator");
});

test("a failing warm-up is logged and does not escape as an unhandled rejection", async () => {
	let attempted = false;
	const { logger } = startWith({
		piLocator: { check: async () => null },
		warmVersionCache: () => {
			attempted = true;
			return Promise.reject(new Error("probe exploded"));
		},
	});
	await until(() => logger.entries.some((entry) => entry.scope === "pi-process"));
	assert.equal(attempted, true);
});

test("no locator means no warm-up (and no real pi spawn)", async () => {
	let attempted = false;
	startWith({ piLocator: null, warmVersionCache: () => { attempted = true; return Promise.resolve(true); } });
	await new Promise((resolveWait) => setTimeout(resolveWait, 50));
	assert.equal(attempted, false);
});
