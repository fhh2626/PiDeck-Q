import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * Web SSE 流式化（A1）：pi 事件 → AI SDK v5 UIMessageStream 帧 翻译器。
 * 验证：
 * 1) text_delta 生成 text-start/text-delta/text-end 三件套（首帧自动补 start）
 * 2) thinking_delta/end 生成 reasoning 块
 * 3) tool_execution_start/end 生成 tool-input/output-available
 * 4) agent_end 收尾（error 时带 error 帧）
 * 5) 端点与协议头接线（WebServiceManager 注册 /stream + x-vercel-ai-ui-message-stream）
 */

const webServiceSource = readFileSync("src/main/web/WebServiceManager.ts", "utf8");
const createBackendSource = readFileSync("src/main/backend/createBackend.ts", "utf8");

const {
	PiEventToUiMessageStream,
	WebEventStreamRouter,
	SSE_DONE,
	serializeSseFrame,
} = loadTsCommonJs("src/main/web/WebEventStream.ts");

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

test("WebEventStreamRouter resumes a session with a fresh subscription", () => {
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
	emitPiEvent("agent-a", {
		type: "message_update",
		assistantMessageEvent: { type: "thinking_delta", delta: "after reconnect" },
	});
	emitPiEvent("agent-a", {
		type: "message_update",
		assistantMessageEvent: { type: "text_delta", delta: "resumed text" },
	});
	emitPiEvent("agent-a", {
		type: "tool_execution_start",
		toolName: "read",
		toolCallId: "resumed-tool",
	});
	emitPiEvent("agent-a", { type: "agent_settled" });

	assert.match(first.join(""), /before disconnect/);
	assert.doesNotMatch(first.join(""), /after reconnect/);
	assert.match(resumed.join(""), /after reconnect/);
	assert.match(resumed.join(""), /resumed text/);
	assert.match(resumed.join(""), /resumed-tool/);
	assert.equal(resumed.at(-1), SSE_DONE);
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

test("WebServiceManager registers /stream SSE endpoint with protocol header", () => {
	assert.match(webServiceSource, /\/api\/sessions\/([^/]+)\/stream/);
	assert.match(webServiceSource, /x-vercel-ai-ui-message-stream/);
	assert.match(webServiceSource, /text\/event-stream/);
	// [DONE] 终止标记在翻译器模块
	assert.match(
		readFileSync("src/main/web/WebEventStream.ts", "utf8"),
		/data: \[DONE\]/,
	);
});

test("index.ts wires pi event source + agent-to-session router to WebServiceManager", () => {
	assert.match(createBackendSource, /subscribePiEvents:/);
	assert.match(createBackendSource, /addLocalEventListener/);
	assert.match(createBackendSource, /getSessionIdForAgent:/);
	assert.match(createBackendSource, /getSessionId\(agentId\)/);
});

test("web frontend preserves streaming block during polling refresh", () => {
  // refresh() 在流式活跃时只渲染侧栏/状态，不整体重绘 #messages
  assert.match(webServiceSource, /if \(streamingSessionId\)/);
  assert.match(webServiceSource, /renderMessages\(\)/);
  // render() 不再直接操作 #messages（拆到 renderMessages）
  const renderBody = webServiceSource.slice(
    webServiceSource.indexOf("function render() {"),
    webServiceSource.indexOf("function renderMessages()"),
  );
  assert.doesNotMatch(renderBody, /el\("messages"\)/);
});

test("web frontend reloads authoritative messages on stream finish", () => {
  // [DONE] 后先停流、再 loadSessionMessages + 整体重绘（替换流式增量块）
  assert.match(webServiceSource, /finishStream\(sessionId\)/);
  assert.match(webServiceSource, /loadSessionMessages\(sessionId\)/);
  assert.match(webServiceSource, /async function finishStream/);
});
test("WebServiceManager disables Node request timeouts for long SSE replies", () => {
	assert.match(webServiceSource, /server\.requestTimeout = 0/);
	assert.match(webServiceSource, /server\.headersTimeout = 0/);
	assert.doesNotMatch(webServiceSource, /server\.keepAliveTimeout = 0/);
});

test("handlePiEvent emits each local event once for Web SSE", () => {
	const agentManager = readFileSync("src/main/pi/AgentManager.ts", "utf8");
	const handler = agentManager.slice(
		agentManager.indexOf("private handlePiEvent("),
		agentManager.indexOf("private beginAssistantMessage("),
	);
	const emits = handler.match(/this\.emitLocalEvent\(/g) ?? [];
	assert.equal(emits.length, 1, "duplicate local emits replay every text_delta twice on Web");
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
