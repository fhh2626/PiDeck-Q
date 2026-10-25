import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";
import { createStore } from "jotai/vanilla";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { withTimelineController } from "./helpers/l6_timelineControllerHarness.mjs";

const nodeRequire = createRequire(import.meta.url);

function compileModule(filePath, imports = {}) {
	const source = readFileSync(filePath, "utf8");
	const output = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
			esModuleInterop: true,
		},
		fileName: filePath,
	}).outputText;
	const module = { exports: {} };
	const localRequire = (specifier) => imports[specifier] ?? nodeRequire(specifier);
	vm.runInNewContext(output, {
		module,
		exports: module.exports,
		require: localRequire,
		console,
		Date,
		Set,
	}, { filename: filePath });
	return module.exports;
}

function loadAtoms() {
	const runtimeState = compileModule("src/renderer/src/utils/agentRuntimeState.ts");
	const sessionRecordIdentity = compileModule("src/renderer/src/utils/sessionRecordIdentity.ts");
	const messageFingerprint = compileModule("src/shared/messageFingerprint.ts");
	const sessions = compileModule("src/renderer/src/atoms/session-atoms.ts", {
		"../utils/agentRuntimeState": runtimeState,
		"../utils/sessionRecordIdentity": sessionRecordIdentity,
		"../../../shared/messageFingerprint": messageFingerprint,
		"../utils/historyTurnWindow": compileModule("src/renderer/src/utils/historyTurnWindow.ts"),
	});
	return sessions;
}

function deferred() {
	let resolve;
	let reject;
	const promise = new Promise((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

// ── 1. 压缩后分页加载测试 ──

/** 压缩后的 runtime 窗口：首条是无 entryId 的系统摘要卡片，windowStartFilePos=24，history 尚未加载。 */
function seedCompactedRuntimeWindow(store, atoms, sessionId) {
	store.set(atoms.applySessionRuntimeEventAtom, {
		sessionId,
		agentId: "agent-compaction-hook",
		runtimeGeneration: 1,
		sourceChannel: "agents:message",
		payload: {
			agentId: "agent-compaction-hook",
			windowStart: 0,
			totalLength: 30,
			windowStartFilePos: 24,
			messages: [
				{ id: "compaction-summary", role: "system", text: "已压缩", meta: {} },
				{ id: "r1", role: "user", text: "最近问题", meta: {} },
				{ id: "r2", role: "assistant", text: "最近回答", meta: {} },
			],
		},
	});
}

const OLDER_TURN_PAGE = {
	messages: [
		{ id: "h1", role: "user", text: "旧问题1", meta: { entryId: "e1" } },
		{ id: "h2", role: "assistant", text: "旧回答1", meta: { entryId: "e2" } },
	],
	total: 30,
	nextBefore: 12,
	indexVersion: "1:1",
};

/** 首屏磁盘读取（50 轮、无游标）返回空页；其余调用按 history 页应答。 */
function respondWithHistory(historyPage) {
	return (call) => Promise.resolve(
		call.before === undefined && call.opts.beforeEntryId === undefined
			? { messages: [], total: 0, nextBefore: null }
			: historyPage,
	);
}

test("timeline controller: first history page after compaction is accepted although the disk cursor is numeric (24)", async () => {
	// 回归：hook 若把磁盘读取游标 requestBefore(24) 当作 renderer continuation cursor 传给
	// prependSessionHistoryPageAtom，首页会被 atom 拒绝（!history && before !== undefined），
	// 表现为压缩后上翻/自动补页静默失败。这里挂载真实 hook，从 atom 结果与 IPC 调用两侧断言。
	await withTimelineController({ respond: respondWithHistory(OLDER_TURN_PAGE) }, async ({ atoms, store, calls, mount }) => {
		seedCompactedRuntimeWindow(store, atoms, "session-hook-1");
		await mount("session-hook-1");

		const historyCall = calls.find((call) => call.before === 24);
		assert.ok(historyCall, "history page must be requested with the disk cursor windowStartFilePos=24");
		const entry = store.get(atoms.sessionMessagesCacheAtom)["session-hook-1"];
		assert.ok(entry.history, "history prefix must be established, not rejected by the atom");
		assert.equal(entry.history.messages.length, 2);
		assert.equal(entry.history.nextBefore, 12);
	});
});

test("timeline controller: window below the 50-turn floor requests exactly the missing turns once", async () => {
	// 运行中会话「前缀 + 窗口」不足 50 轮且还有更早历史：必须自动补足差额（49 轮），
	// 且同一缓存状态只尝试一次（不形成请求循环）。
	await withTimelineController({ respond: respondWithHistory({ ...OLDER_TURN_PAGE, messages: [] }) }, async ({ atoms, store, calls, mount }) => {
		seedCompactedRuntimeWindow(store, atoms, "session-hook-2");
		await mount("session-hook-2");

		const topUps = calls.filter((call) => call.before === 24);
		assert.equal(topUps.length, 1, "same cache state must only be tried once");
		assert.equal(topUps[0].pageSize, 49, "1 turn in window => 49 missing turns");
		assert.equal(topUps[0].opts.unit, "turn");
	});
});

test("timeline controller: user scroll-up loads one 3-turn page through the same history loader", async () => {
	// 用户上滚（loadMoreMessages）与自动保底补页共用 loadRuntimeHistoryPage：
	// 窗口已满 50 轮时不会自动补页，上滚才请求 3 轮，并以窗口首条 entryId 为锚点。
	const windowMessages = [];
	for (let i = 1; i <= 50; i += 1) {
		windowMessages.push(
			{ id: `wu${i}`, role: "user", text: `q${i}`, meta: { entryId: `wu-e${i}` } },
			{ id: `wa${i}`, role: "assistant", text: `a${i}`, meta: { entryId: `wa-e${i}` } },
		);
	}
	await withTimelineController({ respond: respondWithHistory(OLDER_TURN_PAGE) }, async ({ atoms, store, calls, mount, controller, act }) => {
		store.set(atoms.applySessionRuntimeEventAtom, {
			sessionId: "session-hook-3",
			agentId: "agent-hook-3",
			runtimeGeneration: 1,
			sourceChannel: "agents:message",
			payload: {
				agentId: "agent-hook-3",
				windowStart: 40,
				totalLength: 140,
				windowStartFilePos: 40,
				messages: windowMessages,
			},
		});
		await mount("session-hook-3");
		assert.equal(calls.filter((call) => call.pageSize !== 50).length, 0, "no automatic top-up at the floor");

		await act(async () => {
			controller().loadMoreMessages();
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		const scrollUp = calls.find((call) => call.pageSize === 3);
		assert.ok(scrollUp, "scroll-up must request a 3-turn page");
		assert.equal(scrollUp.opts.beforeEntryId, "wu-e1", "first scroll-up anchors on the window's first entryId");
		assert.ok(store.get(atoms.sessionMessagesCacheAtom)["session-hook-3"].history);
	});
});

test("compaction pagination: windowStartFilePos fallback passes before=undefined to atom, establishing history", () => {
	const atoms = loadAtoms();
	const store = createStore();
	const sessionId = "session-compaction-1";
	const entry = () => store.get(atoms.sessionMessagesCacheAtom)[sessionId];

	// 模拟压缩后/大窗口会话的 runtime 消息段：窗口首条无 entryId（如系统卡片），
	// 且 windowStartFilePos = 24，history 尚未加载（undefined）。
	store.set(atoms.applySessionRuntimeEventAtom, {
		sessionId,
		agentId: "agent-compaction-1",
		runtimeGeneration: 1,
		sourceChannel: "agents:message",
		payload: {
			agentId: "agent-compaction-1",
			windowStart: 0,
			totalLength: 30,
			windowStartFilePos: 24,
			messages: [
				{ id: "compaction-summary", role: "system", text: "已压缩", meta: {} },
				{ id: "r1", role: "user", text: "最近问题", meta: { entryId: "e25" } },
				{ id: "r2", role: "assistant", text: "最近回答", meta: { entryId: "e26" } },
			],
		},
	});

	assert.equal(entry().history, undefined);
	assert.equal(entry().windowStartFilePos, 24);

	// 回归验证：如果像旧代码那样把 requestBefore (24) 当作 before 传给 atom，
	// 会被 prependSessionHistoryPageAtom 拒绝（!current.history && before !== undefined）
	const oldBuggyResult = store.set(atoms.prependSessionHistoryPageAtom, {
		sessionId,
		expectedRevision: entry().revision,
		before: 24,
		page: {
			messages: [
				{ id: "h1", role: "user", text: "旧问题1", meta: { entryId: "e1" } },
				{ id: "h2", role: "assistant", text: "旧回答1", meta: { entryId: "e2" } },
			],
			total: 30,
			nextBefore: 12,
			indexVersion: "1:1",
		},
	});
	assert.equal(oldBuggyResult, false, "old buggy cursor mixup must return false");
	assert.equal(entry().history, undefined, "history must remain undefined when rejected");

	// 修复后：首次加载传入 before: undefined，即使底层从 requestBefore=24 读取，
	// atom 正常建立 history 前缀
	const fixedFirstPageResult = store.set(atoms.prependSessionHistoryPageAtom, {
		sessionId,
		expectedRevision: entry().revision,
		before: undefined,
		page: {
			messages: [
				{ id: "h1", role: "user", text: "旧问题1", meta: { entryId: "e1" } },
				{ id: "h2", role: "assistant", text: "旧回答1", meta: { entryId: "e2" } },
			],
			total: 30,
			nextBefore: 12,
			indexVersion: "1:1",
		},
	});
	assert.equal(fixedFirstPageResult, true, "fixed first page with before=undefined must succeed");
	assert.ok(entry().history, "history should now be present");
	assert.equal(entry().history.nextBefore, 12);
	assert.equal(entry().history.messages.length, 2);

	// 第二次加载（续页）：before = current.history.nextBefore (12)
	const continuationResult = store.set(atoms.prependSessionHistoryPageAtom, {
		sessionId,
		expectedRevision: entry().revision,
		before: 12,
		page: {
			messages: [
				{ id: "h0", role: "user", text: "最旧问题", meta: { entryId: "e0" } },
			],
			total: 30,
			nextBefore: null,
			indexVersion: "1:1",
		},
	});
	assert.equal(continuationResult, true, "continuation page with matching cursor must succeed");
	assert.equal(entry().history.nextBefore, null);
	assert.equal(entry().history.messages.length, 3);
});

// ── 2. Compaction race 测试 ──

/**
 * 构造一个已推进到 generation=10、get_state 由测试控制的 AgentManager。
 * 必须在加载 AgentManager 之前启用 mock timers：vm 沙箱在加载时捕获 setTimeout。
 */
function createRaceHarness(agentId, getStateDeferred) {
	const { AgentManager } = loadTsCommonJs("src/main/pi/AgentManager.ts");
	const makeProcess = () => ({
		client: {
			request: async (req) => (req.type === "get_state" ? getStateDeferred.promise : { success: true, data: {} }),
		},
	});
	const manager = new AgentManager(
		() => ({ id: "project-1", name: "Project", path: "C:/project" }),
		() => null,
		{ get: () => ({}) },
		{},
	);
	const runtime = {
		tab: {
			id: agentId,
			projectId: "project-1",
			cwd: "C:/project",
			title: "Race Test Session",
			status: "running",
			sessionPath: "C:/project/session.jsonl",
			sessionEnvironment: "native",
			sessionSource: "pi",
			createdAt: 1,
		},
		process: makeProcess(),
	};
	manager.agents.set(agentId, runtime);
	for (let i = 0; i < 10; i += 1) manager.openAgentStream(agentId);
	return { manager, runtime, makeProcess };
}

const PI_IDLE_STATE = {
	success: true,
	data: { isStreaming: false, isCompacting: false, pendingMessageCount: 0 },
};

async function flushMicrotasks() {
	for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

test("compaction_end fallback timer: a newer generation started before the timer fires is not idled", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const getStateDeferred = deferred();
	const { manager, runtime } = createRaceHarness("agent-compaction-end-gen", getStateDeferred);
	assert.equal(manager.getStreamGate("agent-compaction-end-gen").currentGeneration, 10);

	// 真实事件入口：compaction_end 在 generation 10 排一个 300ms 兜底 idle 检查。
	manager.handlePiEvent("agent-compaction-end-gen", { type: "compaction_end", reason: "threshold" });
	// 事件之后、兜底定时器触发之前新任务启动（generation 11）：定时器必须使用事件时快照的
	// generation 10，而不是触发时再取当前值，否则会把新一轮误判为已结束。
	manager.openAgentStream("agent-compaction-end-gen");
	runtime.tab.status = "running";
	t.mock.timers.tick(300);
	await flushMicrotasks();
	// 旧 generation 的 get_state 返回“无工作”。
	getStateDeferred.resolve(PI_IDLE_STATE);
	await flushMicrotasks();

	assert.equal(runtime.tab.status, "running", "newer generation must not be settled by the stale check");
});

test("compaction_end fallback timer: a process restarted before the timer fires is not idled", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const getStateDeferred = deferred();
	const { manager, runtime, makeProcess } = createRaceHarness("agent-compaction-end-proc", getStateDeferred);

	manager.handlePiEvent("agent-compaction-end-proc", { type: "compaction_end", reason: "threshold" });
	// 事件之后、兜底定时器触发之前进程被重启（新的 PiProcess）：定时器必须绑定事件时的旧进程，
	// 不能在触发时重新取 runtime.process，否则新进程会被旧事件的兜底检查收口。
	runtime.process = makeProcess();
	runtime.tab.status = "running";
	t.mock.timers.tick(300);
	await flushMicrotasks();
	getStateDeferred.resolve(PI_IDLE_STATE);
	await flushMicrotasks();

	assert.equal(runtime.tab.status, "running", "restarted process must not be settled by the old process' state");
});

test("compaction_end fallback timer still settles an unchanged run when Pi reports no work", async (t) => {
	// 反向对照：无并发变化时兜底检查应当收口为 idle，证明上面两个用例不是因为兜底整体失效而通过。
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const getStateDeferred = deferred();
	const { manager, runtime } = createRaceHarness("agent-compaction-end-ok", getStateDeferred);

	manager.handlePiEvent("agent-compaction-end-ok", { type: "compaction_end", reason: "threshold" });
	t.mock.timers.tick(300);
	getStateDeferred.resolve(PI_IDLE_STATE);
	await flushMicrotasks();

	assert.notEqual(runtime.tab.status, "running");
});

test("compaction race: in-flight get_state from old generation does not settle new generation run", async () => {
	const { AgentManager } = loadTsCommonJs("src/main/pi/AgentManager.ts");

	const getStateDeferred = deferred();
	let clientRequestCalls = 0;

	const mockProcess = {
		client: {
			request: async (req) => {
				if (req.type === "get_state") {
					clientRequestCalls++;
					return getStateDeferred.promise;
				}
				return { success: true, data: {} };
			},
		},
	};

	const manager = new AgentManager(
		() => ({ id: "project-1", name: "Project", path: "C:/project" }),
		() => null,
		{ get: () => ({}) },
		{},
	);

	const agentId = "agent-compaction-race";
	const runtime = {
		tab: {
			id: agentId,
			projectId: "project-1",
			cwd: "C:/project",
			title: "Race Test Session",
			status: "running",
			sessionPath: "C:/project/session.jsonl",
			sessionEnvironment: "native",
			sessionSource: "pi",
			createdAt: 1,
		},
		process: mockProcess,
	};
	manager.agents.set(agentId, runtime);

	// 1. 模拟 generation 10
	manager.openAgentStream(agentId); // gen 1
	for (let i = 2; i <= 10; i++) {
		manager.openAgentStream(agentId);
	}
	const gen10 = manager.getStreamGate(agentId).currentGeneration;
	assert.equal(gen10, 10);

	// 2. 模拟 compaction_end 触发 markIdleIfPiReportsNoWork (generation 10)
	const idleCheckPromise = manager.markIdleIfPiReportsNoWork(
		agentId,
		mockProcess,
		gen10,
	);

	// 此时 get_state 已经在途
	assert.equal(clientRequestCalls, 1);

	// 3. 在 get_state 返回前，新任务启动 (generation 11)
	manager.openAgentStream(agentId);
	const gen11 = manager.getStreamGate(agentId).currentGeneration;
	assert.equal(gen11, 11);
	runtime.tab.status = "running";

	// 4. 旧的 get_state (gen 10) 结果返回：Pi 报告无工作
	getStateDeferred.resolve({
		success: true,
		data: {
			isStreaming: false,
			isCompacting: false,
			pendingMessageCount: 0,
		},
	});

	await idleCheckPromise;

	// 5. 验证：新 generation 11 没有被错误置为 idle，状态依然是 running
	assert.equal(runtime.tab.status, "running", "runtime tab status must remain 'running'");
});

test("markIdleIfPiReportsNoWork snapshots process and generation at call time when not explicitly passed", async () => {
	const { AgentManager } = loadTsCommonJs("src/main/pi/AgentManager.ts");

	const getStateDeferred = deferred();

	const mockProcess = {
		client: {
			request: async (req) => {
				if (req.type === "get_state") {
					return getStateDeferred.promise;
				}
				return { success: true, data: {} };
			},
		},
	};

	const manager = new AgentManager(
		() => ({ id: "project-1", name: "Project", path: "C:/project" }),
		() => null,
		{ get: () => ({}) },
		{},
	);

	const agentId = "agent-snapshot-test";
	const runtime = {
		tab: {
			id: agentId,
			projectId: "project-1",
			cwd: "C:/project",
			title: "Snapshot Test Session",
			status: "running",
			sessionPath: "C:/project/session.jsonl",
			sessionEnvironment: "native",
			sessionSource: "pi",
			createdAt: 1,
		},
		process: mockProcess,
	};
	manager.agents.set(agentId, runtime);

	// Generation 5
	for (let i = 1; i <= 5; i++) {
		manager.openAgentStream(agentId);
	}
	assert.equal(manager.getStreamGate(agentId).currentGeneration, 5);

	// 调用时未显式传 process 和 generation
	const idlePromise = manager.markIdleIfPiReportsNoWork(agentId);

	// 在 RPC 返回前晋升 generation 到 6
	manager.openAgentStream(agentId);
	assert.equal(manager.getStreamGate(agentId).currentGeneration, 6);
	runtime.tab.status = "running";

	// 旧 get_state 响应
	getStateDeferred.resolve({
		success: true,
		data: {
			isStreaming: false,
			isCompacting: false,
			pendingMessageCount: 0,
		},
	});

	await idlePromise;

	// 即使没有显式传参，内部默认 snapshot 也保护了新 generation 不被关闭
	assert.equal(runtime.tab.status, "running", "runtime status must remain running even when called without explicit args");
});
