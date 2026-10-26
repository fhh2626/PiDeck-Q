import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { trackedTempDirs } from "./helpers/trackedTempDirs.mjs";

const makeTempDir = trackedTempDirs();

const { sanitizeChildEnvironment } = loadTsCommonJs("src/main/process/sanitizeChildEnvironment.ts");

/**
 * PiLocator 的同步探测（登录 shell PATH、WSL which）会阻塞主线程：
 * 每次 spawn / createProcessEnv 都重新执行，等于每启动一个 Agent 就卡一次。
 * 这里只替换 child_process 边界，计数真实执行次数。
 */
function loadLocator({ platform, now = () => 0, execFileSync, env = {} }) {
	const childProcess = {
		execFile: () => { throw new Error("execFile is not expected in this test"); },
		execFileSync,
	};
	return loadTsCommonJs("src/main/pi/PiLocator.ts", {
		stubs: {
			"node:child_process": childProcess,
			"../process/sanitizeChildEnvironment": { sanitizeChildEnvironment },
			"../wsl/wslExe": { getWslExe: () => ({ command: "wsl.exe", shell: false }) },
		},
		globals: {
			process: { ...process, platform, env: { ...process.env, ...env } },
			Date: class extends Date { static now() { return now(); } },
		},
	});
}

test("login-shell PATH is probed once across repeated spawns, failures included", () => {
	let calls = 0;
	const { PiLocator } = loadLocator({
		platform: "linux",
		execFileSync: (file) => {
			assert.equal(file, "/bin/sh");
			calls += 1;
			throw new Error("login shell timed out");
		},
	});
	const first = new PiLocator();
	first.createProcessEnv();
	first.getSearchDirs();
	// 新实例同样复用：AgentManager / modelListCache / ExtensionManager 各自 new 或共享 locator。
	new PiLocator().createProcessEnv();
	assert.equal(calls, 1, "a failing login shell must not be re-run on every spawn");
});

test("login-shell PATH result is reused and refreshed after its TTL", () => {
	let calls = 0;
	let now = 1_000;
	const { PiLocator } = loadLocator({
		platform: "darwin",
		now: () => now,
		execFileSync: () => {
			calls += 1;
			return `/opt/shell-bin-${calls}\n`;
		},
	});
	const locator = new PiLocator();
	assert.ok(locator.getSearchDirs().includes("/opt/shell-bin-1"));
	assert.ok(locator.getSearchDirs().includes("/opt/shell-bin-1"));
	assert.equal(calls, 1);
	now += 60_001;
	assert.ok(locator.getSearchDirs().includes("/opt/shell-bin-2"), "newly installed toolchains are picked up after the TTL");
	assert.equal(calls, 2);
});

test("WSL which is cached per distro/user/command for a short TTL", () => {
	const calls = [];
	let now = 5_000;
	const { PiLocator } = loadLocator({
		platform: "win32",
		now: () => now,
		execFileSync: (_file, args) => {
			calls.push(args.join(" "));
			return "/usr/local/bin/pi\n";
		},
	});
	const locator = new PiLocator();
	const resolve = (distro, user, preference = "auto") =>
		locator.resolveCommand("", true, distro, user, preference);
	assert.equal(resolve("Ubuntu", "dev"), "wsl://Ubuntu/dev/pi");
	assert.equal(resolve("Ubuntu", "dev"), "wsl://Ubuntu/dev/pi");
	assert.equal(new PiLocator().resolveCommand("", true, "Ubuntu", "dev"), "wsl://Ubuntu/dev/pi");
	assert.equal(calls.length, 1, "same distro/user/command must reuse the which result");
	// 键不同（用户、发行版、命令名）必须独立探测，不能串用。
	resolve("Ubuntu", "root");
	resolve("Debian", "dev");
	resolve("Ubuntu", "dev", "bolt");
	assert.equal(calls.length, 4);
	now += 60_001;
	resolve("Ubuntu", "dev");
	assert.equal(calls.length, 5, "the cache expires so a newly installed pi is found");
});

test("a failed WSL which is also remembered within the TTL", () => {
	let calls = 0;
	const { PiLocator } = loadLocator({
		platform: "win32",
		execFileSync: () => {
			calls += 1;
			throw new Error("wsl unavailable");
		},
	});
	const locator = new PiLocator();
	// WSL 失败后回退本机自动检测（结果取决于宿主 PATH），这里只关心不重复探测 WSL。
	const first = locator.resolveCommand("", true, "Ubuntu", "dev");
	assert.ok(!first.startsWith("wsl://"));
	assert.equal(locator.resolveCommand("", true, "Ubuntu", "dev"), first);
	assert.equal(calls, 1);
});

test("an absolute Windows .exe is spawned directly instead of through cmd.exe", () => {
	const root = makeTempDir("pideck-locator-exe-");
	const exe = join(root, "Pi Bolt", "pi-bolt.exe");
	mkdirSync(join(root, "Pi Bolt"), { recursive: true });
	writeFileSync(exe, "", "utf8");
	const { PiLocator } = loadLocator({ platform: "win32", execFileSync: () => "" });
	const invocation = new PiLocator().createInvocation(exe, ["--mode", "rpc", "-e", "C:\\a b\\ext.ts"]);
	assert.equal(invocation.command, exe);
	// vm 加载的数组属于另一个 realm，用 JSON 比较内容。
	assert.equal(JSON.stringify(invocation.args), JSON.stringify(["--mode", "rpc", "-e", "C:\\a b\\ext.ts"]));
	assert.equal(invocation.shell, false);
	// 直接启动必须交给 Node 做参数转义；verbatim 只属于 cmd /c 手工拼好的命令行。
	assert.notEqual(invocation.windowsVerbatimArguments, true);
});

test(".cmd shims and bare command names stay wrapped by cmd.exe on Windows", () => {
	const root = makeTempDir("pideck-locator-cmd-");
	const shim = join(root, "pi.cmd");
	writeFileSync(shim, "@echo off\r\n", "utf8");
	const { PiLocator } = loadLocator({ platform: "win32", execFileSync: () => "" });
	const locator = new PiLocator();
	for (const command of [shim, "pi", "pi.exe", "npm"]) {
		const invocation = locator.createInvocation(command, ["--version"]);
		assert.match(invocation.command.toLowerCase(), /cmd(\.exe)?$/, command);
		assert.equal(JSON.stringify(invocation.args.slice(0, 3)), JSON.stringify(["/d", "/s", "/c"]), command);
		assert.equal(invocation.windowsVerbatimArguments, true, command);
	}
});
