/**
 * Web 端数据转换单测：chatMessagesToUiMessages（历史 ChatMessage → useChat UIMessage）。
 * 验证：角色映射（user/assistant，其它角色兜底 assistant）、thinking 注入
 * reasoning part、正文注入 text part、空消息/无 thinking 的边界。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const {
	chatMessagesToUiMessages,
	mergeAuthoritativeUiMessages,
	getWebAskQuestionResult,
} = loadTsCommonJs(
	"src/renderer/src/web/webApi.ts",
);

function message(overrides = {}) {
	return {
		id: "m1",
		agentId: "a1",
		role: "assistant",
		text: "hello",
		timestamp: 1,
		...overrides,
	};
}

test("maps user role to user and text part", () => {
	const result = chatMessagesToUiMessages([message({ role: "user", text: "hi" })]);
	assert.equal(result.length, 1);
	assert.equal(result[0].role, "user");
	assert.equal(result[0].parts.length, 1);
	assert.equal(result[0].parts[0].type, "text");
	assert.equal(result[0].parts[0].text, "hi");
});
test("maps assistant role to assistant and text part", () => {
	const result = chatMessagesToUiMessages([message({ role: "assistant", text: "hi" })]);
	assert.equal(result[0].role, "assistant");
	assert.equal(result[0].parts[0].type, "text");
});
test("falls back non-user roles to assistant", () => {
	for (const role of ["system", "tool", "error"]) {
		const result = chatMessagesToUiMessages([message({ role })]);
		assert.equal(result[0].role, "assistant", `role ${role} should map to assistant`);
	}
});

test("injects reasoning part before text when thinking present", () => {
	const result = chatMessagesToUiMessages([
		message({ thinking: "推理内容", text: "正文" }),
	]);
	assert.equal(result[0].parts.length, 2);
	assert.equal(result[0].parts[0].type, "reasoning");
	assert.equal(result[0].parts[0].text, "推理内容");
	assert.equal(result[0].parts[1].type, "text");
	assert.equal(result[0].parts[1].text, "正文");
});

test("omits text part when text empty", () => {
	const result = chatMessagesToUiMessages([message({ text: "" })]);
	assert.equal(result[0].parts.length, 0);
});

test("preserves validated historical images as local file parts", () => {
	const result = chatMessagesToUiMessages([
		message({
			role: "user",
			text: "",
			images: [{ type: "image", mimeType: "image/png", data: "aGVsbG8=" }],
		}),
	]);
	assert.equal(result[0].parts.length, 1);
	assert.equal(result[0].parts[0].type, "file");
	assert.equal(result[0].parts[0].url, "data:image/png;base64,aGVsbG8=");
});

test("rejects external or unsupported historical image payloads", () => {
	const result = chatMessagesToUiMessages([
		message({
			role: "user",
			text: "caption",
			images: [
				{ type: "image", mimeType: "text/html", data: "aGVsbG8=" },
				{ type: "image", mimeType: "image/png", data: "not base64" },
			],
		}),
	]);
	assert.equal(result[0].parts.length, 1);
	assert.equal(result[0].parts[0].type, "text");
});

test("keeps stable ids from message", () => {
	const result = chatMessagesToUiMessages([message({ id: "stable-id" })]);
	assert.equal(result[0].id, "stable-id");
});

test("keeps historical tool messages as styled dynamic tool parts", () => {
	const result = chatMessagesToUiMessages([
		message({
			id: "tool-message",
			role: "tool",
			text: "✓ bash",
			meta: {
				toolName: "bash",
				toolCallId: "call-bash",
				status: "done",
				args: JSON.stringify({ command: "pwd" }),
				detailText: "C:/project",
			},
		}),
	]);

	assert.equal(result[0].role, "assistant");
	assert.equal(result[0].parts[0].type, "dynamic-tool");
	assert.equal(result[0].parts[0].toolName, "bash");
	assert.equal(result[0].parts[0].toolCallId, "call-bash");
	assert.equal(result[0].parts[0].state, "output-available");
});

test("merges a runtime snapshot into local Web messages without duplicating local ids", () => {
	const current = chatMessagesToUiMessages([
		message({ id: "history-1", role: "assistant", text: "older" }),
		message({ id: "web-user", role: "user", text: "hello" }),
		message({ id: "web-assistant", role: "assistant", text: "answer" }),
	]);
	const authoritative = chatMessagesToUiMessages([
		message({ id: "runtime-user", role: "user", text: "hello" }),
		message({ id: "runtime-assistant", role: "assistant", text: "answer" }),
		message({ id: "runtime-next", role: "assistant", text: "new from PC" }),
	]);

	const merged = mergeAuthoritativeUiMessages(current, authoritative);
	assert.equal(merged.map((item) => item.parts[0]?.type).join(","), "text,text,text,text");
	assert.equal(merged.map((item) => item.parts[0]?.text).join(","), "older,hello,answer,new from PC");
	assert.equal(merged[1].id, "runtime-user");
	assert.equal(merged[2].id, "runtime-assistant");
});

test("authoritative snapshots replace a stale partial assistant message", () => {
	const current = chatMessagesToUiMessages([
		message({ id: "local-assistant", role: "assistant", text: "partial" }),
	]);
	const authoritative = chatMessagesToUiMessages([
		message({ id: "runtime-assistant", role: "assistant", text: "partial answer" }),
	]);

	const merged = mergeAuthoritativeUiMessages(current, authoritative);
	assert.equal(merged.length, 1);
	assert.equal(merged[0].id, "runtime-assistant");
	assert.equal(merged[0].parts[0].text, "partial answer");
});

test("runtime snapshots match the newest repeated message instead of old history", () => {
	const current = chatMessagesToUiMessages([
		message({ id: "old-ok", role: "assistant", text: "ok" }),
		message({ id: "web-ok", role: "assistant", text: "ok" }),
	]);
	const authoritative = chatMessagesToUiMessages([
		message({ id: "runtime-ok", role: "assistant", text: "ok" }),
	]);

	const merged = mergeAuthoritativeUiMessages(current, authoritative);
	assert.equal(merged.length, 2);
	assert.equal(merged[0].id, "old-ok");
	assert.equal(merged[1].id, "runtime-ok");
});

test("runtime tool snapshots keep their position when display text changes", () => {
	const current = chatMessagesToUiMessages([
		message({ id: "history-user", role: "user", text: "inspect" }),
		message({ id: "history-assistant", role: "assistant", text: "I will inspect" }),
		message({ id: "history-tool", role: "tool", text: "✓ read", meta: { toolCallId: "call-1" } }),
		message({ id: "history-final", role: "assistant", text: "done" }),
	]);
	const authoritative = chatMessagesToUiMessages([
		message({ id: "runtime-user", role: "user", text: "inspect" }),
		message({ id: "runtime-assistant", role: "assistant", text: "I will inspect" }),
		message({ id: "runtime-tool", role: "tool", text: "▶ read", meta: { toolCallId: "call-1" } }),
		message({ id: "runtime-final", role: "assistant", text: "done" }),
	]);

	const merged = mergeAuthoritativeUiMessages(current, authoritative);
	assert.equal(
		merged.map((item) => item.parts[0]?.type).join(","),
		["text", "text", "dynamic-tool", "text"].join(","),
	);
	assert.equal(merged.length, 4);
	assert.equal(merged[2].parts[0].toolName, "read");
});

test("unmatched authoritative messages are inserted by their timeline timestamp", () => {
	const current = chatMessagesToUiMessages([
		message({ id: "history-first", role: "user", text: "first", timestamp: 100 }),
		message({ id: "history-last", role: "assistant", text: "last", timestamp: 300 }),
	]);
	const authoritative = chatMessagesToUiMessages([
		message({ id: "runtime-first", role: "user", text: "first", timestamp: 100 }),
		message({ id: "runtime-status", role: "system", text: "retrying", timestamp: 200 }),
		message({ id: "runtime-last", role: "assistant", text: "last", timestamp: 300 }),
	]);

	const merged = mergeAuthoritativeUiMessages(current, authoritative);
	assert.equal(
		merged.map((item) => item.parts[0]?.text).join("\u0000"),
		["first", "retrying", "last"].join("\u0000"),
	);
});

test("does not treat a later assistant reply as the same as an earlier prefix", () => {
	const current = chatMessagesToUiMessages([
		message({ id: "web-user-1", role: "user", text: "第一问", timestamp: 100 }),
		message({ id: "web-user-2", role: "user", text: "第二问", timestamp: 200 }),
		message({ id: "web-assistant-2", role: "assistant", text: "第二问的完整答复", timestamp: 300 }),
	]);
	const authoritative = chatMessagesToUiMessages([
		message({ id: "runtime-user-2", role: "user", text: "第二问", timestamp: 200 }),
		message({ id: "runtime-assistant-2", role: "assistant", text: "第二问的完整答复还有后续", timestamp: 300 }),
	]);

	const merged = mergeAuthoritativeUiMessages(current, authoritative);
	assert.deepEqual(
		Array.from(merged, (item) => item.parts[0]?.text),
		["第一问", "第二问", "第二问的完整答复还有后续"],
	);
});

test("drops an empty local user bubble once the runtime snapshot has the real user message", () => {
	const current = [
		...chatMessagesToUiMessages([
			message({ id: "history-user", role: "user", text: "第一问", timestamp: 100 }),
		]),
		{ id: "local-empty-user", role: "user", parts: [] },
	];
	const authoritative = chatMessagesToUiMessages([
		message({ id: "runtime-user", role: "user", text: "第二问", timestamp: 200 }),
		message({ id: "runtime-assistant", role: "assistant", text: "答复", timestamp: 300 }),
	]);

	const merged = mergeAuthoritativeUiMessages(current, authoritative);
	assert.deepEqual(
		Array.from(merged, (item) => item.parts[0]?.text ?? ""),
		["第一问", "第二问", "答复"],
	);
});

test("does not collapse two identical user messages into one", () => {
	const current = chatMessagesToUiMessages([
		message({ id: "web-user-1", role: "user", text: "继续", timestamp: 100 }),
		message({ id: "web-user-2", role: "user", text: "继续", timestamp: 200 }),
	]);
	const authoritative = chatMessagesToUiMessages([
		message({ id: "runtime-user-2", role: "user", text: "继续", timestamp: 200 }),
	]);

	const merged = mergeAuthoritativeUiMessages(current, authoritative);
	assert.equal(merged.length, 2);
	assert.equal(merged[0].id, "web-user-1");
	assert.equal(merged[1].id, "runtime-user-2");
});



test("inserts a missed assistant reply before the next local turn", () => {
	const current = [
		...chatMessagesToUiMessages([
			message({ id: "web-user-1", role: "user", text: "第一问" }),
		]),
		{ id: "web-user-2", role: "user", parts: [{ type: "text", text: "第二问" }] },
		{ id: "web-assistant-2", role: "assistant", parts: [{ type: "text", text: "第二问答复" }] },
	];
	const authoritative = chatMessagesToUiMessages([
		message({ id: "runtime-user-1", role: "user", text: "第一问", timestamp: 100 }),
		message({ id: "runtime-assistant-1", role: "assistant", text: "第一问答复", timestamp: 150 }),
		message({ id: "runtime-user-2", role: "user", text: "第二问", timestamp: 200 }),
		message({ id: "runtime-assistant-2", role: "assistant", text: "第二问答复", timestamp: 300 }),
	]);

	const merged = mergeAuthoritativeUiMessages(current, authoritative);
	assert.deepEqual(
		Array.from(merged, (item) => item.parts[0]?.text),
		["第一问", "第一问答复", "第二问", "第二问答复"],
	);
});

test("merges streamed reasoning without creating a duplicate assistant message", () => {
	const current = [
		{ id: "web-u-1", role: "user", parts: [{ type: "text", text: "问" }] },
		{
			id: "web-a-1",
			role: "assistant",
			parts: [
				{ type: "reasoning", text: "思考中" },
				{ type: "text", text: "回答" },
			],
		},
	];
	const authoritative = chatMessagesToUiMessages([
		message({ id: "rt-u-1", role: "user", text: "问", timestamp: 100 }),
		message({ id: "rt-a-1", role: "assistant", text: "回答", thinking: "思考中", timestamp: 101 }),
	]);

	const merged = mergeAuthoritativeUiMessages(current, authoritative);
	assert.equal(merged.length, 2);
	assert.equal(merged[0].id, "rt-u-1");
	assert.equal(merged[1].id, "rt-a-1");
});

test("drops a trailing local thinking/tool placeholder after the authoritative timeline", () => {
	const current = [
		{ id: "web-u-1", role: "user", parts: [{ type: "text", text: "继续" }] },
		{
			id: "web-old-think",
			role: "assistant",
			parts: [{ type: "reasoning", text: "旧思考" }],
		},
		{
			id: "web-old-tool",
			role: "assistant",
			parts: [{ type: "dynamic-tool", toolName: "bash", toolCallId: "old-tool", state: "output-available", input: {}, output: "done" }],
		},
	];
	const authoritative = chatMessagesToUiMessages([
		message({ id: "rt-u-1", role: "user", text: "继续", timestamp: 100 }),
		message({ id: "rt-think", role: "assistant", text: "", thinking: "旧思考", timestamp: 110 }),
		message({ id: "rt-tool", role: "tool", text: "done", timestamp: 120, meta: { toolCallId: "old-tool", toolName: "bash" } }),
		message({ id: "rt-latest", role: "assistant", text: "真正最新的回复", timestamp: 130 }),
	]);

	const merged = mergeAuthoritativeUiMessages(current, authoritative);
	assert.equal(merged.length, 4);
	assert.equal(merged.at(-1)?.id, "rt-latest");
	assert.equal(merged.at(-1)?.parts.find((part) => part.type === "text")?.text, "真正最新的回复");
});

test("idle merge drops a leftover combined SSE assistant after the split snapshot timeline", () => {
	const current = [
		{ id: "web-u-1", role: "user", parts: [{ type: "text", text: "继续" }] },
		{
			id: "web-live",
			role: "assistant",
			parts: [
				{ type: "reasoning", text: "旧思考" },
				{ type: "dynamic-tool", toolName: "bash", toolCallId: "old-tool", state: "output-available", input: {}, output: "done" },
				{ type: "text", text: "真正最新" },
			],
		},
	];
	const authoritative = chatMessagesToUiMessages([
		message({ id: "rt-u-1", role: "user", text: "继续", timestamp: 100 }),
		message({ id: "rt-think", role: "assistant", text: "", thinking: "旧思考", timestamp: 110 }),
		message({ id: "rt-tool", role: "tool", text: "done", timestamp: 120, meta: { toolCallId: "old-tool", toolName: "bash" } }),
		message({ id: "rt-latest", role: "assistant", text: "真正最新的回复", timestamp: 130 }),
	]);

	const streaming = mergeAuthoritativeUiMessages(current, authoritative);
	assert.equal(streaming.some((item) => item.id === "web-live"), true);

	const idle = mergeAuthoritativeUiMessages(current, authoritative, {
		dropUnmatchedTrailingPlaceholders: true,
	});
	assert.equal(idle.length, 4);
	assert.equal(idle.some((item) => item.id === "web-live"), false);
	assert.equal(idle.at(-1)?.parts.find((part) => part.type === "text")?.text, "真正最新的回复");
});

test("reorders matched cached messages to the authoritative timeline after reconnect", () => {
	const current = chatMessagesToUiMessages([
		message({ id: "cached-user", role: "user", text: "继续", timestamp: 100, meta: { entryId: "entry-user" } }),
		message({ id: "cached-final", role: "assistant", text: "真正最新的回复", timestamp: 130, meta: { entryId: "entry-final" } }),
		message({ id: "cached-think", role: "assistant", text: "", thinking: "这一轮的思考", timestamp: 110, meta: { entryId: "entry-think" } }),
	]);
	const authoritative = chatMessagesToUiMessages([
		message({ id: "rt-user", role: "user", text: "继续", timestamp: 100, meta: { entryId: "entry-user" } }),
		message({ id: "rt-think", role: "assistant", text: "", thinking: "这一轮的思考", timestamp: 110, meta: { entryId: "entry-think" } }),
		message({ id: "rt-final", role: "assistant", text: "真正最新的回复", timestamp: 130, meta: { entryId: "entry-final" } }),
	]);

	const merged = mergeAuthoritativeUiMessages(current, authoritative, {
		dropUnmatchedTrailingPlaceholders: true,
	});
	assert.deepEqual(
		Array.from(merged, (item) => item.id),
		["rt-user", "rt-think", "rt-final"],
	);
	assert.equal(merged.at(-1)?.parts.find((part) => part.type === "text")?.text, "真正最新的回复");
});

test("keeps an unmatched mid-timeline SSE assistant reply that is not a trailing placeholder", () => {
	const current = [
		{ id: "web-u-1", role: "user", parts: [{ type: "text", text: "问" }] },
		{
			id: "web-live",
			role: "assistant",
			parts: [
				{ type: "reasoning", text: "还在想" },
				{ type: "text", text: "半句" },
			],
		},
	];
	const authoritative = chatMessagesToUiMessages([
		message({ id: "rt-u-1", role: "user", text: "问", timestamp: 100 }),
	]);

	const merged = mergeAuthoritativeUiMessages(current, authoritative);
	assert.equal(merged.length, 2);
	assert.equal(merged[1].id, "web-live");
});

test("keeps a trailing local thinking card that the snapshot has not covered yet", () => {
	const current = [
		{ id: "web-u-1", role: "user", parts: [{ type: "text", text: "继续" }] },
		{
			id: "web-new-think",
			role: "assistant",
			parts: [{ type: "reasoning", text: "这一轮刚开始想" }],
		},
	];
	const authoritative = chatMessagesToUiMessages([
		message({ id: "rt-u-1", role: "user", text: "继续", timestamp: 100 }),
		message({ id: "rt-old", role: "assistant", text: "上一轮已经说完", timestamp: 110 }),
	]);

	const merged = mergeAuthoritativeUiMessages(current, authoritative);
	assert.equal(merged.at(-1)?.id, "web-new-think");
	assert.equal(merged.at(-1)?.parts[0]?.text, "这一轮刚开始想");
});

test("idle merge drops unmatched trailing thinking even when the snapshot rewrote the text", () => {
	const current = [
		{ id: "web-u-1", role: "user", parts: [{ type: "text", text: "继续" }] },
		{
			id: "web-old-think",
			role: "assistant",
			parts: [{ type: "reasoning", text: "SSE 里的旧思考原文" }],
		},
	];
	const authoritative = chatMessagesToUiMessages([
		message({ id: "rt-u-1", role: "user", text: "继续", timestamp: 100 }),
		message({ id: "rt-latest", role: "assistant", text: "真正最新的回复", thinking: "快照里完全改写过的思考", timestamp: 130 }),
	]);

	const keptWhileStreaming = mergeAuthoritativeUiMessages(current, authoritative);
	assert.equal(keptWhileStreaming.at(-1)?.id, "web-old-think");

	const idle = mergeAuthoritativeUiMessages(current, authoritative, {
		dropUnmatchedTrailingPlaceholders: true,
	});
	assert.equal(idle.at(-1)?.id, "rt-latest");
	assert.equal(idle.at(-1)?.parts.find((part) => part.type === "text")?.text, "真正最新的回复");
});

test("streaming merge does not treat a new short thought as a prefix of an older snapshot", () => {
	const current = [
		{ id: "web-u-1", role: "user", parts: [{ type: "text", text: "继续" }] },
		{
			id: "web-new-think",
			role: "assistant",
			parts: [{ type: "reasoning", text: "旧" }],
		},
	];
	const authoritative = chatMessagesToUiMessages([
		message({ id: "rt-u-1", role: "user", text: "继续", timestamp: 100 }),
		message({ id: "rt-old", role: "assistant", text: "旧回复已经说完", timestamp: 110 }),
	]);

	const merged = mergeAuthoritativeUiMessages(current, authoritative);
	assert.equal(merged.at(-1)?.id, "web-new-think");
});

test("idle merge keeps unmatched thinking when the snapshot has not settled a final answer", () => {
	const current = [
		{ id: "web-u-1", role: "user", parts: [{ type: "text", text: "继续" }] },
		{
			id: "web-live-think",
			role: "assistant",
			parts: [{ type: "reasoning", text: "还在想，快照还没正文" }],
		},
	];
	const authoritative = chatMessagesToUiMessages([
		message({ id: "rt-u-1", role: "user", text: "继续", timestamp: 100 }),
	]);

	const idle = mergeAuthoritativeUiMessages(current, authoritative, {
		dropUnmatchedTrailingPlaceholders: true,
	});
	assert.equal(idle.at(-1)?.id, "web-live-think");
});

test("idle merge drops an unmatched thinking card stuck in the middle once the snapshot settled", () => {
	const current = [
		{ id: "web-u-1", role: "user", parts: [{ type: "text", text: "继续" }] },
		{
			id: "web-old-think",
			role: "assistant",
			parts: [{ type: "reasoning", text: "卡在中间的旧思考" }],
		},
		{ id: "web-u-2", role: "user", parts: [{ type: "text", text: "下一问" }] },
	];
	const authoritative = chatMessagesToUiMessages([
		message({ id: "rt-u-1", role: "user", text: "继续", timestamp: 100 }),
		message({ id: "rt-latest", role: "assistant", text: "真正最新的回复", timestamp: 130 }),
		message({ id: "rt-u-2", role: "user", text: "下一问", timestamp: 140 }),
	]);

	const idle = mergeAuthoritativeUiMessages(current, authoritative, {
		dropUnmatchedTrailingPlaceholders: true,
	});
	assert.deepEqual(
		Array.from(idle, (item) => item.parts.find((part) => part.type === "text")?.text ?? item.parts[0]?.type),
		["继续", "真正最新的回复", "下一问"],
	);
});

test("carries a completed ask_question result in UIMessage metadata", () => {
	const result = chatMessagesToUiMessages([
		message({
			id: "ask-done",
			role: "tool",
			text: "✓ ask_question",
			meta: {
				toolName: "ask_question",
				toolCallId: "call-ask",
				status: "done",
				_askCard: {
					question: "选一个",
					type: "select",
					answered: true,
					answer: "b",
					answerLabel: "B 选项",
					options: ["a", "b"],
				},
			},
		}),
	]);
	const [ui] = result;
	// metadata 带规范化后的结果（供 Web 时间线渲染常驻问答卡）
	assert.equal(ui.metadata.askQuestionResult.question, "选一个");
	assert.equal(ui.metadata.askQuestionResult.answerLabel, "B 选项");
	assert.equal(ui.metadata.askQuestionResult.cancelled, false);
	// 读取接口同样返回规范结构
	const read = getWebAskQuestionResult(ui);
	assert.equal(read.question, "选一个");
	assert.equal(read.answered, true);
});

test("keeps a full batch ask_question result in Web metadata", () => {
	const result = chatMessagesToUiMessages([
		message({
			id: "ask-batch",
			role: "tool",
			text: "✓ ask_question",
			meta: {
				toolName: "ask_question",
				toolCallId: "call-ask-batch",
				status: "done",
				_askCard: {
					question: "批量",
					answered: false,
					answer: null,
					questions: [
						{ question: "第一题", type: "select", answered: true, answer: "x", answerLabel: "X" },
						{ question: "第二题", type: "confirm", answered: true, answer: true },
						{ question: "第三题", type: "input", answered: false, answer: null },
					],
				},
			},
		}),
	]);
	const read = getWebAskQuestionResult(result[0]);
	// 批量：questions 数组完整保留（逐题展示）
	assert.equal(read.questions.length, 3);
	assert.equal(read.questions.map((item) => item.question).join("|"), "第一题|第二题|第三题");
});

test("degrades a corrupt _askCard to a plain Web tool message", () => {
	const result = chatMessagesToUiMessages([
		message({
			id: "ask-bad",
			role: "tool",
			text: "✓ ask_question",
			meta: { toolName: "ask_question", toolCallId: "call-ask-bad", status: "done", _askCard: { cancelled: true } },
		}),
	]);
	// 无问题文本 → normalizer 返回 undefined → Web 时间线退回普通工具卡
	assert.equal(getWebAskQuestionResult(result[0]), undefined);
	assert.equal(result[0].metadata.askQuestionResult, undefined);
});

test("SSE placeholder merge keeps the ask card when the runtime snapshot settles it", () => {
	// 本地 SSE 只有工具占位（无 _askCard），运行时快照带完整结果；
	// 按 toolCallId 合并后 metadata 必须继承快照的 askQuestionResult。
	const current = [
		{
			id: "local-ask",
			role: "assistant",
			parts: [{ type: "dynamic-tool", toolName: "ask_question", toolCallId: "call-ask", state: "input-available", input: {} }],
		},
	];
	const authoritative = chatMessagesToUiMessages([
		message({
			id: "rt-ask",
			role: "tool",
			text: "✓ ask_question",
			timestamp: 120,
			meta: {
				toolName: "ask_question",
				toolCallId: "call-ask",
				status: "done",
				_askCard: { question: "选一个", answered: true, answer: "a", answerLabel: "A 选项" },
			},
		}),
	]);
	const merged = mergeAuthoritativeUiMessages(current, authoritative);
	assert.equal(merged.length, 1);
	assert.equal(merged[0].id, "rt-ask");
	const read = getWebAskQuestionResult(merged[0]);
	assert.equal(read.question, "选一个");
	assert.equal(read.answered, true);
});

test("merge applies a metadata-only snapshot update (ask card appears late)", () => {
	// 同一 toolCallId 已匹配（parts 形状一致），但本地快照先于 ask 完成到达
	// （metadata 无 askQuestionResult），下一轮轮询快照才带上结果。
	// sameUiMessage 若只比 parts 会跳过这次「只变 metadata」的更新。
	const current = chatMessagesToUiMessages([
		message({
			id: "early-ask",
			role: "tool",
			text: "✓ ask_question",
			timestamp: 100,
			meta: { toolName: "ask_question", toolCallId: "call-ask-2", status: "done", result: "" },
		}),
	]);
	const authoritative = chatMessagesToUiMessages([
		message({
			id: "late-ask",
			role: "tool",
			text: "✓ ask_question",
			timestamp: 100,
			meta: {
				toolName: "ask_question",
				toolCallId: "call-ask-2",
				status: "done",
				result: "",
				_askCard: { question: "选一个", answered: true, answer: "a", answerLabel: "A" },
			},
		}),
	]);
	const merged = mergeAuthoritativeUiMessages(current, authoritative);
	assert.equal(merged.length, 1);
	assert.equal(merged[0].id, "late-ask");
	const read = getWebAskQuestionResult(merged[0]);
	assert.equal(read.question, "选一个");
	assert.equal(read.answered, true);

	// 反向：快照没带结果时，本地已有的结果不被「无 metadata」的空快照抹掉。
	// （parts 相同但 metadata 不同 → 按权威快照替换，权威缺结果即卡片消失，
	//  与「以快照为准」的合并语义一致。）
	const mergedBack = mergeAuthoritativeUiMessages(
		merged,
		chatMessagesToUiMessages([
			message({
				id: "early-ask-again",
				role: "tool",
				text: "✓ ask_question",
				timestamp: 100,
				meta: { toolName: "ask_question", toolCallId: "call-ask-2", status: "done", result: "" },
			}),
		]),
	);
	assert.equal(mergedBack.length, 1);
	assert.equal(getWebAskQuestionResult(mergedBack[0]), undefined);
});
