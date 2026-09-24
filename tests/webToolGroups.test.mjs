import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const {
	isWebToolPart,
	isPureToolMessage,
	groupWebAssistantParts,
	groupWebTimelineMessages,
} = loadTsCommonJs("src/renderer/src/web/webToolGroups.ts");

test("isWebToolPart recognizes dynamic-tool and tool-*", () => {
	assert.equal(isWebToolPart({ type: "dynamic-tool" }), true);
	assert.equal(isWebToolPart({ type: "tool-read_file" }), true);
	assert.equal(isWebToolPart({ type: "text" }), false);
	assert.equal(isWebToolPart({ type: "reasoning" }), false);
	assert.equal(isWebToolPart(null), false);
});

test("groupWebAssistantParts groups consecutive tool parts within single message", () => {
	const message = { id: "msg-1", role: "assistant", parts: [] };
	const parts = [
		{ type: "reasoning", text: "thinking..." },
		{ type: "tool-exec", toolCallId: "call-1", toolName: "exec" },
		{ type: "dynamic-tool", toolCallId: "call-2", toolName: "read" },
		{ type: "text", text: "done" },
	];

	const grouped = groupWebAssistantParts(parts, message);
	assert.equal(grouped.length, 3);
	assert.equal(grouped[0].kind, "reasoning");
	assert.equal(grouped[1].kind, "tool-group");
	assert.equal(grouped[1].id, "call-1");
	assert.equal(grouped[1].parts.length, 2);
	assert.equal(grouped[2].kind, "text");
});

test("groupWebAssistantParts leaves single tool as tool-single", () => {
	const message = { id: "msg-1", role: "assistant", parts: [] };
	const parts = [
		{ type: "tool-exec", toolCallId: "call-1", toolName: "exec" },
		{ type: "text", text: "done" },
	];

	const grouped = groupWebAssistantParts(parts, message);
	assert.equal(grouped.length, 2);
	assert.equal(grouped[0].kind, "tool-single");
	assert.equal(grouped[0].part.toolCallId, "call-1");
	assert.equal(grouped[1].kind, "text");
});

test("groupWebAssistantParts does not merge tools separated by text or reasoning", () => {
	const message = { id: "msg-1", role: "assistant", parts: [] };
	const parts = [
		{ type: "tool-exec", toolCallId: "call-1" },
		{ type: "reasoning", text: "think again" },
		{ type: "tool-exec", toolCallId: "call-2" },
	];

	const grouped = groupWebAssistantParts(parts, message);
	assert.equal(grouped.length, 3);
	assert.equal(grouped[0].kind, "tool-single");
	assert.equal(grouped[1].kind, "reasoning");
	assert.equal(grouped[2].kind, "tool-single");
});

test("groupWebAssistantParts keeps tool group intact when separated only by empty text part", () => {
	const message = { id: "msg-1", role: "assistant", parts: [] };
	const parts = [
		{ type: "tool-exec", toolCallId: "call-1", toolName: "exec" },
		{ type: "text", text: "" }, // 不可见的空文本 part
		{ type: "tool-read", toolCallId: "call-2", toolName: "read" },
	];

	const grouped = groupWebAssistantParts(parts, message);
	// 验证未被空文本冲刷切断，两个工具仍合并为一个 tool-group
	assert.equal(grouped.length, 1);
	assert.equal(grouped[0].kind, "tool-group");
	assert.equal(grouped[0].parts.length, 2);
});

test("groupWebAssistantParts separates ask_question result card from tool group", () => {
	const message = {
		id: "msg-ask",
		role: "assistant",
		metadata: {
			chatRole: "assistant",
			askQuestionResult: {
				question: "Confirm action?",
				answered: true,
				answer: "yes",
			},
		},
		parts: [],
	};
	const parts = [
		{ type: "tool-ask_question", toolCallId: "call-ask" },
		{ type: "tool-write_file", toolCallId: "call-write" },
	];

	const grouped = groupWebAssistantParts(parts, message);
	assert.equal(grouped.length, 2);
	assert.equal(grouped[0].kind, "ask-result");
	assert.equal(grouped[1].kind, "tool-single");
});

test("groupWebTimelineMessages groups consecutive historical pure-tool messages", () => {
	const messages = [
		{ id: "u1", role: "user", parts: [{ type: "text", text: "hello" }] },
		{ id: "t1", role: "assistant", parts: [{ type: "tool-read", toolCallId: "c1" }] },
		{ id: "t2", role: "assistant", parts: [{ type: "tool-write", toolCallId: "c2" }] },
		{ id: "a1", role: "assistant", parts: [{ type: "text", text: "I finished" }] },
	];

	const grouped = groupWebTimelineMessages(messages);
	assert.equal(grouped.length, 3);
	assert.equal(grouped[0].kind, "message");
	assert.equal(grouped[0].message.id, "u1");
	assert.equal(grouped[1].kind, "tool-message-group");
	assert.equal(grouped[1].id, "c1");
	assert.equal(grouped[1].parts.length, 2);
	assert.equal(grouped[2].kind, "message");
	assert.equal(grouped[2].message.id, "a1");
});

test("groupWebTimelineMessages does not group single tool message", () => {
	const messages = [
		{ id: "u1", role: "user", parts: [{ type: "text", text: "hello" }] },
		{ id: "t1", role: "assistant", parts: [{ type: "tool-read", toolCallId: "c1" }] },
		{ id: "a1", role: "assistant", parts: [{ type: "text", text: "done" }] },
	];

	const grouped = groupWebTimelineMessages(messages);
	assert.equal(grouped.length, 3);
	assert.equal(grouped[1].kind, "message");
	assert.equal(grouped[1].message.id, "t1");
});

test("groupWebTimelineMessages breaks tool message group on user message", () => {
	const messages = [
		{ id: "t1", role: "assistant", parts: [{ type: "tool-read", toolCallId: "c1" }] },
		{ id: "u1", role: "user", parts: [{ type: "text", text: "continue" }] },
		{ id: "t2", role: "assistant", parts: [{ type: "tool-write", toolCallId: "c2" }] },
	];

	const grouped = groupWebTimelineMessages(messages);
	assert.equal(grouped.length, 3);
	assert.equal(grouped[0].kind, "message");
	assert.equal(grouped[0].message.id, "t1");
	assert.equal(grouped[1].kind, "message");
	assert.equal(grouped[1].message.id, "u1");
	assert.equal(grouped[2].kind, "message");
	assert.equal(grouped[2].message.id, "t2");
});

test("groupWebTimelineMessages excludes assistant messages containing ask cards from pure-tool grouping", () => {
	const messages = [
		{ id: "t1", role: "assistant", parts: [{ type: "tool-read", toolCallId: "c1" }] },
		{
			id: "t2",
			role: "assistant",
			parts: [{ type: "tool-ask_question", toolCallId: "c2" }],
			metadata: {
				chatRole: "tool",
				askQuestionResult: {
					question: "请确认",
					answered: true,
					answer: "yes",
				},
			},
		},
	];

	const grouped = groupWebTimelineMessages(messages);
	// t2 含有规范的 askQuestionResult，不能与 t1 聚合为纯工具组
	assert.equal(grouped.length, 2);
	assert.equal(grouped[0].kind, "message");
	assert.equal(grouped[0].message.id, "t1");
	assert.equal(grouped[1].kind, "message");
	assert.equal(grouped[1].message.id, "t2");
});

test("groupWebTimelineMessages keeps parts in strict sequential order when prepending earlier page", () => {
	// 模拟分页翻历史：先有当前页 [t2, t3, a1]，向前翻页加载 [t0, t1]
	const pageOlder = [
		{ id: "t0", role: "assistant", parts: [{ type: "tool-step0", toolCallId: "c0" }] },
		{ id: "t1", role: "assistant", parts: [{ type: "tool-step1", toolCallId: "c1" }] },
	];
	const pageNewer = [
		{ id: "t2", role: "assistant", parts: [{ type: "tool-step2", toolCallId: "c2" }] },
		{ id: "t3", role: "assistant", parts: [{ type: "tool-step3", toolCallId: "c3" }] },
		{ id: "a1", role: "assistant", parts: [{ type: "text", text: "all done" }] },
	];

	const combined = [...pageOlder, ...pageNewer];
	const grouped = groupWebTimelineMessages(combined);

	// 4 个连续工具消息合并为一个组
	assert.equal(grouped.length, 2);
	assert.equal(grouped[0].kind, "tool-message-group");
	assert.equal(grouped[0].parts.length, 4);
	assert.equal(grouped[0].parts[0].toolCallId, "c0");
	assert.equal(grouped[0].parts[1].toolCallId, "c1");
	assert.equal(grouped[0].parts[2].toolCallId, "c2");
	assert.equal(grouped[0].parts[3].toolCallId, "c3");
	assert.equal(grouped[1].kind, "message");
	assert.equal(grouped[1].message.id, "a1");
});

// ── 计划步骤 1：复现测试用例 ──

test("1. groupWebAssistantParts merges consecutive tools across invisible step-start, but breaks on visible text", () => {
	const message = { id: "msg-step", role: "assistant", parts: [] };
	const partsWithoutText = [
		{ type: "tool-read", toolCallId: "c1", toolName: "read" },
		{ type: "step-start" },
		{ type: "tool-write", toolCallId: "c2", toolName: "write" },
	];

	const grouped = groupWebAssistantParts(partsWithoutText, message);
	assert.equal(grouped.length, 1, "step-start 不可见标记不应切断工具组");
	assert.equal(grouped[0].kind, "tool-group");
	assert.equal(grouped[0].parts.length, 2);
	assert.equal(grouped[0].parts[0].part.toolCallId, "c1");
	assert.equal(grouped[0].parts[1].part.toolCallId, "c2");

	// 包含可见正文时仍必须切断
	const partsWithText = [
		{ type: "tool-read", toolCallId: "c1", toolName: "read" },
		{ type: "step-start" },
		{ type: "text", text: "可见正文" },
		{ type: "tool-write", toolCallId: "c2", toolName: "write" },
	];
	const groupedWithText = groupWebAssistantParts(partsWithText, message);
	assert.equal(groupedWithText.length, 3);
	assert.equal(groupedWithText[0].kind, "tool-single");
	assert.equal(groupedWithText[1].kind, "text");
	assert.equal(groupedWithText[2].kind, "tool-single");
});

test("2. isPureToolMessage qualifies assistant messages containing tools and step-start, rejects step-start only", () => {
	const validMessage = {
		id: "m-valid",
		role: "assistant",
		parts: [
			{ type: "tool-read", toolCallId: "c1" },
			{ type: "step-start" },
			{ type: "tool-write", toolCallId: "c2" },
		],
	};
	assert.equal(isPureToolMessage(validMessage), true, "包含工具与 step-start 的消息应为纯工具消息");

	const onlyStepMessage = {
		id: "m-step-only",
		role: "assistant",
		parts: [{ type: "step-start" }],
	};
	assert.equal(isPureToolMessage(onlyStepMessage), false, "仅有 step-start 无工具的消息不可作为纯工具消息");
});

test("3. groupWebAssistantParts treats unanswered ask_question as group boundary and keeps it as plain tool card", () => {
	const message = { id: "msg-pending-ask", role: "assistant", parts: [] };
	const parts = [
		{ type: "tool-read", toolCallId: "c-read" },
		{ type: "tool-ask_question", toolCallId: "c-ask" },
		{ type: "tool-write", toolCallId: "c-write" },
	];

	const grouped = groupWebAssistantParts(parts, message);
	assert.equal(grouped.length, 3, "未回答的 ask_question 必须作为边界隔开前后工具");
	assert.equal(grouped[0].kind, "tool-single");
	assert.equal(grouped[0].part.toolCallId, "c-read");
	assert.equal(grouped[1].kind, "tool-single");
	assert.equal(grouped[1].part.toolCallId, "c-ask");
	assert.equal(grouped[2].kind, "tool-single");
	assert.equal(grouped[2].part.toolCallId, "c-write");

	// 历史消息流：未回答的 ask_question 消息不能合并进纯工具组
	const historyMessages = [
		{ id: "t1", role: "assistant", parts: [{ type: "tool-read", toolCallId: "c1" }] },
		{ id: "t2", role: "assistant", parts: [{ type: "tool-ask_question", toolCallId: "c2" }] },
		{ id: "t3", role: "assistant", parts: [{ type: "tool-write", toolCallId: "c3" }] },
	];
	const historyGrouped = groupWebTimelineMessages(historyMessages);
	assert.equal(historyGrouped.length, 3, "含未回答 ask_question 的消息不得并入前后纯工具组");
});

test("4. groupWebAssistantParts places ask-result card on the ask_question part when it is not the first tool", () => {
	const message = {
		id: "msg-answered-second",
		role: "assistant",
		metadata: {
			chatRole: "assistant",
			askQuestionResult: {
				question: "确认执行?",
				answered: true,
				answer: "yes",
			},
		},
		parts: [],
	};
	const parts = [
		{ type: "tool-read", toolCallId: "c-read" },
		{ type: "tool-ask_question", toolCallId: "c-ask" },
		{ type: "tool-write", toolCallId: "c-write" },
	];

	const grouped = groupWebAssistantParts(parts, message);
	assert.equal(grouped.length, 3);
	assert.equal(grouped[0].kind, "tool-single");
	assert.equal(grouped[0].part.toolCallId, "c-read");
	assert.equal(grouped[1].kind, "ask-result", "问答结果卡应挂在真正的 ask_question 上，而非误吞 read");
	assert.equal(grouped[2].kind, "tool-single");
	assert.equal(grouped[2].part.toolCallId, "c-write");
});

test("5. dynamic-tool ask_question behaves identically to tool-ask_question as a boundary", () => {
	const message = {
		id: "msg-dyn-ask",
		role: "assistant",
		metadata: {
			chatRole: "assistant",
			askQuestionResult: {
				question: "请选择",
				answered: true,
				answer: "opt1",
			},
		},
		parts: [],
	};
	const parts = [
		{ type: "dynamic-tool", toolName: "read_file", toolCallId: "c-dyn-read" },
		{ type: "dynamic-tool", toolName: "ask_question", toolCallId: "c-dyn-ask" },
		{ type: "dynamic-tool", toolName: "write_file", toolCallId: "c-dyn-write" },
	];

	const grouped = groupWebAssistantParts(parts, message);
	assert.equal(grouped.length, 3);
	assert.equal(grouped[0].kind, "tool-single");
	assert.equal(grouped[0].part.toolCallId, "c-dyn-read");
	assert.equal(grouped[1].kind, "ask-result");
	assert.equal(grouped[2].kind, "tool-single");
	assert.equal(grouped[2].part.toolCallId, "c-dyn-write");
});

test("6. fallback to first tool only when askQuestionResult exists but no recognizable ask tool part is present", () => {
	const message = {
		id: "msg-fallback",
		role: "assistant",
		metadata: {
			chatRole: "assistant",
			askQuestionResult: {
				question: "兼容旧格式",
				answered: true,
				answer: "ok",
			},
		},
		parts: [],
	};
	// 工具名称均不是 ask_question 的旧数据
	const parts = [
		{ type: "tool-custom1", toolCallId: "c1" },
		{ type: "tool-custom2", toolCallId: "c2" },
	];

	const grouped = groupWebAssistantParts(parts, message);
	assert.equal(grouped.length, 2);
	assert.equal(grouped[0].kind, "ask-result", "在无明确 ask 工具时回退到首个工具");
	assert.equal(grouped[1].kind, "tool-single");
});
