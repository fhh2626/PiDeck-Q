import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { mergeAdjacentWebMessageParts, isWebReasoningPartRunning } = loadTsCommonJs(
	"src/renderer/src/web/webMessageParts.ts",
);

test("Web display merges adjacent reasoning parts created by stream resume", () => {
	const parts = [
		{ type: "reasoning", text: "前半段思考" },
		{ type: "reasoning", text: "后半段思考" },
	];
	const merged = mergeAdjacentWebMessageParts(parts);
	assert.equal(
		JSON.stringify(merged),
		JSON.stringify([{ type: "reasoning", text: "前半段思考后半段思考" }]),
	);
	assert.equal(parts.length, 2, "display normalization must not mutate the AI SDK message");
});

test("Web display merges adjacent text parts created by stream resume", () => {
	const merged = mergeAdjacentWebMessageParts([
		{ type: "text", text: "first half " },
		{ type: "text", text: "second half" },
	]);
	assert.equal(
		JSON.stringify(merged),
		JSON.stringify([{ type: "text", text: "first half second half" }]),
	);
});

test("Web display preserves repeated characters across snapshot-to-stream text parts without replay evidence", () => {
	const merged = mergeAdjacentWebMessageParts([
		{ type: "text", text: "hello" },
		{ type: "text", text: "o", state: "done" },
	]);
	assert.equal(merged[0].text, "helloo");
});

test("Web display preserves real overlapping characters across resumed text parts without offsets", () => {
	const merged = mergeAdjacentWebMessageParts([
		{ type: "text", text: "你好世界，" },
		{ type: "text", text: "世界，我们继续", state: "streaming" },
	]);
	assert.equal(merged[0].text, "你好世界，世界，我们继续");
});

test("Web display preserves genuinely repeated adjacent snapshot text", () => {
	const merged = mergeAdjacentWebMessageParts([
		{ type: "text", text: "哈哈" },
		{ type: "text", text: "哈哈" },
	]);
	assert.equal(merged[0].text, "哈哈哈哈");
});

test("Web display preserves repeated adjacent reasoning without replay evidence", () => {
	const merged = mergeAdjacentWebMessageParts([
		{ type: "reasoning", text: "同一段思考" },
		{ type: "reasoning", text: "同一段思考" },
	]);
	assert.equal(merged[0].text, "同一段思考同一段思考");
});

test("Web display preserves overlapping adjacent reasoning without replay offsets", () => {
	const merged = mergeAdjacentWebMessageParts([
		{ type: "reasoning", text: "前半段" },
		{ type: "reasoning", text: "前半段继续" },
	]);
	assert.equal(merged[0].text, "前半段前半段继续");
});

test("Web display never merges reasoning or text across a tool part", () => {
	const tool = {
		type: "dynamic-tool",
		toolName: "read",
		toolCallId: "call-1",
		state: "output-available",
		input: {},
		output: {},
	};
	const merged = mergeAdjacentWebMessageParts([
		{ type: "reasoning", text: "before reasoning" },
		{ type: "reasoning", text: " continued" },
		tool,
		{ type: "reasoning", text: "after tool" },
		{ type: "text", text: "answer one" },
		{ type: "text", text: " and two" },
	]);
	assert.equal(
		JSON.stringify(merged),
		JSON.stringify([
			{ type: "reasoning", text: "before reasoning continued" },
			tool,
			{ type: "reasoning", text: "after tool" },
			{ type: "text", text: "answer one and two" },
		]),
	);
});

test("only the last unfinished reasoning part runs while a message is streaming", () => {
	const tool = {
		type: "dynamic-tool",
		toolName: "read",
		toolCallId: "call-1",
		state: "output-available",
		input: {},
		output: {},
	};
	const withTool = [
		{ type: "reasoning", text: "first" },
		tool,
		{ type: "reasoning", text: "second" },
	];
	assert.equal(isWebReasoningPartRunning(withTool, 0, true), false);
	assert.equal(isWebReasoningPartRunning(withTool, 2, true), true);

	const withText = [
		{ type: "reasoning", text: "thought" },
		{ type: "text", text: "answer" },
	];
	assert.equal(isWebReasoningPartRunning(withText, 0, true), false);

	const onlyReasoning = [{ type: "reasoning", text: "thought" }];
	assert.equal(isWebReasoningPartRunning(onlyReasoning, 0, true), true);
	assert.equal(isWebReasoningPartRunning(onlyReasoning, 0, false), false);
});

test("Web display collapses a cross-step duplicate tool part into its strongest evidence", () => {
	const running = {
		type: "dynamic-tool", toolName: "bash", toolCallId: "call-1",
		state: "input-available", input: { command: "ls" },
	};
	const unknown = {
		type: "dynamic-tool", toolName: "bash", toolCallId: "call-1",
		state: "input-available", input: { command: "ls" }, toolMetadata: { resultMissing: true },
	};
	const merged = mergeAdjacentWebMessageParts([
		{ type: "text", text: "before" },
		running,
		{ type: "step-start" },
		unknown,
		{ type: "text", text: "after" },
	]);
	assert.deepEqual(Array.from(merged, (part) => part.type), ["text", "dynamic-tool", "step-start", "text"]);
	assert.equal(merged[1].toolMetadata.resultMissing, true, "unknown must win over a stale running copy");
	assert.equal(merged[1].state, "input-available", "unknown must not be upgraded to success/failure");
});

test("Web display keeps the terminal evidence of a duplicated tool call", () => {
	const settled = {
		type: "dynamic-tool", toolName: "read", toolCallId: "call-2",
		state: "output-available", input: { path: "x" }, output: { ok: true },
	};
	const staleRunning = {
		type: "dynamic-tool", toolName: "read", toolCallId: "call-2",
		state: "input-available", input: { path: "x" },
	};
	const merged = mergeAdjacentWebMessageParts([staleRunning, { type: "step-start" }, settled]);
	assert.equal(merged.length, 2, "the duplicate part is dropped, the invisible step marker stays");
	assert.equal(merged[0].state, "output-available");
	assert.deepEqual(merged[0].output, { ok: true });
});

test("a genuine later input clears an older cross-step unknown card", () => {
	const previous = { type: "dynamic-tool", toolName: "subagent", toolCallId: "resume",
		state: "input-available", input: {}, toolMetadata: { resultMissing: true } };
	const active = { type: "dynamic-tool", toolName: "subagent", toolCallId: "resume",
		state: "input-available", input: { task: "actual live input" }, toolMetadata: {} };
	const merged = mergeAdjacentWebMessageParts([previous, { type: "step-start" }, active]);
	assert.equal(merged[0], active);
	assert.equal(merged.filter((part) => part.type === "dynamic-tool").length, 1);
});

test("duplicate running parts retain the latest real input update", () => {
	const previous = { type: "dynamic-tool", toolName: "bash", toolCallId: "update", state: "input-available", input: {} };
	const latest = { ...previous, input: { command: "actual updated command" } };
	assert.equal(mergeAdjacentWebMessageParts([previous, { type: "step-start" }, latest])[0], latest);
});

test("Web display keeps distinct tool calls in their original order", () => {
	const first = { type: "dynamic-tool", toolName: "bash", toolCallId: "a", state: "output-available", input: {}, output: {} };
	const second = { type: "dynamic-tool", toolName: "read", toolCallId: "b", state: "input-available", input: {} };
	const merged = mergeAdjacentWebMessageParts([first, second]);
	assert.deepEqual(Array.from(merged, (part) => part.toolCallId), ["a", "b"]);
});
