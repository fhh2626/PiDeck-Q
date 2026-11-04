import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { pathToFileURL } from "node:url";
import { loadPiProcess } from "./helpers/loadPiProcess.mjs";

const { sanitizeChildEnvironment } = loadTsCommonJs("src/main/process/sanitizeChildEnvironment.ts");
const { detectPiRuntimeKind, piSupportsTrustFlags } = loadTsCommonJs("src/shared/piCompatibility.ts");

// 真实 Pi-Bolt 1.0.2（基于 Pi 1.4.0）在 Windows 上 `--version` 的完整输出。
const BOLT_VERSION = "1.4.0 (Pi-Bolt 1.0.2, win32-x64-jit, JIT on)";

function loadPiLocator(platform, env) {
	return loadTsCommonJs("src/main/pi/PiLocator.ts", {
		stubs: {
			electron: { app: { getPath: () => tmpdir() } },
			"../process/sanitizeChildEnvironment": { sanitizeChildEnvironment },
		},
		globals: { process: { ...process, platform, env: { ...process.env, ...env } } },
	}).PiLocator;
}

// ── 版本识别 ───────────────────────────────────────────────────────

test("recognises Pi-Bolt by its version banner, not by the underlying Pi semver", () => {
	assert.equal(detectPiRuntimeKind(BOLT_VERSION), "bolt");
	assert.equal(detectPiRuntimeKind("1.4.0 (Pi-Bolt 1.0.2, linux-x64, JIT off)"), "bolt");
});

test("keeps classifying stock Pi and Rust Pi as before", () => {
	assert.equal(detectPiRuntimeKind("1.4.0"), "typescript");
	assert.equal(detectPiRuntimeKind("0.85.1"), "typescript");
	assert.equal(detectPiRuntimeKind("pi 0.2.0 (unknown abc)"), "rust");
	assert.equal(detectPiRuntimeKind("development build"), "unknown");
});

// ── 信任标志版本门槛 ───────────────────────────────────────────────

test("trust flags are supported from Pi 0.79 and across the whole 1.x line", () => {
	assert.equal(piSupportsTrustFlags("0.78.9"), false);
	assert.equal(piSupportsTrustFlags("0.79.0"), true);
	assert.equal(piSupportsTrustFlags("0.85.1"), true);
	// 回归：次版本号 < 79 的 1.x 曾被误判为不支持。
	assert.equal(piSupportsTrustFlags("1.0.0"), true);
	assert.equal(piSupportsTrustFlags("1.4.0"), true);
	assert.equal(piSupportsTrustFlags(BOLT_VERSION), true);
});

test("trust flags stay off for Rust Pi and for unparsable versions", () => {
	assert.equal(piSupportsTrustFlags("pi 0.2.0 (unknown abc)"), false);
	assert.equal(piSupportsTrustFlags(""), false);
	assert.equal(piSupportsTrustFlags("development build"), false);
});

// ── 定位 ───────────────────────────────────────────────────────────

test("bolt preference uses the configured Pi-Bolt path", () => {
	const PiLocator = loadPiLocator("darwin", {});
	const locator = new PiLocator();
	assert.equal(
		locator.resolveCommand(undefined, false, undefined, undefined, "bolt", "/opt/pi-ts", "/opt/pi-rust", "/opt/pi-bolt"),
		"/opt/pi-bolt",
	);
});

test("other preferences never pick up the Pi-Bolt path", () => {
	const PiLocator = loadPiLocator("darwin", {});
	const locator = new PiLocator();
	assert.equal(
		locator.resolveCommand(undefined, false, undefined, undefined, "typescript", "/opt/pi-ts", "/opt/pi-rust", "/opt/pi-bolt"),
		"/opt/pi-ts",
	);
	assert.equal(
		locator.resolveCommand(undefined, false, undefined, undefined, "rust", "/opt/pi-ts", "/opt/pi-rust", "/opt/pi-bolt"),
		"/opt/pi-rust",
	);
	assert.notEqual(
		locator.resolveCommand(undefined, false, undefined, undefined, "auto", "/opt/pi-ts", "/opt/pi-rust", "/opt/pi-bolt"),
		"/opt/pi-bolt",
	);
});

test("bolt preference searches PATH for pi-bolt and ignores a plain pi", () => {
	const root = join(tmpdir(), `pideck-bolt-locator-${process.pid}-${Date.now()}`);
	// 原版 pi 所在目录排在 PATH 前面：如果错误地把 pi 当作候选，就会先命中它。
	const stockDir = join(root, "stock-bin");
	const boltDir = join(root, "bolt-bin");
	mkdirSync(stockDir, { recursive: true });
	mkdirSync(boltDir, { recursive: true });
	writeFileSync(join(stockDir, "pi"), "", "utf8");
	writeFileSync(join(boltDir, "pi-bolt"), "", "utf8");
	try {
		const PiLocator = loadPiLocator("linux", { PATH: [stockDir, boltDir].join(delimiter), HOME: root });
		const resolved = new PiLocator(undefined, root).resolveCommand(
			undefined, false, undefined, undefined, "bolt", undefined, undefined, undefined,
		);
		assert.equal(resolved, join(boltDir, "pi-bolt"));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("bolt preference finds pi-bolt.exe on Windows PATH", () => {
	const root = join(tmpdir(), `pideck-bolt-locator-win-${process.pid}-${Date.now()}`);
	const pathDir = join(root, "bin");
	mkdirSync(pathDir, { recursive: true });
	writeFileSync(join(pathDir, "pi-bolt.exe"), "", "utf8");
	try {
		const PiLocator = loadPiLocator("win32", {
			PATH: pathDir,
			LOCALAPPDATA: join(root, "Local"),
			APPDATA: join(root, "Roaming"),
		});
		const resolved = new PiLocator(undefined, root).resolveCommand(
			undefined, false, undefined, undefined, "bolt", undefined, undefined, undefined,
		);
		assert.equal(resolved, join(pathDir, "pi-bolt.exe"));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("bolt preference falls back to the pi-bolt command name when nothing is installed", () => {
	const root = join(tmpdir(), `pideck-bolt-locator-empty-${process.pid}-${Date.now()}`);
	mkdirSync(root, { recursive: true });
	try {
		const PiLocator = loadPiLocator("linux", { PATH: join(root, "empty"), HOME: root });
		const resolved = new PiLocator(undefined, root).resolveCommand(
			undefined, false, undefined, undefined, "bolt", undefined, undefined, undefined,
		);
		assert.equal(resolved, "pi-bolt");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// ── 启动参数与环境 ─────────────────────────────────────────────────

function createLocator(command) {
	return {
		resolveCommand: () => command,
		createInvocation: (_command, args) => ({ command, args, shell: false }),
		createProcessEnv: () => ({}),
	};
}

function nativeSettings(extra = {}) {
	return { piRuntimePreference: "bolt", piRpcOffline: true, ...extra };
}

test("a Pi-Bolt launch uses the TypeScript argument set and forwards trust decisions", async () => {
	const spawnCalls = [];
	const { PiProcess } = loadPiProcess(spawnCalls, { versionOutput: `${BOLT_VERSION}\n` });
	const proc = new PiProcess(process.cwd(), nativeSettings(), createLocator("C:\\Pi-Bolt\\pi-bolt.exe"));

	await proc.start(undefined, "approve");

	assert.deepEqual(spawnCalls[0].args, ["--mode", "rpc", "--no-themes", "--offline", "--approve"]);
});

test("a Pi-Bolt launch tells built-in extensions that Pi is a standalone binary", async () => {
	const spawnCalls = [];
	const { PiProcess } = loadPiProcess(spawnCalls, { versionOutput: `${BOLT_VERSION}\n` });
	const proc = new PiProcess(process.cwd(), nativeSettings(), createLocator("C:\\Pi-Bolt\\pi-bolt.exe"));

	await proc.start();

	assert.equal(spawnCalls[0].options.env.PIDECK_PI_STANDALONE, "1");
});

function locatorWithParentEnv(command, parentEnv) {
	return {
		resolveCommand: () => command,
		createInvocation: (_command, args) => ({ command, args, shell: false }),
		createProcessEnv: () => parentEnv,
	};
}

for (const [label, versionOutput, preference] of [
	["TypeScript", "1.4.0\n", "typescript"],
	["Rust", "pi 0.2.0 (unknown abc)\n", "rust"],
	["unknown", "development build\n", "auto"],
]) {
	test(`a ${label} launch drops an inherited standalone marker without mutating the parent env`, async () => {
		const spawnCalls = [];
		const { PiProcess } = loadPiProcess(spawnCalls, { versionOutput });
		const parentEnv = { PIDECK_PI_STANDALONE: "1", KEEP_ME: "kept" };
		const command = "C:\\Pi\\pi.exe";
		const proc = new PiProcess(
			process.cwd(),
			nativeSettings({ piRuntimePreference: preference }),
			locatorWithParentEnv(command, parentEnv),
		);

		await proc.start();

		assert.equal(parentEnv.PIDECK_PI_STANDALONE, "1", "the locator input must stay unchanged");
		assert.equal(spawnCalls[0].options.env.PIDECK_PI_STANDALONE, undefined);
		assert.equal(spawnCalls[0].options.env.KEEP_ME, "kept");
	});
}

for (const inherited of [undefined, "0", "1"]) {
	test(`a Pi-Bolt launch sets the standalone marker when the parent value is ${String(inherited)}`, async () => {
		const spawnCalls = [];
		const { PiProcess } = loadPiProcess(spawnCalls, { versionOutput: `${BOLT_VERSION}\n` });
		const parentEnv = { KEEP_ME: "kept" };
		if (inherited !== undefined) parentEnv.PIDECK_PI_STANDALONE = inherited;
		const proc = new PiProcess(
			process.cwd(),
			nativeSettings(),
			locatorWithParentEnv("C:\\Pi-Bolt\\pi-bolt.exe", parentEnv),
		);

		await proc.start();

		assert.equal(parentEnv.PIDECK_PI_STANDALONE, inherited);
		assert.equal(spawnCalls[0].options.env.PIDECK_PI_STANDALONE, "1");
		assert.equal(spawnCalls[0].options.env.KEEP_ME, "kept");
	});
}

test("the standalone marker is also registered in WSLENV for a WSL Pi-Bolt", async () => {
	const spawnCalls = [];
	const { PiProcess } = loadPiProcess(spawnCalls, { versionOutput: `${BOLT_VERSION}\n` });
	const wslLocator = {
		resolveCommand: () => "wsl://Ubuntu-24.04/root/pi-bolt",
		createInvocation: (_command, args) => ({
			command: "wsl.exe",
			args: ["-d", "Ubuntu-24.04", "-u", "root", "pi-bolt", ...args],
			shell: false,
			wsl: { distro: "Ubuntu-24.04", user: "root", piCommand: "pi-bolt" },
		}),
		createProcessEnv: () => ({}),
	};
	const proc = new PiProcess(
		"//wsl.localhost/Ubuntu-24.04/root/work",
		nativeSettings({ wslEnabled: true, wslDistro: "Ubuntu-24.04", wslUser: "root" }),
		wslLocator,
	);

	await proc.start();

	const env = spawnCalls[0].options.env;
	assert.equal(env.PIDECK_PI_STANDALONE, "1");
	assert.ok(env.WSLENV.split(":").includes("PIDECK_PI_STANDALONE"), `WSLENV was ${env.WSLENV}`);
});

test("auto mode waits for an in-flight version probe so a Pi-Bolt custom path still gets the marker", async () => {
	const spawnCalls = [];
	const { PiProcess } = loadPiProcess(spawnCalls, { versionOutput: `${BOLT_VERSION}\n` });
	const locator = createLocator("C:\\Pi-Bolt\\pi-bolt.exe");
	const settings = nativeSettings({ piRuntimePreference: "auto", customPiPath: "C:\\Pi-Bolt\\pi-bolt.exe" });
	// 应用启动时预热 --version 缓存但尚未完成，此时用户就开了会话：没有持久化的 runtimeKind 可用。
	void PiProcess.warmVersionCache(settings, locator);
	const proc = new PiProcess(process.cwd(), settings, locator);

	await proc.start();

	assert.equal(spawnCalls[0].options.env.PIDECK_PI_STANDALONE, "1");
	assert.ok(spawnCalls[0].args.includes("--offline"), `args were ${spawnCalls[0].args.join(" ")}`);
});

test("an explicit bolt preference re-probes instead of trusting a runtime kind persisted before Pi-Bolt was recognised", async () => {
	// 旧版本把 Pi-Bolt（版本串是 "1.4.0 (Pi-Bolt …)"）误记成 typescript 并持久化进 settings.piInstall。
	// 显式选择 bolt 时必须以实测版本为准，否则升级后冷启动的第一次会话会被“类型不符”误拒。
	const spawnCalls = [];
	const { PiProcess } = loadPiProcess(spawnCalls, { versionOutput: `${BOLT_VERSION}\n` });
	const command = "C:\\Pi-Bolt\\pi-bolt.exe";
	const proc = new PiProcess(
		process.cwd(),
		nativeSettings({ piInstall: { command, version: "1.4.0", runtimeKind: "typescript" } }),
		createLocator(command),
	);

	await proc.start();

	assert.equal(spawnCalls[0].options.env.PIDECK_PI_STANDALONE, "1");
});

test("auto mode still trusts the persisted runtime kind without spawning a probe", async () => {
	const spawnCalls = [];
	const { PiProcess } = loadPiProcess(spawnCalls, { versionOutput: "garbage\n" });
	const command = "C:\\Pi-Bolt\\pi-bolt.exe";
	const proc = new PiProcess(
		process.cwd(),
		nativeSettings({
			piRuntimePreference: "auto",
			piInstall: { command, version: BOLT_VERSION, runtimeKind: "bolt" },
		}),
		createLocator(command),
	);

	await proc.start();

	assert.equal(spawnCalls[0].options.env.PIDECK_PI_STANDALONE, "1", "the persisted kind decides, not the live probe");
});

const failedVersionProbe = {
	versionResult: () => ({ error: new Error("version probe failed"), stdout: "" }),
};

function staleBoltInstall(command) {
	return { command, version: BOLT_VERSION, runtimeKind: "typescript" };
}

test("a failed probe reclassifies a persisted Pi-Bolt version instead of trusting the old typescript kind", async () => {
	const spawnCalls = [];
	const { PiProcess } = loadPiProcess(spawnCalls, failedVersionProbe);
	const command = "C:\\Pi-Bolt\\pi-bolt.exe";
	const locator = createLocator(command);
	const settings = nativeSettings({
		piRuntimePreference: "auto",
		customPiPath: command,
		piInstall: staleBoltInstall(command),
	});
	await PiProcess.warmVersionCache(settings, locator);

	await new PiProcess(process.cwd(), settings, locator).start();

	assert.equal(spawnCalls[0].options.env.PIDECK_PI_STANDALONE, "1");
});

test("explicit bolt is not rejected when a failed probe leaves only a stale typescript classification", async () => {
	const spawnCalls = [];
	const { PiProcess } = loadPiProcess(spawnCalls, failedVersionProbe);
	const command = "C:\\Pi-Bolt\\pi-bolt.exe";
	const locator = createLocator(command);
	const settings = nativeSettings({
		piRuntimePreference: "bolt",
		piBoltPath: command,
		piInstall: staleBoltInstall(command),
	});
	await PiProcess.warmVersionCache(settings, locator);

	await new PiProcess(process.cwd(), settings, locator).start();

	assert.equal(spawnCalls.length, 1);
	assert.equal(spawnCalls[0].options.env.PIDECK_PI_STANDALONE, "1");
});

test("an in-flight probe that fails still uses the reclassified persisted Pi-Bolt version", { timeout: 3_000 }, async () => {
	const spawnCalls = [];
	let release;
	const versionGate = new Promise((resolve) => { release = resolve; });
	const { PiProcess } = loadPiProcess(spawnCalls, { ...failedVersionProbe, versionGate });
	const command = "C:\\Pi-Bolt\\pi-bolt.exe";
	const locator = createLocator(command);
	const settings = nativeSettings({
		piRuntimePreference: "auto",
		customPiPath: command,
		piInstall: staleBoltInstall(command),
	});
	const probe = PiProcess.warmVersionCache(settings, locator);
	const started = new PiProcess(process.cwd(), settings, locator).start();
	try {
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(spawnCalls.length, 0);
	} finally {
		release();
	}

	await probe;
	await started;
	assert.equal(spawnCalls[0].options.env.PIDECK_PI_STANDALONE, "1");
});

test("a matching WSL command reclassifies its persisted Pi-Bolt version after probe failure", async () => {
	const spawnCalls = [];
	const { PiProcess } = loadPiProcess(spawnCalls, failedVersionProbe);
	const command = "wsl://Ubuntu-24.04/root/pi-bolt";
	const locator = {
		resolveCommand: () => command,
		createInvocation: (_command, args) => ({
			command: "wsl.exe", args, shell: false,
			wsl: { distro: "Ubuntu-24.04", user: "root", piCommand: "pi-bolt" },
		}),
		createProcessEnv: () => ({}),
	};
	const settings = nativeSettings({
		piRuntimePreference: "auto",
		wslEnabled: true,
		wslDistro: "Ubuntu-24.04",
		wslUser: "root",
		piInstall: staleBoltInstall("wsl -d Ubuntu-24.04 -u root pi-bolt"),
	});
	await PiProcess.warmVersionCache(settings, locator);

	await new PiProcess("//wsl.localhost/Ubuntu-24.04/root/work", settings, locator).start();

	assert.equal(spawnCalls[0].options.env.PIDECK_PI_STANDALONE, "1");
});

test("a failed probe does not borrow a persisted Pi-Bolt record for a different command", async () => {
	const spawnCalls = [];
	const { PiProcess } = loadPiProcess(spawnCalls, failedVersionProbe);
	const command = "C:\\Pi\\pi.exe";
	const locator = createLocator(command);
	const settings = nativeSettings({
		piRuntimePreference: "auto",
		customPiPath: command,
		piInstall: staleBoltInstall("C:\\Other\\pi-bolt.exe"),
	});
	await PiProcess.warmVersionCache(settings, locator);

	await new PiProcess(process.cwd(), settings, locator).start();

	assert.equal(spawnCalls[0].options.env.PIDECK_PI_STANDALONE, undefined);
});

test("a failed probe does not borrow a persisted record from another WSL distro", async () => {
	const spawnCalls = [];
	const { PiProcess } = loadPiProcess(spawnCalls, failedVersionProbe);
	const command = "wsl://Ubuntu-24.04/root/pi";
	const locator = {
		resolveCommand: () => command,
		createInvocation: (_command, args) => ({
			command: "wsl.exe", args, shell: false,
			wsl: { distro: "Ubuntu-24.04", user: "root", piCommand: "pi" },
		}),
		createProcessEnv: () => ({}),
	};
	const settings = nativeSettings({
		piRuntimePreference: "auto",
		wslEnabled: true,
		wslDistro: "Ubuntu-24.04",
		wslUser: "root",
		piInstall: staleBoltInstall("wsl -d Other -u root pi-bolt"),
	});
	await PiProcess.warmVersionCache(settings, locator);

	await new PiProcess("//wsl.localhost/Ubuntu-24.04/root/work", settings, locator).start();

	assert.equal(spawnCalls[0].options.env.PIDECK_PI_STANDALONE, undefined);
});

test("a successful live probe wins when it conflicts with the persisted runtime record", async () => {
	const spawnCalls = [];
	const { PiProcess } = loadPiProcess(spawnCalls, { versionOutput: "1.4.0\n" });
	const command = "C:\\Pi\\pi.exe";
	const locator = createLocator(command);
	const settings = nativeSettings({
		piRuntimePreference: "auto",
		customPiPath: command,
		piInstall: { command, version: BOLT_VERSION, runtimeKind: "bolt" },
	});
	await PiProcess.warmVersionCache(settings, locator);

	await new PiProcess(process.cwd(), settings, locator).start();

	assert.equal(spawnCalls[0].options.env.PIDECK_PI_STANDALONE, undefined);
});

test("an unrecognisable persisted version keeps the stored runtime kind after probe failure", async () => {
	const spawnCalls = [];
	const { PiProcess } = loadPiProcess(spawnCalls, failedVersionProbe);
	const command = "C:\\Pi\\pi.exe";
	const locator = createLocator(command);
	const settings = nativeSettings({
		piRuntimePreference: "typescript",
		piTypescriptPath: command,
		piInstall: { command, version: "", runtimeKind: "typescript" },
	});
	await PiProcess.warmVersionCache(settings, locator);

	await new PiProcess(process.cwd(), settings, locator).start();

	assert.equal(spawnCalls[0].options.env.PIDECK_PI_STANDALONE, undefined);
	assert.ok(spawnCalls[0].args.includes("--offline"));
});

for (const persisted of [false, true]) {
	test(`auto mode awaits the actual pending probe with ${persisted ? "stale" : "no"} persisted classification`, { timeout: 3_000 }, async () => {
		const spawnCalls = [];
		let release;
		const versionGate = new Promise((resolve) => { release = resolve; });
		const { PiProcess } = loadPiProcess(spawnCalls, { versionOutput: `${BOLT_VERSION}\n`, versionGate });
		const command = "C:\\Pi-Bolt\\pi-bolt.exe";
		const locator = createLocator(command);
		const settings = nativeSettings({
			piRuntimePreference: "auto",
			customPiPath: command,
			piInstall: persisted ? { command, version: "1.4.0", runtimeKind: "typescript" } : undefined,
		});
		const probe = PiProcess.warmVersionCache(settings, locator);
		const started = new PiProcess(process.cwd(), settings, locator).start();
		try {
			// 让启动逻辑推进到探测屏障；回调尚未放行，不允许用陈旧/未知类型 spawn。
			await new Promise((resolve) => setImmediate(resolve));
			assert.equal(spawnCalls.length, 0);
		} finally {
			// 释放不能依赖 start() 返回，否则回归会让测试自身死锁。
			release();
		}
		await probe;
		await started;
		assert.equal(spawnCalls[0].options.env.PIDECK_PI_STANDALONE, "1");
		assert.ok(spawnCalls[0].args.includes("--offline"));
	});
}

test("stock Pi does not get the standalone marker from PiDeck", async () => {
	const spawnCalls = [];
	const { PiProcess } = loadPiProcess(spawnCalls, { versionOutput: "1.4.0\n" });
	const proc = new PiProcess(
		process.cwd(),
		nativeSettings({ piRuntimePreference: "typescript" }),
		createLocator("C:\\Pi\\pi.exe"),
	);

	await proc.start();

	assert.equal(spawnCalls[0].options.env.PIDECK_PI_STANDALONE, undefined);
});

test("stock Pi 1.x receives the trust flag instead of silently dropping it", async () => {
	const spawnCalls = [];
	const { PiProcess } = loadPiProcess(spawnCalls, { versionOutput: "1.4.0\n" });
	const proc = new PiProcess(
		process.cwd(),
		nativeSettings({ piRuntimePreference: "typescript" }),
		createLocator("C:\\Pi\\pi.exe"),
	);

	await proc.start(undefined, "no-approve");

	assert.ok(spawnCalls[0].args.includes("--no-approve"), `args were ${spawnCalls[0].args.join(" ")}`);
});

test("pre-0.79 Pi still never receives trust flags", async () => {
	const spawnCalls = [];
	const { PiProcess } = loadPiProcess(spawnCalls, { versionOutput: "0.78.2\n" });
	const proc = new PiProcess(
		process.cwd(),
		nativeSettings({ piRuntimePreference: "typescript" }),
		createLocator("C:\\Pi\\pi.exe"),
	);

	await proc.start(undefined, "approve");

	assert.equal(spawnCalls[0].args.includes("--approve"), false);
});

test("selecting bolt but resolving stock Pi is rejected before spawning", async () => {
	const spawnCalls = [];
	const { PiProcess } = loadPiProcess(spawnCalls, { versionOutput: "1.4.0\n" });
	const proc = new PiProcess(process.cwd(), nativeSettings(), createLocator("C:\\Pi\\pi.exe"));

	await assert.rejects(proc.start(), /Selected Pi runtime is bolt, but the resolved command is typescript/);
	assert.equal(spawnCalls.length, 0);
});

test("selecting TypeScript but resolving Pi-Bolt is rejected before spawning", async () => {
	const spawnCalls = [];
	const { PiProcess } = loadPiProcess(spawnCalls, { versionOutput: `${BOLT_VERSION}\n` });
	const proc = new PiProcess(
		process.cwd(),
		nativeSettings({ piRuntimePreference: "typescript" }),
		createLocator("C:\\Pi-Bolt\\pi-bolt.exe"),
	);

	await assert.rejects(proc.start(), /Selected Pi runtime is typescript, but the resolved command is bolt/);
	assert.equal(spawnCalls.length, 0);
});

// ── 子代理拉起 Pi 子进程 ───────────────────────────────────────────

const { getPiSpawnCommand } = await import(
	pathToFileURL(join(process.cwd(), "resources/extensions/pideck-q-subagents/src/runs/shared/pi-spawn.ts")).href
);

test("subagents relaunch a PiDeck-marked standalone Pi through its own executable", () => {
	const spawn = getPiSpawnCommand(["--mode", "json"], {
		platform: "win32",
		execPath: "C:\\Pi-Bolt\\pi-bolt.exe",
		env: { PIDECK_PI_STANDALONE: "1" },
	});
	assert.deepEqual(spawn, { command: "C:\\Pi-Bolt\\pi-bolt.exe", args: ["--mode", "json"] });
});

test("an unmarked pi-bolt executable is not guessed to be standalone", () => {
	// 没有标记时按“Node + CLI 脚本”解析；这里让所有解析途径都落空，结果必须是明确报错，
	// 而不是把 pi-bolt.exe 当作可直接复用的独立二进制。
	assert.throws(
		() => getPiSpawnCommand(["--mode", "json"], {
			platform: "win32",
			execPath: "C:\\Pi-Bolt\\pi-bolt.exe",
			env: {},
			existsSync: () => false,
			argv1: "",
			resolvePackageEntry: () => {
				throw new Error("no Pi package in this test");
			},
		}),
		/Could not resolve the Pi CLI on Windows/,
	);
});
test("stock pi.exe is still recognised as standalone without any marker", () => {
	const spawn = getPiSpawnCommand(["-p"], { platform: "win32", execPath: "C:\\Pi\\pi.exe", env: {} });
	assert.deepEqual(spawn, { command: "C:\\Pi\\pi.exe", args: ["-p"] });
});

// ── 设置兼容 ───────────────────────────────────────────────────────

test("a settings file saved before Pi-Bolt support loads with an empty Pi-Bolt path and keeps its other choices", async () => {
	const { SettingsStore } = loadTsCommonJs("src/main/settings/SettingsStore.ts");
	const root = mkdtempSync(join(tmpdir(), "pideck-bolt-settings-"));
	try {
		const desktopSettingsFile = join(root, "settings.json");
		writeFileSync(desktopSettingsFile, JSON.stringify({ piRuntimePreference: "rust", piRustPath: "/opt/pi-rust" }));
		const store = new SettingsStore({ desktopSettingsFile, piAgentSettingsFile: join(root, "missing") });
		await store.load();
		assert.equal(store.get().piBoltPath, "");
		assert.equal(store.get().piRuntimePreference, "rust");
		assert.equal(store.get().piRustPath, "/opt/pi-rust");
		// 选择 bolt 并保存后重启仍能读回。
		await store.update({ piRuntimePreference: "bolt", piBoltPath: "C:\\Pi-Bolt\\pi-bolt.exe" });
		const saved = JSON.parse(readFileSync(desktopSettingsFile, "utf8"));
		assert.equal(saved.piRuntimePreference, "bolt");
		assert.equal(saved.piBoltPath, "C:\\Pi-Bolt\\pi-bolt.exe");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// ── 三处独立定义的环境变量名必须一致 ───────────────────────────────

test("the standalone marker name is identical in PiDeck and both bundled extensions", async () => {
	const { PIDECK_PI_STANDALONE_ENV: host } = loadTsCommonJs("src/shared/piCompatibility.ts");
	const { PIDECK_PI_STANDALONE_ENV: subagents } = await import(
		pathToFileURL(join(process.cwd(), "resources/extensions/pideck-q-subagents/src/runs/shared/pi-spawn.ts")).href
	);
	const { PIDECK_PI_STANDALONE_ENV: promptRewriter } = await import(
		pathToFileURL(join(process.cwd(), "resources/extensions/pideck-q-change-pi-prompt/runtime.ts")).href
	);
	// 扩展随应用独立打包，不能 import src/shared，所以各自保留一份常量；改名时必须三处同步。
	assert.equal(subagents, host);
	assert.equal(promptRewriter, host);
});
