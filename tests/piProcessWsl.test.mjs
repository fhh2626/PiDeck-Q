import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { PassThrough } from "node:stream";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

const require = createRequire(import.meta.url);

function transpile(filePath) {
	return ts.transpileModule(readFileSync(filePath, "utf8"), {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
	}).outputText;
}

function loadWslPaths() {
	const sandbox = { exports: {}, require };
	vm.runInNewContext(transpile("src/main/wsl/WslPaths.ts"), sandbox, { filename: "WslPaths.ts" });
	return sandbox.exports;
}

// PiProcess 拆分出的扩展隔离模块；vm 沙箱不会自动解析相对模块，需与 WslPaths 一样显式登记。
function loadPiExtensionFilter() {
	const sandbox = { exports: {}, require };
	vm.runInNewContext(transpile("src/main/pi/piExtensionFilter.ts"), sandbox, { filename: "piExtensionFilter.ts" });
	return sandbox.exports;
}

function loadPiCompatibility() {
	const sandbox = { exports: {}, require };
	vm.runInNewContext(transpile("src/shared/piCompatibility.ts"), sandbox, { filename: "piCompatibility.ts" });
	return sandbox.exports;
}

function createChildProcess() {
	const child = new EventEmitter();
	child.stdin = new PassThrough();
	child.stdout = new PassThrough();
	child.stderr = new PassThrough();
	child.kill = () => true;
	return child;
}

function loadPiProcess(spawnCalls) {
	const paths = loadWslPaths();
	const extensionFilter = loadPiExtensionFilter();
	const compatibility = loadPiCompatibility();
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
					spawn: (command, args, options) => {
						const child = createChildProcess();
						spawnCalls.push({ command, args, options, child });
						return child;
					},
				};
			}
			if (id === "./PiRpcClient") return { PiRpcClient: FakeRpcClient };
			if (id === "./PiLocator") return { PiLocator: FakePiLocator };
			if (id === "../../shared/piCompatibility") return compatibility;
			if (id === "../wsl/WslPaths") return paths;
			if (id === "./piExtensionFilter") return extensionFilter;
			// 25fd516 起 PiProcess 引入内置扩展参数拼接；WSL 测试只关心路径转换，
			// mock 为原样透传，避免 vm sandbox 的 require 按 tests/ 相对路径误解析。
			if (id === "../extensions/builtInExtensions") {
				return { appendBuiltInExtensionArgs: (args) => [...args] };
			}
			// sharedLogger 未注册时 getAppLogger 返回 null，PiProcess 埋点静默跳过
			if (id === "../logging/sharedLogger") {
				return { getAppLogger: () => null };
			}
			return require(id);
		},
	};
	vm.runInNewContext(transpile("src/main/pi/PiProcess.ts"), sandbox, { filename: "PiProcess.ts" });
	return sandbox.exports;
}

function createLocator(invocationCalls) {
	return {
		resolveCommand: () => "wsl://Ubuntu-24.04/root/pi",
		createInvocation: (_command, args, options = {}) => {
			invocationCalls.push({ args: [...args], options: { ...options } });
			return {
				command: "wsl.exe",
				args: [
					"-d", "Ubuntu-24.04",
					"-u", "root",
					...(options.wslCwd ? ["--cd", options.wslCwd] : []),
					"pi",
					...args,
				],
				shell: false,
				wsl: { distro: "Ubuntu-24.04", user: "root", piCommand: "pi" },
			};
		},
		createProcessEnv: () => ({}),
	};
}

function createRustLocator(invocationCalls) {
	return {
		resolveCommand: () => "wsl://Ubuntu-24.04/root/pi",
		createInvocation: (_command, args, options = {}) => {
			invocationCalls.push({ args: [...args], options: { ...options } });
			return {
				command: "wsl.exe",
				args: ["-d", "Ubuntu-24.04", "-u", "root", ...(options.wslCwd ? ["--cd", options.wslCwd] : []), "pi", ...args],
				shell: false,
				wsl: { distro: "Ubuntu-24.04", user: "root", piCommand: "pi" },
			};
		},
		createProcessEnv: () => ({}),
	};
}

const settings = {
	wslEnabled: true,
	wslDistro: "Ubuntu-24.04",
	wslUser: "root",
	piProxyEnabled: false,
	piProxyUrl: "",
	piProxyBypass: "",
};

test("starts WSL pi with Linux cwd/session while keeping a Windows-accessible spawn cwd", async () => {
	const spawnCalls = [];
	const invocationCalls = [];
	const { PiProcess } = loadPiProcess(spawnCalls);
	const process = new PiProcess(
		"//wsl.localhost/Ubuntu-24.04/root/ba_cli",
		settings,
		createLocator(invocationCalls),
	);

	await process.start("\\\\wsl$\\Ubuntu-24.04\\root\\.pi\\agent\\sessions\\session.jsonl");

	assert.equal(invocationCalls[0].options.wslCwd, "/root/ba_cli");
	assert.deepEqual(
		invocationCalls[0].args,
		["--mode", "rpc", "--no-themes", "--session", "/root/.pi/agent/sessions/session.jsonl"],
	);
	assert.equal(spawnCalls[0].options.cwd, "\\\\wsl.localhost\\Ubuntu-24.04\\root\\ba_cli");
	assert.deepEqual(
		spawnCalls[0].args,
		[
			"-d", "Ubuntu-24.04",
			"-u", "root",
			"--cd", "/root/ba_cli",
			"pi", "--mode", "rpc", "--no-themes",
			"--session", "/root/.pi/agent/sessions/session.jsonl",
		],
	);
	assert.equal(process.getDiagnostics().cwd, "/root/ba_cli");
});

test("rejects a project UNC from another distro before spawning pi", async () => {
	const spawnCalls = [];
	const { PiProcess } = loadPiProcess(spawnCalls);
	const process = new PiProcess(
		"\\\\wsl.localhost\\Debian\\root\\ba_cli",
		settings,
		createLocator([]),
	);

	await assert.rejects(
		process.start(),
		(error) => error.code === "WSL_DISTRO_MISMATCH",
	);
	assert.equal(spawnCalls.length, 0);
});

test("does not pass TypeScript-only --offline to a detected Rust runtime", async () => {
	const spawnCalls = [];
	const invocationCalls = [];
	const { PiProcess } = loadPiProcess(spawnCalls);
	const rustSettings = {
		...settings,
		piInstall: {
			command: "wsl -d Ubuntu-24.04 -u root pi",
			version: "pi 0.2.0 (unknown)",
			runtimeKind: "rust",
		},
	};
	const process = new PiProcess(
		"//wsl.localhost/Ubuntu-24.04/root/ba_cli",
		rustSettings,
		createRustLocator(invocationCalls),
	);

	await process.start();
	assert.deepEqual(invocationCalls[0].args, ["--mode", "rpc", "--no-themes"]);
	assert.deepEqual(spawnCalls[0].args.slice(-4), ["pi", "--mode", "rpc", "--no-themes"]);
});

test("does not reuse a cached WSL runtime kind from another distro", async () => {
	const spawnCalls = [];
	const invocationCalls = [];
	const { PiProcess } = loadPiProcess(spawnCalls);
	const rustSettings = {
		...settings,
		piInstall: {
			command: "wsl -d Debian -u root pi",
			version: "pi 0.2.0 (unknown)",
			runtimeKind: "rust",
		},
	};
	const process = new PiProcess(
		"//wsl.localhost/Ubuntu-24.04/root/ba_cli",
		rustSettings,
		createRustLocator(invocationCalls),
	);

	await process.start();
	assert.deepEqual(invocationCalls[0].args, ["--mode", "rpc", "--no-themes"]);
});

// 界面语言随 env 传给 pi 子进程；WSL 模式必须同时登记 WSLENV，
// 否则 wsl.exe 不会把 PIDECK_UI_LANGUAGE 传进 Linux 侧，扩展会回退中文。
test("WSL spawn forwards the UI language through WSLENV", async () => {
	const spawnCalls = [];
	const { PiProcess } = loadPiProcess(spawnCalls);
	const process = new PiProcess(
		"//wsl.localhost/Ubuntu-24.04/root/ba_cli",
		settings,
		createLocator([]),
		{ uiLocale: "en-US" },
	);

	await process.start("\\\\wsl$\\Ubuntu-24.04\\root\\.pi\\agent\\sessions\\session.jsonl");

	assert.equal(spawnCalls[0].options.env.PIDECK_UI_LANGUAGE, "en-US");
	assert.ok(
		spawnCalls[0].options.env.WSLENV.split(":").includes("PIDECK_UI_LANGUAGE"),
		`WSLENV must list PIDECK_UI_LANGUAGE, got ${spawnCalls[0].options.env.WSLENV}`,
	);
});

test("appendWslEnvName merges, dedupes and keeps existing entries", () => {
	const { appendWslEnvName } = loadPiProcess([]);
	assert.equal(appendWslEnvName(undefined, "A"), "A");
	assert.equal(appendWslEnvName("USERPROFILE/p:A", "A"), "USERPROFILE/p:A", "dedupe by name ignoring /p flag");
	assert.equal(appendWslEnvName("USERPROFILE/p", "A"), "USERPROFILE/p:A");
	assert.equal(appendWslEnvName("", "A"), "A");
});

test("WSL keeps an opaque session id verbatim and still converts security file paths", async () => {
	const spawnCalls = [];
	const { PiProcess } = loadPiProcess(spawnCalls);
	const sessionId = "11111111-2222-4333-8444-555555555555";
	const piProc = new PiProcess(
		"//wsl.localhost/Ubuntu-24.04/root/ba_cli",
		settings,
		createLocator([]),
		{
			securitySessionId: sessionId,
			securitySnapshotPath: "C:\\pideck\\security.json",
			resolveBuiltInExtensionPaths: () => ["C:\\pideck\\pi-deck-security-gate.ts"],
		},
	);

	await piProc.start();

	const env = spawnCalls[0].options.env;
	assert.equal(env.PIDECK_SESSION_ID, sessionId);
	assert.equal(env.PIDECK_SECURITY_CONFIG, "/mnt/c/pideck/security.json");
	assert.equal(env.PIDECK_SECURITY_GATE_EXTENSION, "/mnt/c/pideck/pi-deck-security-gate.ts");
	const names = env.WSLENV.split(":").map((entry) => entry.split("/")[0]);
	assert.ok(names.includes("PIDECK_SESSION_ID"));
	assert.ok(names.includes("PIDECK_SECURITY_CONFIG"));
	assert.ok(names.includes("PIDECK_SECURITY_GATE_EXTENSION"));
	assert.equal(env.WSLENV.includes("PIDECK_SESSION_ID/p"), false);
	assert.equal(spawnCalls.length, 1);
});

// 非 WSL 模式：只设 PIDECK_UI_LANGUAGE，不引入 WSLENV。
test("native spawn sets PIDECK_UI_LANGUAGE without WSLENV", async () => {
	const spawnCalls = [];
	const { PiProcess } = loadPiProcess(spawnCalls);
	const nativeLocator = {
		resolveCommand: () => "pi",
		createInvocation: (_command, args) => ({ command: "pi", args, shell: false }),
		createProcessEnv: () => ({}),
	};
	const piProc = new PiProcess(globalThis.process.cwd(), undefined, nativeLocator, { uiLocale: "en-US" });

	await piProc.start();

	assert.equal(spawnCalls[0].options.env.PIDECK_UI_LANGUAGE, "en-US");
	assert.equal(spawnCalls[0].options.env.WSLENV, undefined);
});
