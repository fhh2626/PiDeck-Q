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

async function createFixture(agents) {
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
		sendToRenderer(...args) { events.push(args); },
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
	const { root, catalog, coordinator, bridge } = await createFixture(agents);
	try {
		const created = await bridge.createAnonymousSession({ projectId: "project" });
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
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
