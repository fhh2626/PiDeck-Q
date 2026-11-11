import assert from "node:assert/strict";
import test from "node:test";
import { readUIMessageStream } from "ai";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { PiEventToUiMessageStream, WebEventStreamRouter, SSE_DONE } = loadTsCommonJs("src/main/web/WebEventStream.ts");
const { readCurrentWebStreamTools, readRunningWebTools } = loadTsCommonJs("src/main/web/webStreamTools.ts");
const TOOL_NAMES = ["subagent", "bg_wait", "bash", "powershell", "read", "write", "edit", "web_search", "webfetch", "todo", "ask_question", "mcp__fixture__inspect"];

/** A real router with an independently attachable socket, without a Pi process. */
function fixture() {
	let emit;
	const router = new WebEventStreamRouter((agentId) => agentId === "agent" ? "session" : undefined);
	router.bindPiSource((handler) => { emit = handler; return () => {}; });
	const attach = (tools = []) => {
		const frames = [];
		const close = router.add("session", (wire) => {
			if (wire !== SSE_DONE) frames.push(JSON.parse(wire.slice(6)));
			return true;
		}, () => {}, undefined, tools);
		return { frames, close };
	};
	return { router, emit, attach };
}

for (const toolName of TOOL_NAMES) {
	test(`joining during ${toolName} restores the active tool before its next event`, () => {
		const { router, emit, attach } = fixture();
		emit("agent", { type: "agent_start" }, 1);
		emit("agent", { type: "tool_execution_start", toolName, toolCallId: "call", args: { task: "fixture" } }, 1);
		const first = attach();
		assert.deepEqual(first.frames.map((frame) => frame.type), ["tool-input-start", "tool-input-available"]);
		assert.equal(first.frames[1].toolName, toolName);
		assert.equal(first.frames[1].toolCallId, "call");
		assert.deepEqual(first.frames[1].input, { task: "fixture" });
		const second = attach();
		assert.equal(first.frames.length, 2, "attaching another socket must not broadcast a replay to existing readers");
		assert.equal(second.frames.length, 2);
		emit("agent", { type: "tool_execution_end", toolName, toolCallId: "call" }, 1);
		assert.equal(first.frames.at(-1).type, "tool-output-available");
		assert.equal(second.frames.at(-1).type, "tool-output-available");
		router.unbindPiSource();
	});
}

test("completed tools are not replayed, while parallel active tools survive repeated reconnects", () => {
	const { router, emit, attach } = fixture();
	for (const id of ["finished", "active-a", "active-b"]) {
		emit("agent", { type: "tool_execution_start", toolName: "subagent", toolCallId: id });
	}
	emit("agent", { type: "tool_execution_end", toolName: "subagent", toolCallId: "finished" });
	const first = attach();
	first.close();
	const resumed = attach();
	assert.deepEqual(resumed.frames.filter((frame) => frame.type === "tool-input-available").map((frame) => frame.toolCallId), ["active-a", "active-b"]);
	assert.equal(resumed.frames.some((frame) => frame.toolCallId === "finished"), false);
	router.unbindPiSource();
});

test("toolcall_end means arguments are ready, not that subagent execution succeeded", () => {
	const adapter = new PiEventToUiMessageStream();
	const input = { agent: "readonly", task: "inspect" };
	const declared = adapter.push({ type: "message_update", assistantMessageEvent: {
		type: "toolcall_end", toolCall: { type: "toolCall", id: "sub", name: "subagent", arguments: input },
	} });
	assert.equal(declared.some((frame) => frame.type.startsWith("tool-output")), false);
	assert.equal(JSON.stringify(declared.find((frame) => frame.type === "tool-input-available")?.input), JSON.stringify(input));
	assert.equal(adapter.push({ type: "tool_execution_start", toolName: "subagent", toolCallId: "sub", args: input }).length, 0);
	const ended = adapter.push({ type: "tool_execution_end", toolName: "subagent", toolCallId: "sub", isError: true });
	assert.equal(ended.at(-1).type, "tool-output-error", "an actual execution error must not be swallowed by a premature success");
});

test("an assistant message snapshot recovers calls when tool execution start was missed", () => {
	const { router, emit, attach } = fixture();
	emit("agent", { type: "message_end", message: { role: "assistant", content: [
		{ type: "toolCall", id: "sub", name: "subagent", arguments: { task: "inspect" } },
	] } }, 1);
	const socket = attach();
	assert.equal(socket.frames.find((frame) => frame.type === "tool-input-available")?.toolName, "subagent");
	emit("agent", { type: "tool_execution_start", toolName: "subagent", toolCallId: "sub", args: { task: "inspect" } }, 1);
	assert.equal(socket.frames.filter((frame) => frame.type === "tool-input-start").length, 1);
	router.unbindPiSource();
});

test("a progress-only tool event also recovers a missed start", () => {
	const { router, emit, attach } = fixture();
	emit("agent", { type: "tool_execution_update", toolName: "subagent", toolCallId: "sub" }, 1);
	const socket = attach();
	assert.equal(socket.frames.find((frame) => frame.type === "tool-input-available")?.toolCallId, "sub");
	assert.equal(socket.frames.some((frame) => frame.type.startsWith("tool-output")), false);
	router.unbindPiSource();
});

test("late tool events from an old generation neither settle nor resurrect new-generation tools", () => {
	const { router, emit, attach } = fixture();
	emit("agent", { type: "agent_start" }, 1);
	emit("agent", { type: "tool_execution_start", toolName: "subagent", toolCallId: "same" }, 1);
	emit("agent", { type: "agent_start" }, 2);
	emit("agent", { type: "tool_execution_start", toolName: "subagent", toolCallId: "same" }, 2);
	emit("agent", { type: "tool_execution_end", toolName: "subagent", toolCallId: "same", isError: true }, 1);
	emit("agent", { type: "tool_execution_start", toolName: "subagent", toolCallId: "stale" }, 1);
	const socket = attach();
	assert.deepEqual(socket.frames.filter((frame) => frame.type === "tool-input-available").map((frame) => frame.toolCallId), ["same"]);
	emit("agent", { type: "tool_execution_end", toolName: "subagent", toolCallId: "same" }, 2);
	assert.equal(socket.frames.at(-1).type, "tool-output-available");
	router.unbindPiSource();
});

test("replayed tools update an existing dynamic snapshot in the real AI SDK without duplicates", async () => {
	const { router, emit, attach } = fixture();
	emit("agent", { type: "tool_execution_start", toolName: "subagent", toolCallId: "sub", args: { task: "inspect" } }, 1);
	const socket = attach();
	emit("agent", { type: "tool_execution_end", toolName: "subagent", toolCallId: "sub" }, 1);
	emit("agent", { type: "agent_settled" }, 1);
	const stream = new ReadableStream({ start(controller) {
		for (const frame of socket.frames) controller.enqueue(frame);
		controller.close();
	} });
	const initial = { id: "snapshot", role: "assistant", parts: [{
		type: "dynamic-tool", toolName: "subagent", toolCallId: "sub", state: "input-available", input: { task: "inspect" },
	}] };
	const errors = [];
	let final = initial;
	for await (const message of readUIMessageStream({ message: initial, stream, onError: (error) => errors.push(error) })) final = message;
	assert.deepEqual(errors, []);
	const tools = final.parts.filter((part) => "toolCallId" in part);
	assert.equal(tools.length, 1);
	assert.equal(tools[0].toolName, "subagent");
	assert.equal(tools[0].state, "output-available");
	router.unbindPiSource();
});

test("large replay inputs remain stable across progress events without arguments", () => {
	const adapter = new PiEventToUiMessageStream();
	adapter.push({ type: "tool_execution_start", toolName: "subagent", toolCallId: "sub", args: { task: "x".repeat(20_000) } });
	for (let i = 0; i < 3; i++) {
		assert.equal(adapter.push({ type: "tool_execution_update", toolName: "subagent", toolCallId: "sub" }).length, 0);
	}
	const end = adapter.push({ type: "tool_execution_end", toolName: "subagent", toolCallId: "sub" });
	assert.deepEqual(Array.from(end, (frame) => frame.type), ["tool-output-available"]);
});

test("a cold translator accepts bounded live snapshot inputs without reviving completed tools", () => {
	const { router, emit, attach } = fixture();
	const first = attach([{ toolCallId: "sub", toolName: "subagent", args: { task: "x".repeat(20_000) } }]);
	assert.equal(first.frames.find((frame) => frame.type === "tool-input-available")?.toolName, "subagent");
	assert.ok(JSON.stringify(first.frames).length < 10_000, "a reconnect must not retain/replay unbounded tool input");
	emit("agent", { type: "tool_execution_end", toolCallId: "sub", toolName: "subagent" });
	const second = attach([{ toolCallId: "sub", toolName: "subagent", args: {} }]);
	assert.equal(second.frames.length, 0, "a stale running snapshot must not reopen a known completed call");
	router.unbindPiSource();
});

test("runtime bootstrap accepts only matching session, agent, generation and running state", () => {
	const runtime = { sessionId: "s", agentId: "a", runtimeGeneration: 3, status: "running" };
	const tool = { id: "tool", agentId: "a", role: "tool", text: "subagent", timestamp: 1,
		meta: { status: "running", toolName: "subagent", toolCallId: "sub", args: '{"task":"inspect"}' } };
	const snapshot = { target: runtime, value: [tool] };
	const calls = readCurrentWebStreamTools("s", [runtime], snapshot);
	assert.equal(calls.length, 1);
	assert.equal(JSON.stringify(calls[0].args), '{"task":"inspect"}');
	assert.equal(readCurrentWebStreamTools("s", [runtime], undefined).length, 0);
	assert.equal(readCurrentWebStreamTools("s", [{ ...runtime, status: "idle" }], snapshot).length, 0);
	for (const patch of [{ sessionId: "other" }, { agentId: "old-agent" }, { runtimeGeneration: 2 }]) {
		assert.equal(readCurrentWebStreamTools("s", [runtime], { ...snapshot, target: { ...runtime, ...patch } }).length, 0);
	}
	assert.equal(readRunningWebTools([
		{ ...tool, role: "assistant" }, { ...tool, meta: { ...tool.meta, status: "done" } },
		{ ...tool, meta: { ...tool.meta, status: "error" } }, { ...tool, meta: { ...tool.meta, toolCallId: "" } },
	]).length, 0);
});

test("a failed replay writer is cleaned up without affecting another subscriber", () => {
	const { router, emit, attach } = fixture();
	emit("agent", { type: "tool_execution_start", toolName: "subagent", toolCallId: "sub" });
	let writes = 0, closes = 0;
	router.add("session", () => { writes++; return false; }, () => { closes++; });
	const healthy = attach();
	emit("agent", { type: "tool_execution_end", toolName: "subagent", toolCallId: "sub" });
	assert.equal(writes, 1);
	assert.equal(closes, 1);
	assert.equal(healthy.frames.at(-1).type, "tool-output-available");
	router.unbindPiSource();
});

/** Feed wire frames through the real AI SDK parser, exactly like useChat does. */
async function drainFrames(frames, initial) {
	const stream = new ReadableStream({ start(controller) {
		for (const frame of frames) controller.enqueue(frame);
		controller.close();
	} });
	const errors = [];
	let final = initial;
	for await (const message of readUIMessageStream({ message: initial, stream, onError: (error) => errors.push(error) })) final = message;
	return { final, errors };
}

/** readUIMessageStream mutates the seed message, so every test needs a fresh one. */
const emptyAssistant = () => ({ id: "stream", role: "assistant", parts: [] });

test("a replayed running tool is not duplicated into a second step by the real AI SDK", async () => {
	const { router, emit, attach } = fixture();
	emit("agent", { type: "agent_start" }, 1);
	emit("agent", { type: "tool_execution_start", toolName: "mcp__fixture__inspect", toolCallId: "call", args: { task: "fixture" } }, 1);
	// 冷 translator 从中途工具回放开始：回放帧把 part 建在当前 step 里。
	const socket = attach();
	emit("agent", { type: "message_start", message: { role: "assistant", id: "m2" } }, 1);
	emit("agent", { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "still working" } }, 1);
	emit("agent", { type: "agent_settled" }, 1);
	const { final, errors } = await drainFrames(socket.frames, emptyAssistant());
	assert.deepEqual(errors, []);
	const tools = final.parts.filter((part) => "toolCallId" in part);
	assert.equal(tools.length, 1, "one toolCallId must stay exactly one part");
	assert.equal(tools[0].state, "input-available");
	assert.equal(tools[0].toolMetadata?.resultMissing, true, "no terminal evidence must surface as unknown");
	assert.equal(tools[0].toolName, "mcp__fixture__inspect");
	assert.equal(tools[0].input.task, "fixture");
	router.unbindPiSource();
});

test("parallel calls, input updates and a genuine second step never duplicate a part in the real AI SDK", async () => {
	const adapter = new PiEventToUiMessageStream();
	const frames = [];
	const push = (event) => { frames.push(...adapter.push(event)); };
	push({ type: "message_start", message: { role: "assistant", id: "m1" } });
	push({ type: "tool_execution_start", toolName: "bash", toolCallId: "a", args: { command: "ls" } });
	push({ type: "tool_execution_start", toolName: "read", toolCallId: "b", args: { path: "x" } });
	push({ type: "tool_execution_update", toolName: "bash", toolCallId: "a", args: { command: "ls -la" } });
	push({ type: "tool_execution_end", toolName: "bash", toolCallId: "a" });
	push({ type: "tool_execution_end", toolName: "read", toolCallId: "b" });
	push({ type: "message_start", message: { role: "assistant", id: "m2" } });
	// 收尾后的迟到 update 不能复活旧工具，也不能造出第二条 part。
	push({ type: "tool_execution_update", toolName: "bash", toolCallId: "a", args: { command: "ls -la" } });
	push({ type: "tool_execution_start", toolName: "edit", toolCallId: "c", args: { file: "y" } });
	push({ type: "tool_execution_end", toolName: "edit", toolCallId: "c" });
	push({ type: "agent_settled" });
	const { final, errors } = await drainFrames(frames, emptyAssistant());
	assert.deepEqual(errors, []);
	const tools = final.parts.filter((part) => "toolCallId" in part);
	assert.deepEqual(Array.from(tools, (part) => part.toolCallId), ["a", "b", "c"]);
	assert.deepEqual(Array.from(tools, (part) => part.state), ["output-available", "output-available", "output-available"]);
	assert.equal(tools[0].input.command, "ls -la", "the last live input update must win");
});

test("a live >8k structured input stays intact, while the retained replay snapshot stays bounded", () => {
	const { router, emit, attach } = fixture();
	const socket = attach();
	const args = { patch: "x".repeat(20_000), nested: { keep: true } };
	emit("agent", { type: "tool_execution_start", toolName: "write", toolCallId: "big", args }, 1);
	const live = socket.frames.find((frame) => frame.type === "tool-input-available");
	assert.deepEqual(live.input, args, "live frames must carry the real structured input, not a truncated string");
	assert.equal(typeof live.input, "object");
	const resumed = attach();
	const replayed = resumed.frames.find((frame) => frame.type === "tool-input-available");
	assert.equal(typeof replayed.input, "string", "replay keeps the bounded snapshot");
	assert.ok(replayed.input.length <= 8001);
	assert.ok(JSON.stringify(resumed.frames).length < 10_000, "reconnect must not replay unbounded input");
	// 未知收尾也不能把已经展示的大参数降级成截断串。
	emit("agent", { type: "agent_settled" }, 1);
	const unknown = socket.frames.at(-2);
	assert.equal(unknown.type, "tool-input-available");
	assert.equal(unknown.toolMetadata.resultMissing, true);
	assert.deepEqual(unknown.input, args);
	router.unbindPiSource();
});
