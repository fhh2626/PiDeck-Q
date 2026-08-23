import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";
import { createStore } from "jotai/vanilla";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

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

test("source contract: useSessionTimelineController passes `before` (not `requestBefore`) to prependHistoryPage", () => {
	const source = readFileSync("src/renderer/src/hooks/useSessionTimelineController.ts", "utf8");
	// 确保传给 prependHistoryPage 的是 renderer continuation cursor `before`，
	// 而不是磁盘读取游标 `requestBefore`（数值 windowStartFilePos 会导致首页被 session-atoms 拒绝）
	assert.match(
		source,
		/prependHistoryPage\(\{\s*sessionId,\s*expectedRevision,\s*before,\s*page\s*\}\)/,
	);
	assert.doesNotMatch(
		source,
		/prependHistoryPage\(\{\s*sessionId,\s*expectedRevision,\s*before:\s*requestBefore,\s*page\s*\}\)/,
	);
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

test("source contract: compaction_end passes settledProcess and settledGeneration to markIdleIfPiReportsNoWork", () => {
	const source = readFileSync("src/main/pi/AgentManager.ts", "utf8");
	// 验证 compaction_end 代码块中绑定了 settledProcess 和 settledGeneration
	const compactionEndMatch = source.match(
		/if \(typed\.type === "compaction_end" \|\| typed\.type === "auto_compaction_end"\) \{[\s\S]*?\n\t\t\}/,
	);
	assert.ok(compactionEndMatch, "compaction_end handler block found");
	const block = compactionEndMatch[0];
	assert.match(block, /const settledProcess = runtime\.process;/);
	assert.match(block, /const settledGeneration = this\.getStreamGate\(agentId\)\.currentGeneration;/);
	assert.match(block, /markIdleIfPiReportsNoWork\(\s*agentId,\s*settledProcess,\s*settledGeneration,?\s*\)/);
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
