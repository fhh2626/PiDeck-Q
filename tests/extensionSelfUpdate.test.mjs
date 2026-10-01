import assert from "node:assert/strict";
import * as os from "node:os";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 扩展自更新（保留功能）的行为测试。
 *
 * 原来这层只有 noUpdateSystem.test.mjs 里的源码正则
 * （assert.match(ext, /updateExtensions\(/)），只能证明方法还在文件里，
 * 证不了它真的会调对 `pi update` 参数。这里改成驱动真实调用。
 *
 * 与「已移除的 Pi 自身更新」的分界：pi update --extensions / pi update <source>
 * 属于保留能力；checkPiUpdate / updatePi 已删除，不在本文件范围内。
 */
function loadExtensionManager({ execFileCalls, runPiOutput = "updated" }) {
	return loadTsCommonJs("src/main/extensions/ExtensionManager.ts", {
		stubs: {
			"node:os": { ...os, homedir: () => os.homedir() },
			"node:child_process": {
				execFile: (command, args, options, callback) => {
					execFileCalls.push({ command, args: Array.from(args) });
					queueMicrotask(() => callback(null, runPiOutput, ""));
				},
			},
			"../pi/PiLocator": {},
			"../fs/trash": { trashPath: async () => {} },
			"../logging/sharedLogger": { getAppLogger: () => null },
		},
	});
}

function createManager(ExtensionManager, execFileCalls, translate = (key) => key) {
	return new ExtensionManager(
		{
			// runPi 不真正探测不了版本时走 unknown 分支，不需要 --no-approve 探测
			check: async () => ({ installed: true, version: "0.80.0" }),
			createInvocation: (command, args) => ({ command, args, shell: false }),
			createProcessEnv: () => process.env,
			resolveCommand: () => "pi",
		},
		() => ({ piRuntimePreference: "typescript" }),
		() => ({}),
		async (patch) => patch,
		translate,
	);
}

test("updateExtensions runs pi update --extensions and reports the command", async () => {
	const execFileCalls = [];
	const { ExtensionManager } = loadExtensionManager({ execFileCalls, runPiOutput: "3 updated\n" });
	const manager = createManager(ExtensionManager, execFileCalls);

	const result = await manager.updateExtensions();

	// 参数必须是数组形式（AGENTS.md：禁止字符串插值拼 shell 命令）
	const updateCall = execFileCalls.find((call) => call.args.includes("update"));
	assert.ok(updateCall, `必须真的执行 pi update，实际调用：${JSON.stringify(execFileCalls)}`);
	assert.ok(updateCall.args.includes("--extensions"), "updateExtensions 必须带 --extensions");
	assert.ok(!String(updateCall.command).includes(" "), "命令不得是拼接的字符串");

	// 返回值形状：调用方（设置页）依赖 command/output/updated
	assert.equal(result.updated, true);
	assert.equal(result.output, "3 updated");
	assert.match(result.command, /extensions/);
});

test("updateExtension passes the exact extension source and invalidates the list cache", async () => {
	const execFileCalls = [];
	const { ExtensionManager } = loadExtensionManager({ execFileCalls, runPiOutput: "ok" });
	const manager = createManager(ExtensionManager, execFileCalls);

	// 先塞一个缓存，验证更新后会被清掉（否则 UI 会继续显示旧版本）
	manager.listCache = { extensions: [{ id: "stale" }], raw: "stale" };
	manager.listCacheGeneration = 7;

	const result = await manager.updateExtension("npm:context-mode");

	const updateCall = execFileCalls.find((call) => call.args.includes("update"));
	assert.ok(updateCall, `必须真的执行 pi update，实际调用：${JSON.stringify(execFileCalls)}`);
	assert.ok(updateCall.args.includes("npm:context-mode"), "必须原样传递扩展 source（与 pi list 输出一致）");
	assert.equal(result.updated, true);
	assert.equal(result.command, "pi update npm:context-mode");
	// 版本信息已变化，缓存必须失效且 generation 前进
	assert.equal(manager.listCache, null, "更新后必须清列表缓存");
	assert.equal(manager.listCacheGeneration, 8, "清缓存必须同时递增 generation");
});

test("a failing extension update rejects instead of silently succeeding, and keeps stderr in the log", async () => {
	const execFileCalls = [];
	const logged = [];
	const translatedKeys = [];
	const { ExtensionManager } = loadTsCommonJs("src/main/extensions/ExtensionManager.ts", {
		stubs: {
			"node:os": { ...os, homedir: () => os.homedir() },
			"node:child_process": {
				execFile: (command, args, options, callback) => {
					execFileCalls.push({ command, args: Array.from(args) });
					queueMicrotask(() => callback(Object.assign(new Error("exit 1"), { code: 1 }), "", "no such extension"));
				},
			},
			"../pi/PiLocator": {},
			"../fs/trash": { trashPath: async () => {} },
			"../logging/sharedLogger": { getAppLogger: () => null },
		},
		globals: {
			// 生产代码用 console.error 记录 args + stderr（stderr 面向上层的是 i18n 文案，原文只进日志）
			console: { ...console, error: (...args) => { logged.push(args); } },
		},
	});
	const manager = createManager(ExtensionManager, execFileCalls, (key) => {
		translatedKeys.push(key);
		return `translated:${key}`;
	});

	// 失败必须抛出：设置页依赖 reject 才能提示用户，静默成功会伪装成已更新。
	// 断言的是 i18n key（而非英文文案），这样改文案不会误伤测试。
	await assert.rejects(() => manager.updateExtension("npm:does-not-exist"), /translated:mainExtension\.commandFailed/);
	assert.ok(
		translatedKeys.includes("mainExtension.commandFailed"),
		`失败应用 mainExtension.commandFailed 文案，实际用了：${JSON.stringify(translatedKeys)}`,
	);

	// stderr 不得丢失：它是排查真实原因的唯一线索，必须进日志。
	const failureLog = logged.find((args) => args.some((a) => typeof a === "string" && a.includes("pi command failed")));
	assert.ok(failureLog, `必须记录 pi 命令失败日志，实际：${JSON.stringify(logged)}`);
	const payload = failureLog.find((a) => a && typeof a === "object" && "stderr" in a);
	assert.equal(payload?.stderr, "no such extension", "日志必须带上原始 stderr");
	// 日志里的 args 是最终参数（含 pi >= 0.79 才加的 --no-approve），便于复现问题
	const loggedArgs = Array.from(payload?.args ?? []);
	assert.equal(loggedArgs[0], "update", "日志必须带上真实子命令");
	assert.equal(loggedArgs[1], "npm:does-not-exist", "日志必须带上真实扩展 source");
	assert.equal(payload?.error, "exit 1", "日志必须带上退出错误");
});
