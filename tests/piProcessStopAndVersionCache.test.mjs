import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { loadPiProcess } from "./helpers/loadPiProcess.mjs";
import { trackedTempDirs } from "./helpers/trackedTempDirs.mjs";

const makeTempDir = trackedTempDirs();

/**
 * PiProcess.stop() 的退出顺序：先关 stdin 让 pi 走自身的优雅退出（session_shutdown 等），
 * 宽限期过后才强制结束；经 cmd.exe 包装的进程必须杀进程树，否则 kill() 只结束 cmd。
 * 只替换 spawn/execFile 与定时器边界。
 */

/** 可手动推进的假定时器：只记录登记与清除，测试决定何时触发。 */
function fakeTimers() {
	const pending = new Map();
	let nextId = 1;
	return {
		timers: {
			setTimeout: (fn, delay) => {
				const id = nextId++;
				pending.set(id, { fn, delay });
				return { id, unref() { return this; }, ref() { return this; } };
			},
			clearTimeout: (handle) => {
				if (handle) pending.delete(handle.id);
			},
		},
		pending,
		fireAll() {
			for (const [id, timer] of [...pending]) {
				pending.delete(id);
				timer.fn();
			}
		},
	};
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

function locatorFor(invocation) {
	return {
		resolveCommand: () => "test-pi",
		createInvocation: (command, args) => ({ command, args, shell: false, ...invocation }),
		createProcessEnv: () => ({}),
	};
}

async function startedProcess({ platform = "win32", invocation = {} } = {}) {
	const spawnCalls = [];
	const execCalls = [];
	const clock = fakeTimers();
	const { PiProcess } = loadPiProcess(spawnCalls, { timers: clock.timers, platform, execCalls });
	const pi = new PiProcess(process.cwd(), { piRpcOffline: true }, locatorFor(invocation));
	await pi.start(undefined, undefined, true);
	return { pi, child: spawnCalls[0].child, clock, execCalls };
}

test("stop ends stdin first and only kills after the grace period", async () => {
	const h = await startedProcess();
	h.pi.stop();
	await flush();
	assert.deepEqual(h.child.actions, ["stdin-end"], "no kill before the grace period elapses");
	assert.equal(h.clock.pending.size, 1);
	const [timer] = h.clock.pending.values();
	assert.ok(timer.delay >= 1_000, `grace period too short: ${timer.delay}ms`);
	h.clock.fireAll();
	assert.deepEqual(h.child.actions, ["stdin-end", "kill"]);
});

test("a graceful exit within the grace period clears the kill timer", async () => {
	const h = await startedProcess();
	h.pi.stop();
	await flush();
	h.child.emit("exit", 0, null);
	assert.equal(h.clock.pending.size, 0, "the force-kill timer must be cleared on exit");
	assert.deepEqual(h.child.actions, ["stdin-end"]);
});

test("repeated stop calls do not stack additional kill timers", async () => {
	const h = await startedProcess();
	h.pi.stop();
	h.pi.stop();
	assert.equal(h.clock.pending.size, 1);
});

test("cmd.exe-wrapped processes are force-terminated as a whole tree", async () => {
	const h = await startedProcess({ invocation: { windowsVerbatimArguments: true } });
	h.pi.stop();
	h.clock.fireAll();
	await flush();
	assert.equal(h.execCalls.length, 1);
	assert.equal(JSON.stringify(h.execCalls[0].args), JSON.stringify(["/PID", String(h.child.pid), "/T", "/F"]));
	assert.ok(!h.child.actions.includes("kill"), "taskkill succeeded, so no fallback kill");
});

test("directly spawned executables are force-terminated with kill(), not taskkill", async () => {
	const h = await startedProcess({ invocation: { windowsVerbatimArguments: false } });
	h.pi.stop();
	h.clock.fireAll();
	await flush();
	assert.equal(h.execCalls.length, 0);
	assert.ok(h.child.actions.includes("kill"));
});

// ── A7: 版本缓存随二进制替换失效 ───────────────────────────────────────

test("replacing a local pi binary invalidates its cached version probe", async () => {
	const dir = makeTempDir("pideck-version-cache-");
	const binary = join(dir, "pi-bolt.exe");
	writeFileSync(binary, "v1");
	let calls = 0;
	const { PiProcess } = loadPiProcess([], {
		versionResult: () => {
			calls += 1;
			return { error: null, stdout: calls === 1 ? "1.4.0" : "1.5.0" };
		},
	});
	const locator = {
		resolveCommand: () => binary,
		createInvocation: (command, args) => ({ command, args }),
		createProcessEnv: () => ({}),
	};
	assert.equal(await PiProcess.warmVersionCache(undefined, locator), true);
	assert.equal(await PiProcess.warmVersionCache(undefined, locator), true);
	assert.equal(calls, 1, "an unchanged binary keeps using the cached probe");
	// 升级安装：大小变化即可判定为新文件（mtime 在快速写入时可能相同）。
	writeFileSync(binary, "version-two");
	assert.equal(await PiProcess.warmVersionCache(undefined, locator), true);
	assert.equal(calls, 2, "a replaced binary must be probed again");
});

test("bare command names keep the plain command-keyed cache", async () => {
	let calls = 0;
	const { PiProcess } = loadPiProcess([], {
		versionResult: () => {
			calls += 1;
			return { error: null, stdout: "1.4.0" };
		},
	});
	const locator = {
		resolveCommand: () => "pi",
		createInvocation: (command, args) => ({ command, args }),
		createProcessEnv: () => ({}),
	};
	await PiProcess.warmVersionCache(undefined, locator);
	await PiProcess.warmVersionCache(undefined, locator);
	assert.equal(calls, 1);
});

test("stop remains pending after forced kill until the process actually exits", async () => {
 const h = await startedProcess();
 let finished = false;
 const stopping = h.pi.stop().then(result => { finished = true; return result; });
 h.clock.fireAll(); await flush();
 assert.equal(finished, false);
 h.child.emit("exit", 0, null);
 assert.equal(await stopping, true);
 assert.equal(h.clock.pending.size, 0);
});

test("stop reports an unconfirmed shutdown when the process ignores forced termination", async () => {
 const h = await startedProcess();
 const stopping = h.pi.stop();
 h.clock.fireAll(); h.clock.fireAll();
 assert.equal(await stopping, false);
 assert.equal(h.pi.isRunning(), true, "do not pretend a still-live process exited");
 assert.equal(h.clock.pending.size, 0);
 h.child.emit("exit", 0, null);
});
