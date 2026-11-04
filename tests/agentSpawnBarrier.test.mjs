import assert from "node:assert/strict";
import test from "node:test";

import {
	createFakePiManager,
	loadAgentManagerWithFakePi,
	settle,
} from "./helpers/l4_agentManagerHarness.mjs";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 首次 spawn 前必须跨过启动屏障（回归测试）。
 *
 * 背景：内置扩展改为 `-e` 注入后，旧全局入口 `<agentDir>/extensions/*.ts` 仍会被
 * pi 自动发现。迁移是启动期异步任务，若它没跑完就有 Agent 起来，同一个扩展会加载
 * 两份（重复的 system prompt 钩子与命令）。因此 createPiProcess 必须先 await
 * 屏障，再构造 PiProcess。
 */

/** 本机 node_modules/electron 未装二进制：真实 require 会触发下载（60s+），一律 stub。 */
const ELECTRON_STUB = { app: {}, Notification: class {} };

/**
 * 加载 AgentManager，把 PiProcess 换成只记录构造时机的替身。
 * @param {(event: string) => void} onConstruct
 */
function loadAgentManager(onConstruct) {
	return loadTsCommonJs("src/main/pi/AgentManager.ts", {
		stubs: {
			electron: ELECTRON_STUB,
			"./PiProcess": {
				PiProcess: class {
					constructor() {
						onConstruct("construct");
					}
					on() {}
				},
			},
		},
	});
}

const BASE_PLATFORM_DEPS = {
	appName: "PiDeck",
	appPath: "/app",
	resourcesPath: "/res",
	isPackaged: true,
	notifications: { isSupported: () => false, show: () => undefined },
	focusSessionFromNotification: () => false,
};

function createManager(loaded, platformDeps, appLogger) {
	// 位置参数顺序与 createBackend 装配一致：仅填用到 spawn 路径的几项。
	return new loaded.AgentManager(
		() => undefined,
		() => null,
		{ get: () => ({}) },
		{},
		undefined,
		appLogger,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		platformDeps,
	);
}

/** TS 的 private 只是编译期约束，运行时按普通方法取。 */
function createPiProcess(manager, cwd) {
	return Reflect.get(manager, "createPiProcess").call(manager, cwd);
}

test("pi process is constructed only after the startup barrier settles", async () => {
	const order = [];
	let releaseBarrier;
	const loaded = loadAgentManager((event) => order.push(event));
	const manager = createManager(loaded, {
		...BASE_PLATFORM_DEPS,
		startupBarrier: {
			add: () => undefined,
			wait: () => new Promise((resolve) => { releaseBarrier = resolve; }),
		},
	});

	const creating = createPiProcess(manager, "/proj");
	await Promise.resolve();
	assert.deepEqual(order, [], "PiProcess must not be constructed while the barrier is pending");
	releaseBarrier(true);
	await creating;
	assert.deepEqual(order, ["construct"]);
});

test("a timed-out barrier is logged but never blocks agent startup", async () => {
	const order = [];
	const warnings = [];
	const loaded = loadAgentManager((event) => order.push(event));
	const manager = createManager(
		loaded,
		{
			...BASE_PLATFORM_DEPS,
			// UNC 指向被挂起的 WSL 时 wait() 返回 false：记日志后照常 spawn。
			startupBarrier: { add: () => undefined, wait: async () => false },
		},
		{
			info: () => undefined,
			warn: (scope, message, detail) => warnings.push({ scope, message, detail }),
			error: () => undefined,
		},
	);

	await createPiProcess(manager, "/proj");
	assert.deepEqual(order, ["construct"], "a timed-out barrier must not block agent startup");
	assert.ok(
		warnings.some((w) => /barrier/i.test(w.message)),
		"the timeout must be diagnosable in the app log",
	);
});

test("absent barrier (unit hosts / standalone backends) keeps the spawn path working", async () => {
	const order = [];
	const loaded = loadAgentManager((event) => order.push(event));
	const manager = createManager(loaded, { ...BASE_PLATFORM_DEPS });

	await createPiProcess(manager, "/proj");
	assert.deepEqual(order, ["construct"]);
});

/**
 * 三条 spawn 路径（create / 历史 clone 的临时进程 / 压缩后 reattach）都必须经过
 * 屏障：屏障挂起时不得构造 PiProcess，放行后必须用真正的 PiProcess 实例继续 start()。
 * 若某条路径漏写 await，拿到的会是 Promise，后续 on()/start() 会直接抛错。
 */
async function expectSpawnPathHonoursBarrier(invoke) {
	let releaseBarrier;
	const harness = loadAgentManagerWithFakePi();
	const manager = createFakePiManager(harness, {
		platformDeps: {
			...BASE_PLATFORM_DEPS,
			startupBarrier: {
				add: () => undefined,
				wait: () => new Promise((resolve) => { releaseBarrier = resolve; }),
			},
		},
	});

	const running = invoke(manager).catch(() => undefined);
	await settle();
	assert.deepEqual(harness.log, [], "屏障挂起期间不得构造 PiProcess");

	releaseBarrier(true);
	await running;
	await settle();
	assert.equal(harness.log[0], "construct", "屏障放行后才构造 PiProcess");
	assert.ok(harness.log.includes("start"), "放行后必须对真实 PiProcess 调用 start()");
}

test("create() waits for the startup barrier before spawning", async () => {
	await expectSpawnPathHonoursBarrier((manager) => manager.create({ projectId: "p1" }));
});

test("cloneSessionFile() temporary process waits for the startup barrier", async () => {
	await expectSpawnPathHonoursBarrier((manager) => manager.cloneSessionFile("p1", "/proj/s.jsonl"));
});

test("reattach after compaction waits for the startup barrier", async () => {
	await expectSpawnPathHonoursBarrier((manager) => {
		manager.agents.set("a1", {
			tab: { id: "a1", projectId: "p1", cwd: "/proj", title: "t", status: "running", createdAt: 1 },
			process: { isRunning: () => false },
		});
		// reattachProcess 无公开入口（仅 compact 的进程退出分支内部使用），按普通方法取用
		return Reflect.get(manager, "reattachProcess").call(manager, "a1", "/proj/s.jsonl");
	});
});