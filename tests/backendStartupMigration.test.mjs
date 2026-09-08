import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

const require = createRequire(import.meta.url);

/**
 * 启动任务编排层的行为测试（真实临时目录 + 替身服务）。
 *
 * 覆盖两个回归点：
 * 1. 旧同名入口 `change-pi-prompt.ts` 只按指纹备份迁移，不再无条件 rm；
 * 2. WSL 路径必须来自 resolveWslEnvironment().windowsHome，而不是手拼
 *    `\\wsl$\<distro>\home\<user>`（root / 自定义 home 都会静默走错目录）。
 *
 * 收敛方式：`startBackendStartupTasks` 是 fire-and-forget，测试用真实
 * StartupBarrier 作为唯一同步点 —— 迁移任务被登记进屏障，wait() 返回即完成。
 */

const moduleCache = new Map();
let profileCounter = 0;

/**
 * 每个测试一套独立模块子图（profile）：backendStartupTasks 内部用 `await import`
 * 取 WslEnvironment，替身按测试注入；若共用模块缓存，第一个测试加载的真实模块
 * 会被后面所有测试复用，替身失效。
 */
function newProfile() {
	return `p${profileCounter++}`;
}

function loadTs(filePath, overrides, profile) {
	const cacheKey = `${profile}::${filePath}`;
	if (moduleCache.has(cacheKey)) return moduleCache.get(cacheKey);
	const outputText = ts.transpileModule(readFileSync(filePath, "utf8"), {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
	}).outputText;
	const sandbox = {
		clearTimeout,
		setTimeout,
		setImmediate,
		console,
		process,
		exports: {},
		require: buildRequire(filePath, overrides, profile),
	};
	// 占位避免循环依赖时读到空
	moduleCache.set(cacheKey, sandbox.exports);
	vm.runInNewContext(outputText, sandbox, { filename: filePath });
	return sandbox.exports;
}

function buildRequire(rootFile, overrides, profile) {
	const importerDir = dirname(rootFile);
	return (id) => {
		// 显式替身优先（按裸模块名精确匹配，避免误伤兄弟模块）
		for (const [key, value] of overrides) {
			if (id === key || id.endsWith(`/${key}`)) return value;
		}
		if (id.startsWith("./") || id.startsWith("../")) {
			let base = resolve(importerDir, id);
			if (existsSync(`${base}.ts`)) base = `${base}.ts`;
			else if (existsSync(join(base, "index.ts"))) base = join(base, "index.ts");
			else if (existsSync(`${base}.js`)) base = `${base}.js`;
			return loadTs(base, overrides, profile);
		}
		return require(id);
	};
}

const loadStartupTasks = (overrides, profile) =>
	loadTs(resolve("src/main/backend/backendStartupTasks.ts"), overrides, profile);
const loadBarrier = (profile) =>
	loadTs(resolve("src/main/utils/StartupBarrier.ts"), new Map(), profile);

/** 命中 self-use-shim 指纹的入口形态（与本机实际存留文件同构）。 */
const RECOGNIZED_SHIM = [
	"/**",
	" * Pi prompt replacement extension.",
	" */",
	"import { registerPromptExtension } from './change-pi-prompt/runtime.ts';",
	"export default (pi) => registerPromptExtension(pi);",
	"",
].join("\n");

/** 用户自有同名文件：迁移必须原样保留。 */
const USER_FILE = "export default (pi) => pi.on('session_start', () => {});\n";

const stubSettings = (settings) => ({
	get: () => settings,
	update: async (patch) => Object.assign(settings, patch),
	ensureRpcTimeoutMinimum: async () => undefined,
});

/** 替身服务集合；wslCalls 记录各模块收到的 configureWsl 参数。 */
function makeStubServices(wslCalls) {
	const configureWsl = (env) => wslCalls.push(env);
	return {
		projectStore: { load: async () => undefined, list: () => [] },
		sessionScanner: { configureWsl: async (env) => configureWsl(env), clearWsl: () => configureWsl(null) },
		configManager: { configureWsl },
		promptManager: { configureWsl },
		xuePromptManager: { configureWsl },
		skillManager: { configureWsl },
		extensionManager: { configureWsl },
		webServiceManager: { applySettings: async () => undefined },
		appLogger: {
			entries: [],
			info(scope, message, detail) { this.entries.push({ level: "info", scope, message, detail }); },
			warn(scope, message, detail) { this.entries.push({ level: "warn", scope, message, detail }); },
			error(scope, message, detail) { this.entries.push({ level: "error", scope, message, detail }); },
		},
	};
}

async function makeHome() {
	const root = await mkdtemp(join(tmpdir(), "pideck-startup-"));
	const agentDir = join(root, ".pi", "agent");
	await mkdir(join(agentDir, "extensions"), { recursive: true });
	return { root, agentDir, entry: join(agentDir, "extensions", "change-pi-prompt.ts") };
}

async function runStartupTasks({ settings, homeRoot, wslEnv, piLocator = null, profile, barrier }) {
	const wslCalls = [];
	const overrides = new Map([
		// 外部编辑器探测会 spawn 进程，测试里整体替掉
		["../editors/EditorDetector", { detectExternalEditors: async () => [], mergeDetectedExternalEditors: (c) => c }],
	]);
	if (wslEnv) {
		// 替身接管 WSL 环境解析：真实实现要跑 wsl.exe。
		overrides.set("../wsl/WslEnvironment", { resolveWslEnvironment: async () => wslEnv });
	}
	const { startBackendStartupTasks } = loadStartupTasks(overrides, profile);
	const services = makeStubServices(wslCalls);
	startBackendStartupTasks({
		paths: { home: homeRoot, userData: homeRoot, appPath: homeRoot, resourcesPath: homeRoot },
		host: { sendToRenderer: () => undefined },
		appVersion: "0.2.1",
		startupBarrier: barrier,
		services: { ...services, piLocator, settingsStore: stubSettings(settings) },
	});
	return { services, wslCalls, settled: await barrier.wait(5_000) };
}

test("recognized legacy entry is backed up rather than deleted, even with WSL off", async () => {
	const profile = newProfile();
	const startup = loadBarrier(profile).createStartupBarrier();
	const home = await makeHome();
	await writeFile(home.entry, RECOGNIZED_SHIM, "utf8");

	const { services, wslCalls, settled } = await runStartupTasks({
		profile,
		barrier: startup,
		homeRoot: home.root,
		settings: { wslEnabled: false, externalEditors: {}, removedBuiltInExtensions: [] },
	});

	assert.equal(settled, true, "startup barrier must settle once migration finished");
	assert.ok(!existsSync(home.entry), "recognized shim must leave the auto-discovered dir");
	const backup = join(home.agentDir, "pideck-backups", "0.2.1", "change-pi-prompt.ts");
	assert.equal(await readFile(backup, "utf8"), RECOGNIZED_SHIM, "content must be preserved in backup");
	// 迁移要留痕：备份位置写进日志，用户才能事后找回文件
	assert.ok(
		services.appLogger.entries.some((e) => e.message === "Backed up legacy built-in extension entry"),
		"migration must log the backup location",
	);
	// WSL 未启用时其余模块仍按原约定收到 null
	assert.ok(wslCalls.length > 0);
	assert.ok(wslCalls.every((env) => env === null));
});

test("unknown same-name user file survives startup migration", async () => {
	const profile = newProfile();
	const startup = loadBarrier(profile).createStartupBarrier();
	const home = await makeHome();
	await writeFile(home.entry, USER_FILE, "utf8");

	const { services } = await runStartupTasks({
		profile,
		barrier: startup,
		homeRoot: home.root,
		settings: { wslEnabled: false, externalEditors: {}, removedBuiltInExtensions: [] },
	});

	assert.equal(await readFile(home.entry, "utf8"), USER_FILE, "user file must not be touched");
	assert.ok(
			services.appLogger.entries.some(
				(e) => e.level === "warn" && /not a PiDeck-authored file/.test(String(e.detail?.detail)),
			),
		"preserving an unknown file must be surfaced as a warning",
	);
});

test("PiDeck-owned built-in copies are still purged from the extensions dir", async () => {
	const profile = newProfile();
	const startup = loadBarrier(profile).createStartupBarrier();
	const home = await makeHome();
	const stale = join(home.agentDir, "extensions", "pideck-q-change-pi-prompt.ts");
	const renamed = join(home.agentDir, "extensions", "pi-better-compaction.ts");
	await writeFile(stale, "// old deploy copy\n", "utf8");
	await writeFile(renamed, "// old name copy\n", "utf8");

	await runStartupTasks({
		profile,
		barrier: startup,
		homeRoot: home.root,
		settings: { wslEnabled: false, externalEditors: {}, removedBuiltInExtensions: [] },
	});

	assert.ok(!existsSync(stale), "stale built-in copy must be removed (name is PiDeck-owned)");
	assert.ok(!existsSync(renamed), "renamed legacy entry must be removed (name is PiDeck-owned)");
});

test("WSL agent dir is migrated through windowsHome, not a hand-built home path", async () => {
	const profile = newProfile();
	const startup = loadBarrier(profile).createStartupBarrier();
	const home = await makeHome();
	// WSL 侧独立 temp root，模拟 UNC 映射下的 Linux home（含空格，最容易暴露拼路径 bug）
	const wslRoot = await mkdtemp(join(tmpdir(), "pideck-wslhome-"));
	const wslAgentDir = join(wslRoot, "srv", "dev home", ".pi", "agent");
	await mkdir(join(wslAgentDir, "extensions"), { recursive: true });
	const wslEntry = join(wslAgentDir, "extensions", "change-pi-prompt.ts");
	await writeFile(wslEntry, RECOGNIZED_SHIM, "utf8");
	await writeFile(home.entry, USER_FILE, "utf8");

	const { settled } = await runStartupTasks({
		profile,
		barrier: startup,
		homeRoot: home.root,
		settings: {
			wslEnabled: true,
			wslDistro: "Ubuntu-24.04",
			wslUser: "dev",
			externalEditors: {},
			removedBuiltInExtensions: [],
		},
		// 关键：windowsHome 指向 temp 下的自定义路径，与手拼的 \\wsl$\...\home\dev 完全不同
		wslEnv: {
			distro: "Ubuntu-24.04",
			user: "dev",
			linuxHome: "/srv/dev home",
			windowsHome: join(wslRoot, "srv", "dev home"),
		},
	});

	assert.equal(settled, true);
	assert.ok(!existsSync(wslEntry), "WSL agent dir must be migrated via resolved windowsHome");
	assert.equal(
		await readFile(join(wslAgentDir, "pideck-backups", "0.2.1", "change-pi-prompt.ts"), "utf8"),
		RECOGNIZED_SHIM,
	);
	// 本机那份是用户文件：WSL 迁移不得顺手把它删了
	assert.equal(await readFile(home.entry, "utf8"), USER_FILE);
});

test("pi settings defaults are ensured in every resolved agent dir", async () => {
	const profile = newProfile();
	const startup = loadBarrier(profile).createStartupBarrier();
	const home = await makeHome();
	const wslRoot = await mkdtemp(join(tmpdir(), "pideck-wslhome2-"));
	const wslAgentDir = join(wslRoot, "root", ".pi", "agent");
	await mkdir(join(wslAgentDir, "extensions"), { recursive: true });

	await runStartupTasks({
		profile,
		barrier: startup,
		homeRoot: home.root,
		settings: {
			wslEnabled: true,
			wslDistro: "Ubuntu",
			wslUser: "root",
			externalEditors: {},
			removedBuiltInExtensions: [],
		},
		// root 用户的 home 是 /root：手拼 /home/root 会指向一个不存在的路径
		wslEnv: { distro: "Ubuntu", user: "root", linuxHome: "/root", windowsHome: join(wslRoot, "root") },
	});

	const localSettings = JSON.parse(await readFile(join(home.agentDir, "settings.json"), "utf8"));
	const wslSettings = JSON.parse(await readFile(join(wslAgentDir, "settings.json"), "utf8"));
	assert.equal(localSettings.defaultProjectTrust, "ask");
	assert.equal(wslSettings.defaultProjectTrust, "ask");
	assert.equal(localSettings.compaction.enabled, true);
});

test("pi version hint is written to lastChangelogVersion when available", async () => {
	const profile = newProfile();
	const startup = loadBarrier(profile).createStartupBarrier();
	const home = await makeHome();
	const piLocator = {
		check: async () => ({ version: "0.84.4" }),
	};

	await runStartupTasks({
		profile,
		barrier: startup,
		homeRoot: home.root,
		piLocator,
		settings: { wslEnabled: false, externalEditors: {}, removedBuiltInExtensions: [] },
	});

	const written = JSON.parse(await readFile(join(home.agentDir, "settings.json"), "utf8"));
	assert.equal(written.lastChangelogVersion, "0.84.4");
});

test("startup does not block when WSL environment resolution throws", async () => {
	const profile = newProfile();
	const startup = loadBarrier(profile).createStartupBarrier();
	const home = await makeHome();
	await writeFile(home.entry, RECOGNIZED_SHIM, "utf8");

	const overrides = new Map([
		["../editors/EditorDetector", { detectExternalEditors: async () => [], mergeDetectedExternalEditors: (c) => c }],
		["../wsl/WslEnvironment", {
			resolveWslEnvironment: async () => {
				throw new Error("wsl.exe unavailable");
			},
		}],
	]);
	const { startBackendStartupTasks } = loadStartupTasks(overrides, profile);
	const wslCalls = [];
	const services = makeStubServices(wslCalls);
	startBackendStartupTasks({
		paths: { home: home.root, userData: home.root, appPath: home.root, resourcesPath: home.root },
		host: { sendToRenderer: () => undefined },
		appVersion: "0.2.1",
		startupBarrier: startup,
		services: {
			...services,
			piLocator: null,
			settingsStore: stubSettings({
				wslEnabled: true,
				wslDistro: "Ubuntu",
				wslUser: "dev",
				externalEditors: {},
				removedBuiltInExtensions: [],
			}),
		},
	});

	// WSL 挂了也必须放行：迁移退化到本机目录，屏障照常 settle
	assert.equal(await startup.wait(5_000), true);
	assert.ok(!existsSync(home.entry), "local migration must still run when WSL resolution throws");
});
