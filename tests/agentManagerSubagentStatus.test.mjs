import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

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

function loadModule(filePath, customRequire) {
	const sandbox = {
		clearTimeout,
		setTimeout,
		process,
		exports: {},
		require: customRequire ?? require,
	};
	vm.runInNewContext(transpile(filePath), sandbox, { filename: filePath });
	return sandbox.exports;
}

const ipc = loadModule("src/shared/ipc.ts");
const askQuestion = loadModule("src/shared/askQuestion.ts");
const messageFingerprint = loadModule("src/shared/messageFingerprint.ts");
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

function loadAgentManager() {
	return loadModule("src/main/pi/AgentManager.ts", (id) => {
		if (id.includes("shared/ipc")) return ipc;
		if (id.includes("agentUtils")) return agentUtils;
		if (id.includes("WslPaths")) return wslPaths;
		if (id.includes("piCompatibility")) return piCompatibility;
		if (id.includes("SubagentRunTracker")) return loadTsCommonJs("src/main/pi/SubagentRunTracker.ts");
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
		if (id.includes("historyMessages")) return loadModule("src/main/pi/historyMessages.ts", (specifier) => (
			specifier.includes("messageFingerprint") ? messageFingerprint : require(specifier)
		));
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
	});
}

const { AgentManager } = loadAgentManager();

/** 只关心子代理通道：其它 emit（message/state/notice）一律忽略。 */
function createHarness() {
	const settingsStore = { get: () => ({ enableNotifications: false, removedBuiltInExtensions: [] }) };
	const manager = new AgentManager(
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
