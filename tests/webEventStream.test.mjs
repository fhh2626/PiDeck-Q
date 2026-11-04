import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readUIMessageStream } from "ai";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { startWebWiringHarness } from "./helpers/l1a_webWiringHarness.mjs";
import { bootLegacyWebPage, createControlledSseBody, settle } from "./helpers/l1a_legacyWebPageHarness.mjs";

/**
 * Web SSE 流式化（A1）：pi 事件 → AI SDK v5 UIMessageStream 帧 翻译器。
 * 验证：
 * 1) text_delta 生成 text-start/text-delta/text-end 三件套（首帧自动补 start）
 * 2) thinking_delta/end 生成 reasoning 块
 * 3) tool_execution_start/end 生成 tool-input/output-available
 * 4) agent_end 收尾（error 时带 error 帧）
 * 5) 端点与协议头接线（WebServiceManager 注册 /stream + x-vercel-ai-ui-message-stream）
 */

const {
	PiEventToUiMessageStream,
	WebEventStreamRouter,
	SSE_DONE,
	serializeSseFrame,
} = loadTsCommonJs("src/main/web/WebEventStream.ts");
const { mergeAdjacentWebMessageParts } = loadTsCommonJs("src/renderer/src/web/webMessageParts.ts");

test("text_delta produces start/delta/end triple with auto text-start", () => {
	const adapter = new PiEventToUiMessageStream();

	const start = adapter.push({ type: "message_start", message: { role: "assistant", id: "m1" } });
	assert.equal(start[0].type, "start");
	assert.equal(start[0].messageId, "m1");

	const d1 = adapter.push({
		type: "message_update",
		assistantMessageEvent: { type: "text_delta", delta: "Hello" },
	});
	assert.equal(d1.length, 2);
	assert.equal(d1[0].type, "text-start");
	assert.equal(d1[1].type, "text-delta");
	assert.equal(d1[1].delta, "Hello");

	// 同一 text 块复用 id，不再发 text-start
	const d2 = adapter.push({
		type: "message_update",
		assistantMessageEvent: { type: "text_delta", delta: " world" },
	});
	assert.equal(d2.length, 1);
	assert.equal(d2[0].type, "text-delta");
	assert.equal(d2[0].id, d1[0].id);

	const end = adapter.push({
		type: "message_update",
		assistantMessageEvent: { type: "text_end" },
	});
	assert.equal(end[0].type, "text-end");
	assert.equal(end[0].id, d1[0].id);
});

test("text_end backfills authoritative content when a block emitted no deltas", () => {
	const adapter = new PiEventToUiMessageStream();
	adapter.push({ type: "message_start", message: { role: "assistant", id: "m-text-final" } });
	const frames = adapter.push({
		type: "message_update",
		assistantMessageEvent: { type: "text_end", content: "完整正文" },
	});
	assert.deepEqual(Array.from(frames, (frame) => frame.type), ["text-start", "text-delta", "text-end"]);
	assert.equal(frames[1].delta, "完整正文");
});

test("text_end does not append full content after deltas already streamed", () => {
	const adapter = new PiEventToUiMessageStream();
	const delta = adapter.push({
		type: "message_update",
		assistantMessageEvent: { type: "text_delta", delta: "部分正文" },
	});
	const end = adapter.push({
		type: "message_update",
		assistantMessageEvent: { type: "text_end", content: "部分正文完整" },
	});
	assert.equal(delta.at(-1).delta, "部分正文");
	assert.deepEqual(Array.from(end, (frame) => frame.type), ["text-end"]);
});

test("thinking_delta/end produces reasoning block with start/delta/end", () => {
	const adapter = new PiEventToUiMessageStream();

	const d = adapter.push({
		type: "message_update",
		assistantMessageEvent: { type: "thinking_delta", delta: "思考中" },
	});
	assert.equal(d.length, 2);
	assert.equal(d[0].type, "reasoning-start");
	assert.equal(d[1].type, "reasoning-delta");
	assert.equal(d[1].delta, "思考中");

	const end = adapter.push({
		type: "message_update",
		assistantMessageEvent: { type: "thinking_end", content: "思考中" },
	});
	// 已经发送过 reasoning delta，thinking_end 的完整 content 不能再次追加。
	assert.equal(end.length, 1);
	assert.equal(end[0].type, "reasoning-end");
});

test("thinking_end without previous delta backfills complete reasoning", () => {
	const adapter = new PiEventToUiMessageStream();
	const end = adapter.push({
		type: "message_update",
		assistantMessageEvent: { type: "thinking_end", content: "完整思考" },
	});
	assert.equal(end.length, 3);
	assert.equal(end[0].type, "reasoning-start");
	assert.equal(end[1].type, "reasoning-delta");
	assert.equal(end[1].delta, "完整思考");
	assert.equal(end[2].type, "reasoning-end");
});

test("done resets reasoning delta state before the next reasoning block", () => {
	const adapter = new PiEventToUiMessageStream();
	adapter.push({
		type: "message_update",
		assistantMessageEvent: { type: "thinking_delta", delta: "第一段" },
	});
	adapter.push({
		type: "message_update",
		assistantMessageEvent: { type: "done" },
	});
	const next = adapter.push({
		type: "message_update",
		assistantMessageEvent: { type: "thinking_end", content: "第二段完整思考" },
	});
	assert.equal(next[1].type, "reasoning-delta");
	assert.equal(next[1].delta, "第二段完整思考");
});

test("tool_execution_start/end produces tool-input-available and tool-output-available", () => {
	const adapter = new PiEventToUiMessageStream();

	const start = adapter.push({
		type: "tool_execution_start",
		toolName: "bash",
		toolCallId: "call_1",
		args: { command: "ls" },
	});
	assert.equal(start[0].type, "tool-input-start");
	assert.equal(start[0].toolCallId, "call_1");
	assert.equal(start[0].toolName, "bash");
	assert.equal(start[1].type, "tool-input-available");
	assert.equal(start[1].input.command, "ls");

	const end = adapter.push({
		type: "tool_execution_end",
		toolName: "bash",
		toolCallId: "call_1",
		isError: false,
	});
	assert.equal(end.at(-1).type, "tool-output-available");
	assert.equal(end.at(-1).toolCallId, "call_1");
});

test("assistant done and agent_end do not close the stream before tools finish", () => {
	const adapter = new PiEventToUiMessageStream();
	adapter.push({ type: "message_start", message: { role: "assistant", id: "m1" } });
	const midDone = adapter.push({
		type: "message_update",
		assistantMessageEvent: { type: "done" },
	});
	assert.equal(midDone.some((frame) => frame.type === "finish"), false);
	assert.equal(adapter.push({ type: "agent_end", stopReason: "toolUse" }).length, 0);

	const tool = adapter.push({
		type: "tool_execution_start",
		toolName: "bash",
		toolCallId: "call_1",
	});
	assert.equal(tool[0].type, "tool-input-start");
	const next = adapter.push({ type: "message_start", message: { role: "assistant", id: "m2" } });
	assert.equal(next[0].type, "start-step");

	const settled = adapter.push({ type: "agent_settled" });
	assert.equal(settled.at(-1).type, "finish");
});

test("tool_execution_end with isError emits tool-output-error", () => {
	const adapter = new PiEventToUiMessageStream();
	adapter.push({ type: "tool_execution_start", toolName: "bash", toolCallId: "call_err" });
	const end = adapter.push({
		type: "tool_execution_end",
		toolCallId: "call_err",
		isError: true,
	});
	assert.equal(end.at(-1).type, "tool-output-error");
	assert.equal(end.at(-1).toolCallId, "call_err");
});

test("agent_end without error does not emit finish; settled does", () => {
	const adapter = new PiEventToUiMessageStream();
	assert.equal(adapter.push({ type: "agent_end", stopReason: "done" }).length, 0);
	assert.equal(adapter.push({ type: "agent_settled" })[0].type, "finish");
});

test("agent_settled also closes the Web stream", () => {
	const adapter = new PiEventToUiMessageStream();
	const frames = adapter.push({ type: "agent_settled" });
	assert.equal(frames[0].type, "finish");
});

test("agent_end error carries error frame before finish", () => {
	const adapter = new PiEventToUiMessageStream();
	const frames = adapter.push({ type: "agent_end", error: "boom" });
	assert.equal(frames[0].type, "error");
	assert.equal(frames[0].errorText, "boom");
	assert.equal(frames[1].type, "finish");
});

test("finish() closes open text/reasoning blocks", () => {
	const adapter = new PiEventToUiMessageStream();
	adapter.push({
		type: "message_update",
		assistantMessageEvent: { type: "text_delta", delta: "abc" },
	});
	const frames = adapter.finish();
	assert.equal(frames[0].type, "text-end");
	assert.equal(frames[1].type, "finish");
});

test("serializeSseFrame / SSE_DONE produce AI SDK wire format", () => {
	assert.equal(serializeSseFrame({ type: "finish" }), 'data: {"type":"finish"}\n\n');
	assert.equal(SSE_DONE, "data: [DONE]\n\n");
});

test("WebEventStreamRouter closes the response after sending the done marker", () => {
	const received = [];
	let finished = 0;
	const router = new WebEventStreamRouter(() => "session-1");
	router.add("session-1", (wire) => { received.push(wire); return true; }, () => {}, () => { finished += 1; });
	router.bindPiSource((handler) => {
		handler("agent-a", { type: "agent_settled" });
		return () => {};
	});
	assert.equal(received.at(-1), "data: [DONE]\n\n");
	assert.equal(finished, 1);
});

test("WebEventStreamRouter keeps translator state across socket reconnects", () => {
	let emitPiEvent;
	const first = [];
	const resumed = [];
	const router = new WebEventStreamRouter(() => "session-1");
	const closeFirst = router.add(
		"session-1",
		(wire) => { first.push(wire); return true; },
		() => {},
	);
	router.bindPiSource((handler) => {
		emitPiEvent = handler;
		return () => {};
	});
	emitPiEvent("agent-a", { type: "message_start", message: { role: "assistant", id: "m1" } });
	emitPiEvent("agent-a", {
		type: "message_update",
		assistantMessageEvent: { type: "thinking_delta", delta: "before disconnect" },
	});
	closeFirst();
	router.add(
		"session-1",
		(wire) => { resumed.push(wire); return true; },
		() => {},
	);
	// attach 不重放 snapshot 已包含的 delta，也不预建一个空 reasoning part。
	assert.deepEqual(resumed, []);
	emitPiEvent("agent-a", {
		type: "message_update",
		assistantMessageEvent: { type: "thinking_end", content: "before disconnect" },
	});
	emitPiEvent("agent-a", {
		type: "tool_execution_start",
		toolName: "read",
		toolCallId: "resumed-tool",
	});
	emitPiEvent("agent-a", { type: "message_start", message: { role: "assistant", id: "m2" } });
	emitPiEvent("agent-a", {
		type: "message_update",
		assistantMessageEvent: { type: "text_delta", delta: "resumed text" },
	});
	emitPiEvent("agent-a", { type: "agent_settled" });

	assert.match(first.join(""), /before disconnect/);
	assert.doesNotMatch(resumed.join(""), /"delta":"before disconnect"/);
	assert.match(resumed.join(""), /resumed text/);
	assert.match(resumed.join(""), /resumed-tool/);
	assert.match(resumed.join(""), /"type":"start-step"/);
	assert.doesNotMatch(resumed.join(""), /"type":"start","messageId":"m2"/);
	assert.equal(resumed.at(-1), SSE_DONE);
});

test("a resumed reasoning delta gets a socket-local start without replaying old content", () => {
	let emitPiEvent;
	const resumed = [];
	const router = new WebEventStreamRouter(() => "session-1");
	const closeFirst = router.add("session-1", () => true, () => {});
	router.bindPiSource((handler) => {
		emitPiEvent = handler;
		return () => {};
	});
	emitPiEvent("agent-a", {
		type: "message_update",
		assistantMessageEvent: { type: "thinking_delta", delta: "before" },
	});
	closeFirst();
	router.add("session-1", (wire) => { resumed.push(wire); return true; }, () => {});
	emitPiEvent("agent-a", {
		type: "message_update",
		assistantMessageEvent: { type: "thinking_delta", delta: "after" },
	});
	assert.match(resumed[0], /"type":"reasoning-start"/);
	assert.match(resumed[1], /"type":"reasoning-delta"/);
	assert.match(resumed[1], /"delta":"after"/);
	assert.doesNotMatch(resumed.join(""), /before/);
});

test("a text_end-only provider event reaches the AI SDK as complete message text", async () => {
	let emitPiEvent;
	const chunks = [];
	const router = new WebEventStreamRouter(() => "session-1");
	router.add(
		"session-1",
		(wire) => {
			if (wire !== SSE_DONE) chunks.push(JSON.parse(wire.slice(6)));
			return true;
		},
		() => {},
	);
	router.bindPiSource((handler) => {
		emitPiEvent = handler;
		return () => {};
	});
	emitPiEvent("agent-a", { type: "message_start", message: { role: "assistant", id: "m-text-final" } });
	emitPiEvent("agent-a", {
		type: "message_update",
		assistantMessageEvent: { type: "text_end", content: "完整正文来自 text_end" },
	});
	emitPiEvent("agent-a", { type: "agent_settled" });

	const parserErrors = [];
	const stream = new ReadableStream({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(chunk);
			controller.close();
		},
	});
	const initial = { id: "m-text-final", role: "assistant", parts: [] };
	let finalMessage = initial;
	for await (const message of readUIMessageStream({
		message: initial,
		stream,
		onError: (error) => parserErrors.push(error),
	})) finalMessage = message;

	assert.deepEqual(parserErrors, []);
	assert.equal(finalMessage.parts.find((part) => part.type === "text")?.text, "完整正文来自 text_end");
});

test("snapshot baseline plus resumed text delta preserves content without protocol replay evidence", async () => {
	let emitPiEvent;
	const router = new WebEventStreamRouter(() => "session-1");
	const closeFirst = router.add("session-1", () => true, () => {});
	router.bindPiSource((handler) => {
		emitPiEvent = handler;
		return () => {};
	});
	emitPiEvent("agent-a", { type: "message_start", message: { role: "assistant", id: "m-text-resume" } });
	emitPiEvent("agent-a", {
		type: "message_update",
		assistantMessageEvent: { type: "text_delta", delta: "first " },
	});
	closeFirst();

	emitPiEvent("agent-a", {
		type: "message_update",
		assistantMessageEvent: { type: "text_delta", delta: "gap " },
	});
	const chunks = [];
	router.add(
		"session-1",
		(wire) => {
			if (wire !== SSE_DONE) chunks.push(JSON.parse(wire.slice(6)));
			return true;
		},
		() => {},
	);
	emitPiEvent("agent-a", {
		type: "message_update",
		assistantMessageEvent: { type: "text_delta", delta: "last" },
	});
	emitPiEvent("agent-a", {
		type: "message_update",
		assistantMessageEvent: { type: "text_end", content: "first gap last" },
	});
	emitPiEvent("agent-a", { type: "agent_settled" });

	const parserErrors = [];
	const stream = new ReadableStream({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(chunk);
			controller.close();
		},
	});
	const initial = {
		id: "m-text-resume",
		role: "assistant",
		parts: [{ type: "text", text: "first gap last" }],
	};
	let finalMessage = initial;
	for await (const message of readUIMessageStream({
		message: initial,
		stream,
		onError: (error) => parserErrors.push(error),
	})) finalMessage = message;

	assert.deepEqual(parserErrors, []);
	const textParts = finalMessage.parts.filter((part) => part.type === "text");
	assert.equal(textParts.length, 2, "the resumed socket streams only the received delta after the snapshot baseline");
	const displayParts = mergeAdjacentWebMessageParts(finalMessage.parts);
	assert.equal(displayParts.filter((part) => part.type === "text").length, 1);
	// The wire contains no replay identity/offset. Do not guess based on UIMessage part state.
	assert.equal(displayParts.find((part) => part.type === "text")?.text, "first gap lastlast");
});

test("snapshot plus resumed thinking_end does not duplicate reasoning in the AI SDK parser", async () => {
	let emitPiEvent;
	const router = new WebEventStreamRouter(() => "session-1");
	const closeFirst = router.add("session-1", () => true, () => {});
	router.bindPiSource((handler) => {
		emitPiEvent = handler;
		return () => {};
	});
	emitPiEvent("agent-a", { type: "message_start", message: { role: "assistant", id: "m1" } });
	emitPiEvent("agent-a", {
		type: "message_update",
		assistantMessageEvent: { type: "thinking_delta", delta: "abcdef" },
	});
	closeFirst();

	const chunks = [];
	router.add(
		"session-1",
		(wire) => {
			if (wire !== SSE_DONE) chunks.push(JSON.parse(wire.slice(6)));
			return true;
		},
		() => {},
	);
	emitPiEvent("agent-a", {
		type: "message_update",
		assistantMessageEvent: { type: "thinking_end", content: "abcdef" },
	});
	emitPiEvent("agent-a", { type: "agent_settled" });

	const parserErrors = [];
	const stream = new ReadableStream({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(chunk);
			controller.close();
		},
	});
	const initial = { id: "m1", role: "assistant", parts: [{ type: "reasoning", text: "abcdef" }] };
	let finalMessage = initial;
	for await (const message of readUIMessageStream({
		message: initial,
		stream,
		onError: (error) => parserErrors.push(error),
	})) finalMessage = message;

	assert.deepEqual(parserErrors, []);
	const reasoningParts = finalMessage.parts.filter((part) => part.type === "reasoning");
	assert.equal(reasoningParts.length, 1, "resume must not append an empty reasoning part");
	assert.equal(reasoningParts[0].text, "abcdef");
});

test("WebEventStreamRouter rejects late events from an older run generation", () => {
	let emitPiEvent;
	const received = [];
	const router = new WebEventStreamRouter(() => "session-1");
	router.add("session-1", (wire) => { received.push(wire); return true; }, () => {});
	router.bindPiSource((handler) => {
		emitPiEvent = handler;
		return () => {};
	});
	emitPiEvent("agent-a", { type: "agent_start" }, 1);
	emitPiEvent("agent-a", { type: "agent_start" }, 2);
	emitPiEvent("agent-a", { type: "agent_settled" }, 1);
	emitPiEvent("agent-a", {
		type: "message_update",
		assistantMessageEvent: { type: "text_delta", delta: "new run" },
	}, 2);
	assert.doesNotMatch(received.join(""), /"type":"finish"/);
	assert.match(received.join(""), /new run/);
});

test("WebEventStreamRouter routes agent events to per-session entries only", () => {
	const received = [];
	const router = new WebEventStreamRouter((agentId) => {
		if (agentId === "agent-a") return "session-1";
		return undefined;
	});
	router.add("session-1", (wire) => { received.push(wire); return true; }, () => {});
	// 绑定 pi 源后事件按 agentId → sessionId 路由；finish 后自动附 [DONE]
	router.bindPiSource((handler) => {
		handler("agent-a", { type: "message_start", message: { role: "assistant" } });
		handler("other-agent", { type: "agent_settled" });
		handler("agent-a", { type: "agent_settled" });
		return () => {};
	});
	assert.equal(received.length, 3);
	assert.match(received[0], /data: \{"type":"start"/);
	assert.match(received[1], /data: \{"type":"finish"\}/);
	assert.equal(received[2], "data: [DONE]\n\n");

	router.unbindPiSource();
});

/** 起一个真实 WebServiceManager（只提供 SSE 路径需要的依赖），返回 baseUrl 与 pi 事件触发器。 */
async function withStreamServer(run, { runtimeStatus = "running" } = {}) {
	const WebServiceManager = loadTsCommonJs("src/main/web/WebServiceManager.ts", {
		globals: { fetch: globalThis.fetch, Response: globalThis.Response, ReadableStream: globalThis.ReadableStream },
	}).WebServiceManager;
	let emitPiEvent = null;
	const manager = new WebServiceManager({
		subscribePiEvents: (handler) => {
			emitPiEvent = handler;
			return () => { emitPiEvent = null; };
		},
		getSessionIdForAgent: (agentId) => (agentId === "agent-1" ? "session-1" : undefined),
		listSessionRuntimes: () => [{
			sessionId: "session-1",
			agentId: "agent-1",
			runtimeGeneration: 1,
			projectId: "project-1",
			cwd: "C:/project",
			status: runtimeStatus,
			createdAt: 1,
		}],
	});
	const token = "t".repeat(43);
	await manager.start("127.0.0.1", 0, token);
	try {
		await run({
			baseUrl: `http://127.0.0.1:${manager.current.port}`,
			token,
			manager,
			emit: (agentId, event) => emitPiEvent(agentId, event),
		});
	} finally {
		await manager.stop();
	}
}

test("GET /stream answers with the AI SDK protocol header and a [DONE]-terminated SSE body", async () => {
	await withStreamServer(async ({ baseUrl, token, emit }) => {
		const response = await fetch(`${baseUrl}/api/sessions/session-1/stream`, {
			headers: { authorization: `Bearer ${token}`, accept: "text/event-stream" },
		});
		assert.equal(response.status, 200);
		assert.equal(response.headers.get("x-vercel-ai-ui-message-stream"), "v1");
		assert.match(response.headers.get("content-type") ?? "", /^text\/event-stream/);
		emit("agent-1", { type: "agent_settled" });
		const body = await response.text();
		assert.match(body, /data: \{"type":"finish"\}\n\n/);
		assert.ok(body.endsWith(SSE_DONE), "stream must end with the [DONE] marker");
	});
});

test("GET /stream only delivers events of the agent bound to that session", async () => {
	await withStreamServer(async ({ baseUrl, token, emit }) => {
		const response = await fetch(`${baseUrl}/api/sessions/session-1/stream`, {
			headers: { authorization: `Bearer ${token}` },
		});
		emit("foreign-agent", {
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", delta: "LEAKED" },
		});
		emit("agent-1", {
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", delta: "mine" },
		});
		emit("agent-1", { type: "agent_settled" });
		const body = await response.text();
		assert.match(body, /mine/);
		assert.doesNotMatch(body, /LEAKED/);
	});
});

test("GET /stream rejects unauthenticated clients before any SSE headers are written", async () => {
	await withStreamServer(async ({ baseUrl }) => {
		const response = await fetch(`${baseUrl}/api/sessions/session-1/stream`);
		assert.equal(response.status, 401);
		assert.equal(response.headers.get("x-vercel-ai-ui-message-stream"), null);
	});
});

test("createBackend wires the Web pi event source to AgentManager local listeners", async () => {
	const harness = await startWebWiringHarness();
	try {
		const [deps] = harness.webDeps;
		assert.ok(deps, "createBackend must construct the WebServiceManager");
		const received = [];
		const unsubscribe = deps.subscribePiEvents((agentId, event, generation) => {
			received.push({ agentId, event, generation });
		});
		assert.equal(harness.localListeners.size, 1, "subscribing must register one AgentManager listener");
		for (const listener of harness.localListeners) {
			listener("agent-9", { type: "agent_settled" }, 7);
		}
		assert.deepEqual(received, [{ agentId: "agent-9", event: { type: "agent_settled" }, generation: 7 }]);
		unsubscribe();
		assert.equal(harness.localListeners.size, 0, "the returned unsubscribe must detach the listener");
	} finally {
		await harness.dispose();
	}
});

test("createBackend resolves Web agent ids to Session ids through the runtime coordinator", async () => {
	const harness = await startWebWiringHarness();
	try {
		harness.bindAgentToSession("agent-1", "session-1");
		const [deps] = harness.webDeps;
		assert.equal(deps.getSessionIdForAgent("agent-1"), "session-1");
		assert.equal(deps.getSessionIdForAgent("unknown-agent"), undefined);
	} finally {
		await harness.dispose();
	}
});

const STREAMED_SESSION = {
	id: "s1",
	projectId: "p1",
	title: "Session One",
	status: "active",
	projectPath: "C:/project",
};

/** 页面所需的最小 /api 假后端；authoritative 是流结束后 /messages/page 返回的权威消息。 */
function createLegacyPageBackend(authoritativeMessages, sse) {
	let messagePageFetches = 0;
	const handle = async (url) => {
		if (url === "/api/state") {
			return {
				json: {
					projects: [],
					sessions: [STREAMED_SESSION],
					runtimes: [],
					messagesBySession: { s1: [{ id: "u1", role: "user", text: "hi" }] },
					pendingUiRequests: [],
				},
			};
		}
		if (url.startsWith("/api/sessions/s1/prompt")) {
			return { json: { result: { accepted: true, sessionId: "s1", requestId: "r" } } };
		}
		if (url.startsWith("/api/sessions/s1/stream")) return { stream: sse.stream };
		if (url.startsWith("/api/sessions/s1/messages/page")) {
			messagePageFetches += 1;
			return { json: { messages: authoritativeMessages, total: authoritativeMessages.length, nextBefore: null } };
		}
		throw new Error(`unexpected request ${url}`);
	};
	return { handle, messagePageFetches: () => messagePageFetches };
}

test("legacy web page keeps the live streaming block when the 600ms poll refreshes", async () => {
	const sse = createControlledSseBody();
	const backend = createLegacyPageBackend([], sse);
	const page = await bootLegacyWebPage(backend.handle);
	assert.match(page.document.getElementById("messages").textContent, /hi/);

	await page.submitPrompt("question");
	sse.pushFrame({ type: "text-start", id: "t1" });
	sse.pushFrame({ type: "text-delta", id: "t1", delta: "typing live" });
	await settle();
	assert.match(page.document.querySelector(".streaming-text")?.textContent ?? "", /typing live/);

	await page.runPoll();
	// 轮询只刷新侧栏/状态，整体重绘 #messages 会清掉正在打字的流式块。
	assert.match(
		page.document.querySelector(".streaming-text")?.textContent ?? "",
		/typing live/,
		"poll refresh must not wipe the in-flight streaming block",
	);
	sse.close();
	await settle();
});

test("legacy web page replaces streamed blocks with the authoritative messages on [DONE]", async () => {
	const sse = createControlledSseBody();
	const backend = createLegacyPageBackend([
		{ id: "u1", role: "user", text: "hi" },
		{ id: "a1", role: "assistant", text: "final persisted answer" },
	], sse);
	const page = await bootLegacyWebPage(backend.handle);

	await page.submitPrompt("question");
	sse.pushFrame({ type: "text-delta", id: "t1", delta: "partial" });
	await settle();
	assert.ok(page.document.querySelector(".streaming-text"), "precondition: a streamed block is displayed");
	assert.equal(backend.messagePageFetches(), 0);

	sse.pushDone();
	await settle(12);
	assert.equal(backend.messagePageFetches(), 1, "[DONE] must reload the authoritative message list once");
	assert.equal(page.document.querySelector(".streaming-text"), null, "streamed increments must be replaced");
	const rendered = page.document.getElementById("messages").textContent;
	assert.match(rendered, /final persisted answer/);
	sse.close();
});

test("legacy web page inline script is syntactically valid JavaScript", () => {
	const { WebServiceManager } = loadTsCommonJs("src/main/web/WebServiceManager.ts");
	const html = new WebServiceManager({
		subscribePiEvents: () => () => undefined,
		getSessionIdForAgent: () => undefined,
	}).renderPage();
	const script = html.slice(html.indexOf("<script>") + "<script>".length, html.lastIndexOf("</script>"));
	assert.doesNotThrow(() => new vm.Script(script));
});

test("WebServiceManager disables Node request timeouts but keeps the default keep-alive timeout", async () => {
	const { createServer } = await import("node:http");
	const pristine = createServer();
	const defaultKeepAlive = pristine.keepAliveTimeout;
	pristine.close();
	await withStreamServer(async ({ manager }) => {
		// 长回复 SSE 超过 5 分钟不能被 Node 的请求/头超时切断；keep-alive 仍保持默认以便回收空闲连接。
		assert.equal(manager.server.requestTimeout, 0);
		assert.equal(manager.server.headersTimeout, 0);
		assert.equal(manager.server.keepAliveTimeout, defaultKeepAlive);
	});
});

/** 构造带一个运行时的 AgentManager，并返回收集本地事件的 listener 记录。 */
function createAgentManagerWithListener() {
	const { AgentManager } = loadTsCommonJs("src/main/pi/AgentManager.ts");
	const manager = new AgentManager(
		() => ({ id: "project-1", name: "Project", path: "C:/project" }),
		() => null,
		{ get: () => ({}) },
		{},
	);
	manager.agents.set("agent-1", {
		tab: {
			id: "agent-1",
			projectId: "project-1",
			cwd: "C:/project",
			title: "Session",
			status: "idle",
			sessionPath: "C:/project/.pi/sessions/x.jsonl",
			sessionEnvironment: "native",
			sessionSource: "pi",
			createdAt: 1,
		},
		process: { client: { request: async () => ({ success: true, data: {} }) } },
	});
	const seen = [];
	manager.addLocalEventListener((agentId, event, generation) => seen.push({ agentId, event, generation }));
	return { manager, seen };
}

test("AgentManager emits each pi event to local (Web SSE) listeners exactly once", () => {
	// 重复 emit 会让 Web 端每个 text_delta 被追加两遍。
	const { manager, seen } = createAgentManagerWithListener();
	const events = [
		{ type: "agent_start" },
		{ type: "message_start", message: { role: "assistant", id: "m1" } },
		{ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Hello" } },
		{ type: "tool_execution_start", toolName: "bash", toolCallId: "c1" },
		{ type: "agent_end" },
	];
	for (const event of events) manager.handlePiEvent("agent-1", event);
	assert.deepEqual(
		seen.map((entry) => entry.event.type),
		events.map((event) => event.type),
	);
});

test("AgentManager forwards agent_start with the next stream generation to local listeners", () => {
	const { manager, seen } = createAgentManagerWithListener();
	const before = manager.getStreamGate("agent-1").currentGeneration;
	manager.handlePiEvent("agent-1", { type: "agent_start" });
	assert.equal(seen.length, 1);
	assert.equal(seen[0].generation, before + 1);
});

test("tool_execution_end without a start still opens the same toolCallId", () => {
	const adapter = new PiEventToUiMessageStream();
	const frames = adapter.push({
		type: "tool_execution_end",
		toolName: "bash",
		toolCallId: "late-1",
		isError: false,
	});
	assert.equal(frames[0].type, "tool-input-start");
	assert.equal(frames[0].toolCallId, "late-1");
	assert.equal(frames[1].type, "tool-input-available");
	assert.equal(frames[2].type, "tool-output-available");
	assert.equal(frames[2].toolCallId, "late-1");
});

test("repeated tool_execution_start keeps a single invocation for the same id", () => {
	const adapter = new PiEventToUiMessageStream();
	const first = adapter.push({
		type: "tool_execution_start",
		toolName: "bash",
		toolCallId: "call-dup",
	});
	const second = adapter.push({
		type: "tool_execution_start",
		toolName: "bash",
		toolCallId: "call-dup",
	});
	assert.equal(first.length, 2);
	assert.equal(second.length, 0);
});

test("anonymous tool_execution_end reuses the last started toolCallId", () => {
	const adapter = new PiEventToUiMessageStream();
	adapter.push({
		type: "tool_execution_start",
		toolName: "bash",
		toolCallId: "anon-start",
	});
	const end = adapter.push({
		type: "tool_execution_end",
		toolName: "bash",
		isError: false,
	});
	assert.equal(end.at(-1).type, "tool-output-available");
	assert.equal(end.at(-1).toolCallId, "anon-start");
});

test("settled closes leftover tool cards that never received an end", () => {
	const adapter = new PiEventToUiMessageStream();
	adapter.push({
		type: "tool_execution_start",
		toolName: "bash",
		toolCallId: "orphan-1",
	});
	const settled = adapter.push({ type: "agent_settled" });
	assert.equal(settled[0].type, "tool-output-available");
	assert.equal(settled[0].toolCallId, "orphan-1");
	assert.equal(settled.at(-1).type, "finish");
});
