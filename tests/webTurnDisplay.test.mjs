/**
 * Web 整轮展示模型单测：buildWebTurnDisplay（折叠区/常驻区拆分、跨消息工具合并、
 * 流式与落盘排版一致）与 groupWebTimelineTurns（按轮分组、透明占位跳过）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { buildWebTurnDisplay } = loadTsCommonJs("src/renderer/src/web/webTurnDisplay.ts");
const { groupWebTimelineTurns } = loadTsCommonJs("src/renderer/src/web/webToolGroups.ts");
const { chatMessagesToUiMessages } = loadTsCommonJs("src/renderer/src/web/webApi.ts", {
	globals: { fetch: () => { throw new Error("no fetch in tests"); } },
});

/**
 * 步骤形状快照：只保留判别字段，便于逐项比对顺序。
 * 用 Array.from（测试域）构造结果：steps 是 VM 沙箱域数组，直接 .map 会得到沙箱域数组，
 * node:assert/strict 的 deepEqual（deepStrictEqual）会因跨域原型不同而失败。
 */
function shape(steps) {
	return Array.from(steps, (step) =>
		step.kind === "tools"
			? `tools(${step.parts.map((part) => part.toolCallId).join(",")})`
			: step.kind === "text"
				? `text(${step.text})`
				: step.kind === "reasoning"
					? `reasoning(${step.text})`
					: step.kind);
}

function toolPart(callId) {
	return { type: "dynamic-tool", toolName: "bash", toolCallId: callId, state: "output-available", input: {}, output: "ok" };
}

/** 本地 SSE 侧：一轮合成一条 assistant 气泡。 */
function localCombinedTurn() {
	return [
		{ id: "local-user", role: "user", parts: [{ type: "text", text: "问题" }] },
		{ id: "msg_local", role: "assistant", parts: [
			{ type: "step-start" },
			{ type: "reasoning", text: "思考一" },
			toolPart("t1"),
			{ type: "step-start" },
			{ type: "text", text: "插入语" },
			toolPart("t2"),
			{ type: "step-start" },
			{ type: "reasoning", text: "思考二" },
			{ type: "text", text: "最终答案" },
		] },
	];
}

function chatMessage(overrides) {
	return {
		id: "m1",
		agentId: "a1",
		role: "assistant",
		text: "",
		timestamp: 1,
		...overrides,
	};
}

function persistedMultiStepTurn() {
	return chatMessagesToUiMessages([
		chatMessage({ id: "u1", role: "user", text: "问题", timestamp: 1000 }),
		chatMessage({ id: "a1", text: "", thinking: "思考一", timestamp: 1001 }),
		chatMessage({ id: "x1", role: "tool", text: "✓ bash t1", timestamp: 1002, meta: { toolCallId: "t1", toolName: "bash", status: "done", result: "ok" } }),
		chatMessage({ id: "a2", text: "插入语", timestamp: 1003 }),
		chatMessage({ id: "x2", role: "tool", text: "✓ bash t2", timestamp: 1004, meta: { toolCallId: "t2", toolName: "bash", status: "done", result: "ok" } }),
		chatMessage({ id: "a3", text: "最终答案", thinking: "思考二", timestamp: 1005 }),
	]);
}

test("single combined SSE bubble splits into a fold of thinking/tools/interim plus a persistent final answer", () => {
	// buildWebTurnDisplay 只接收助手侧消息（user 由 groupWebTimelineTurns 单独成项）。
	const display = buildWebTurnDisplay(localCombinedTurn().slice(1), { streaming: false });
	assert.deepEqual(shape(display.foldSteps), [
		"reasoning(思考一)",
		"tools(t1)",
		"text(插入语)",
		"tools(t2)",
		"reasoning(思考二)",
	]);
	assert.deepEqual(shape(display.persistentSteps), ["text(最终答案)"]);
	// summary 来自 VM 沙箱域对象，逐字段比对避免跨域原型差异。
	assert.equal(display.summary.toolCount, 2);
	assert.equal(display.summary.thinkingCount, 2);
	assert.equal(display.summary.interimCount, 1);
	assert.equal(display.hasFinalAnswer, true);
});

test("persisted multi-step messages produce the same layout as the combined SSE bubble", () => {
	const streaming = buildWebTurnDisplay(localCombinedTurn().slice(1), { streaming: false });
	const persisted = buildWebTurnDisplay(persistedMultiStepTurn().slice(1), { streaming: false });
	assert.deepEqual(shape(persisted.foldSteps), shape(streaming.foldSteps));
	assert.deepEqual(shape(persisted.persistentSteps), shape(streaming.persistentSteps));
});

test("adjacent pure-tool messages merge into one tool group across messages", () => {
	// 落盘后每个工具是一条独立消息：相邻两条应合并为一个工具组。
	const toolRows = chatMessagesToUiMessages([
		chatMessage({ id: "x1", role: "tool", text: "✓ bash t1", timestamp: 1002, meta: { toolCallId: "t1", toolName: "bash", status: "done", result: "ok" } }),
		chatMessage({ id: "x2", role: "tool", text: "✓ bash t2", timestamp: 1003, meta: { toolCallId: "t2", toolName: "bash", status: "done", result: "ok" } }),
	]);
	const display = buildWebTurnDisplay([...toolRows, ...chatMessagesToUiMessages([chatMessage({ id: "a1", text: "完成", timestamp: 1004 })])], { streaming: false });
	assert.deepEqual(shape(display.foldSteps), ["tools(t1,t2)"]);
	assert.deepEqual(shape(display.persistentSteps), ["text(完成)"]);
});

test("streaming tail text stays visible and marks the turn as unfinished", () => {
	const messages = [
		{ id: "msg_local", role: "assistant", parts: [
			{ type: "reasoning", text: "想" },
			toolPart("t1"),
			{ type: "text", text: "正在看" },
		] },
	];
	const display = buildWebTurnDisplay(messages, { streaming: true });
	assert.deepEqual(shape(display.persistentSteps), ["text(正在看)"]);
	const tail = display.persistentSteps[0];
	assert.equal(tail.kind, "text");
	assert.equal(tail.streaming, true);
	assert.equal(display.hasFinalAnswer, false);
});

test("streaming text followed by another tool becomes an interim step inside the fold", () => {
	const messages = [
		{ id: "msg_local", role: "assistant", parts: [
			{ type: "reasoning", text: "想" },
			toolPart("t1"),
			{ type: "text", text: "正在看" },
			toolPart("t2"),
		] },
	];
	const display = buildWebTurnDisplay(messages, { streaming: true });
	assert.deepEqual(shape(display.foldSteps), ["reasoning(想)", "tools(t1)", "text(正在看)", "tools(t2)"]);
	assert.deepEqual(shape(display.persistentSteps), []);
});

test("a turn ending with a tool call has no persistent content and no final answer", () => {
	const display = buildWebTurnDisplay([
		{ id: "msg_tools", role: "assistant", parts: [{ type: "reasoning", text: "想" }, toolPart("t1")] },
	], { streaming: false });
	assert.deepEqual(shape(display.persistentSteps), []);
	assert.equal(display.hasFinalAnswer, false);
	assert.deepEqual(shape(display.foldSteps), ["reasoning(想)", "tools(t1)"]);
});

test("an unanswered ask_question keeps its lead-in text and card outside the fold", () => {
	const display = buildWebTurnDisplay([
		{ id: "msg_ask", role: "assistant", parts: [
			{ type: "text", text: "请选择" },
			{ type: "dynamic-tool", toolName: "ask_question", toolCallId: "ask-1", state: "input-available", input: {} },
		] },
	], { streaming: false });
	assert.deepEqual(shape(display.persistentSteps), ["text(请选择)", "ask-tool"]);
	assert.deepEqual(shape(display.foldSteps), []);
});

test("error rows stay visible instead of being folded into the execution process", () => {
	const errorRow = chatMessagesToUiMessages([chatMessage({ id: "e1", role: "error", text: "boom", timestamp: 1001 })]);
	const display = buildWebTurnDisplay([
		{ id: "msg_local", role: "assistant", parts: [{ type: "reasoning", text: "想" }, toolPart("t1")] },
		errorRow[0],
		{ id: "msg_after", role: "assistant", parts: [toolPart("t2"), { type: "text", text: "最终答案" }] },
	], { streaming: false });
	assert.deepEqual(shape(display.persistentSteps), ["text(boom)", "text(最终答案)"]);
	assert.deepEqual(shape(display.foldSteps), ["reasoning(想)", "tools(t1)", "tools(t2)"]);
});

test("a trailing system row (compaction card) does not steal the final answer", () => {
	// 压缩卡由历史读取器插在上一轮末尾：最终回答仍须常驻，卡片也常驻，且不被当成最终回答
	const card = chatMessagesToUiMessages([chatMessage({ id: "s1", role: "system", text: "summary", timestamp: 1002 })]);
	const display = buildWebTurnDisplay([
		{ id: "a1", role: "assistant", parts: [{ type: "text", text: "最终答案" }] },
		card[0],
	], { streaming: false });
	assert.deepEqual(shape(display.persistentSteps), ["text(最终答案)", "text(summary)"]);
	assert.equal(display.foldSteps.length, 0);
	assert.equal(display.hasFinalAnswer, true);
});

test("a trailing error row after tools does not count as a final answer", () => {
	const errorRow = chatMessagesToUiMessages([chatMessage({ id: "e2", role: "error", text: "boom", timestamp: 1003 })]);
	const display = buildWebTurnDisplay([
		{ id: "a1", role: "assistant", parts: [toolPart("t1")] },
		errorRow[0],
	], { streaming: false });
	assert.deepEqual(shape(display.persistentSteps), ["text(boom)"]);
	assert.deepEqual(shape(display.foldSteps), ["tools(t1)"]);
	assert.equal(display.hasFinalAnswer, false);
});

test("the last reasoning part of a streaming message is marked running", () => {
	const messages = [{ id: "msg_local", role: "assistant", parts: [{ type: "reasoning", text: "想" }] }];
	const running = buildWebTurnDisplay(messages, { streaming: true });
	assert.equal(running.foldSteps[0].kind, "reasoning");
	assert.equal(running.foldSteps[0].running, true);
	const settled = buildWebTurnDisplay(messages, { streaming: false });
	assert.equal(settled.foldSteps[0].running, false);
});

test("groupWebTimelineTurns groups assistant-side messages between users and skips transparent placeholders", () => {
	const toolMessage = { id: "tool-1", role: "assistant", parts: [toolPart("t1")] };
	const grouped = groupWebTimelineTurns([
		{ id: "u1", role: "user", parts: [{ type: "text", text: "问题" }] },
		{ id: "placeholder", role: "assistant", parts: [{ type: "step-start" }] },
		toolMessage,
		{ id: "a2", role: "assistant", parts: [{ type: "text", text: "答案" }] },
		{ id: "u2", role: "user", parts: [{ type: "text", text: "再问" }] },
		{ id: "a3", role: "assistant", parts: [{ type: "text", text: "再答" }] },
	]);
	assert.deepEqual(Array.from(grouped, (item) => item.kind), ["user", "assistant-turn", "user", "assistant-turn"]);
	const firstTurn = grouped[1];
	assert.deepEqual(Array.from(firstTurn.messages, (message) => message.id), ["tool-1", "a2"]);
	assert.equal(firstTurn.id, toolMessage.id);
});

test("groupWebTimelineTurns starts with an assistant turn when the window begins mid-turn", () => {
	const grouped = groupWebTimelineTurns([
		{ id: "a1", role: "assistant", parts: [{ type: "text", text: "答案" }] },
		{ id: "u2", role: "user", parts: [{ type: "text", text: "问题" }] },
	]);
	assert.deepEqual(Array.from(grouped, (item) => item.kind), ["assistant-turn", "user"]);
	assert.equal(grouped[0].id, "a1");
});

test("groupWebTimelineTurns emits nothing for a turn made only of transparent placeholders", () => {
	const grouped = groupWebTimelineTurns([
		{ id: "u1", role: "user", parts: [{ type: "text", text: "问题" }] },
		{ id: "placeholder", role: "assistant", parts: [{ type: "step-start" }] },
	]);
	assert.deepEqual(Array.from(grouped, (item) => item.kind), ["user"]);
});
