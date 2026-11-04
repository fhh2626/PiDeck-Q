import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { createFakeWslExecFile } from "./helpers/fakeWslExecFile.mjs";
import { loadSessionScanner } from "./helpers/loadSessionScanner.mjs";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const ROOT = "C:\\FakeWin";

/** 以伪造的 fs/process 装载 wslExe 模块；existing 为“磁盘上存在”的路径集合。 */
function loadWslExe({ existing, arch = "x64" }) {
	const probes = [];
	const mod = loadTsCommonJs("src/main/wsl/wslExe.ts", {
		stubs: {
			"node:fs": {
				existsSync: (path) => {
					probes.push(path);
					return existing.has(path);
				},
			},
		},
		globals: { process: { env: { SystemRoot: ROOT }, arch } },
	});
	return { ...mod, probes };
}

test("wsl.exe resolves to the System32 absolute path without shell mode when it exists", () => {
	const system32 = join(ROOT, "System32", "wsl.exe");
	const { getWslExe } = loadWslExe({ existing: new Set([system32]) });
	assert.deepEqual({ ...getWslExe() }, { command: system32, shell: false });
});

test("wsl.exe falls back to PATH lookup in shell mode only when System32 has no wsl.exe", () => {
	const { getWslExe } = loadWslExe({ existing: new Set() });
	assert.deepEqual({ ...getWslExe() }, { command: "wsl", shell: true });
});

test("32-bit process prefers the Sysnative alias to bypass SysWOW64 redirection", () => {
	const sysnative = join(ROOT, "Sysnative", "wsl.exe");
	const system32 = join(ROOT, "System32", "wsl.exe");
	const { getWslExe } = loadWslExe({ existing: new Set([sysnative, system32]), arch: "ia32" });
	assert.equal(getWslExe().command, sysnative);
});

test("64-bit process never probes the Sysnative alias", () => {
	const sysnative = join(ROOT, "Sysnative", "wsl.exe");
	const { getWslExe, probes } = loadWslExe({ existing: new Set([sysnative]), arch: "x64" });
	assert.deepEqual({ ...getWslExe() }, { command: "wsl", shell: true });
	assert.deepEqual(probes, [join(ROOT, "System32", "wsl.exe")]);
});

test("the shared resolver caches its result instead of probing every call", () => {
	const system32 = join(ROOT, "System32", "wsl.exe");
	const { getWslExe, probes } = loadWslExe({ existing: new Set([system32]) });
	const first = getWslExe();
	const second = getWslExe();
	assert.equal(first, second, "同一进程内必须返回同一个缓存对象");
	assert.equal(probes.length, 1, "缓存命中后不得再 existsSync");
});

test("PiLocator builds WSL invocations from the shared resolver (command and shell mode)", () => {
	const { PiLocator } = loadTsCommonJs("src/main/pi/PiLocator.ts", {
		stubs: { "../wsl/wslExe": { getWslExe: () => ({ command: "SENTINEL-wsl", shell: true }) } },
	});
	const invocation = new PiLocator(undefined, "C:\\home").createInvocation("wsl://Ubuntu/me/pi", ["--version"]);
	assert.equal(invocation.command, "SENTINEL-wsl");
	assert.equal(invocation.shell, true);
	assert.deepEqual([...invocation.args], ["-d", "Ubuntu", "-u", "me", "pi", "--version"]);
});

test("PiLocator WSL CLI check and distro lookup both go through the shared resolver", async () => {
	const calls = [];
	const childProcess = {
		execFile: (command, args, options, callback) => {
			calls.push({ kind: "execFile", command, shell: options.shell });
			callback(null, "0.81.1\n", "");
			return {};
		},
		execFileSync: (command, args, options) => {
			calls.push({ kind: "execFileSync", command, shell: options.shell });
			return "/usr/bin/pi\n";
		},
	};
	const { PiLocator } = loadTsCommonJs("src/main/pi/PiLocator.ts", {
		stubs: {
			"node:child_process": childProcess,
			"../wsl/wslExe": { getWslExe: () => ({ command: "SENTINEL-wsl", shell: true }) },
		},
		// resolveWslCommand 仅在 win32 上启用；伪造 platform 让用例在任何宿主上都走同一分支。
		globals: { process: Object.create(process, { platform: { value: "win32" } }) },
	});
	const locator = new PiLocator(undefined, "C:\\home");
	const status = await locator.validateCustomPath("wsl://Ubuntu/me/pi");
	assert.equal(status.installed, true);
	locator.resolveCommand(undefined, true, "Ubuntu", "me");
	assert.ok(calls.some((c) => c.kind === "execFile"), "checkWslCommand 必须被触发");
	assert.ok(calls.some((c) => c.kind === "execFileSync"), "resolveWslCommand 必须被触发");
	for (const call of calls) {
		assert.equal(call.command, "SENTINEL-wsl", `${call.kind} 必须使用共享解析器的 command`);
		assert.equal(call.shell, true, `${call.kind} 必须使用共享解析器的 shell 模式`);
	}
});

test("SessionScanner WSL commands use the shared resolver's command and shell mode", async () => {
	const home = mkdtempSync(join(tmpdir(), "pideck-wsl-resolver-"));
	try {
		const fake = createFakeWslExecFile(join(home, "wslfs"));
		const seen = [];
		const execFile = (command, args, options, callback) => {
			seen.push({ command, shell: options?.shell });
			return fake.execFile(command, args, options, callback);
		};
		const { SessionScanner } = loadSessionScanner(home, {
			childProcess: { execFile },
			stubs: { "../wsl/wslExe": { getWslExe: () => ({ command: "SENTINEL-wsl", shell: true }) } },
		});
		const scanner = new SessionScanner(undefined, home);
		await scanner.configureWsl({ distro: "Ubuntu", user: "u", linuxHome: "/home/u", windowsHome: home });
		// delete 会依次触发 test/mv 等多条 wsl 命令，覆盖 getter 的实际使用点。
		const file = "/home/u/.pi/agent/sessions/p.jsonl";
		mkdirSync(dirname(fake.host(file)), { recursive: true });
		writeFileSync(fake.host(file), "{}\n");
		await scanner.delete(file);
		// 列表与归档目录扫描走另外几条 wsl 命令（find / test / 读文件），各有自己的 execFile 调用点，
		// 只测 delete 会漏掉它们：任何一处退回硬编码 "wsl" 都会在 32 位进程或 PATH 缺失时失效。
		await scanner.list();
		await scanner.listArchived();
		assert.ok(seen.length > 0, "configureWsl 之后必须至少发出一次 wsl 调用");
		for (const call of seen) {
			assert.equal(call.command, "SENTINEL-wsl");
			assert.equal(call.shell, true);
		}
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("SessionScanner cleans up its WSL temp file through the shared resolver when the atomic replace fails", async () => {
	// 原子写失败（mv 报错）时要用共享解析器的 command 执行 rm -f 清掉 .tmp，
	// 否则 32 位进程或 PATH 里没有 wsl 时会留下半个临时文件，且错误被吞掉看不出来。
	const home = mkdtempSync(join(tmpdir(), "pideck-wsl-resolver-cleanup-"));
	try {
		const fake = createFakeWslExecFile(join(home, "wslfs"));
		const seen = [];
		const execFile = (command, args, options, callback) => {
			const verb = args.slice(4)[0];
			seen.push({ command, shell: options?.shell, verb });
			if (verb === "mv") {
				queueMicrotask(() => callback(new Error("mv: Input/output error"), "", ""));
				return { stdin: null };
			}
			return fake.execFile(command, args, options, callback);
		};
		const { SessionScanner } = loadSessionScanner(home, {
			childProcess: { execFile },
			stubs: { "../wsl/wslExe": { getWslExe: () => ({ command: "SENTINEL-wsl", shell: true }) } },
		});
		const scanner = new SessionScanner(undefined, home);
		await scanner.configureWsl({ distro: "Ubuntu", user: "u", linuxHome: "/home/u", windowsHome: home });
		const file = "/home/u/.pi/agent/sessions/p.jsonl";
		const dir = dirname(fake.host(file));
		mkdirSync(dir, { recursive: true });
		const original = '{"type":"session","id":"s1"}\n';
		writeFileSync(fake.host(file), original);

		await assert.rejects(scanner.rename(file, "New name"), /Input\/output error/);

		const cleanup = seen.filter((call) => call.verb === "rm");
		assert.equal(cleanup.length, 1, "the temp file must be removed exactly once");
		assert.equal(cleanup[0].command, "SENTINEL-wsl");
		assert.equal(cleanup[0].shell, true);
		assert.deepEqual(readdirSync(dir), ["p.jsonl"], "no .tmp file is left next to the session");
		assert.equal(readFileSync(fake.host(file), "utf8"), original, "the original session file is untouched");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});
