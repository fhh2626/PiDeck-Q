import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { AgentManager } = loadTsCommonJs("src/main/pi/AgentManager.ts");

/**
 * 断层补发的范围：既不能对全部 Agent 无差别扇出（每个全量窗口可达数 MB，会打满 SSE 背压，
 * 使断层自我延续），也不能漏掉断层期间确实下发过消息的 Agent（否则界面停在旧内容）。
 */

// 下发时间与断层起点都是进程内单调时钟（monotonicNowMs = performance.now()）口径。
function createManager(agentIds) {
	const emittedAgents = [];
	const manager = new AgentManager(
		() => ({ id: "project-1", name: "Project", path: "C:/project" }),
		(channel, payload) => {
			if (channel === "agents:message") emittedAgents.push(payload.agentId);
		},
		{ get: () => ({}) },
		{},
	);
	for (const id of agentIds) {
		manager.agents.set(id, {
			tab: {
				id,
				projectId: "project-1",
				cwd: "C:/project",
				title: id,
				status: "idle",
				sessionPath: `C:/project/${id}.jsonl`,
				sessionEnvironment: "native",
				sessionSource: "pi",
				createdAt: 1,
			},
			process: { client: { request: async () => ({ success: true, data: {} }) } },
		});
		manager.messages.set(id, [{ id: `${id}-u`, agentId: id, role: "user", text: "hi", timestamp: 1 }]);
	}
	return { manager, emittedAgents };
}

test("断层起点已知时：聚焦会话必补，断层前就已静止的会话不被扇出", () => {
	const { manager, emittedAgents } = createManager(["focused", "idle-a", "idle-b"]);
	const lostSinceMs = performance.now() - 5_000;
	manager.lastMessageEmitAtByAgent.set("idle-a", lostSinceMs - 60_000);
	manager.flushLiveRendererState({ priorityAgentIds: new Set(["focused"]), lostSinceMs });
	assert.deepEqual(emittedAgents, ["focused"]);
});

test("正在流式输出的 Agent 即使未聚焦也必须补发，否则其实时增量会停住", () => {
	const { manager, emittedAgents } = createManager(["focused", "streaming", "idle"]);
	manager.streamingAgents.add("streaming");
	manager.flushLiveRendererState({ priorityAgentIds: new Set(["focused"]), lostSinceMs: performance.now() });
	assert.deepEqual(emittedAgents.sort(), ["focused", "streaming"]);
});

test("断层起点之后下发过消息的 Agent 必须补发，哪怕早已空闲很久（例如睡眠期间跑完的后台会话）", () => {
	const { manager, emittedAgents } = createManager(["finished-during-gap", "idle-before-gap"]);
	const lostSinceMs = performance.now() - 30 * 60_000; // 断层持续了 30 分钟
	manager.lastMessageEmitAtByAgent.set("finished-during-gap", lostSinceMs + 10 * 60_000);
	manager.lastMessageEmitAtByAgent.set("idle-before-gap", lostSinceMs - 60_000);
	manager.flushLiveRendererState({ lostSinceMs });
	assert.deepEqual(emittedAgents, ["finished-during-gap"]);
});

test("断层起点未知时保守地补发全部 Agent（含未聚焦的分屏会话）", () => {
	const { manager, emittedAgents } = createManager(["a", "b", "c"]);
	manager.lastMessageEmitAtByAgent.set("b", performance.now() - 60 * 60_000);
	manager.flushLiveRendererState({ priorityAgentIds: new Set(["a"]) });
	assert.deepEqual(emittedAgents.sort(), ["a", "b", "c"]);
});

test("有待投递的全量校准或脏下标的 Agent 必须补发", () => {
	const { manager, emittedAgents } = createManager(["pending-full", "dirty", "clean"]);
	manager.pendingFullMessageEmitAgents.add("pending-full");
	manager.messageDirtyFromByAgent.set("dirty", 0);
	manager.flushLiveRendererState({ lostSinceMs: performance.now() });
	assert.deepEqual(emittedAgents.sort(), ["dirty", "pending-full"]);
});

test("补发后记录下发时间，Agent 关闭时清理该记录", () => {
	const { manager } = createManager(["a"]);
	manager.flushLiveRendererState({ priorityAgentIds: new Set(["a"]) });
	assert.ok(manager.lastMessageEmitAtByAgent.has("a"));
	manager.clearAgentState("a");
	assert.equal(manager.lastMessageEmitAtByAgent.has("a"), false);
});
