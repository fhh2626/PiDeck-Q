import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";
import { createAgentManagerHarness } from "./helpers/l2_agentManagerHarness.mjs";
import { createSnapshotDir, loadGate, makeLevel } from "./helpers/l2_securityGateHarness.mjs";
import { loadPiProcess } from "./helpers/loadPiProcess.mjs";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { createSecurityStoreFixture, deferred } from "./helpers/securityStoreFixture.mjs";

const require = createRequire(import.meta.url);

/**
 * 安全门集成契约测试（行为版）：
 * - 内置扩展清单包含安全门（否则 -e 注入会缺失）
 * - 扩展自包含：真正执行扩展模块，记录它 require 了什么
 * - PiProcess 注入的环境变量能被扩展读到并产生拦截（主进程 → 扩展 端到端）
 * - SecurityStore 真实写出的快照能被扩展消费（schema 契约）
 * - AgentManager 以 catalog 会话身份而不是 sessionPath 作为 PIDECK_SESSION_ID
 */

function loadBuiltInExtensionsModule() {
	const source = readFileSync("src/main/extensions/builtInExtensions.ts", "utf8");
	const { outputText } = ts.transpileModule(source, {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
	});
	const sandbox = { exports: {}, require, console };
	vm.runInNewContext(outputText, sandbox, { filename: "builtInExtensions.ts" });
	return sandbox.exports;
}

/** 启动一个假 PiProcess 并返回 spawn 时交给子进程的 env（非 WSL 路径）。 */
async function spawnEnvFor(processOptions) {
	const spawnCalls = [];
	const { PiProcess } = loadPiProcess(spawnCalls);
	const nativeLocator = {
		resolveCommand: () => "pi",
		createInvocation: (_command, args) => ({ command: "pi", args, shell: false }),
		createProcessEnv: () => ({}),
	};
	const piProc = new PiProcess(process.cwd(), undefined, nativeLocator, processOptions);
	await piProc.start();
	return spawnCalls[0].options.env;
}

test("BUILT_IN_EXTENSIONS includes pi-deck-security-gate.ts", () => {
	const { BUILT_IN_EXTENSIONS, isBuiltInExtensionName } = loadBuiltInExtensionsModule();
	assert.ok(BUILT_IN_EXTENSIONS.includes("pi-deck-security-gate.ts"));
	assert.ok(isBuiltInExtensionName("pi-deck-security-gate.ts"));
	assert.ok(!isBuiltInExtensionName("../pi-deck-security-gate.ts"));
});

test("security gate extension is self-contained: executing it only requires @earendil-works and node builtins", async () => {
	// 扩展被 pi 单独加载，不能依赖 PiDeck 源码。真正执行模块并记录 require，
	// 比正则扫描 import 语句更准确（不会被注释/字符串误伤，也覆盖 require() 写法）。
	const source = readFileSync("resources/extensions/pi-deck-security-gate.ts", "utf8");
	const { outputText } = ts.transpileModule(source, {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
	});
	const requested = [];
	const sandbox = {
		exports: {},
		require: (id) => {
			requested.push(id);
			if (id.startsWith("node:")) return require(id);
			throw new Error(`不允许的扩展依赖: ${id}`);
		},
		console,
		process,
	};
	vm.runInNewContext(outputText, sandbox, { filename: "pi-deck-security-gate.ts" });
	const handlers = new Map();
	await sandbox.exports.default({ on: (event, handler) => handlers.set(event, handler) });
	assert.ok(handlers.has("tool_call"), "扩展必须注册 tool_call 拦截");
	for (const id of requested) {
		assert.ok(
			id.startsWith("@earendil-works/") || id.startsWith("node:"),
			`不允许的扩展依赖: ${id}`,
		);
	}
});

test("PiProcess injects the env pair the extension reads, so a session override blocks the write", async () => {
	// 端到端：snapshot 里 sid-strict 会话被覆盖为严格等级（workspace 边界），
	// 全局默认等级不限制路径。只有 PIDECK_SECURITY_CONFIG 与 PIDECK_SESSION_ID 两个变量名
	// 在主进程注入侧与扩展读取侧一致，才会出现「strict 会话被拦、其他会话放行」。
	const tmp = createSnapshotDir();
	try {
		const snapshotPath = tmp.writeSnapshot({
			schemaVersion: 1,
			enabled: true,
			defaultLevelId: "open",
			levels: [
				makeLevel("open"),
				makeLevel("strict", { pathPolicy: "workspace", defaultAction: "deny" }),
			],
			sessionLevels: { "sid-strict": "strict" },
		});
		const workspace = join(tmp.dir, "workspace");
		const outside = join(tmp.dir, "outside", "a.txt");
		const event = { toolName: "write", input: { path: outside, content: "x" } };
		const ctx = { cwd: workspace, hasUI: false };

		const strictEnv = await spawnEnvFor({ securitySnapshotPath: snapshotPath, securitySessionId: "sid-strict" });
		assert.equal(strictEnv.PIDECK_SECURITY_CONFIG, snapshotPath);
		assert.equal(strictEnv.PIDECK_SESSION_ID, "sid-strict");
		const strictGate = await loadGate(strictEnv);
		assert.ok((await strictGate.toolCall(event, ctx))?.block, "被覆盖为 strict 的会话必须拦截目录外写入");

		const otherEnv = await spawnEnvFor({ securitySnapshotPath: snapshotPath, securitySessionId: "sid-other" });
		const otherGate = await loadGate(otherEnv);
		assert.equal(await otherGate.toolCall(event, ctx), undefined, "未覆盖的会话回落全局默认等级，放行");
	} finally {
		tmp.cleanup();
	}
});

test("PiProcess without security options injects neither security env var", async () => {
	const env = await spawnEnvFor({});
	assert.equal(env.PIDECK_SECURITY_CONFIG, undefined);
	assert.equal(env.PIDECK_SESSION_ID, undefined);
});

test("shared SECURITY_ENV_* constants name the env vars PiProcess actually injects", async () => {
	const { SECURITY_ENV_CONFIG_PATH, SECURITY_ENV_SESSION_ID } = loadTsCommonJs("src/shared/types/security.ts");
	const env = await spawnEnvFor({ securitySnapshotPath: "/snap.json", securitySessionId: "sid" });
	assert.equal(env[SECURITY_ENV_CONFIG_PATH], "/snap.json");
	assert.equal(env[SECURITY_ENV_SESSION_ID], "sid");
});

test("AgentManager.create uses the catalog deckSessionId as PIDECK_SESSION_ID, not sessionPath", async (t) => {
	// 回归：SecurityLevelMenu 用 SessionRecord.id（UUID）保存会话级覆盖，
	// 主进程注入的 key 必须是同一个，否则扩展按 sessionLevels[sessionId] 永远查不到覆盖。
	const h = createAgentManagerHarness();
	t.after(() => h.manager.stopAll());
	await h.manager.create({ projectId: h.project.id, sessionPath: h.sessionPath, deckSessionId: "catalog-uuid" });
	assert.equal(h.processes.length, 1);
	assert.equal(h.processes[0].options.securitySessionId, "catalog-uuid");
	assert.notEqual(h.processes[0].options.securitySessionId, h.sessionPath);
});

test("AgentManager.create falls back to sessionPath when no catalog identity exists", async (t) => {
	const h = createAgentManagerHarness();
	t.after(() => h.manager.stopAll());
	await h.manager.create({ projectId: h.project.id, sessionPath: h.sessionPath });
	assert.equal(h.processes[0].options.securitySessionId, h.sessionPath);
});

test("AgentManager.restart keeps the catalog deckSessionId for the new process", async (t) => {
	const h = createAgentManagerHarness();
	t.after(() => h.manager.stopAll());
	const tab = await h.manager.create({ projectId: h.project.id, sessionPath: h.sessionPath, deckSessionId: "catalog-uuid" });
	await h.manager.restart(tab.id);
	assert.equal(h.processes.length, 2, "restart must spawn a fresh process");
	assert.equal(h.processes[1].options.securitySessionId, "catalog-uuid");
});

test("AgentManager passes the snapshot path to PiProcess only after the snapshot has been written", async (t) => {
	// 用挂起的快照写入证明顺序：写入未完成前不得构造 PiProcess（扩展一启动就会读快照），
	// 放行之后才构造，且带上 store 的快照路径。
	const gate = deferred();
	const h = createAgentManagerHarness({ security: { writeSnapshot: () => gate.promise } });
	t.after(() => h.manager.stopAll());

	const creating = h.manager.create({ projectId: h.project.id, sessionPath: h.sessionPath, deckSessionId: "catalog-uuid" });
	for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
	assert.equal(h.snapshots.length, 1, "the snapshot write has started");
	assert.equal(h.processes.length, 0, "spawn 必须等快照落盘，否则扩展读到旧/缺失快照");

	gate.resolve();
	await creating;
	assert.equal(h.processes.length, 1);
	assert.equal(h.processes[0].options.securitySnapshotPath, h.store.getSnapshotPath());
});

test("snapshot written by SecurityStore is consumed by the extension (schema contract)", async () => {
	// 契约：主进程写入的字段必须被扩展读取。扩展无法 import 主进程模块，
	// 所以用主进程真实产出的快照驱动扩展，任一侧改名/漏同步都会让断言失败。
	const fixture = createSecurityStoreFixture();
	await fixture.store.updateConfig({ enabled: true, defaultLevelId: "standard" });
	await fixture.store.setSessionLevel("sid-strict", "strict");
	await fixture.store.ensureSnapshotWritten();
	const snapshot = fixture.snapshots.at(-1);
	assert.equal(snapshot.schemaVersion, 1);

	const tmp = createSnapshotDir();
	try {
		const snapshotPath = tmp.writeSnapshot(snapshot);
		const workspace = join(tmp.dir, "workspace");
		const ctx = { cwd: workspace, hasUI: false };
		const outsideWrite = { toolName: "write", input: { path: join(tmp.dir, "outside", "a.txt"), content: "x" } };
		const envWrite = { toolName: "write", input: { path: join(workspace, ".env"), content: "S=1" } };

		// defaultLevelId + levels：standard 目录不限制，但敏感文件受保护
		const standardGate = await loadGate({ PIDECK_SECURITY_CONFIG: snapshotPath, PIDECK_SESSION_ID: "sid-plain" });
		assert.equal(await standardGate.toolCall(outsideWrite, ctx), undefined);
		assert.ok((await standardGate.toolCall(envWrite, ctx))?.block);

		// sessionLevels：strict 收紧到工作目录
		const strictGate = await loadGate({ PIDECK_SECURITY_CONFIG: snapshotPath, PIDECK_SESSION_ID: "sid-strict" });
		assert.ok((await strictGate.toolCall(outsideWrite, ctx))?.block);

		// enabled=false：同一份结构，扩展必须完全放行
		const disabledPath = tmp.writeSnapshot({ ...snapshot, enabled: false }, "disabled.json");
		const disabledGate = await loadGate({ PIDECK_SECURITY_CONFIG: disabledPath, PIDECK_SESSION_ID: "sid-strict" });
		assert.equal(await disabledGate.toolCall(outsideWrite, ctx), undefined);
		assert.equal(await disabledGate.toolCall(envWrite, ctx), undefined);
	} finally {
		tmp.cleanup();
	}
});

test("extension rejects a snapshot whose schemaVersion differs from the one the main process writes", async () => {
	const fixture = createSecurityStoreFixture();
	await fixture.store.updateConfig({ enabled: true });
	await fixture.store.ensureSnapshotWritten();
	const tmp = createSnapshotDir();
	try {
		const snapshotPath = tmp.writeSnapshot({ ...fixture.snapshots.at(-1), schemaVersion: 2 });
		const gate = await loadGate({ PIDECK_SECURITY_CONFIG: snapshotPath, PIDECK_SESSION_ID: "s" });
		const result = await gate.toolCall({ toolName: "bash", input: { command: "echo" } }, { cwd: tmp.dir, hasUI: false });
		assert.equal(result?.block, true);
		assert.match(result.reason, /SECURITY_POLICY_UNAVAILABLE/);
	} finally {
		tmp.cleanup();
	}
});

test("extension reads the tool_call input fields PiDeck tools emit (path / filePath / command)", async () => {
	// read/grep/find/ls 用 path；write/edit 用 filePath（兼容 path）；bash 用 command。
	const tmp = createSnapshotDir();
	try {
		const snapshotPath = tmp.writeSnapshot({
			schemaVersion: 1,
			enabled: true,
			defaultLevelId: "ws",
			levels: [
				makeLevel("ws", {
					pathPolicy: "workspace",
					defaultAction: "deny",
					toolActions: { read: "allow", grep: "allow", find: "allow", ls: "allow", write: "allow", edit: "allow" },
				}),
				// bash=ask + 兜底 deny：命中危险模式 → deny；未命中 → ask（用户在 UI 里允许）。
				makeLevel("shell", { denyBashPatterns: ["\\bforbidden-cmd\\b"], defaultAction: "deny", toolActions: { bash: "ask" } }),
			],
			sessionLevels: { "s-shell": "shell" },
		});
		const gate = await loadGate({ PIDECK_SECURITY_CONFIG: snapshotPath, PIDECK_SESSION_ID: "s" });
		const shellGate = await loadGate({ PIDECK_SECURITY_CONFIG: snapshotPath, PIDECK_SESSION_ID: "s-shell" });
		const workspace = join(tmp.dir, "workspace");
		const outside = join(tmp.dir, "outside", "x.txt");
		const inside = join(workspace, "x.txt");
		const ctx = { cwd: workspace, hasUI: false };

		for (const toolName of ["read", "grep", "find", "ls"]) {
			assert.ok((await gate.toolCall({ toolName, input: { path: outside } }, ctx))?.block, `${toolName}(path) outside must be blocked`);
			assert.equal(await gate.toolCall({ toolName, input: { path: inside } }, ctx), undefined, `${toolName}(path) inside must pass`);
		}
		for (const toolName of ["write", "edit"]) {
			assert.ok((await gate.toolCall({ toolName, input: { filePath: outside } }, ctx))?.block, `${toolName}(filePath) outside must be blocked`);
			assert.equal(await gate.toolCall({ toolName, input: { filePath: inside } }, ctx), undefined, `${toolName}(filePath) inside must pass`);
		}
		const approvingCtx = { cwd: workspace, hasUI: true, ui: { select: async () => "允许执行" } };
		assert.ok((await shellGate.toolCall({ toolName: "bash", input: { command: "forbidden-cmd --now" } }, approvingCtx))?.block, "危险命令不经确认直接拒绝");
		assert.equal(await shellGate.toolCall({ toolName: "bash", input: { command: "harmless" } }, approvingCtx), undefined, "未命中模式的命令走确认并放行");
	} finally {
		tmp.cleanup();
	}
});

test("desktopApi.security routes its three methods to the security IPC channels", async () => {
	// 通道名既是 shared/ipc.ts 的常量，也是主进程 handler 的注册 key；用真实工厂 + 记录型 transport 验证线上实际发出的通道与参数。
	const { createPiDesktopApi } = loadTsCommonJs("src/shared/desktop/createPiDesktopApi.ts");
	const calls = [];
	const transport = {
		invoke: async (channel, ...args) => { calls.push({ channel, args }); return undefined; },
		subscribe: () => () => undefined,
	};
	const syncHost = {
		readClipboardText: () => "", readClipboardHtml: () => "", readClipboardImage: () => "",
		getPathForFile: () => "", getClipboardPaths: () => [],
	};
	const api = createPiDesktopApi(transport, syncHost);
	await api.security.getConfig();
	await api.security.updateConfig({ enabled: true });
	await api.security.setSessionLevel("sid", "strict");
	assert.deepEqual(calls, [
		{ channel: "security:get-config", args: [] },
		{ channel: "security:update-config", args: [{ enabled: true }] },
		{ channel: "security:set-session-level", args: ["sid", "strict"] },
	]);
});

test("default security config stays zero-intervention (enabled=false, standard level, snapshot schema 1)", () => {
	const { createDefaultSecurityConfig } = loadTsCommonJs("src/shared/types/security.ts");
	const { buildSnapshot } = loadTsCommonJs("src/main/security/policy.ts");
	const config = createDefaultSecurityConfig();
	assert.equal(config.enabled, false);
	assert.equal(config.defaultLevelId, "standard");
	assert.ok(config.levels.some((level) => level.id === "standard"));
	const snapshot = buildSnapshot(config);
	assert.equal(snapshot.schemaVersion, 1);
	assert.equal(snapshot.enabled, false);
});
