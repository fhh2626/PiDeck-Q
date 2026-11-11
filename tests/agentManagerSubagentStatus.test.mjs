import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { createFakeClock } from "./helpers/fakeClock.mjs";

// AgentManager → 侧栏子代理状态投影的接线测试：真实 handlePiEvent，只替身化 pi 进程与投影器。
// 覆盖点：工具事件是否真的发出 agents:subagent-status、终态是否清条目、失败是否保留、
// 回合结束是否清 running、清理路径是否补推空快照。

const require = createRequire(import.meta.url);

function transpile(filePath) {
	return ts.transpileModule(readFileSync(filePath, "utf8"), {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
	}).outputText;
}

function loadModule(filePath, customRequire, globals = {}) {
	const sandbox = {
		clearTimeout,
		setTimeout,
		process,
		exports: {},
		require: customRequire ?? require,
		...globals,
	};
	vm.runInNewContext(transpile(filePath), sandbox, { filename: filePath });
	return sandbox.exports;
}

const ipc = loadModule("src/shared/ipc.ts");
const askQuestion = loadModule("src/shared/askQuestion.ts");
const sessionIdentity = loadModule("src/shared/sessionIdentity.ts");
const messageDeliveryBudget = loadModule("src/main/pi/messageDeliveryBudget.ts");
const agentUtils = loadModule("src/main/pi/agentUtils.ts", (id) => {
	if (id.includes("messageDeliveryBudget")) return messageDeliveryBudget;
	return require(id);
});
const wslPaths = loadModule("src/main/wsl/WslPaths.ts");
const piCompatibility = loadModule("src/shared/piCompatibility.ts");
const agentMessageProjector = {
	// 工具行构造会用到这些纯格式化方法；返回空载体即可，本用例只关心侧栏投影。
	AgentMessageProjector: class {
		constructor() {}
		convert(message) { return message; }
		extractText() { return ""; }
		extractThinking() { return ""; }
		extractToolResultText() { return ""; }
		formatToolDetail() { return undefined; }
		safeJson(value) { return JSON.stringify(value); }
		truncateDetailWithMeta(value) { return { text: String(value ?? ""), truncated: false }; }
		truncateForDetail(value) { return String(value ?? ""); }
	},
};
const sessionFileEditor = { SessionFileEditor: class { constructor() {} } };
const sessionHistoryReader = { SessionHistoryReader: class { constructor() {} } };
const piProcess = { PiProcess: class { constructor() {} } };
const builtInExtensions = { listActiveBuiltInExtensionPaths: () => [] };

function loadAgentManager(globals = {}) {
	return loadModule("src/main/pi/AgentManager.ts", (id) => {
		if (id.includes("shared/ipc")) return ipc;
		if (id.includes("agentUtils")) return agentUtils;
		if (id.includes("WslPaths")) return wslPaths;
		if (id.includes("piCompatibility")) return piCompatibility;
		if (id.includes("SubagentRunTracker")) return loadTsCommonJs("src/main/pi/SubagentRunTracker.ts", { globals });
		if (id.includes("subagentStatusSnapshot")) return loadTsCommonJs("src/main/pi/subagentStatusSnapshot.ts");
		if (id.includes("types/subagents")) return loadTsCommonJs("src/shared/types/subagents.ts");
		if (id.includes("PiProcess")) return piProcess;
		if (id.includes("SessionFileEditor")) return sessionFileEditor;
		if (id.includes("AgentMessageProjector")) return agentMessageProjector;
		if (id.includes("SessionHistoryReader")) return sessionHistoryReader;
		if (id.includes("recoverRecentHistoryLoad")) return loadTsCommonJs("src/main/pi/recoverRecentHistoryLoad.ts");
		if (id.includes("monotonicNow")) return loadTsCommonJs("src/main/transport/monotonicNow.ts");
		if (id.includes("LiveRpcLogBuffer")) return loadTsCommonJs("src/main/pi/LiveRpcLogBuffer.ts");
		if (id.includes("imageContent")) return loadModule("src/shared/imageContent.ts");
		if (id.includes("imageLimits")) return loadModule("src/shared/imageLimits.ts");
		if (id.includes("runtimeImageBudget")) {
			return {
				computeTurnImageUsedBytes: () => 0,
				applyRuntimeMessageImageBudget: (images) => ({ images: images ?? [] }),
				enforceRuntimeImageEviction: () => undefined,
			};
		}
		if (id.includes("builtInExtensions")) return builtInExtensions;
		if (id.includes("toolRuntimeState")) return loadModule("src/shared/toolRuntimeState.ts");
		if (id.includes("askQuestionResult")) return loadModule("src/main/pi/askQuestionResult.ts", (specifier) => (
			specifier.includes("askQuestion") ? askQuestion : require(specifier)
		));
		if (id.includes("historyMessages")) return loadTsCommonJs("src/main/pi/historyMessages.ts");
		if (id.includes("agentSessionIdentity")) return loadModule("src/main/pi/agentSessionIdentity.ts", (specifier) => (
			specifier.includes("sessionIdentity") ? sessionIdentity : require(specifier)
		));
		if (id.includes("streamGate")) return loadModule("src/main/pi/streamGate.ts");
		if (id.includes("bashResult")) return loadModule("src/main/pi/bashResult.ts");
		if (id.includes("cacheHitStats")) return loadModule("src/main/pi/cacheHitStats.ts");
		if (id.includes("LatestByKeyEmitter")) return loadModule("src/main/pi/LatestByKeyEmitter.ts");
		if (id.includes("messageContent")) return loadModule("src/main/pi/messageContent.ts", (specifier) => (
			specifier.includes("hostInstruction") ? loadModule("src/main/pi/hostInstruction.ts") : require(specifier)
		));
		return require(id);
	}, globals);
}

const { AgentManager } = loadAgentManager();

/** 只关心子代理通道：其它 emit（message/state/notice）一律忽略。 */
function createHarness(clock) {
	const Manager = clock ? loadAgentManager(clock.globals).AgentManager : AgentManager;
	const settingsStore = { get: () => ({ enableNotifications: false, removedBuiltInExtensions: [] }) };
	const manager = new Manager(
		() => undefined,
		() => {},
		settingsStore,
		{ getProjectTrustDecision: async () => true },
		{ push: () => {} },
		{ info: () => undefined, warn: () => undefined, error: () => undefined },
		undefined,
		(key) => key,
		undefined,
		undefined,
		undefined,
		() => "session-record-id",
		{
			appName: "PiDeckApp",
			appPath: "/app",
			resourcesPath: "/resources",
			isPackaged: true,
			notifications: { isSupported: () => false, show: () => undefined },
			focusSessionFromNotification: () => true,
			hasLiveWindow: () => true,
		},
	);
	// getRuntimeState 走异步 RPC；本用例只验证子代理投影，桩掉避免噪声。
	manager.getRuntimeState = async () => ({});

	const snapshots = [];
	manager.onOutput((channel, payload) => {
		if (channel !== ipc.ipcChannels.agentsSubagentStatus) return;
		snapshots.push(payload);
	});

	const agentId = "agent-1";
	manager.agents.set(agentId, {
		tab: {
			id: agentId,
			projectId: "project-1",
			cwd: "C:/project",
			title: "Session title",
			status: "running",
			createdAt: 1,
			sessionId: "session-1",
		},
		process: { isRunning: () => true, stop: async () => true, client: { request: async () => ({ success: true }) } },
	});
	manager.messages.set(agentId, []);
	return { manager, agentId, snapshots };
}

function updateEvent(results, toolCallId = "call-1") {
	return {
		type: "tool_execution_update",
		toolName: "subagent",
		toolCallId,
		partialResult: { content: [], details: { mode: "single", results } },
	};
}

function endEvent(results, { toolCallId = "call-1", isError = false } = {}) {
	return {
		type: "tool_execution_end",
		toolName: "subagent",
		toolCallId,
		isError,
		result: { content: [], details: { mode: "single", results } },
	};
}

function childResult(sessionFile, progressStatus, overrides = {}) {
	return {
		index: 0,
		agent: "readonly",
		task: "t",
		exitCode: 0,
		usage: {},
		sessionFile,
		progress: { index: 0, agent: "readonly", status: progressStatus, task: "t", recentTools: [], recentOutput: [], toolCount: 0, tokens: 0, durationMs: 0 },
		...overrides,
	};
}

function summarize(payload) {
	return Array.from(payload?.runs ?? [], (run) => `${run.sessionFile}|${run.status}`);
}

test("tool events publish the subagent projection and clear it on completion", () => {
	const { manager, agentId, snapshots } = createHarness();

	manager.handlePiEvent(agentId, updateEvent([childResult("C:/child/session.jsonl", "running")]));
	assert.deepEqual(snapshots.map(summarize), [["C:/child/session.jsonl|running"]]);

	// 同状态重复帧不再推送：流式期间不能把通道刷满。
	manager.handlePiEvent(agentId, updateEvent([childResult("C:/child/session.jsonl", "running")]));
	assert.equal(snapshots.length, 1);

	// 完成即收灯：completed 不能留在快照里，否则侧栏会「停了还黄着」。
	manager.handlePiEvent(agentId, endEvent([childResult("C:/child/session.jsonl", "completed")]));
	assert.deepEqual(snapshots.map(summarize), [
		["C:/child/session.jsonl|running"],
		[],
	]);
});

test("a failed child keeps its red row through the isError end frame", () => {
	const { manager, agentId, snapshots } = createHarness();

	manager.handlePiEvent(agentId, updateEvent([childResult("C:/child/session.jsonl", "running")]));
	manager.handlePiEvent(agentId, endEvent([
		childResult("C:/child/session.jsonl", "failed", { exitCode: 1, error: "boom" }),
	], { isError: true }));

	// 失败终态必须保留：isError 清理只清 running。
	assert.deepEqual(snapshots.map(summarize), [
		["C:/child/session.jsonl|running"],
		["C:/child/session.jsonl|error"],
	]);
});

test("agent_end clears running rows but keeps failures", () => {
	const { manager, agentId, snapshots } = createHarness();

	manager.handlePiEvent(agentId, updateEvent([childResult("C:/failed.jsonl", "failed", { exitCode: 1 })]));
	manager.handlePiEvent(agentId, updateEvent([childResult("C:/running.jsonl", "running")]));
	snapshots.length = 0;

	manager.handlePiEvent(agentId, { type: "agent_end", messages: [] });

	// running 随回合结束清掉，失败条目保留供回看。
	assert.deepEqual(snapshots.map(summarize), [["C:/failed.jsonl|error"]]);
});

test("stopping an agent pushes an empty snapshot so no stale dot survives", async () => {
	const { manager, agentId, snapshots } = createHarness();

	manager.handlePiEvent(agentId, updateEvent([childResult("C:/child/session.jsonl", "running")]));
	assert.deepEqual(summarize(snapshots.at(-1)), ["C:/child/session.jsonl|running"]);

	await manager.stop(agentId);

	assert.deepEqual(summarize(snapshots.at(-1)), []);
});

test("pi-subagents 在 running 阶段就下发 sessionFile（否则侧栏运行中永远没有条目）", () => {
	// 跨仓契约：PiDeck 的 tracker 按 sessionFile 登记运行态，而扩展的 partial 快照
	// 只是 {...result} 展开。如果 result.sessionFile 只在收尾时赋值，运行期的每一次
	// tool_execution_update 都会被 extractSubagentRunUpdates 丢掉——表现为子代理跑的时候
	// 不点灯、结束后才从终态帧学到一次 completed（用户报告的正是这个顺序）。
	const source = readFileSync(
		"resources/extensions/pideck-q-subagents/src/runs/foreground/execution.ts",
		"utf8",
	);
	const literalStart = source.indexOf("const result: SingleResult = withRunContext({");
	assert.ok(literalStart > 0, "找不到初始 result 字面量");
	const literalEnd = source.indexOf("}, options.context);", literalStart);
	assert.ok(literalEnd > literalStart, "找不到初始 result 字面量的结尾");
	assert.match(
		source.slice(literalStart, literalEnd),
		/sessionFile: options\.sessionFile/,
		"初始 result 必须带上子会话路径，partial 快照才能透出运行中的子会话来",
	);

	// 快照函数必须保留该字段：snapshotStreamResult（onUpdate 用的流式快照）
	// 基于 snapshotResult，而后者靠 {...result} 展开，不是白名单拷贝。
	const snapshotStart = source.indexOf("function snapshotResult(");
	assert.ok(snapshotStart > 0);
	assert.match(source.slice(snapshotStart, snapshotStart + 400), /\.\.\.result,/);
	const streamStart = source.indexOf("function snapshotStreamResult(");
	assert.ok(streamStart > 0);
	assert.match(source.slice(streamStart, streamStart + 200), /snapshotResult\(result, progress\)/);
});

// ── 交接后的状态槽（ctx.ui.setStatus） ─────────────────────────────────
// 交接后工具调用已经返回，扩展改经状态槽继续上报；主进程必须按前缀消费，
// 并且回合结束不能把还在跑的子代理灯灭掉。

function statusEvent(statusKey, statusText) {
	return { type: "extension_ui_request", id: "ui-1", method: "setStatus", statusKey, statusText };
}

const STATUS_KEY = "pideck.subagent-status.v1:run-1";
// 主进程会把相对路径按项目根补全，测试必须用当前平台的绝对路径，
// 否则在 Linux 上 "C:/..." 会被当成相对路径，合法帧反而被拒。
const SESSION_PATH = process.platform === "win32" ? "C:/sessions/parent.jsonl" : "/sessions/parent.jsonl";
const OTHER_SESSION_PATH = process.platform === "win32" ? "C:/sessions/other.jsonl" : "/sessions/other.jsonl";

function statusSnapshot(overrides = {}) {
	return JSON.stringify({
		version: 1,
		ownerSessionId: SESSION_PATH,
		parentToolCallId: "call-workflow",
		workflowRunId: "run-1",
		sequence: 1,
		complete: false,
		truncated: false,
		observedAt: 1,
		children: [{ taskKey: "first", sessionFile: "C:/child/session.jsonl", state: "running" }],
		...overrides,
	});
}

test("the status slot lights a handed-off child and clears when the slot resets", () => {
	const { manager, agentId, snapshots } = createHarness();

	manager.handlePiEvent(agentId, statusEvent(STATUS_KEY, statusSnapshot()));
	assert.deepEqual(snapshots.map(summarize), [["C:/child/session.jsonl|running"]]);

	// 回合结束：状态槽还在上报，不能灭灯。
	manager.handlePiEvent(agentId, { type: "agent_end", messages: [] });
	assert.deepEqual(snapshots.map(summarize), [["C:/child/session.jsonl|running"]]);

	// 状态槽清空：扩展已收尾，立即收灯。
	manager.handlePiEvent(agentId, statusEvent(STATUS_KEY, undefined));
	assert.deepEqual(snapshots.map(summarize), [
		["C:/child/session.jsonl|running"],
		[],
	]);
});

test("the status slot rejects foreign keys, foreign sessions and malformed frames", () => {
	const { manager, agentId, snapshots } = createHarness();
	manager.agents.get(agentId).tab.sessionPath = SESSION_PATH;

	manager.handlePiEvent(agentId, statusEvent("other-extension:status", statusSnapshot()));
	assert.equal(snapshots.length, 0, "other extensions keep their setStatus ignored");

	manager.handlePiEvent(agentId, statusEvent(STATUS_KEY, "not json"));
	assert.equal(snapshots.length, 0, "a malformed frame must not reach the sidebar");

	manager.handlePiEvent(agentId, statusEvent(STATUS_KEY, statusSnapshot({ ownerSessionId: OTHER_SESSION_PATH })));
	assert.equal(snapshots.length, 0, "a frame from another session must not light this one");

	manager.handlePiEvent(agentId, statusEvent("pideck.subagent-status.v1:run-2", statusSnapshot()));
	assert.equal(snapshots.length, 0, "the key and the payload run id must agree");

	manager.handlePiEvent(agentId, statusEvent(STATUS_KEY, statusSnapshot()));
	assert.deepEqual(snapshots.map(summarize), [["C:/child/session.jsonl|running"]]);
});

// Expiry must publish without another pi event or a renderer read.
const STALE_MS = 30_000;
const ERROR_TTL_MS = 30 * 60_000;

function sendSlot(manager, agentId, runId, sequence = 1, children = [{ taskKey: "single", sessionFile: `/${runId}.jsonl`, state: "running", executionId: runId }], extras = {}) {
	manager.handlePiEvent(agentId, statusEvent(`pideck.subagent-status.v1:${runId}`, statusSnapshot({
		workflowRunId: runId, parentToolCallId: `call-${runId}`, sequence, children, ...extras,
	})));
}

test("an idle renderer receives an empty snapshot when a handed-off heartbeat expires", async () => {
	const clock = createFakeClock();
	const { manager, agentId, snapshots } = createHarness(clock);
	try {
		sendSlot(manager, agentId, "silent");
		manager.handlePiEvent(agentId, { type: "agent_end", messages: [] });
		assert.deepEqual(summarize(snapshots.at(-1)), ["/silent.jsonl|running"]);
		clock.advance(STALE_MS - 1);
		assert.equal(snapshots.length, 1);
		clock.advance(1);
		assert.deepEqual(snapshots.map(summarize), [["/silent.jsonl|running"], []]);
		assert.equal(clock.pendingTimers, 0, "expiry must not leave an empty task timer");
	} finally { await manager.stopAll(); }
});

test("same-status heartbeat refreshes the expiry deadline without redundant status pushes", async () => {
	const clock = createFakeClock();
	const { manager, agentId, snapshots } = createHarness(clock);
	try {
		sendSlot(manager, agentId, "refreshed");
		clock.advance(20_000);
		sendSlot(manager, agentId, "refreshed", 2);
		assert.equal(snapshots.length, 1);
		clock.advance(10_000);
		assert.equal(snapshots.length, 1, "the original deadline must not expire a refreshed heartbeat");
		clock.advance(20_000);
		assert.deepEqual(summarize(snapshots.at(-1)), []);
		assert.equal(snapshots.length, 2);
		assert.equal(clock.pendingTimers, 0);
	} finally { await manager.stopAll(); }
});

test("tasks and agents expire independently while another task keeps heartbeating", async () => {
	const clock = createFakeClock();
	const { manager, agentId, snapshots } = createHarness(clock);
	const secondId = "agent-2";
	manager.agents.set(secondId, { ...manager.agents.get(agentId), tab: { ...manager.agents.get(agentId).tab, id: secondId } });
	manager.messages.set(secondId, []);
	try {
		sendSlot(manager, agentId, "first");
		clock.advance(5_000);
		sendSlot(manager, agentId, "second");
		sendSlot(manager, secondId, "separate");
		clock.advance(20_000);
		sendSlot(manager, agentId, "second", 2);
		clock.advance(5_000);
		assert.deepEqual(summarize(snapshots.filter((row) => row.agentId === agentId).at(-1)), ["/second.jsonl|running"]);
		assert.deepEqual(summarize(snapshots.filter((row) => row.agentId === secondId).at(-1)), ["/separate.jsonl|running"]);
		clock.advance(5_000);
		assert.deepEqual(summarize(snapshots.filter((row) => row.agentId === secondId).at(-1)), []);
		assert.deepEqual(summarize(snapshots.filter((row) => row.agentId === agentId).at(-1)), ["/second.jsonl|running"]);
		clock.advance(20_000);
		assert.deepEqual(summarize(snapshots.filter((row) => row.agentId === agentId).at(-1)), []);
		assert.equal(clock.pendingTimers, 0);
	} finally { await manager.stopAll(); }
});

for (const cleanup of ["complete", "clear", "stop", "restart", "stopAll"]) {
	test(`${cleanup} cancels expiry so no late status is emitted`, async () => {
		const clock = createFakeClock();
		const { manager, agentId, snapshots } = createHarness(clock);
		try {
			sendSlot(manager, agentId, "cleanup");
			if (cleanup === "complete") sendSlot(manager, agentId, "cleanup", 2, [], { complete: true });
			if (cleanup === "clear") manager.handlePiEvent(agentId, statusEvent("pideck.subagent-status.v1:cleanup", undefined));
			if (cleanup === "stop") await manager.stop(agentId);
			if (cleanup === "stopAll") await manager.stopAll();
			if (cleanup === "restart") {
				manager.agents.get(agentId).tab.sessionPath = SESSION_PATH;
				manager.create = async () => ({ id: "replacement" });
				await manager.restart(agentId);
			}
			assert.deepEqual(summarize(snapshots.at(-1)), []);
			assert.equal(clock.pendingTimers, 0);
			const count = snapshots.length;
			clock.advance(ERROR_TTL_MS + STALE_MS);
			assert.equal(snapshots.length, count, "canceled timers must never publish later");
		} finally { await manager.stopAll(); }
	});
}

test("heartbeat expiry and clear retain failures until their 30-minute deadline", async () => {
	const clock = createFakeClock();
	const { manager, agentId, snapshots } = createHarness(clock);
	try {
		sendSlot(manager, agentId, "failed", 1, [
			{ taskKey: "live", sessionFile: "/live.jsonl", state: "running", executionId: "live" },
			{ taskKey: "failed", sessionFile: "/failed.jsonl", state: "failed", executionId: "failed" },
		]);
		clock.advance(STALE_MS);
		assert.deepEqual(summarize(snapshots.at(-1)), ["/failed.jsonl|error"]);
		manager.handlePiEvent(agentId, statusEvent("pideck.subagent-status.v1:failed", undefined));
		clock.advance(ERROR_TTL_MS - STALE_MS - 1);
		assert.deepEqual(summarize(snapshots.at(-1)), ["/failed.jsonl|error"]);
		clock.advance(1);
		assert.deepEqual(summarize(snapshots.at(-1)), []);
		assert.equal(clock.pendingTimers, 0);
	} finally { await manager.stopAll(); }
});

test("empty status frames do not leave scheduled tasks behind", async () => {
	const clock = createFakeClock();
	const { manager, agentId } = createHarness(clock);
	try {
		for (let index = 0; index < 100; index += 1) sendSlot(manager, agentId, `empty-${index}`, 1, []);
		assert.equal(clock.pendingTimers, 0);
	} finally { await manager.stopAll(); }
});

test("a same-status failure refresh retains the row for 30 minutes from its latest observation", async () => {
	const clock = createFakeClock();
	const { manager, agentId, snapshots } = createHarness(clock);
	const failed = [{ taskKey: "failed", sessionFile: "/failed.jsonl", state: "failed", executionId: "failed" }];
	try {
		sendSlot(manager, agentId, "failure-refresh", 1, failed);
		clock.advance(20 * 60_000);
		sendSlot(manager, agentId, "failure-refresh", 2, failed);
		assert.equal(snapshots.length, 1, "same failure and heartbeat expiry must not emit redundant status");
		clock.advance(10 * 60_000);
		assert.deepEqual(summarize(snapshots.at(-1)), ["/failed.jsonl|error"], "the original error deadline is no longer authoritative");
		clock.advance(20 * 60_000);
		assert.deepEqual(summarize(snapshots.at(-1)), []);
		assert.equal(snapshots.length, 2);
		assert.equal(clock.pendingTimers, 0);
	} finally { await manager.stopAll(); }
});

test("a task flood remains bounded and all retained rows expire without leaving a timer", async () => {
	const clock = createFakeClock();
	const { manager, agentId, snapshots } = createHarness(clock);
	try {
		for (let index = 0; index < 100; index += 1) sendSlot(manager, agentId, `task-${index}`);
		assert.equal(snapshots.at(-1).runs.length, 64);
		clock.advance(STALE_MS);
		assert.deepEqual(summarize(snapshots.at(-1)), []);
		assert.equal(clock.pendingTimers, 0);
	} finally { await manager.stopAll(); }
});