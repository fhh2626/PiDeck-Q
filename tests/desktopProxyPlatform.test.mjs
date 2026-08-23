import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve, join } from "node:path";
import ts from "typescript";
import vm from "node:vm";

const require = createRequire(import.meta.url);

/**
 * Desktop proxy 行为测试。
 *
 * DesktopProxy.ts 用「无扩展名」相对 import（sharedLogger / PlatformServices），
 * Node 原生 strip-types 无法直接解析，这里用 ts.transpileModule + 递归 .ts require 加载。
 *
 * 注意：vm 沙箱里的对象有自己的 Object.prototype，node:assert/strict 的 deepEqual
 * 会因 realm 不同报「same structure but not reference-equal」，所以这里逐字段断言。
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
		URL,
		require: buildRequire(dirname(filePath), overrides),
	};
	moduleCache.set(filePath, sandbox.exports);
	vm.runInNewContext(transpile(source), sandbox, { filename: filePath });
	return sandbox.exports;
}

const { applyDesktopProxy, buildDesktopProxyConfig } = loadTs("src/main/settings/DesktopProxy.ts");

test("buildDesktopProxyConfig: disabled returns direct", () => {
	const cfg = buildDesktopProxyConfig({
		desktopProxyEnabled: false,
		desktopProxyUrl: "http://127.0.0.1:7890",
		desktopProxyBypass: "localhost",
	});
	assert.equal(cfg.mode, "direct");
	assert.equal("proxyRules" in cfg, false);
});

test("buildDesktopProxyConfig: enabled with empty url returns direct", () => {
	const cfg = buildDesktopProxyConfig({
		desktopProxyEnabled: true,
		desktopProxyUrl: "   ",
		desktopProxyBypass: "",
	});
	assert.equal(cfg.mode, "direct");
});

test("buildDesktopProxyConfig: enabled with invalid url returns direct", () => {
	const cfg = buildDesktopProxyConfig({
		desktopProxyEnabled: true,
		desktopProxyUrl: "not a url at all",
		desktopProxyBypass: "",
	});
	assert.equal(cfg.mode, "direct");
});

test("buildDesktopProxyConfig: enabled with bare host:port adds http and strips trailing slash", () => {
	const cfg = buildDesktopProxyConfig({
		desktopProxyEnabled: true,
		desktopProxyUrl: "127.0.0.1:7890",
		desktopProxyBypass: "",
	});
	assert.equal(cfg.mode, "fixed_servers");
	assert.equal(cfg.proxyRules, "http://127.0.0.1:7890");
});

test("buildDesktopProxyConfig: enabled with full url keeps scheme", () => {
	const cfg = buildDesktopProxyConfig({
		desktopProxyEnabled: true,
		desktopProxyUrl: "http://proxy:8080",
		desktopProxyBypass: "",
	});
	assert.equal(cfg.mode, "fixed_servers");
	assert.equal(cfg.proxyRules, "http://proxy:8080");
});

test("buildDesktopProxyConfig: bypass list is normalized to semicolon-joined, trimmed, empty-removed", () => {
	const cfg = buildDesktopProxyConfig({
		desktopProxyEnabled: true,
		desktopProxyUrl: "http://proxy:8080",
		desktopProxyBypass: "localhost, 127.0.0.1\n*.internal; example.com ;",
	});
	assert.equal(cfg.mode, "fixed_servers");
	assert.equal(cfg.proxyBypassRules, "localhost;127.0.0.1;*.internal;example.com");
});

test("applyDesktopProxy: success calls platformProxy.apply once with the config", async () => {
	const applied = [];
	const platformProxy = {
		apply: async (cfg) => {
			applied.push(cfg);
		},
	};
	await applyDesktopProxy(
		{
			desktopProxyEnabled: true,
			desktopProxyUrl: "127.0.0.1:7890",
			desktopProxyBypass: "",
		},
		platformProxy,
	);
	assert.equal(applied.length, 1);
	assert.equal(applied[0].mode, "fixed_servers");
	assert.equal(applied[0].proxyRules, "http://127.0.0.1:7890");
});

test("applyDesktopProxy: disabled applies direct", async () => {
	const applied = [];
	const platformProxy = {
		apply: async (cfg) => {
			applied.push(cfg);
		},
	};
	await applyDesktopProxy(
		{
			desktopProxyEnabled: false,
			desktopProxyUrl: "http://127.0.0.1:7890",
			desktopProxyBypass: "",
		},
		platformProxy,
	);
	assert.equal(applied.length, 1);
	assert.equal(applied[0].mode, "direct");
	assert.equal("proxyRules" in applied[0], false);
});

test("applyDesktopProxy: platformProxy.apply reject propagates (not swallowed, not fallback direct)", async () => {
	const applied = [];
	const boom = new Error("proxy apply failed");
	const platformProxy = {
		apply: async (cfg) => {
			applied.push(cfg);
			throw boom;
		},
	};
	await assert.rejects(
		() =>
			applyDesktopProxy(
				{
					desktopProxyEnabled: true,
					desktopProxyUrl: "127.0.0.1:7890",
					desktopProxyBypass: "",
				},
				platformProxy,
			),
		(err) => err === boom,
	);
	// 只 apply 了一次，没有静默回退成 direct
	assert.equal(applied.length, 1);
	assert.equal(applied[0].mode, "fixed_servers");
});
