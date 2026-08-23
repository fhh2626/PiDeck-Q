import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
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
const agentUtils = loadModule("src/main/pi/agentUtils.ts");
const wslPaths = loadModule("src/main/wsl/WslPaths.ts");
const piCompatibility = loadModule("src/shared/piCompatibility.ts");
const hostInstruction = loadModule("src/main/pi/hostInstruction.ts");
const messageContent = loadModule("src/main/pi/messageContent.ts", (id) => {
	if (id.includes("hostInstruction")) return hostInstruction;
	return require(id);
});
const streamGate = loadModule("src/main/pi/streamGate.ts");
const bashResult = loadModule("src/main/pi/bashResult.ts");
const cacheHitStats = loadModule("src/main/pi/cacheHitStats.ts");
const askQuestionResult = loadModule("src/main/pi/askQuestionResult.ts", (id) => {
	if (id.includes("askQuestion")) return askQuestion;
	return require(id);
});
const historyMessages = loadModule("src/main/pi/historyMessages.ts", (id) => {
	if (id.includes("messageFingerprint")) return messageFingerprint;
	return require(id);
});
const agentSessionIdentity = loadModule("src/main/pi/agentSessionIdentity.ts", (id) => {
	if (id.includes("sessionIdentity")) return sessionIdentity;
	return require(id);
});
const latestByKeyEmitter = loadModule("src/main/pi/LatestByKeyEmitter.ts");
const piProcess = {
	PiProcess: class {
		constructor() {}
	},
};
const sessionFileEditor = {
	SessionFileEditor: class {
		constructor() {}
	},
};
const agentMessageProjector = {
	AgentMessageProjector: class {
		constructor() {}
	},
};
const sessionHistoryReader = {
	SessionHistoryReader: class {
		constructor() {}
	},
};
const builtInExtensions = {
	listActiveBuiltInExtensionPaths: () => [],
};

function loadAgentManager() {
	const toolRuntimeState = { updateActiveToolCalls: () => {} };
	return loadModule("src/main/pi/AgentManager.ts", (id) => {
		if (id.includes("shared/ipc")) return ipc;
		if (id.includes("agentUtils")) return agentUtils;
		if (id.includes("WslPaths")) return wslPaths;
		if (id.includes("piCompatibility")) return piCompatibility;
		if (id.includes("messageContent")) return messageContent;
		if (id.includes("toolRuntimeState")) return toolRuntimeState;
		if (id.includes("streamGate")) return streamGate;
		if (id.includes("bashResult")) return bashResult;
		if (id.includes("cacheHitStats")) return cacheHitStats;
		if (id.includes("askQuestionResult")) return askQuestionResult;
		if (id.includes("historyMessages")) return historyMessages;
		if (id.includes("agentSessionIdentity")) return agentSessionIdentity;
		if (id.includes("LatestByKeyEmitter")) return latestByKeyEmitter;
		if (id.includes("PiProcess")) return piProcess;
		if (id.includes("SessionFileEditor")) return sessionFileEditor;
		if (id.includes("AgentMessageProjector")) return agentMessageProjector;
		if (id.includes("SessionHistoryReader")) return sessionHistoryReader;
		if (id.includes("builtInExtensions")) return builtInExtensions;
		return require(id);
	});
}

const { AgentManager } = loadAgentManager();

test("AgentManager notification platform behavior", async () => {
	const showCalls = [];
	const platformNotifications = {
		supported: true,
		isSupported() {
			return this.supported;
		},
		show(opts) {
			showCalls.push(opts);
		},
	};

	let focusCalledWith = null;
	const platformDeps = {
		appName: "PiDeckApp",
		appPath: "/app",
		resourcesPath: "/resources",
		isPackaged: true,
		notifications: platformNotifications,
		focusSessionFromNotification: (s) => {
			focusCalledWith = s;
			return true;
		},
		hasLiveWindow: () => true,
	};

	let enabled = true;
	const settingsStore = {
		get: () => ({
			enableNotifications: enabled,
			removedBuiltInExtensions: [],
		}),
	};

	const manager = new AgentManager(
		() => undefined,
		() => {},
		settingsStore,
		{ getProjectTrustDecision: async () => true },
		{ push: () => {} },
		{ info: () => {}, warn: () => {}, error: () => {} },
		undefined,
		(k) => `translated:${k}`,
		undefined,
		undefined,
		undefined,
		(agentId) => (agentId === "agent-1" ? "session-rec-1" : undefined),
		platformDeps,
	);

	// CASE 1: notifyAskPending normal call
	manager.notifyAskPending("agent-1", "session-rec-1", "My Session", "What is your name?");
	assert.equal(showCalls.length, 1);
	assert.equal(showCalls[0].title, "PiDeckApp");
	assert.equal(showCalls[0].activationUrl, "pideck://session/session-rec-1");
	assert.equal(showCalls[0].silent, false);

	// Click invokes focus callback
	showCalls[0].onClick();
	assert.equal(focusCalledWith, "session-rec-1");

	// CASE 2: notifyAskPending with empty sessionId falls back to pideck://
	manager.notifyAskPending("agent-2", "", "My Session 2", "Another question?");
	assert.equal(showCalls.length, 2);
	assert.equal(showCalls[1].activationUrl, "pideck://");

	// CASE 3: enableNotifications false does not trigger show
	enabled = false;
	manager.notifyAskPending("agent-3", "session-rec-3", "Session 3", "Ignored?");
	assert.equal(showCalls.length, 2);

	// CASE 4: isSupported false does not trigger show
	enabled = true;
	platformNotifications.supported = false;
	manager.notifyAskPending("agent-4", "session-rec-4", "Session 4", "Ignored 2?");
	assert.equal(showCalls.length, 2);

	// CASE 5: notification.show throws exception without affecting caller flow
	platformNotifications.supported = true;
	platformNotifications.show = () => {
		throw new Error("OS Notification Error");
	};
	assert.doesNotThrow(() => {
		manager.notifyAskPending("agent-5", "session-rec-5", "Session 5", "Safe?");
	});
});

// ────────────────────────────────────────────────────────────────
// 会话完成通知（notifySessionEnd）—— 通过真实 agent_settled 事件驱动，
// 验证触发条件，而不是直接调用私有方法。
// ────────────────────────────────────────────────────────────────

function createSettledHarness({
	resolveRecordId,
	piSessionId,
	runtimeStatus = "running",
	lastRole = "assistant",
	focusReturns = true,
	enableNotifications = true,
	supported = true,
	showImpl,
} = {}) {
	const showCalls = [];
	const warnCalls = [];
	const platformNotifications = {
		isSupported: () => supported,
		show: showImpl ?? ((opts) => showCalls.push(opts)),
	};
	let focusLast;
	const focusCalls = [];
	const platformDeps = {
		appName: "PiDeckApp",
		appPath: "/app",
		resourcesPath: "/resources",
		isPackaged: true,
		notifications: platformNotifications,
		focusSessionFromNotification: (s) => {
			focusCalls.push(s);
			focusLast = s;
			return focusReturns;
		},
		hasLiveWindow: () => true,
	};
	const settingsStore = {
		get: () => ({
			enableNotifications,
			removedBuiltInExtensions: [],
		}),
	};
	const manager = new AgentManager(
		() => undefined,
		() => {},
		settingsStore,
		{ getProjectTrustDecision: async () => true },
		{ push: () => {} },
		{
			info: () => {},
			warn: (scope, message, detail) => warnCalls.push({ scope, message, detail }),
			error: () => {},
		},
		undefined,
		(k) => `t:${k}`,
		undefined,
		undefined,
		undefined,
		resolveRecordId,
		platformDeps,
	);
	// emitRuntimeState 走异步 get_state RPC；settled 测试不关心其内容，stub 掉避免噪声。
	manager.getRuntimeState = async () => ({});
	return { manager, showCalls, warnCalls, focusCalls, focusLast };
}

function attachRuntime(manager, agentId, { runtimeStatus = "running", lastRole = "assistant", piSessionId } = {}) {
	const tab = {
		id: agentId,
		projectId: "project-1",
		cwd: "C:/project",
		title: "Session title",
		status: runtimeStatus,
		createdAt: 1,
	};
	if (piSessionId !== undefined) tab.sessionId = piSessionId;
	manager.agents.set(agentId, {
		tab,
		process: { isRunning: () => true, client: { request: async () => ({ success: true }) } },
	});
	// 最后一条消息角色决定是否触发完成通知
	const message = {
		id: `msg-${agentId}`,
		agentId,
		role: lastRole,
		text: "final", 
		timestamp: 1,
	};
	manager.messages.set(agentId, [message]);
	return tab;
}

test("agent_settled with normal assistant run fires exactly one session-complete notification", () => {
	const { manager, showCalls } = createSettledHarness({
		resolveRecordId: () => "session-record-id",
	});
	attachRuntime(manager, "agent-ok", { runtimeStatus: "running", lastRole: "assistant", piSessionId: "pi-1" });

	manager.handlePiEvent("agent-ok", { type: "agent_settled" });

	assert.equal(showCalls.length, 1);
	assert.equal(showCalls[0].title, "PiDeckApp");
	// body 必须是翻译后的 sessionDone 文案；silent 必须保持有声提醒（计划 47 节 CASE 3）。
	assert.equal(showCalls[0].body, "t:mainNotification.sessionDone");
	assert.equal(showCalls[0].silent, false);
	assert.equal(showCalls[0].activationUrl, "pideck://session/session-record-id");
	// 正常 settle 后 runtime 必须进入 idle
	assert.equal(manager.agents.get("agent-ok").tab.status, "idle");
});

test("agent_settled prefers SessionRecord.id over pi sessionId in activation URL", () => {
	const { manager, showCalls } = createSettledHarness({
		resolveRecordId: () => "record-abc",
	});
	attachRuntime(manager, "agent-res", { runtimeStatus: "running", lastRole: "assistant", piSessionId: "pi-xyz" });

	manager.handlePiEvent("agent-res", { type: "agent_settled" });

	assert.equal(showCalls.length, 1);
	assert.equal(showCalls[0].activationUrl, "pideck://session/record-abc");
	assert.ok(!showCalls[0].activationUrl.includes("pi-xyz"), "URL must use record.id, not pi session id");
});

test("agent_settled does not use pi sessionId when stable SessionRecord.id is unavailable", () => {
	const { manager, showCalls } = createSettledHarness({
		resolveRecordId: undefined,
	});
	attachRuntime(manager, "agent-fallback", { runtimeStatus: "running", lastRole: "assistant", piSessionId: "pi-only" });

	manager.handlePiEvent("agent-fallback", { type: "agent_settled" });

	assert.equal(showCalls.length, 1);
	assert.equal(showCalls[0].activationUrl, "pideck://");
});

test("agent_settled with no session id at all uses the root pideck:// URL", () => {
	const { manager, showCalls } = createSettledHarness({
		resolveRecordId: () => undefined,
	});
	attachRuntime(manager, "agent-noise", { runtimeStatus: "running", lastRole: "assistant" });

	manager.handlePiEvent("agent-noise", { type: "agent_settled" });

	assert.equal(showCalls.length, 1);
	assert.equal(showCalls[0].activationUrl, "pideck://");
});

test("agent_settled does not notify when notifications are disabled", () => {
	const { manager, showCalls } = createSettledHarness({
		resolveRecordId: () => "rec-disabled",
		enableNotifications: false,
	});
	attachRuntime(manager, "agent-disabled", { runtimeStatus: "running", lastRole: "assistant" });

	manager.handlePiEvent("agent-disabled", { type: "agent_settled" });

	assert.equal(showCalls.length, 0);
	assert.equal(manager.agents.get("agent-disabled").tab.status, "idle");
});

test("agent_settled does not notify when platform notifications are unsupported", () => {
	const { manager, showCalls } = createSettledHarness({
		resolveRecordId: () => "rec-unsupported",
		supported: false,
	});
	attachRuntime(manager, "agent-unsupported", { runtimeStatus: "running", lastRole: "assistant" });

	manager.handlePiEvent("agent-unsupported", { type: "agent_settled" });

	assert.equal(showCalls.length, 0);
	assert.equal(manager.agents.get("agent-unsupported").tab.status, "idle");
});

test("abort settled does NOT fire the session-complete notification", () => {
	const { manager, showCalls } = createSettledHarness({
		resolveRecordId: () => "rec-abort",
	});
	attachRuntime(manager, "agent-abort", { runtimeStatus: "running", lastRole: "assistant" });
	// 用户主动 abort：recentlyAborted 命中
	manager.recentlyAborted.add("agent-abort");

	manager.handlePiEvent("agent-abort", { type: "agent_settled" });

	assert.equal(showCalls.length, 0, "abort settled must not pop a 'done' notification");
	// 但仍进入 idle
	assert.equal(manager.agents.get("agent-abort").tab.status, "idle");
});

test("error runtime settled does NOT fire the session-complete notification", () => {
	const { manager, showCalls } = createSettledHarness({
		resolveRecordId: () => "rec-err",
	});
	attachRuntime(manager, "agent-err", { runtimeStatus: "error", lastRole: "assistant" });

	manager.handlePiEvent("agent-err", { type: "agent_settled" });

	assert.equal(showCalls.length, 0, "error settled must not pop a 'done' notification");
});

test("settled with non-assistant last message does NOT fire the notification", () => {
	const { manager, showCalls } = createSettledHarness({
		resolveRecordId: () => "rec-user",
	});
	attachRuntime(manager, "agent-userlast", { runtimeStatus: "running", lastRole: "user" });

	manager.handlePiEvent("agent-userlast", { type: "agent_settled" });

	assert.equal(showCalls.length, 0, "only assistant completion should notify");
});

test("notification click focuses the stable SessionRecord.id", () => {
	const { manager, showCalls, focusCalls } = createSettledHarness({
		resolveRecordId: () => "rec-click",
		focusReturns: true,
	});
	attachRuntime(manager, "agent-click", { runtimeStatus: "running", lastRole: "assistant" });

	manager.handlePiEvent("agent-click", { type: "agent_settled" });
	assert.equal(showCalls.length, 1);
	showCalls[0].onClick();
	assert.equal(focusCalls[focusCalls.length - 1], "rec-click");
});

test("focus returning false writes a 'skipped' warn", () => {
	const { manager, showCalls, warnCalls } = createSettledHarness({
		resolveRecordId: () => "rec-skip",
		focusReturns: false,
	});
	attachRuntime(manager, "agent-skip", { runtimeStatus: "running", lastRole: "assistant" });

	manager.handlePiEvent("agent-skip", { type: "agent_settled" });
	showCalls[0].onClick();

	const warn = warnCalls.find((w) => w.message === "Notification focus skipped: no main window");
	assert.ok(warn, `expected a skipped warn, got ${JSON.stringify(warnCalls)}`);
	assert.equal(warn.detail.sessionId, "rec-skip");
});

test("onFailed logs the stringified error (not a bare {} object)", async () => {
	const { manager, showCalls, warnCalls } = createSettledHarness({
		resolveRecordId: () => "rec-fail",
	});
	attachRuntime(manager, "agent-fail", { runtimeStatus: "running", lastRole: "assistant" });

	manager.handlePiEvent("agent-fail", { type: "agent_settled" });
	showCalls[0].onFailed(new Error("notification denied"));
	// onFailed 内部是 void this.appLogger?.warn(...)，同步调用但保留为 async 安全
	await Promise.resolve();

	const warn = warnCalls.find((w) => w.message === "Session notification failed to show");
	assert.ok(warn, `expected an onFailed warn, got ${JSON.stringify(warnCalls)}`);
	assert.equal(warn.detail.error, "Error: notification denied");
});

test("notification.show throwing does not break settled and runtime still idles", () => {
	const { manager, warnCalls } = createSettledHarness({
		resolveRecordId: () => "rec-throw",
		showImpl: () => {
			throw new Error("boom");
		},
	});
	attachRuntime(manager, "agent-throw", { runtimeStatus: "running", lastRole: "assistant" });

	assert.doesNotThrow(() => {
		manager.handlePiEvent("agent-throw", { type: "agent_settled" });
	});
	assert.equal(manager.agents.get("agent-throw").tab.status, "idle");
	// show 抛错被 notifySessionEnd 的 try/catch 吞掉，不应有 onFailed warn（show 没返回）
	assert.equal(warnCalls.length, 0);
});
