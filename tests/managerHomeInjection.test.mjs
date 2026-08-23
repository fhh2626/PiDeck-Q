import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const require = createRequire(import.meta.url);

/**
 * 回归测试：Manager 的「构造时注入本地 home/configDir」在 configureWsl(null) 后必须保持。
 *
 * 背景：createBackend() 用 platform.paths.home 构造这些 Manager，
 * 但 startBackendStartupTasks() 在 WSL 未启用时会调用 configureWsl(null)。
 * 若 configureWsl(null) 重新读取 os.homedir()，注入的隔离 HOME 会丢失。
 *
 * 用一个明显不同于 os.homedir() 的自定义 home 注入，断言 configureWsl(null)
 * 后目录仍在注入值下。
 *
 * 路径说明：Windows 上 node:path.join 会给 posix 风格路径加反斜杠，
 * 所以断言前统一把分隔符归一化为 "/" 再比较。
 */

function transpile(filePath) {
	const source = readFileSync(filePath, "utf8");
	return ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
	}).outputText;
}

const norm = (p) => p.replace(/\\/g, "/");

// 模块缓存 + 相对 import 解析：把 .ts 相对路径解析成真实的 .ts 文件再转译
const moduleCache = new Map();
function buildRequire(rootFile, overrides) {
	const importerDir = dirname(rootFile);
	return (id) => {
		// 1) 显式 override（sql.js 等原生/重依赖）
		for (const key of Object.keys(overrides)) {
			if (id.includes(key)) return overrides[key];
		}
		// 2) 相对路径：解析到真实 .ts 文件
		if (id.startsWith("./") || id.startsWith("../")) {
			let base = resolve(importerDir, id);
			if (existsSync(`${base}.ts`)) base = `${base}.ts`;
			else if (existsSync(join(base, "index.ts"))) base = join(base, "index.ts");
			else if (existsSync(base)) base = base;
			else if (existsSync(`${base}.js`)) base = `${base}.js`;
			return loadTs(base, overrides);
		}
		// 3) node: 内置 / npm 包：用宿主 require
		return require(id);
	};
}

function loadTs(filePath, overrides = {}) {
	if (moduleCache.has(filePath)) return moduleCache.get(filePath);
	const source = readFileSync(filePath, "utf8");
	const outputText = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
	}).outputText;
	const sandbox = {
		clearTimeout,
		setTimeout,
		process,
		exports: {},
		require: buildRequire(filePath, overrides),
	};
	// 占位避免循环依赖时读到空
	moduleCache.set(filePath, sandbox.exports);
	vm.runInNewContext(outputText, sandbox, { filename: filePath });
	return sandbox.exports;
}

const CUSTOM_HOME = "/custom/injected/home";
const CUSTOM_CONFIG_DIR = "/custom/injected/config";
const WSL_ENV = {
	distro: "Ubuntu",
	user: "u",
	linuxHome: "/home/u",
	windowsHome: "/c/WSL/Ubuntu",
};

test("PromptManager keeps injected home across configureWsl(null)", () => {
	const { PromptManager } = loadTs("src/main/prompts/PromptManager.ts");
	const pm = new PromptManager(CUSTOM_HOME);
	assert.equal(norm(pm.getDir()), norm(join(CUSTOM_HOME, ".pi", "agent", "prompts")));

	pm.configureWsl(WSL_ENV);
	assert.ok(
		norm(pm.getDir()).startsWith(norm(WSL_ENV.windowsHome)),
		`WSL dir should be under windowsHome, got ${pm.getDir()}`,
	);

	pm.configureWsl(null);
	assert.equal(norm(pm.getDir()), norm(join(CUSTOM_HOME, ".pi", "agent", "prompts")));
	assert.notEqual(norm(pm.getDir()), norm(join(homedir(), ".pi", "agent", "prompts")));
});

test("SkillManager keeps injected home across configureWsl(null)", () => {
	const { SkillManager } = loadTs("src/main/skills/SkillManager.ts");
	const sm = new SkillManager(CUSTOM_HOME);
	const localGlobal = norm(join(CUSTOM_HOME, ".pi", "agent", "skills"));
	assert.ok(sm.getDirs().some((d) => norm(d) === localGlobal));

	sm.configureWsl(WSL_ENV);
	const wslGlobal = norm(join(WSL_ENV.windowsHome, ".pi", "agent", "skills"));
	assert.ok(sm.getDirs().some((d) => norm(d) === wslGlobal));

	sm.configureWsl(null);
	assert.ok(
		sm.getDirs().some((d) => norm(d) === localGlobal),
		`expected skill dir under injected home, got ${JSON.stringify(sm.getDirs())}`,
	);
});

test("ConfigManager keeps injected configDir across configureWsl(null)", () => {
	const { ConfigManager } = loadTs("src/main/config/ConfigManager.ts");
	const cm = new ConfigManager(CUSTOM_CONFIG_DIR);
	assert.equal(norm(cm.getDir()), norm(CUSTOM_CONFIG_DIR));

	cm.configureWsl(WSL_ENV);
	assert.equal(norm(cm.getDir()), norm(join(WSL_ENV.windowsHome, ".pi", "agent")));

	cm.configureWsl(null);
	assert.equal(norm(cm.getDir()), norm(CUSTOM_CONFIG_DIR));
	assert.notEqual(norm(cm.getDir()), norm(join(homedir(), ".pi", "agent")));
});

test("XuePromptManager forwards configureWsl to inner PromptManager (no any)", () => {
	const stubs = {
		"sql.js": {
			__esModule: true,
			default: function initSqlJs() {
				return Promise.resolve({ Database: function () {} });
			},
		},
	};
	const { XuePromptManager } = loadTs("src/main/prompts/XuePromptManager.ts", stubs);
	const xpm = new XuePromptManager(CUSTOM_HOME, "/tmp/xue.db");
	const inner = xpm.promptManager;
	assert.ok(inner, "XuePromptManager should wrap a PromptManager");

	// 必须通过 XuePromptManager 的公开入口驱动；直接调用 inner.configureWsl
	// 会让转发实现即使退回「永远传 null」也照样绿，属于假覆盖。
	xpm.configureWsl(WSL_ENV);
	assert.ok(norm(inner.getDir()).startsWith(norm(WSL_ENV.windowsHome)));
	xpm.configureWsl(null);
	assert.equal(norm(inner.getDir()), norm(join(CUSTOM_HOME, ".pi", "agent", "prompts")));
});
