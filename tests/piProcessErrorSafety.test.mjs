import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { PassThrough } from "node:stream";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";
import { createFakePiManager, loadAgentManagerWithFakePi } from "./helpers/l4_agentManagerHarness.mjs";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const require = createRequire(import.meta.url);

function transpile(filePath) {
	return ts.transpileModule(readFileSync(filePath, "utf8"), {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
	}).outputText;
}

function createChildProcess() {
	const child = new EventEmitter();
	child.stdin = new PassThrough();
	child.stdout = new PassThrough();
	child.stderr = new PassThrough();
	child.kill = () => true;
	return child;
}

function loadPiProcess(spawnImpl) {
	// vm 沙箱内加载 transpile 后的 CommonJS 源码模块；
	// 新增拆分出的内部依赖时需要在此同步登记，否则 require 会落到真实文件系统解析失败。
	const loadSandboxed = (filePath, name) => {
		const sandbox = { exports: {}, require };
		vm.runInNewContext(transpile(filePath), sandbox, { filename: name });
		return sandbox.exports;
	};
	const paths = loadSandboxed("src/main/wsl/WslPaths.ts", "WslPaths.ts");
	const extensionFilter = loadSandboxed("src/main/pi/piExtensionFilter.ts", "piExtensionFilter.ts");
	const compatibility = loadSandboxed("src/shared/piCompatibility.ts", "piCompatibility.ts");
	const wslEnvNames = loadSandboxed("src/main/pi/wslEnvNames.ts", "wslEnvNames.ts");
	const terminate = loadSandboxed("src/main/process/terminateChildProcess.ts", "terminateChildProcess.ts");

	class FakeRpcClient extends EventEmitter {
		close() {}
	}
	class FakePiLocator {}

	const sandbox = {
		Buffer,
		console: { log() {}, warn() {}, error() {} },
		exports: {},
		process,
		require: (id) => {
			if (id === "node:child_process") {
				return {
					execFile: (_command, _args, _options, callback) => {
						callback(null, "0.81.1\n", "");
						return new EventEmitter();
					},
					spawn: spawnImpl,
				};
			}
			if (id === "./PiRpcClient") return { PiRpcClient: FakeRpcClient };
			if (id === "./PiLocator") return { PiLocator: FakePiLocator };
			if (id === "../../shared/piCompatibility") return compatibility;
			if (id === "../wsl/WslPaths") return paths;
			if (id === "./piExtensionFilter") return extensionFilter;
			if (id === "./wslEnvNames") return wslEnvNames;
			if (id === "../process/terminateChildProcess") return terminate;
			// 25fd516 起 PiProcess 引入内置扩展参数拼接；本测试只关心 spawn 错误转发，
			// mock 为原样透传，避免 vm sandbox 的 require 按 tests/ 相对路径误解析。
			if (id === "../extensions/builtInExtensions") {
				return { appendBuiltInExtensionArgs: (args) => [...args] };
			}
			// 日志共享实例未注册时返回 null，PiProcess 埋点静默跳过；
			// 这里 mock 掉 sharedLogger，避免沙箱 require 按 tests/ 相对路径误解析。
			if (id === "../logging/sharedLogger") {
				return { getAppLogger: () => null };
			}
			return require(id);
		},
	};
	vm.runInNewContext(transpile("src/main/pi/PiProcess.ts"), sandbox, {
		filename: "PiProcess.ts",
	});
	return sandbox.exports;
}

function createLocator(command = "/opt/homebrew/bin/pi") {
	return {
		resolveCommand: () => command,
		createInvocation: (_command, args) => ({
			command,
			args: [...args],
			shell: false,
		}),
		createProcessEnv: () => ({}),
	};
}

test("PiProcess keeps a default error sink so spawn ENOENT does not become uncaught", async () => {
	const child = createChildProcess();
	const { PiProcess } = loadPiProcess(() => child);
	const pi = new PiProcess("/tmp/project", {}, createLocator("/missing/pi"));

	// 关键：没有业务 listener 时，异步 error 也不应变成 uncaughtException。
	await pi.start();

	let uncaught = null;
	const onUncaught = (error) => {
		uncaught = error;
	};
	process.once("uncaughtException", onUncaught);
	child.emit("error", Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }));
	// 给 EventEmitter 一个 tick 升级 uncaught 的机会
	await new Promise((resolve) => setImmediate(resolve));
	process.off("uncaughtException", onUncaught);

	assert.equal(uncaught, null);
	assert.equal(pi.getDiagnostics()?.exitCode, -1);
	assert.match(pi.getDiagnostics()?.stderr.join("") ?? "", /ENOENT/);
});

test("PiProcess forwards spawn error to business listeners after start returns", async () => {
	const child = createChildProcess();
	const { PiProcess } = loadPiProcess(() => child);
	const pi = new PiProcess("/tmp/project", {}, createLocator("/missing/pi"));
	await pi.start();

	const seen = [];
	pi.on("error", (error) => seen.push(error.message));
	child.emit("error", Object.assign(new Error("spawn EACCES"), { code: "EACCES" }));
	await new Promise((resolve) => setImmediate(resolve));

	assert.deepEqual(seen, ["spawn EACCES"]);
});

test("AgentManager attaches lifecycle listeners before process.start", async () => {
	// 顺序契约：spawn 的 error 事件是异步的，start() 之前必须已有 listener，
	// 否则 0 listener 的 EventEmitter 会把 ENOENT 升级成未捕获异常。
	const harness = loadAgentManagerWithFakePi();
	const manager = createFakePiManager(harness);
	await manager.create({ projectId: "p1" });
	const startAt = harness.log.indexOf("start");
	assert.ok(startAt >= 0, "create() 必须调用 PiProcess.start()");
	for (const event of ["event", "stderr", "protocol-error", "error", "exit"]) {
		const attachedAt = harness.log.indexOf(`on:${event}`);
		assert.ok(attachedAt >= 0 && attachedAt < startAt, `${event} listener 必须在 start() 之前挂上`);
	}
});

test("AgentManager reports a start() failure as an in-session error message instead of throwing", async () => {
	// start 同步失败（非法 cwd / spawn 抛错）要落到会话错误卡，且消息带原始错误文本。
	const harness = loadAgentManagerWithFakePi({
		startImpl: () => {
			throw new Error("spawn ENOENT /missing/pi");
		},
	});
	const manager = createFakePiManager(harness);
	const tab = await manager.create({ projectId: "p1" });
	const errors = (manager.messages.get(tab.id) ?? []).filter((message) => message.role === "error");
	assert.equal(errors.length, 1);
	assert.match(errors[0].text, /spawn ENOENT \/missing\/pi/);
	assert.equal(tab.status, "error");
});

/** 伪造宿主平台与空 PATH，使搜索目录只来自 PiLocator 自身的平台分支。 */
function searchDirsFor(platform) {
	const fakeProcess = Object.create(process, {
		platform: { value: platform },
		env: { value: { PATH: "" } },
	});
	const { PiLocator } = loadTsCommonJs("src/main/pi/PiLocator.ts", { globals: { process: fakeProcess } });
	return new PiLocator(undefined, "/Users/tester").getSearchDirs();
}

test("macOS search dirs include Homebrew prefixes for Dock-launched PATH gaps", () => {
	const dirs = searchDirsFor("darwin");
	assert.ok(dirs.includes("/opt/homebrew/bin"), "Apple Silicon Homebrew");
	assert.ok(dirs.includes("/usr/local/bin"), "Intel Homebrew");
});

test("non-macOS hosts do not search the Homebrew prefix", () => {
	assert.ok(!searchDirsFor("win32").includes("/opt/homebrew/bin"));
	assert.ok(!searchDirsFor("linux").includes("/opt/homebrew/bin"));
});