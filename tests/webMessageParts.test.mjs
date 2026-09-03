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

test("Web display keeps identical adjacent reasoning as one part", () => {
	const merged = mergeAdjacentWebMessageParts([
		{ type: "reasoning", text: "同一段思考" },
		{ type: "reasoning", text: "同一段思考" },
	]);
	assert.equal(
		JSON.stringify(merged),
		JSON.stringify([{ type: "reasoning", text: "同一段思考" }]),
	);
});

test("Web display keeps the longer continuation of adjacent reasoning", () => {
	const merged = mergeAdjacentWebMessageParts([
		{ type: "reasoning", text: "前" },
		{ type: "reasoning", text: "前半段" },
	]);
	assert.equal(
		JSON.stringify(merged),
		JSON.stringify([{ type: "reasoning", text: "前半段" }]),
	);
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
