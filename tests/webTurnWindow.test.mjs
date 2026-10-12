/**
 * Web 时间线「最近 N 轮对话」显示窗口单测（2026-12 统一 50 轮）。
 *
 * 一轮 = 一条用户消息及其后的全部内容（助手正文/思考/工具/系统卡片），
 * 直到下一条用户消息。工具调用、工具组、正文与思考都不额外占轮数。
 * 窗口只做展示切片：不得修改、去重或删除底层消息。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const {
	selectWebTurnWindow,
	countWebTurns,
	WEB_TIMELINE_TURN_LIMIT,
	WEB_TIMELINE_TURN_EXPAND_STEP,
} = loadTsCommonJs("src/renderer/src/web/webTurnWindow.ts");

/** 与 chatMessagesToUiMessages 同形状的最小 UIMessage 工厂。 */
function uiMessage(overrides = {}) {
	return {
		id: overrides.id ?? "m1",
		role: overrides.role ?? "assistant",
		parts: overrides.parts ?? [{ type: "text", text: overrides.text ?? "body" }],
		...(overrides.metadata ? { metadata: overrides.metadata } : {}),
	};
}

/** 一条 user 消息 + 其后的一个助手回复 = 一轮。 */
function turn(index, options = {}) {
	const items = [
		uiMessage({
			id: `u${index}`,
			role: "user",
			metadata: { chatRole: "user", entryId: `u${index}`, timestamp: index * 10 },
		}),
	];
	if (options.unanswered) return items;
	items.push(
		uiMessage({
			id: `a${index}`,
			role: "assistant",
			metadata: { chatRole: "assistant", entryId: `a${index}`, timestamp: index * 10 + 1 },
		}),
	);
	for (let tool = 0; tool < (options.tools ?? 0); tool += 1) {
		items.push(
			uiMessage({
				id: `t${index}-${tool}`,
				role: "assistant",
				parts: [{
					type: "dynamic-tool",
					toolName: "read",
					toolCallId: `call-${index}-${tool}`,
					state: "output-available",
					input: {},
					output: "ok",
				}],
				metadata: { chatRole: "tool", toolCallId: `call-${index}-${tool}`, timestamp: index * 10 + 2 },
			}),
		);
	}
	return items;
}

function conversation(turnCount, options = {}) {
	const items = [];
	for (let index = 1; index <= turnCount; index += 1) {
		const turnOptions = { ...options };
		if (options.lastUnanswered && index === turnCount) turnOptions.unanswered = true;
		items.push(...turn(index, turnOptions));
	}
	return items;
}

test("web turn window defaults to the last 50 turns (2026-12)", () => {
	assert.equal(WEB_TIMELINE_TURN_LIMIT, 50, "贴底/上滚基础窗口 = 50 轮");
	assert.equal(WEB_TIMELINE_TURN_EXPAND_STEP, 10, "展开步长保持 10 轮");
});

test("web turn window keeps every turn when under the limit", () => {
	const messages = conversation(49);
	const window = selectWebTurnWindow(messages, WEB_TIMELINE_TURN_LIMIT);
	assert.equal(window.hasHiddenMessages, false);
	assert.equal(window.hiddenTurnCount, 0);
	assert.equal(window.visibleMessages, messages, "未裁剪时必须返回原数组引用（memo 友好）");
	assert.equal(countWebTurns(messages), 49);
});

test("web turn window keeps exactly 50 turns without trimming", () => {
	const messages = conversation(50);
	const window = selectWebTurnWindow(messages, WEB_TIMELINE_TURN_LIMIT);
	assert.equal(window.visibleMessages, messages);
	assert.equal(window.hiddenTurnCount, 0);
});

test("web turn window hides only the oldest turn once the 51st appears", () => {
	const messages = conversation(51);
	const window = selectWebTurnWindow(messages, WEB_TIMELINE_TURN_LIMIT);
	assert.equal(window.hiddenTurnCount, 1);
	assert.equal(window.hasHiddenMessages, true);
	// 第 1 轮整体隐藏，第 2..51 轮完整保留（不从轮中间切开）
	assert.equal(window.visibleMessages[0].id, "u2");
	assert.equal(window.visibleMessages[window.visibleMessages.length - 1].id, "a51");
	assert.equal(countWebTurns(window.visibleMessages), 50);
});

test("web turn window counts an unanswered trailing user message as a turn", () => {
	// 50 个完整轮次 + 第 51 轮用户提问（尚未回复）：窗口 = 第 2..50 轮 + 新提问
	const messages = conversation(51, { lastUnanswered: true });
	const window = selectWebTurnWindow(messages, WEB_TIMELINE_TURN_LIMIT);
	assert.equal(window.hiddenTurnCount, 1);
	assert.equal(window.visibleMessages[0].id, "u2");
	assert.equal(
		window.visibleMessages[window.visibleMessages.length - 1].id,
		"u51",
		"未回复的提问属于新一轮，必须保留在窗口内",
	);
	assert.equal(countWebTurns(window.visibleMessages), 50);
});

test("web turn window counts dense tool traffic inside one turn as one turn", () => {
	// 单轮 150 个工具消息：不额外占轮数，工具组展开/折叠不影响窗口边界
	const messages = [
		...conversation(49),
		...turn(50, { tools: 150 }),
	];
	const window = selectWebTurnWindow(messages, WEB_TIMELINE_TURN_LIMIT);
	assert.equal(window.visibleMessages, messages);
	assert.equal(window.hiddenTurnCount, 0);
	assert.equal(countWebTurns(messages), 50);
});

test("web turn window counts consecutive user messages as separate turns", () => {
	const messages = [
		uiMessage({ id: "u1", role: "user", metadata: { chatRole: "user", timestamp: 1 } }),
		uiMessage({ id: "u2", role: "user", metadata: { chatRole: "user", timestamp: 2 } }),
		uiMessage({ id: "u3", role: "user", metadata: { chatRole: "user", timestamp: 3 } }),
	];
	assert.equal(countWebTurns(messages), 3);
	const window = selectWebTurnWindow(messages, 2);
	assert.equal(window.hiddenTurnCount, 1);
	assert.deepEqual(Array.from(window.visibleMessages, (m) => m.id), ["u2", "u3"]);
});

test("web turn window does not count system, compaction or tool messages as turns", () => {
	const messages = [
		uiMessage({ id: "sys", role: "assistant", metadata: { chatRole: "system", timestamp: 0 } }),
		uiMessage({ id: "summary", role: "assistant", metadata: { chatRole: "system", timestamp: 0 } }),
		...turn(1, { tools: 3 }),
	];
	assert.equal(countWebTurns(messages), 1);
	const window = selectWebTurnWindow(messages, 1);
	assert.equal(window.hiddenTurnCount, 0);
	assert.equal(window.visibleMessages, messages);
});

test("web turn window keeps reasoning and empty placeholders inside the owning turn", () => {
	const messages = [
		...conversation(50),
		// 第 51 轮：思考 → 空助手占位 → 工具 → 正文
		uiMessage({
			id: "u51",
			role: "user",
			metadata: { chatRole: "user", timestamp: 510 },
		}),
		uiMessage({
			id: "think51",
			role: "assistant",
			parts: [{ type: "reasoning", text: "thinking" }],
			metadata: { chatRole: "assistant", timestamp: 511 },
		}),
		uiMessage({
			id: "placeholder51",
			role: "assistant",
			parts: [],
			metadata: { chatRole: "assistant", timestamp: 512 },
		}),
		uiMessage({
			id: "t51",
			role: "assistant",
			parts: [{
				type: "dynamic-tool",
				toolName: "read",
				toolCallId: "call-51",
				state: "output-available",
				input: {},
				output: "ok",
			}],
			metadata: { chatRole: "tool", timestamp: 513 },
		}),
		uiMessage({ id: "a51", role: "assistant", metadata: { chatRole: "assistant", timestamp: 514 } }),
	];
	const window = selectWebTurnWindow(messages, WEB_TIMELINE_TURN_LIMIT);
	assert.equal(window.hiddenTurnCount, 1);
	assert.equal(window.visibleMessages[0].id, "u2");
	assert.equal(window.visibleMessages[1].id, "a2", "第 2 轮起点不能被工具/思考通信打乱");
	assert.equal(window.visibleMessages[window.visibleMessages.length - 1].id, "a51");
});

test("web turn window falls back to the UI role for local optimistic user messages", () => {
	// 本地乐观用户消息还没有 metadata（chatRole 缺失），必须按 UIMessage.role 识别
	const messages = [
		uiMessage({ id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] }),
		uiMessage({ id: "a1", role: "assistant", parts: [{ type: "text", text: "yo" }] }),
		uiMessage({ id: "u2", role: "user", parts: [{ type: "text", text: "again" }] }),
	];
	assert.equal(countWebTurns(messages), 2);
	const window = selectWebTurnWindow(messages, 1);
	assert.deepEqual(Array.from(window.visibleMessages, (m) => m.id), ["u2"]);
});

test("web turn window keeps history without any user turn instead of slicing arbitrarily", () => {
	const messages = [
		uiMessage({ id: "sys", role: "assistant", metadata: { chatRole: "system", timestamp: 1 } }),
		uiMessage({ id: "a1", role: "assistant", metadata: { chatRole: "assistant", timestamp: 2 } }),
	];
	assert.equal(countWebTurns(messages), 0);
	const window = selectWebTurnWindow(messages, 50);
	assert.equal(window.hiddenTurnCount, 0);
	assert.equal(window.hasHiddenMessages, false);
	assert.equal(window.visibleMessages, messages);
});

test("web turn window does not mutate or deduplicate the input", () => {
	const messages = [
		...conversation(51),
		// 两条文本完全相同的用户提问是两轮，不得被合并
		uiMessage({ id: "u52", role: "user", parts: [{ type: "text", text: "same" }] }),
		uiMessage({ id: "u53", role: "user", parts: [{ type: "text", text: "same" }] }),
	];
	const snapshot = messages.map((message) => message.id);
	const window = selectWebTurnWindow(messages, WEB_TIMELINE_TURN_LIMIT);
	assert.deepEqual(Array.from(messages, (m) => m.id), snapshot, "输入数组不得被修改");
	assert.equal(window.hiddenTurnCount, 3);
	assert.equal(countWebTurns(window.visibleMessages), 50);
});

test("web turn window reports the expand step so revealing cached history stays bounded", () => {
	const messages = conversation(120);
	const window = selectWebTurnWindow(messages, WEB_TIMELINE_TURN_LIMIT + WEB_TIMELINE_TURN_EXPAND_STEP);
	assert.equal(window.hiddenTurnCount, 60);
	assert.equal(countWebTurns(window.visibleMessages), 60);
});
