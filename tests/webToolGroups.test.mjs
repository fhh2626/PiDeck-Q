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

// ─────────────────────────────────────────────────────────────────────────────
// 透明助手占位与时间线工具组（2026-09 修复：空 assistant 占位不打断工具组）
// 真实链路：主进程 message_start 会 upsert 一条空 assistant 占位（allowEmpty），
// 纯工具回合（无正文/思考）后占位保持为空。Web 不显示它，但它不应切断
// 前后工具消息的分组。以下用例从完整 ChatMessage 经真实转换链进入分组函数。
// ─────────────────────────────────────────────────────────────────────────────
const { chatMessagesToUiMessages } = loadTsCommonJs(
	"src/renderer/src/web/webApi.ts",
);

/** 构造 UIMessage 占位消息（SSE 实时层形态，metadata 与 webApi.ts 同一形状）。 */
const uiPlaceholder = (id, parts) => ({
	id,
	role: "assistant",
	metadata: { chatRole: "assistant", timestamp: 1 },
	parts,
});

/** 构造完整 ChatMessage 测试数据（工厂函数构造完整对象，不用部分字段强转）。 */
const chatMsg = (overrides) => ({
	id: `cm-${Math.random().toString(36).slice(2, 10)}`,
	agentId: "a1",
	role: "assistant",
	text: "",
	timestamp: 1,
	...overrides,
});

/**
 * 跨 realm 安全的数组比较：生产代码在 VM 上下文执行，其数组/对象的
 * prototype 与宿主不同，assert.deepStrictEqual 会拒绝同结构值。
 */
const sameAs = (actual, expected) =>
	assert.equal(
		JSON.stringify(actual),
		JSON.stringify(expected),
		`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
	);

/** 工具 ChatMessage（真实历史形态：role=tool + meta.toolName/toolCallId）。 */
const toolMsg = (id, toolName, toolCallId, extra = {}) =>
	chatMsg({
		id,
		role: "tool",
		text: `${toolName} ok`,
		meta: { toolName, toolCallId, status: "done", result: `out-${id}` },
		...extra,
	});

/** 经真实转换链（ChatMessage → UIMessage → 分组）得到时间线分组结果。 */
const groupViaRealChain = (chatMessages) =>
	groupWebTimelineMessages(chatMessagesToUiMessages(chatMessages));

test("real chain: tool → empty assistant placeholder → tool forms one group", () => {
	// 工具带非空嵌套参数（meta 整体传入，保留 toolName/toolCallId/status/result）
	const powershellArgs = { command: "Get-Location", options: { timeout: 10 } };
	const readArgs = { path: "fixture.txt", range: { offset: 1, limit: 20 } };
	const chat = [
		toolMsg("t1", "powershell", "call-1", {
			meta: {
				toolName: "powershell",
				toolCallId: "call-1",
				status: "done",
				result: "out-t1",
				args: powershellArgs,
			},
		}),
		chatMsg({ id: "p1", role: "assistant", text: "" }),
		toolMsg("t2", "read", "call-2", {
			meta: {
				toolName: "read",
				toolCallId: "call-2",
				status: "done",
				result: "out-t2",
				args: readArgs,
			},
		}),
	];
	const grouped = groupViaRealChain(chat);
	assert.equal(grouped.length, 1, "应只产生一个工具组");
	assert.equal(grouped[0].kind, "tool-message-group");
	sameAs(grouped[0].parts.map((p) => p.toolCallId), ["call-1", "call-2"]);
	sameAs(grouped[0].parts.map((p) => p.toolName), ["powershell", "read"]);
	assert.equal(grouped[0].parts[0].output, "out-t1", "工具输出保持原样");
	assert.equal(grouped[0].parts[1].output, "out-t2");
	assert.equal(grouped[0].parts[0].state, "output-available");
	assert.equal(grouped[0].parts[1].state, "output-available");
	// 嵌套参数逐字段保留（未被执行层重写或丢失）
	sameAs(grouped[0].parts[0].input, powershellArgs);
	sameAs(grouped[0].parts[1].input, readArgs);
	assert.equal(grouped[0].parts[0].input.options.timeout, 10);
	assert.equal(grouped[0].parts[1].input.range.limit, 20);
	// 工具组 messages 只含真实工具消息，不含空占位
	assert.equal(grouped[0].messages.length, 2);
	sameAs(grouped[0].messages.map((m) => m.id), ["t1", "t2"]);
	// 组 ID 仍由首个工具的稳定身份生成
	assert.equal(grouped[0].id, "call-1");
});

test("tool → multiple empty placeholders → tool still forms one group", () => {
	const chat = [
		toolMsg("t1", "powershell", "c1"),
		chatMsg({ id: "p1", role: "assistant" }),
		chatMsg({ id: "p2", role: "assistant" }),
		toolMsg("t2", "read", "c2"),
	];
	const grouped = groupViaRealChain(chat);
	assert.equal(grouped.length, 1);
	assert.equal(grouped[0].kind, "tool-message-group");
	sameAs(grouped[0].parts.map((p) => p.toolCallId), ["c1", "c2"]);
});

test("tool → step-start-only assistant → tool forms one group", () => {
	// 注意：step-start 仅存在于 SSE 实时消息（UIMessage 层），历史 ChatMessage 转换链
	// 不产生 step-start。因此这里直接在 UIMessage 层构造该形态验证分组行为。
	const ui = [
		chatMessagesToUiMessages([toolMsg("t1", "powershell", "c1")])[0],
		uiPlaceholder("p1", [{ type: "step-start" }]),
		chatMessagesToUiMessages([toolMsg("t2", "read", "c2")])[0],
	];
	const direct = groupWebTimelineMessages(ui);
	assert.equal(direct.length, 1);
	assert.equal(direct[0].kind, "tool-message-group");
	sameAs(direct[0].parts.map((p) => p.toolCallId), ["c1", "c2"]);
});

test("tool → empty-text assistant → tool forms one group", () => {
	const ui = [
		chatMessagesToUiMessages([toolMsg("t1", "powershell", "c1")])[0],
		uiPlaceholder("p1", [{ type: "text", text: "" }]),
		chatMessagesToUiMessages([toolMsg("t2", "read", "c2")])[0],
	];
	const grouped = groupWebTimelineMessages(ui);
	assert.equal(grouped.length, 1);
	assert.equal(grouped[0].kind, "tool-message-group");
	sameAs(grouped[0].parts.map((p) => p.toolCallId), ["c1", "c2"]);
});

test("tool → step-start + empty text assistant → tool forms one group", () => {
	const ui = [
		chatMessagesToUiMessages([toolMsg("t1", "powershell", "c1")])[0],
		uiPlaceholder("p1", [{ type: "step-start" }, { type: "text", text: "" }]),
		chatMessagesToUiMessages([toolMsg("t2", "read", "c2")])[0],
	];
	const grouped = groupWebTimelineMessages(ui);
	assert.equal(grouped.length, 1);
	assert.equal(grouped[0].kind, "tool-message-group");
});

test("empty placeholder → single tool → empty placeholder stays single, no single-item group", () => {
	const chat = [
		chatMsg({ id: "p1", role: "assistant" }),
		toolMsg("t1", "powershell", "c1"),
		chatMsg({ id: "p2", role: "assistant" }),
	];
	const grouped = groupViaRealChain(chat);
	// 透明占位不输出展示条目；单个工具不创建单元素工具组，只保留一个工具消息条目
	assert.equal(grouped.length, 1);
	assert.equal(grouped[0].kind, "message");
	assert.equal(grouped[0].message.id, "t1");
});

test("tool → visible text assistant → tool stays separate", () => {
	const chat = [
		toolMsg("t1", "powershell", "c1"),
		chatMsg({ id: "p1", role: "assistant", text: "我来检查一下" }),
		toolMsg("t2", "read", "c2"),
	];
	const grouped = groupViaRealChain(chat);
	assert.equal(grouped.length, 3);
	assert.equal(grouped[0].kind, "message");
	assert.equal(grouped[1].kind, "message");
	assert.equal(grouped[1].message.id, "p1");
	assert.equal(grouped[1].message.parts[0].text, "我来检查一下", "正文保留");
	assert.equal(grouped[2].kind, "message");
	assert.equal(grouped[2].message.id, "t2");
});

test("tool → reasoning assistant → tool stays separate", () => {
	const chat = [
		toolMsg("t1", "powershell", "c1"),
		chatMsg({ id: "p1", role: "assistant", thinking: "先看看目录" }),
		toolMsg("t2", "read", "c2"),
	];
	const grouped = groupViaRealChain(chat);
	assert.equal(grouped.length, 3);
	assert.equal(grouped[1].kind, "message");
	assert.equal(grouped[1].message.id, "p1");
	assert.equal(grouped[1].message.parts[0].type, "reasoning", "思考保留");
});

test("empty reasoning part remains a boundary between tools", () => {
	// 注意：不能经 ChatMessage.thinking="" 构造——转换器只在 thinking 为真值时才产出
	// reasoning part（空字符串会变成 parts: []），测不到空 reasoning 边界，
	// 因此这里直接在 UIMessage 层构造。
	const ui = [
		chatMessagesToUiMessages([toolMsg("t1", "powershell", "c1")])[0],
		{
			id: "p1",
			role: "assistant",
			metadata: { chatRole: "assistant", timestamp: 1 },
			parts: [{ type: "reasoning", text: "" }],
		},
		chatMessagesToUiMessages([toolMsg("t2", "read", "c2")])[0],
	];
	const grouped = groupWebTimelineMessages(ui);
	assert.equal(grouped.length, 3, "空 reasoning 必须阻断分组");
	assert.equal(grouped[0].kind, "message");
	assert.equal(grouped[0].message.id, "t1");
	assert.equal(grouped[1].kind, "message");
	assert.equal(grouped[1].message.id, "p1");
	// 空 reasoning part 保留在中间消息中，未被跳过或删除
	assert.equal(grouped[1].message.parts.length, 1);
	assert.equal(grouped[1].message.parts[0].type, "reasoning");
	assert.equal(grouped[1].message.parts[0].text, "");
	assert.equal(grouped[2].kind, "message");
	assert.equal(grouped[2].message.id, "t2");
});

test("tool → user message → tool stays separate", () => {
	const chat = [
		toolMsg("t1", "powershell", "c1"),
		chatMsg({ id: "u1", role: "user", text: "继续" }),
		toolMsg("t2", "read", "c2"),
	];
	const grouped = groupViaRealChain(chat);
	assert.equal(grouped.length, 3);
	assert.equal(grouped[1].kind, "message");
	assert.equal(grouped[1].message.id, "u1");
});

test("tool → image assistant → tool stays separate and image preserved", () => {
	const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
	const chat = [
		toolMsg("t1", "powershell", "c1"),
		chatMsg({
			id: "p1",
			role: "assistant",
			images: [{ type: "image", mimeType: "image/png", data: png }],
		}),
		toolMsg("t2", "read", "c2"),
	];
	const grouped = groupViaRealChain(chat);
	assert.equal(grouped.length, 3);
	assert.equal(grouped[1].kind, "message");
	assert.equal(grouped[1].message.parts[0].type, "file", "图片 part 保留");
});

test("tool → completed ask result assistant → tool stays separate", () => {
	// ask 问答卡元数据在 UIMessage 层构造（与既有测试同一形状），
	// 验证有已完成问答结果的助手消息仍是真实边界。
	const ui = [
		chatMessagesToUiMessages([toolMsg("t1", "powershell", "c1")])[0],
		{
			id: "p1",
			role: "assistant",
			metadata: {
				chatRole: "assistant",
				askQuestionResult: {
					question: "是否继续？",
					answered: true,
					answer: "继续",
				},
			},
			parts: [],
		},
		chatMessagesToUiMessages([toolMsg("t2", "read", "c2")])[0],
	];
	const grouped = groupWebTimelineMessages(ui);
	assert.equal(grouped.length, 3);
	assert.equal(grouped[1].kind, "message");
	assert.equal(grouped[1].message.id, "p1");
});

test("tool → unanswered ask_question tool message → tool stays separate", () => {
	const chat = [
		toolMsg("t1", "powershell", "c1"),
		toolMsg("t-ask", "ask_question", "c-ask"),
		toolMsg("t2", "read", "c2"),
	];
	const grouped = groupViaRealChain(chat);
	assert.equal(grouped.length, 3);
	assert.equal(grouped[0].kind, "message");
	assert.equal(grouped[0].message.id, "t1");
	assert.equal(grouped[1].kind, "message");
	assert.equal(grouped[1].message.id, "t-ask");
	assert.equal(grouped[2].kind, "message");
	assert.equal(grouped[2].message.id, "t2");
});

test("tool → assistant with unknown part → tool stays separate (conservative)", () => {
	const ui = [
		chatMessagesToUiMessages([toolMsg("t1", "powershell", "c1")])[0],
		uiPlaceholder("p1", [{ type: "image" }]),
		chatMessagesToUiMessages([toolMsg("t2", "read", "c2")])[0],
	];
	const grouped = groupWebTimelineMessages(ui);
	assert.equal(grouped.length, 3);
	assert.equal(grouped[1].kind, "message");
	assert.equal(grouped[1].message.id, "p1");
});

test("tool → whitespace-only text assistant → tool stays separate (conservative)", () => {
	const chat = [
		toolMsg("t1", "powershell", "c1"),
		chatMsg({ id: "p1", role: "assistant", text: " " }),
		toolMsg("t2", "read", "c2"),
	];
	const grouped = groupViaRealChain(chat);
	assert.equal(grouped.length, 3);
	assert.equal(grouped[1].kind, "message");
	assert.equal(grouped[1].message.id, "p1");
});

test("assistant role with system chatRole metadata is a boundary even when empty", () => {
	const chat = [
		toolMsg("t1", "powershell", "c1"),
		chatMsg({ id: "p1", role: "system", text: "" }),
		toolMsg("t2", "read", "c2"),
	];
	const grouped = groupViaRealChain(chat);
	assert.equal(grouped.length, 3);
	assert.equal(grouped[1].kind, "message");
	assert.equal(grouped[1].message.id, "p1");
});

test("assistant role with user chatRole metadata is a boundary even when empty", () => {
	// 直接构造 UI assistant + 来源 chatRole=user 的形态（经真实链转换会保留 role=user，
	// 那样只能验证第一层角色判断，无法覆盖来源元数据校验）。
	const ui = [
		chatMessagesToUiMessages([toolMsg("t1", "powershell", "c1")])[0],
		{
			id: "p1",
			role: "assistant",
			metadata: { chatRole: "user", timestamp: 1 },
			parts: [],
		},
		chatMessagesToUiMessages([toolMsg("t2", "read", "c2")])[0],
	];
	const grouped = groupWebTimelineMessages(ui);
	assert.equal(grouped.length, 3, "来源为非助手角色的空消息必须阻断分组");
	assert.equal(grouped[0].kind, "message");
	assert.equal(grouped[0].message.id, "t1");
	assert.equal(grouped[1].kind, "message");
	assert.equal(grouped[1].message.id, "p1");
	// 该中间消息确实为 assistant role + chatRole=user（即走到来源校验分支）
	assert.equal(grouped[1].message.role, "assistant");
	assert.equal(grouped[1].message.metadata.chatRole, "user");
	assert.equal(grouped[2].kind, "message");
	assert.equal(grouped[2].message.id, "t2");
});

// ── 占位消息后续更新：纯函数重算必须恢复边界 ──

test("placeholder later gaining visible text re-splits the group", () => {
	const before = groupViaRealChain([
		toolMsg("t1", "powershell", "c1"),
		chatMsg({ id: "p1", role: "assistant", text: "" }),
		toolMsg("t2", "read", "c2"),
	]);
	assert.equal(before.length, 1, "占位为空时合并");

	const after = groupViaRealChain([
		toolMsg("t1", "powershell", "c1"),
		chatMsg({ id: "p1", role: "assistant", text: "继续检查" }),
		toolMsg("t2", "read", "c2"),
	]);
	assert.equal(after.length, 3, "占位出现正文后必须重新拆开");
	assert.equal(after[0].kind, "message");
	assert.equal(after[1].kind, "message");
	assert.equal(after[1].message.id, "p1");
	assert.equal(after[1].message.parts[0].text, "继续检查");
	assert.equal(after[2].kind, "message");
});

test("placeholder later gaining reasoning re-splits the group", () => {
	// 第一份：更新前为空占位 → 两个工具合并
	const before = groupViaRealChain([
		toolMsg("t1", "powershell", "c1"),
		chatMsg({ id: "p1", role: "assistant", text: "" }),
		toolMsg("t2", "read", "c2"),
	]);
	assert.equal(before.length, 1, "占位为空时合并");
	assert.equal(before[0].kind, "tool-message-group");
	sameAs(before[0].parts.map((p) => p.toolCallId), ["c1", "c2"]);
	sameAs(before[0].messages.map((m) => m.id), ["t1", "t2"], "空占位未进入工具组消息列表");

	// 第二份：身份不变（p1），占位获得思考 → 必须重新拆开
	const after = groupViaRealChain([
		toolMsg("t1", "powershell", "c1"),
		chatMsg({ id: "p1", role: "assistant", thinking: "需要再看一眼" }),
		toolMsg("t2", "read", "c2"),
	]);
	assert.equal(after.length, 3, "占位出现思考后必须重新拆开");
	assert.equal(after[0].kind, "message");
	assert.equal(after[0].message.id, "t1");
	assert.equal(after[1].kind, "message");
	assert.equal(after[1].message.id, "p1");
	assert.equal(after[1].message.parts[0].type, "reasoning");
	assert.equal(after[1].message.parts[0].text, "需要再看一眼", "思考文本保留");
	assert.equal(after[2].kind, "message");
	assert.equal(after[2].message.id, "t2");
});

// ── 输入不可变性：分组是展示投影，不得删改底层消息 ──

test("groupWebTimelineMessages does not mutate the input array", () => {
	const powershellArgs = { command: "Get-ChildItem", flags: ["-Force", "-Recurse"] };
	const readArgs = { path: "fixture.txt", range: { offset: 1, limit: 20 } };
	const powershellResult = { lines: ["a", "b"], truncated: false };
	const chat = [
		toolMsg("t1", "powershell", "c1", {
			meta: {
				toolName: "powershell",
				toolCallId: "c1",
				status: "done",
				result: powershellResult,
				args: powershellArgs,
			},
		}),
		chatMsg({ id: "p1", role: "assistant", text: "" }),
		toolMsg("t2", "read", "c2", {
			meta: {
				toolName: "read",
				toolCallId: "c2",
				status: "done",
				result: "out-t2",
				args: readArgs,
			},
		}),
	];
	const ui = chatMessagesToUiMessages(chat);

	// 分组前保存三类证据：完整快照、消息引用、parts/part 引用
	const inputBefore = JSON.stringify(ui);
	const messageRefs = Array.from(ui);
	const partsArrayRefs = Array.from(ui, (message) => message.parts);
	const partRefs = Array.from(ui, (message) => Array.from(message.parts));
	const idsBefore = ui.map((m) => m.id);

	const grouped = groupWebTimelineMessages(ui);
	assert.equal(grouped.length, 1);

	// A. 完整内容未被改写
	assert.equal(JSON.stringify(ui), inputBefore, "分组不得改变输入内容");
	// B. 原数组长度与逐条消息引用保持不变
	assert.equal(ui.length, messageRefs.length);
	sameAs(ui.map((m) => m.id), idsBefore);
	for (let index = 0; index < messageRefs.length; index += 1) {
		assert.strictEqual(ui[index], messageRefs[index], `消息 ${index} 引用被替换`);
	}
	// C. 逐条 parts 数组引用与 part 对象引用保持不变
	for (let index = 0; index < partsArrayRefs.length; index += 1) {
		assert.strictEqual(ui[index].parts, partsArrayRefs[index], `消息 ${index} 的 parts 数组引用被替换`);
		const refs = partRefs[index];
		assert.equal(ui[index].parts.length, refs.length);
		for (let partIndex = 0; partIndex < refs.length; partIndex += 1) {
			assert.strictEqual(
				ui[index].parts[partIndex],
				refs[partIndex],
				`消息 ${index} 的 part ${partIndex} 引用被替换`,
			);
		}
	}
	// D. 空助手占位仍在原数组中
	assert.equal(ui[1].id, "p1", "空占位仍在原数组中");
	assert.equal(ui[1].parts.length, 0);
	// E. 工具组输出仅含两条真实工具消息，且引用对应原消息
	assert.equal(grouped[0].messages.length, 2);
	assert.strictEqual(grouped[0].messages[0], ui[0]);
	assert.strictEqual(grouped[0].messages[1], ui[2]);
	// F. 工具参数/输出未被改写
	const toolParts = grouped[0].parts;
	sameAs(toolParts[0].input, powershellArgs);
	sameAs(toolParts[1].input, readArgs);
	sameAs(toolParts[0].output, powershellResult);
	assert.strictEqual(toolParts[0].input, ui[0].parts[0].input, "工具 1 参数引用被替换");
	assert.strictEqual(toolParts[1].input, ui[2].parts[0].input, "工具 2 参数引用被替换");
});
