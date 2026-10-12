import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { SessionCatalog } = loadTsCommonJs("src/main/sessions/SessionCatalog.ts");
const { SessionRuntimeCoordinator } = loadTsCommonJs("src/main/sessions/SessionRuntimeCoordinator.ts");
const { createSessionRuntimeBridge } = loadTsCommonJs("src/main/backend/sessionRuntimeBridge.ts");
const { ipcChannels } = loadTsCommonJs("src/shared/ipc.ts");

function deferred() {
	let settle;
	const promise = new Promise((resolve, reject) => {
		settle = { resolve, reject };
	});
	return { promise, ...settle };
}

function createAgents() {
	const tabs = [];
	const created = [];
	const prompts = [];
	let inflight = null;
	const agents = {
		tabs,
		created,
		prompts,
		release: () => inflight?.resolve(),
		fail: (error) => inflight?.reject(error),
		list: () => tabs,
		getMessages: () => [],
		getMessageWindow: () => ({ messages: [], windowStart: 0, totalLength: 0 }),
		isRecoverableErrorRuntime: () => false,
		getStartupTimeoutMs: () => 1000,
		publishRuntimeState: async () => undefined,
		setModel: async () => ({}),
		setThinking: async () => ({}),
		stop: async (agentId) => {
			const index = tabs.findIndex((tab) => tab.id === agentId);
			if (index >= 0) tabs.splice(index, 1);
		},
		create: (input) => {
			const tab = {
				id: `agent-${created.length + 1}`,
				projectId: input.projectId,
				cwd: "/repo",
				title: input.title ?? "anonymous",
				status: "idle",
				createdAt: Date.now(),
				noSession: input.noSession,
				deckSessionId: input.deckSessionId,
				sessionSource: input.source ?? "pi",
				sessionEnvironment: input.environment ?? "native",
			};
			created.push({ input, tab });
			inflight = deferred();
			return inflight.promise.then(() => {
				tabs.push(tab);
				return tab;
			});
		},
	};
	return agents;
}

async function createFixture(agents, options = {}) {
	const root = await mkdtemp(join(tmpdir(), "pideck-anon-"));
	const catalog = new SessionCatalog(join(root, "catalog.json"));
	await catalog.load();
	const coordinator = new SessionRuntimeCoordinator(
		catalog,
		agents,
		async (input) => {
			agents.prompts.push(input);
			return { accepted: true, delivery: "confirmed" };
		},
	);
	const errors = [];
	const events = [];
	const bridge = createSessionRuntimeBridge({
		projectStore: { get: (id) => (id === "project" ? { id, name: "Project", path: root } : undefined) },
		settingsStore: { get: () => ({ wslEnabled: false }) },
		configManager: {
			getSettingsConfig: async () => { throw new Error("no config"); },
			getModelsConfig: async () => { throw new Error("no config"); },
		},
		sessionCatalog: catalog,
		sessionRuntimeCoordinator: coordinator,
		sessionScanner: {},
		agentManager: agents,
		terminalManager: {},
		appLogger: { info() {}, warn() {}, error(...args) { errors.push(args); } },
		mainCopy: (key) => key,
		sendToRenderer(...args) {
			events.push(args);
			options.sendToRenderer?.(...args);
		},
	});
	return { root, catalog, coordinator, bridge, errors, events };
}

test("anonymous cold start and the first send share one agent", async () => {
	const agents = createAgents();
	const { root, catalog, coordinator, bridge, errors, events } = await createFixture(agents);
	try {
		const created = await bridge.createAnonymousSession({ projectId: "project" });
		assert.equal(bridge.isAnonymousActivating(created.session.id), true);
		const sending = coordinator.send({
			sessionId: created.session.id,
			requestId: "request-1",
			message: "hello",
		});
		assert.equal(agents.created.length, 1);
		assert.equal(agents.prompts.length, 0);
		assert.equal(agents.created[0].input.noSession, true);
		assert.equal(agents.created[0].input.deckSessionId, created.session.id);

		agents.release();
		const sent = await sending;
		assert.equal(sent.accepted, true, JSON.stringify(sent));
		assert.equal(agents.created.length, 1);
		assert.equal(agents.prompts.length, 1);
		assert.equal(agents.prompts[0].agentId, "agent-1");
		assert.equal(coordinator.getTarget(created.session.id)?.agentId, "agent-1");
		// 等待 bridge 的后台发布完成，不能只在 send 返回时检查绑定。
		await new Promise((resolve) => setImmediate(resolve));
		assert.notEqual(catalog.get(created.session.id), undefined);
		assert.equal(bridge.isAnonymousActivating(created.session.id), false);
		assert.deepEqual(errors, []);
		const messageEvent = events.find(([channel, event]) =>
			channel === ipcChannels.sessionsRuntimeEvent && event.sourceChannel === ipcChannels.agentsMessage);
		assert.ok(messageEvent);
		assert.equal(messageEvent[1].sessionId, created.session.id);
		assert.equal(messageEvent[1].agentId, "agent-1");
		assert.equal(messageEvent[1].runtimeGeneration, coordinator.getTarget(created.session.id).runtimeGeneration);
		assert.equal(messageEvent[1].payload.totalLength, 0);
		assert.deepEqual(messageEvent[1].payload.messages, []);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("anonymous startup failure removes the transient session and does not send", async () => {
	const agents = createAgents();
	const { root, catalog, coordinator, bridge, events } = await createFixture(agents);
	try {
		const created = await bridge.createAnonymousSession({ projectId: "project" });
		// 创建匿名会话时也会推一次刷新，所以比较创建后的次数，不能只断言“收到过”。
		const refreshesAfterCreate = events.filter(([channel]) => channel === ipcChannels.sessionsCatalogRefreshed).length;
		const sending = coordinator.send({
			sessionId: created.session.id,
			requestId: "request-1",
			message: "hello",
		});
		agents.fail(new Error("spawn failed"));
		const sent = await sending;
		assert.equal(sent.accepted, false, JSON.stringify(sent));
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(catalog.get(created.session.id), undefined);
		assert.equal(agents.prompts.length, 0);
		assert.equal(bridge.isAnonymousActivating(created.session.id), false);
		assert.equal(coordinator.getTarget(created.session.id), undefined);
		// 激活失败必须通知渲染端刷新，否则界面会残留一个已不存在的会话标签。
		const refreshed = events.filter(([channel]) => channel === ipcChannels.sessionsCatalogRefreshed);
		assert.equal(
			refreshed.length > refreshesAfterCreate,
			true,
			`激活失败后必须再推送一次 catalog 刷新（创建时 ${refreshesAfterCreate} 次，结束时 ${refreshed.length} 次）`,
		);
		assert.equal(refreshed.at(-1)[1].projectId, created.session.projectId);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("a failure to publish state after a successful activation keeps the session and runtime", async () => {
	const agents = createAgents();
	const { root, catalog, coordinator, bridge, errors } = await createFixture(agents, {
		// 激活已成功，只是通知渲染端这一步失败（原生通道断开等）。
		// 注意：bridge 统一用 sessionsRuntimeEvent 通道发送，agentsState 是 sourceChannel。
		sendToRenderer: (channel, event) => {
			if (channel === ipcChannels.sessionsRuntimeEvent && event?.sourceChannel === ipcChannels.agentsState) {
				throw new Error("renderer channel closed");
			}
		},
	});
	try {
		const created = await bridge.createAnonymousSession({ projectId: "project" });
		const sending = coordinator.send({
			sessionId: created.session.id,
			requestId: "request-1",
			message: "hello",
		});
		agents.release();
		const sent = await sending;
		assert.equal(sent.accepted, true, JSON.stringify(sent));
		await new Promise((resolve) => setImmediate(resolve));

		// 删除会话身份会留下“有 Agent 进程、没会话”的孤儿：两者都必须还在。
		assert.notEqual(catalog.get(created.session.id), undefined, "发布失败不得删除会话身份");
		assert.notEqual(coordinator.getTarget(created.session.id), undefined, "发布失败不得解绑 runtime");
		assert.equal(coordinator.getTarget(created.session.id).agentId, "agent-1");
		assert.equal(bridge.isAnonymousActivating(created.session.id), false);
		// 失败必须留痕
		assert.equal(errors.some((args) => String(args[1] ?? "").includes("publish failed")), true, JSON.stringify(errors));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("a throwing failure handler is logged instead of becoming an unhandled rejection", async () => {
	const agents = createAgents();
	let created;
	const { root, bridge, coordinator, errors } = await createFixture(agents, {
		// 激活失败后的刷新通知也失败（原生通道已断开）：失败处理本身抛错。
		sendToRenderer: (channel) => {
			if (channel === ipcChannels.sessionsCatalogRefreshed && created) {
				throw new Error("renderer channel closed");
			}
		},
	});
	const unhandled = [];
	const onUnhandled = (reason) => unhandled.push(reason);
	process.on("unhandledRejection", onUnhandled);
	try {
		created = await bridge.createAnonymousSession({ projectId: "project" });
		const sending = coordinator.send({ sessionId: created.session.id, requestId: "request-1", message: "hello" });
		agents.fail(new Error("spawn failed"));
		await sending;
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.equal(unhandled.length, 0, `unhandled rejections: ${unhandled.map(String).join(", ")}`);
		assert.equal(errors.some((args) => String(args[1] ?? "").includes("cleanup failed")), true, JSON.stringify(errors));
		assert.equal(bridge.isAnonymousActivating(created.session.id), false);
	} finally {
		process.off("unhandledRejection", onUnhandled);
		await rm(root, { recursive: true, force: true });
	}
});
