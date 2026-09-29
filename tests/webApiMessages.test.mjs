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
	prependOlderHistoryPage,
	fetchTurnPage,
} = loadTsCommonJs(
	"src/renderer/src/web/webApi.ts",
	// webApi 在 VM 沙箱里执行（无浏览器全局）：注入 fetch 供分页 helper 使用；
	// 各用例自行替换 globalThis.fetch 以观察请求 URL。
	{ globals: { fetch: (input, init) => globalThis.fetch(input, init) } },
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
			message({ id: "web-user-1", role: "user", text: "第一问", timestamp: 100 }),
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

// ── 跨轮误匹配防护：相同短句/前缀不得跨过用户消息去认领旧回复 ─────────────────

test("does not match a new assistant reply against an older turn with identical text", () => {
	// 旧轮回复与新轮回复正文都是「好的」。若允许跨轮全文匹配，新轮快照会替换掉
	// 旧轮回复，表现为「上一条回答消失」——必须按同轮尾部限定候选。
	const current = chatMessagesToUiMessages([
		message({ id: "u1", role: "user", text: "先前", timestamp: 100 }),
		message({ id: "a1", role: "assistant", text: "好的", timestamp: 110 }),
		message({ id: "u2", role: "user", text: "继续", timestamp: 200 }),
	]);
	const authoritative = chatMessagesToUiMessages([
		message({ id: "rt-a2", role: "assistant", text: "好的", timestamp: 210 }),
	]);

	const merged = mergeAuthoritativeUiMessages(current, authoritative);
	assert.deepEqual(
		Array.from(merged, (item) => `${item.id}:${item.parts[0]?.text}`),
		["u1:先前", "a1:好的", "u2:继续", "rt-a2:好的"],
	);
});

test("does not match a new assistant reply against an older turn that is its prefix", () => {
	// 局部文本→完整文本的前缀匹配同样不能跨轮：旧轮「好的」是新轮「好的，我来继续处理」
	// 的前缀，但两者属于不同轮次。
	const current = chatMessagesToUiMessages([
		message({ id: "u1", role: "user", text: "先前", timestamp: 100 }),
		message({ id: "a1", role: "assistant", text: "好的", timestamp: 110 }),
		message({ id: "u2", role: "user", text: "继续", timestamp: 200 }),
	]);
	const authoritative = chatMessagesToUiMessages([
		message({ id: "rt-a2", role: "assistant", text: "好的，我来继续处理", timestamp: 210 }),
	]);

	const merged = mergeAuthoritativeUiMessages(current, authoritative);
	assert.deepEqual(
		Array.from(merged, (item) => `${item.id}:${item.parts[0]?.text}`),
		["u1:先前", "a1:好的", "u2:继续", "rt-a2:好的，我来继续处理"],
	);
});

test("does not text-match messages with different stable entry identities", () => {
	const current = chatMessagesToUiMessages([
		message({ id: "history-old", role: "assistant", text: "同一段正文", timestamp: 100, meta: { entryId: "entry-old" } }),
	]);
	const authoritative = chatMessagesToUiMessages([
		message({ id: "runtime-new", role: "assistant", text: "同一段正文", timestamp: 110, meta: { entryId: "entry-new" } }),
	]);

	const merged = mergeAuthoritativeUiMessages(current, authoritative);
	assert.deepEqual(Array.from(merged, (item) => item.id), ["history-old", "runtime-new"]);
});

test("inserts timestamped history before an untimestamped local streaming tail", () => {
	const current = [
		{ id: "local-live", role: "assistant", parts: [{ type: "text", text: "正在生成" }] },
	];
	const authoritative = chatMessagesToUiMessages([
		message({ id: "history-user", role: "user", text: "问题", timestamp: 100 }),
		message({ id: "history-answer", role: "assistant", text: "已落盘回答", timestamp: 110 }),
	]);

	const merged = mergeAuthoritativeUiMessages(current, authoritative);
	assert.deepEqual(
		Array.from(merged, (item) => item.id),
		["history-user", "history-answer", "local-live"],
	);
});

test("still merges a same-turn partial local reply into the authoritative answer", () => {
	// 同轮限定不能把「局部文本→完整文本」的正向能力一起关掉：本地流式半句必须
	// 被本轮完整快照吸收成一条。
	const current = [
		{ id: "web-u-1", role: "user", parts: [{ type: "text", text: "问" }] },
		{ id: "web-a-1", role: "assistant", parts: [{ type: "text", text: "半句" }] },
	];
	const authoritative = chatMessagesToUiMessages([
		message({ id: "rt-u-1", role: "user", text: "问", timestamp: 100 }),
		message({ id: "rt-a-1", role: "assistant", text: "半句完整内容", timestamp: 110 }),
	]);

	const merged = mergeAuthoritativeUiMessages(current, authoritative);
	assert.deepEqual(
		Array.from(merged, (item) => `${item.id}:${item.parts[0]?.text}`),
		["rt-u-1:问", "rt-a-1:半句完整内容"],
	);
});

// ── 历史首页基线：已确认被历史覆盖的本地合泡清掉，未覆盖的保留在尾部 ──────────

test("drops a covered stale local SSE bubble when the history baseline loads", () => {
	// 首页 = 最新一页权威历史。旧轮「思考+正文」合泡的内容已完整出现在历史里，
	// 若只靠默认合并会把它顶到时间线最底部（重复的旧内容排在最新回复之后）。
	const history = chatMessagesToUiMessages([
		message({ id: "u1", role: "user", text: "先前", timestamp: 100 }),
		message({ id: "a1", role: "assistant", text: "旧答复", thinking: "我想一想", timestamp: 110 }),
		message({ id: "u2", role: "user", text: "继续", timestamp: 200 }),
		message({ id: "a2", role: "assistant", text: "新答复", timestamp: 210 }),
	]);
	const cached = [
		{ id: "web-u1", role: "user", parts: [{ type: "text", text: "先前" }] },
		{
			id: "local-combined",
			role: "assistant",
			parts: [
				{ type: "reasoning", text: "我想一想" },
				{ type: "text", text: "旧答复" },
			],
		},
		{ id: "web-u2", role: "user", parts: [{ type: "text", text: "继续" }] },
	];

	const merged = mergeAuthoritativeUiMessages(cached, history, { dropCoveredLocalSseLeftovers: true });
	// A trailing metadata-free user without a covered reply might be an optimistic newer turn;
	// retaining it does not prevent the old reasoning+answer bubble from being cleared.
	assert.deepEqual(
		Array.from(merged, (item) => item.id),
		["u1", "a1", "u2", "a2", "web-u2"],
	);
	assert.equal(merged.some((item) => item.id === "local-combined"), false);
});

test("keeps an uncovered local leftover at the tail when the history baseline loads", () => {
	// 覆盖未确认（历史里没有对应正文）时不得删除：它可能是历史尚未落盘的实时回复。
	const history = chatMessagesToUiMessages([
		message({ id: "u1", role: "user", text: "先前", timestamp: 100 }),
		message({ id: "a1", role: "assistant", text: "旧答复", timestamp: 110 }),
	]);
	const cached = [
		{ id: "web-u1", role: "user", parts: [{ type: "text", text: "先前" }] },
		{ id: "local-live", role: "assistant", parts: [{ type: "text", text: "历史还没落盘的新回复" }] },
	];

	const merged = mergeAuthoritativeUiMessages(cached, history, { dropCoveredLocalSseLeftovers: true });
	// The page does not establish whether its user and the optimistic user are the same turn.
	assert.deepEqual(
		Array.from(merged, (item) => item.id),
		["u1", "a1", "web-u1", "local-live"],
	);
	assert.equal(merged.at(-1)?.parts[0]?.text, "历史还没落盘的新回复");
});

test("history baseline keeps a streaming local reply that merely repeats an old short answer", () => {
	// 反向边界：新轮本地流式正文恰好与旧轮短句相同，但历史尚未包含本轮回复时
	// 不能仅凭「正文相同」就删掉它（覆盖必须能确认，不能跨轮误伤）。
	const history = chatMessagesToUiMessages([
		message({ id: "u1", role: "user", text: "先前", timestamp: 100 }),
		message({ id: "a1", role: "assistant", text: "好的", timestamp: 110 }),
		message({ id: "u2", role: "user", text: "继续", timestamp: 200 }),
	]);
	const cached = [
		{ id: "web-u1", role: "user", parts: [{ type: "text", text: "先前" }] },
		{ id: "web-a1", role: "assistant", parts: [{ type: "text", text: "好的" }] },
		{ id: "web-u2", role: "user", parts: [{ type: "text", text: "继续" }] },
		{ id: "local-live", role: "assistant", parts: [{ type: "text", text: "好的" }] },
	];

	const merged = mergeAuthoritativeUiMessages(cached, history, { dropCoveredLocalSseLeftovers: true });
	// The earlier cached answer can reconcile before the next user, but the newest
	// metadata-free user/reply remains unclaimed without a reliable turn link.
	assert.deepEqual(Array.from(merged, (item) => item.id),
		["u1", "a1", "u2", "web-u2", "local-live"]);
});

test("strict history cleanup requires stable tool ids and complete coverage of every combined part", () => {
	const cached = [
		{ id: "web-turn", role: "user", parts: [{ type: "text", text: "工具问题" }] },
		{
			id: "local-combined-tool",
			role: "assistant",
			parts: [
				{ type: "reasoning", text: "准备调用工具" },
				{ type: "dynamic-tool", toolName: "read", toolCallId: "call-stable", state: "output-available", input: {}, output: "文件内容" },
				{ type: "text", text: "读取完成" },
			],
		},
	];
	const history = chatMessagesToUiMessages([
		message({ id: "history-user", role: "user", text: "工具问题", timestamp: 100 }),
		message({ id: "history-assistant", role: "assistant", text: "读取完成", thinking: "准备调用工具", timestamp: 110 }),
		message({ id: "history-tool", role: "tool", text: "文件内容", timestamp: 111, meta: { toolCallId: "call-stable", toolName: "read" } }),
	]);
	const merged = mergeAuthoritativeUiMessages(cached, history, { dropCoveredLocalSseLeftovers: true });
	assert.equal(merged.some((item) => item.id === "local-combined-tool"), false);

	const unidentifiableTool = cached.map((item) => item.id === "local-combined-tool"
		? { ...item, id: "local-unmatched-tool", parts: item.parts.map((part) => part.type === "dynamic-tool" ? { ...part, toolCallId: "different-call" } : part) }
		: item);
	const retained = mergeAuthoritativeUiMessages(unidentifiableTool, history, { dropCoveredLocalSseLeftovers: true });
	assert.equal(retained.some((item) => item.id === "local-unmatched-tool"), true);
});

test("strict history cleanup does not discard a combined bubble containing a tool without a stable id", () => {
	const cached = [
		{ id: "web-tool-turn", role: "user", parts: [{ type: "text", text: "读取文件" }] },
		{
			id: "local-tool-no-id",
			role: "assistant",
			parts: [
				{ type: "reasoning", text: "开始读取" },
				{ type: "dynamic-tool", toolName: "read", state: "output-available", input: {}, output: "same output" },
				{ type: "text", text: "已读取" },
			],
		},
	];
	const history = chatMessagesToUiMessages([
		message({ id: "history-tool-user", role: "user", text: "读取文件", timestamp: 100 }),
		message({ id: "history-tool-assistant", role: "assistant", text: "已读取", thinking: "开始读取", timestamp: 110 }),
		message({ id: "history-other-tool", role: "tool", text: "same output", timestamp: 111, meta: { toolCallId: "different-call", toolName: "read" } }),
	]);

	const merged = mergeAuthoritativeUiMessages(cached, history, { dropCoveredLocalSseLeftovers: true });
	assert.equal(merged.some((item) => item.id === "local-tool-no-id"), true);
	assert.equal(merged.some((item) => item.id === "history-tool-assistant"), true);
});

test("history merge preserves reasoning joined with a tool that has no stable id", () => {
	const cached = [
		{ id: "web-no-id-turn", role: "user", parts: [{ type: "text", text: "检查" }] },
		{
			id: "local-reasoning-tool-no-id",
			role: "assistant",
			parts: [
				{ type: "reasoning", text: "准备检查" },
				{ type: "dynamic-tool", toolName: "read", state: "output-available", input: {}, output: "same output" },
			],
		},
	];
	const history = chatMessagesToUiMessages([
		message({ id: "history-no-id-user", role: "user", text: "检查", timestamp: 100 }),
		message({ id: "history-no-id-assistant", role: "assistant", text: "", thinking: "准备检查", timestamp: 110 }),
		message({ id: "history-no-id-tool", role: "tool", text: "same output", timestamp: 111, meta: { toolCallId: "other-call", toolName: "read" } }),
	]);

	const merged = mergeAuthoritativeUiMessages(cached, history, { dropCoveredLocalSseLeftovers: true });
	assert.equal(merged.some((item) => item.id === "local-reasoning-tool-no-id"), true);
	assert.equal(merged.some((item) => item.id === "history-no-id-assistant"), true);
});

test("history baseline keeps a distinct local reply when an older answer is its prefix", () => {
	const cached = [
		{ id: "web-u", role: "user", parts: [{ type: "text", text: "问题" }] },
		{ id: "old-answer", role: "assistant", parts: [{ type: "text", text: "OK and more" }] },
		{ id: "new-local", role: "assistant", parts: [{ type: "text", text: "OK" }] },
	];
	const history = chatMessagesToUiMessages([
		message({ id: "u", role: "user", text: "问题", timestamp: 100 }),
		message({ id: "old-answer", role: "assistant", text: "OK and more", timestamp: 110 }),
	]);
	const merged = mergeAuthoritativeUiMessages(cached, history, { dropCoveredLocalSseLeftovers: true });
	assert.deepEqual(Array.from(merged, (item) => item.id), ["u", "old-answer", "new-local"]);
	assert.equal(merged.at(-1)?.parts[0]?.text, "OK");
});

test("history exact-text fallback does not claim a distinct local reply", () => {
	const cached = [
		{ id: "web-u", role: "user", parts: [{ type: "text", text: "问题" }] },
		{ id: "new-local", role: "assistant", parts: [{ type: "text", text: "OK" }] },
	];
	const history = chatMessagesToUiMessages([
		message({ id: "u", role: "user", text: "问题", timestamp: 100 }),
		message({ id: "old-answer", role: "assistant", text: "OK and more", timestamp: 110 }),
	]);
	const merged = mergeAuthoritativeUiMessages(cached, history, { dropCoveredLocalSseLeftovers: true });
	assert.equal(merged.some((item) => item.id === "new-local"), true);
	assert.equal(merged.some((item) => item.id === "old-answer"), true);
});

test("runtime cleanup keeps a distinct plain-text reply after an earlier cached answer", () => {
	const current = chatMessagesToUiMessages([
		message({ id: "u", role: "user", text: "问题", timestamp: 100 }),
		message({ id: "old-answer", role: "assistant", text: "OK and more", timestamp: 110 }),
	]);
	current.push({ id: "new-local", role: "assistant", parts: [{ type: "text", text: "OK" }] });
	const snapshot = chatMessagesToUiMessages([
		message({ id: "u", role: "user", text: "问题", timestamp: 100 }),
		message({ id: "old-answer", role: "assistant", text: "OK and more", timestamp: 110 }),
	]);
	const merged = mergeAuthoritativeUiMessages(current, snapshot, { dropUnmatchedTrailingPlaceholders: true });
	assert.equal(merged.some((item) => item.id === "new-local"), true);
});

test("history baseline keeps an identical distinct local reply", () => {
	const cached = [
		{ id: "web-u", role: "user", parts: [{ type: "text", text: "问题" }] },
		{ id: "old-answer", role: "assistant", parts: [{ type: "text", text: "OK" }] },
		{ id: "new-local", role: "assistant", parts: [{ type: "text", text: "OK" }] },
	];
	const history = chatMessagesToUiMessages([
		message({ id: "u", role: "user", text: "问题", timestamp: 100 }),
		message({ id: "old-answer", role: "assistant", text: "OK", timestamp: 110 }),
	]);
	const merged = mergeAuthoritativeUiMessages(cached, history, { dropCoveredLocalSseLeftovers: true });
	assert.equal(merged.some((item) => item.id === "new-local"), true);
});

test("strict history exact-text match keeps a newer local reply when cached old id differs", () => {
	const cached = [
		...chatMessagesToUiMessages([
			message({ id: "u", role: "user", text: "问题", timestamp: 100 }),
			message({ id: "cache-old", role: "assistant", text: "OK", timestamp: 110 }),
		]),
		{ id: "new-local", role: "assistant", parts: [{ type: "text", text: "OK" }] },
	];
	const history = chatMessagesToUiMessages([
		message({ id: "u", role: "user", text: "问题", timestamp: 100 }),
		message({ id: "hist-old", role: "assistant", text: "OK", timestamp: 110 }),
	]);
	const merged = mergeAuthoritativeUiMessages(cached, history, { dropCoveredLocalSseLeftovers: true });
	assert.equal(merged.some((item) => item.id === "new-local"), true);
	assert.equal(merged.some((item) => item.id === "hist-old"), true);
});

test("runtime exact-text merge keeps a newer reply after an earlier persisted answer", () => {
	const current = [
		...chatMessagesToUiMessages([
			message({ id: "u", role: "user", text: "question", timestamp: 100 }),
			message({ id: "cached-old", role: "assistant", text: "OK", timestamp: 110 }),
		]),
		{ id: "new-local", role: "assistant", parts: [{ type: "text", text: "OK" }] },
	];
	const snapshot = chatMessagesToUiMessages([
		message({ id: "u", role: "user", text: "question", timestamp: 100 }),
		message({ id: "snapshot-old", role: "assistant", text: "OK", timestamp: 110 }),
	]);
	for (const options of [undefined, { dropUnmatchedTrailingPlaceholders: true }]) {
		const merged = mergeAuthoritativeUiMessages(current, snapshot, options);
		assert.equal(merged.some((item) => item.id === "snapshot-old"), true);
		assert.equal(merged.some((item) => item.id === "new-local"), true);
	}
});

test("strict history does not match an unanchored older assistant to a live reply", () => {
	// A bounded history page can begin in the middle of an older turn.
	const cached = [
		{ id: "web-new", role: "user", parts: [{ type: "text", text: "新问题" }] },
		{ id: "new-local", role: "assistant", parts: [{ type: "text", text: "OK" }] },
	];
	const history = chatMessagesToUiMessages([
		message({ id: "older-answer", role: "assistant", text: "OK", timestamp: 100 }),
		message({ id: "history-new", role: "user", text: "新问题", timestamp: 200 }),
	]);
	for (const options of [
		{ dropCoveredLocalSseLeftovers: true },
		{ dropUnmatchedTrailingPlaceholders: true },
	]) {
		const merged = mergeAuthoritativeUiMessages(cached, history, options);
		assert.equal(merged.some((item) => item.id === "new-local"), true);
		assert.equal(merged.some((item) => item.id === "older-answer"), true);
	}
});

test("strict history does not clear a combined bubble from a different timestamped turn", () => {
	const cached = [
		...chatMessagesToUiMessages([message({ id: "cache-u", role: "user", text: "继续", timestamp: 100 })]),
		{ id: "local-combined", role: "assistant", parts: [
			{ type: "reasoning", text: "想好了" },
			{ type: "text", text: "OK" },
		] },
	];
	const history = chatMessagesToUiMessages([
		message({ id: "history-u", role: "user", text: "继续", timestamp: 200 }),
		message({ id: "history-a", role: "assistant", text: "OK", thinking: "想好了", timestamp: 210 }),
	]);
	const merged = mergeAuthoritativeUiMessages(cached, history, { dropCoveredLocalSseLeftovers: true });
	assert.equal(merged.some((item) => item.id === "local-combined"), true);
	assert.equal(merged.some((item) => item.id === "history-a"), true);
});

test("strict history preserves a newer optimistic repeat beyond the loaded history window", () => {
	const cached = [
		{ id: "new-user", role: "user", parts: [{ type: "text", text: "继续" }] },
		{ id: "new-local", role: "assistant", parts: [{ type: "text", text: "尚未落盘的新回复" }] },
	];
	const history = chatMessagesToUiMessages([
		message({ id: "old-user", role: "user", text: "继续", timestamp: 100 }),
		message({ id: "old-answer", role: "assistant", text: "旧答复", timestamp: 110 }),
	]);
	for (const options of [
		{ dropCoveredLocalSseLeftovers: true },
		{ dropUnmatchedTrailingPlaceholders: true },
	]) {
		const merged = mergeAuthoritativeUiMessages(cached, history, options);
		assert.equal(merged.some((item) => item.id === "new-user"), true);
		assert.equal(merged.some((item) => item.id === "old-user"), true);
		assert.equal(merged.some((item) => item.id === "new-local"), true);
	}
});

test("strict history keeps an unanswered optimistic repeat missing from its page", () => {
	const cached = [{ id: "new-user", role: "user", parts: [{ type: "text", text: "repeat" }] }];
	const history = chatMessagesToUiMessages([
		message({ id: "old-user", role: "user", text: "repeat", timestamp: 100 }),
		message({ id: "old-answer", role: "assistant", text: "earlier answer", timestamp: 110 }),
	]);
	const merged = mergeAuthoritativeUiMessages(cached, history, { dropCoveredLocalSseLeftovers: true });
	assert.deepEqual(Array.from(merged, (item) => item.id), ["old-user", "old-answer", "new-user"]);
});

test("timestamp evidence reconciles repeated prompts and assistant replies by turn", () => {
	const current = chatMessagesToUiMessages([
		message({ id: "cache-u1", role: "user", text: "again", timestamp: 100 }),
		message({ id: "cache-a1", role: "assistant", text: "first", timestamp: 110 }),
		message({ id: "cache-u2", role: "user", text: "again", timestamp: 200 }),
		message({ id: "cache-a2", role: "assistant", text: "second", timestamp: 210 }),
	]);
	const history = chatMessagesToUiMessages([
		message({ id: "hist-u1", role: "user", text: "again", timestamp: 100 }),
		message({ id: "hist-a1", role: "assistant", text: "first", timestamp: 110 }),
		message({ id: "hist-u2", role: "user", text: "again", timestamp: 200 }),
		message({ id: "hist-a2", role: "assistant", text: "second", timestamp: 210 }),
	]);
	for (const options of [undefined, { dropCoveredLocalSseLeftovers: true }]) {
		const merged = mergeAuthoritativeUiMessages(current, history, options);
		assert.deepEqual(Array.from(merged, (item) => item.id), ["hist-u1", "hist-a1", "hist-u2", "hist-a2"]);
	}
});

test("strict history cleanup keeps longer local text when history contains only a short prefix", () => {
	const cached = [
		{ id: "web-user", role: "user", parts: [{ type: "text", text: "本轮问题" }] },
		{ id: "local-answer", role: "assistant", parts: [{ type: "text", text: "短内容以及尚未落盘的长后缀" }] },
	];
	const history = chatMessagesToUiMessages([
		message({ id: "history-user", role: "user", text: "本轮问题", timestamp: 100 }),
		message({ id: "history-answer", role: "assistant", text: "短内容", timestamp: 110 }),
	]);
	const merged = mergeAuthoritativeUiMessages(cached, history, { dropCoveredLocalSseLeftovers: true });
	assert.equal(merged.some((item) => item.id === "local-answer"), true);
});

test("strict history cleanup keeps trailing local reasoning and answer characters absent from the snapshot", () => {
	const cached = [
		{ id: "web-trailing-user", role: "user", parts: [{ type: "text", text: "问题" }] },
		{
			id: "local-trailing-space",
			role: "assistant",
			parts: [
				{ type: "reasoning", text: "思考 " },
				{ type: "text", text: "答案 " },
			],
		},
	];
	const history = chatMessagesToUiMessages([
		message({ id: "history-trailing-user", role: "user", text: "问题", timestamp: 100 }),
		message({ id: "history-trailing-answer", role: "assistant", text: "答案", thinking: "思考", timestamp: 110 }),
	]);

	const merged = mergeAuthoritativeUiMessages(cached, history, { dropCoveredLocalSseLeftovers: true });
	assert.equal(merged.some((item) => item.id === "local-trailing-space"), true);
});

test("strict history cleanup keeps a covered-looking orphan when it has no user-turn anchor", () => {
	const orphan = {
		id: "orphan-local",
		role: "assistant",
		parts: [
			{ type: "reasoning", text: "历史思考" },
			{ type: "text", text: "历史回答" },
		],
	};
	const history = chatMessagesToUiMessages([
		message({ id: "history-user", role: "user", text: "问题", timestamp: 100 }),
		message({ id: "history-answer", role: "assistant", text: "历史回答", thinking: "历史思考", timestamp: 110 }),
	]);
	const merged = mergeAuthoritativeUiMessages([orphan], history, { dropCoveredLocalSseLeftovers: true });
	assert.equal(merged.some((item) => item.id === "orphan-local"), true);
});

test("does not map repeated prompts across different timestamps", () => {
	const current = chatMessagesToUiMessages([
		message({ id: "cache-u", role: "user", text: "again", timestamp: 100 }),
		message({ id: "cache-a", role: "assistant", text: "first", timestamp: 110 }),
	]);
	const history = chatMessagesToUiMessages([
		message({ id: "hist-u", role: "user", text: "again", timestamp: 200 }),
		message({ id: "hist-a", role: "assistant", text: "second", timestamp: 210 }),
	]);
	const merged = mergeAuthoritativeUiMessages(current, history);
	assert.equal(merged.some((item) => item.id === "cache-a"), true);
	assert.equal(merged.some((item) => item.id === "hist-a"), true);
});

test("does not choose a repeated prompt when timestamp evidence is non-unique", () => {
	const current = chatMessagesToUiMessages([
		message({ id: "cache-u1", role: "user", text: "again", timestamp: 100 }),
		message({ id: "cache-u2", role: "user", text: "again", timestamp: 100 }),
	]);
	const history = chatMessagesToUiMessages([
		message({ id: "hist-u", role: "user", text: "again", timestamp: 100 }),
	]);
	const merged = mergeAuthoritativeUiMessages(current, history);
	assert.equal(merged.filter((item) => item.role === "user").length, 3);
});

test("stable entry identity resolves repeated user text without text-order fallback", () => {
	const current = [
		{ id: "cache-u1", role: "user", metadata: { chatRole: "user", entryId: "u1", timestamp: 100 }, parts: [{ type: "text", text: "again" }] },
		{ id: "cache-a1", role: "assistant", metadata: { chatRole: "assistant", entryId: "a1", timestamp: 110 }, parts: [{ type: "text", text: "first" }] },
		{ id: "cache-u2", role: "user", metadata: { chatRole: "user", entryId: "u2", timestamp: 200 }, parts: [{ type: "text", text: "again" }] },
		{ id: "cache-a2", role: "assistant", metadata: { chatRole: "assistant", entryId: "a2", timestamp: 210 }, parts: [{ type: "text", text: "second" }] },
	];
	const history = [
		{ id: "hist-u1", role: "user", metadata: { chatRole: "user", entryId: "u1", timestamp: 100 }, parts: [{ type: "text", text: "again" }] },
		{ id: "hist-a1", role: "assistant", metadata: { chatRole: "assistant", entryId: "a1", timestamp: 110 }, parts: [{ type: "text", text: "first" }] },
		{ id: "hist-u2", role: "user", metadata: { chatRole: "user", entryId: "u2", timestamp: 200 }, parts: [{ type: "text", text: "again" }] },
		{ id: "hist-a2", role: "assistant", metadata: { chatRole: "assistant", entryId: "a2", timestamp: 210 }, parts: [{ type: "text", text: "second" }] },
	];
	const merged = mergeAuthoritativeUiMessages(current, history);
	assert.deepEqual(Array.from(merged, (item) => item.id), ["hist-u1", "hist-a1", "hist-u2", "hist-a2"]);
});

test("does not map repeated metadata-free user turns by reverse text order", () => {
	const cached = [
		{ id: "web-u1", role: "user", parts: [{ type: "text", text: "same prompt" }] },
		{ id: "web-a1", role: "assistant", parts: [{ type: "text", text: "first answer" }] },
		{ id: "web-u2", role: "user", parts: [{ type: "text", text: "same prompt" }] },
		{ id: "web-a2", role: "assistant", parts: [{ type: "text", text: "second answer" }] },
	];
	const history = chatMessagesToUiMessages([
		message({ id: "history-u1", role: "user", text: "same prompt", timestamp: 100 }),
		message({ id: "history-a1", role: "assistant", text: "first answer", timestamp: 110 }),
		message({ id: "history-u2", role: "user", text: "same prompt", timestamp: 200 }),
		message({ id: "history-a2", role: "assistant", text: "second answer", timestamp: 210 }),
	]);

	const merged = mergeAuthoritativeUiMessages(cached, history);
	const mergedIds = Array.from(merged, (item) => item.id);
	const expectedIds = ["web-u1", "web-a1", "web-u2", "web-a2", "history-u1", "history-a1", "history-u2", "history-a2"];
	assert.equal(mergedIds.length, expectedIds.length, "ambiguous repeated prompts must not cause a cache row to be replaced or dropped");
	for (const id of expectedIds) {
		assert.equal(mergedIds.filter((actualId) => actualId === id).length, 1, `${id} remains as its own message`);
	}
	assert.deepEqual(mergedIds.filter((id) => id.startsWith("web-")), ["web-u1", "web-a1", "web-u2", "web-a2"]);
	assert.deepEqual(mergedIds.filter((id) => id.startsWith("history-")), ["history-u1", "history-a1", "history-u2", "history-a2"]);
});

test("keeps both identical user turns when the runtime snapshot repeats the newest one", () => {
	const current = chatMessagesToUiMessages([
		message({ id: "u1", role: "user", text: "继续", timestamp: 100 }),
		message({ id: "a1", role: "assistant", text: "一", timestamp: 110 }),
		message({ id: "u2", role: "user", text: "继续", timestamp: 200 }),
	]);
	const authoritative = chatMessagesToUiMessages([
		message({ id: "rt-u2", role: "user", text: "继续", timestamp: 200 }),
	]);

	const merged = mergeAuthoritativeUiMessages(current, authoritative);
	assert.deepEqual(
		Array.from(merged, (item) => `${item.id}:${item.parts[0]?.text}`),
		["u1:继续", "a1:一", "rt-u2:继续"],
	);
});

// ── 历史分页：更早的一页只往顶部插，流式尾部原样保留 ─────────────────────────

test("prepends an older history page above the streaming tail without disturbing it", () => {
	const older = chatMessagesToUiMessages([
		message({ id: "u0", role: "user", text: "最早的问题", timestamp: 50 }),
		message({ id: "a0", role: "assistant", text: "最早的回答", timestamp: 60 }),
	]);
	const tail = [
		...chatMessagesToUiMessages([
			message({ id: "u1", role: "user", text: "第二问", timestamp: 100 }),
			message({ id: "a1", role: "assistant", text: "第二答", timestamp: 110 }),
		]),
		{ id: "live", role: "assistant", parts: [{ type: "text", text: "正在生成" }] },
	];

	const merged = prependOlderHistoryPage(older, tail);
	assert.deepEqual(
		Array.from(merged, (item) => item.id),
		["u0", "a0", "u1", "a1", "live"],
	);
});

test("prepending an overlapping older page does not duplicate already visible rows", () => {
	const older = chatMessagesToUiMessages([
		message({ id: "u0", role: "user", text: "最早的问题", timestamp: 50 }),
		message({ id: "a0", role: "assistant", text: "最早的回答", timestamp: 60 }),
		message({ id: "u1", role: "user", text: "第二问", timestamp: 100 }),
	]);
	const tail = chatMessagesToUiMessages([
		message({ id: "u1", role: "user", text: "第二问", timestamp: 100 }),
		message({ id: "a1", role: "assistant", text: "第二答", timestamp: 110 }),
	]);

	const merged = prependOlderHistoryPage(older, tail);
	assert.deepEqual(
		Array.from(merged, (item) => item.id),
		["u0", "a0", "u1", "a1"],
	);
});

test("prepending an empty older page leaves the tail untouched", () => {
	const tail = chatMessagesToUiMessages([
		message({ id: "u1", role: "user", text: "问", timestamp: 100 }),
	]);
	const merged = prependOlderHistoryPage([], tail);
	assert.deepEqual(Array.from(merged, (item) => item.id), ["u1"]);
});

test("fetchTurnPage requests the turn endpoint with an options object", async () => {
	const previousFetch = globalThis.fetch;
	const calls = [];
	globalThis.fetch = async (input) => {
		calls.push(String(input));
		return new Response(JSON.stringify({
			messages: [],
			total: 5,
			nextBefore: 3,
			nextBeforeEntryId: "e3",
		}), { status: 200, headers: { "content-type": "application/json" } });
	};
	try {
		const page = await fetchTurnPage("sess 1");
		assert.equal(
			calls[0],
			"/api/sessions/sess%201/messages/turn-page",
			"omitted options must not send empty query parameters",
		);
		assert.equal(page.nextBefore, 3);

		await fetchTurnPage("sess-1", { turnCount: 50 });
		assert.equal(calls[1], "/api/sessions/sess-1/messages/turn-page?turnCount=50");

		await fetchTurnPage("sess-1", { turnCount: 3, before: 40, beforeEntryId: "e40" });
		assert.equal(
			calls[2],
			"/api/sessions/sess-1/messages/turn-page?turnCount=3&before=40&beforeEntryId=e40",
			"both cursors must be forwarded so a renamed anchor cannot silently restart from the tail",
		);

		await fetchTurnPage("sess-1", { before: 0 });
		assert.equal(
			calls[3],
			"/api/sessions/sess-1/messages/turn-page?before=0",
			"before=0 is a real cursor and must not be dropped",
		);
	} finally {
		globalThis.fetch = previousFetch;
	}
});

test("fetchTurnPage rejects a failed response instead of returning an empty page", async () => {
	const previousFetch = globalThis.fetch;
	globalThis.fetch = async () => new Response("nope", { status: 500 });
	try {
		await assert.rejects(() => fetchTurnPage("sess-1", { turnCount: 50 }), /messages 500/);
	} finally {
		globalThis.fetch = previousFetch;
	}
});
