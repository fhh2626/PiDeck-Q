import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";
import { createSnapshotDir, loadGate, makeLevel } from "./helpers/l2_securityGateHarness.mjs";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const require = createRequire(import.meta.url);

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
