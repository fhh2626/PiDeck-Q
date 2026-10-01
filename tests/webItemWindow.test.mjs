/**
 * Web 时间线显示窗口单测（2026-12 用户要求：至少显示最近 100 个显示单元）。
 *
 * 显示单元的口径与 webToolGroups.groupWebTimelineMessages 同源：
 * - 每条用户消息 = 1；
 * - 连续纯工具消息合成 1 组 = 1；
 * - 其他每条助手侧消息（正文、思考、系统/摘要卡）= 1；
 * - 透明占位不计。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const {
	selectWebItemWindow,
	countWebDisplayItems,
	WEB_TIMELINE_MIN_DISPLAY_ITEMS,
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

function userMessage(id) {
	return uiMessage({
		id,
		role: "user",
		parts: [{ type: "text", text: id }],
		metadata: { chatRole: "user", entryId: id },
	});
}

function assistantText(id) {
	return uiMessage({
		id,
		role: "assistant",
		parts: [{ type: "text", text: id }],
		metadata: { chatRole: "assistant", entryId: id },
	});
}

function toolMessage(id) {
	return uiMessage({
		id,
		role: "assistant",
		parts: [{
			type: "dynamic-tool",
			toolName: "read",
			toolCallId: `call-${id}`,
			state: "output-available",
			input: {},
			output: "ok",
		}],
		metadata: { chatRole: "tool", toolCallId: `call-${id}` },
	});
}

test("web item window targets at least 100 display items (2026-12)", () => {
	assert.equal(WEB_TIMELINE_MIN_DISPLAY_ITEMS, 100);
});

test("web item window keeps the last 50 two-item turns as exactly 100 items", () => {
	// 60 轮、每轮「user + 1 条正文」= 每轮 2 单元：窗口应从倒数第 50 轮的用户消息开始。
	const messages = [];
	for (let index = 1; index <= 60; index += 1) {
		messages.push(userMessage(`u${index}`), assistantText(`a${index}`));
	}
	assert.equal(countWebDisplayItems(messages), 120);

	const window = selectWebItemWindow(messages, WEB_TIMELINE_MIN_DISPLAY_ITEMS);
	assert.equal(window.hasHiddenMessages, true);
	assert.equal(window.visibleMessages[0].id, "u11", "倒数第 50 轮的用户消息");
	assert.equal(window.visibleMessages[window.visibleMessages.length - 1].id, "a60");
	assert.equal(countWebDisplayItems(window.visibleMessages), 100);
});

test("web item window shows everything when the session is under 100 items", () => {
	// 10 轮、每轮「user + 20 条连续纯工具消息 + 1 条正文」= 每轮 3 单元，共 30。
	const messages = [];
	for (let index = 1; index <= 10; index += 1) {
		messages.push(userMessage(`u${index}`));
		for (let tool = 0; tool < 20; tool += 1) messages.push(toolMessage(`t${index}-${tool}`));
		messages.push(assistantText(`a${index}`));
	}
	assert.equal(countWebDisplayItems(messages), 30, "连续工具消息只算 1 个显示单元");

	const window = selectWebItemWindow(messages, WEB_TIMELINE_MIN_DISPLAY_ITEMS);
	assert.equal(window.hasHiddenMessages, false);
	assert.equal(window.hiddenTurnCount, 0);
	assert.equal(window.visibleMessages, messages, "未裁剪时必须返回原数组引用（memo 友好）");
});

test("web item window rounds up to whole turns of six items", () => {
	// 30 轮、每轮「user + 5 条正文」= 每轮 6 单元：17 轮 = 102 ≥ 100，16 轮 = 96 < 100。
	const messages = [];
	for (let index = 1; index <= 30; index += 1) {
		messages.push(userMessage(`u${index}`));
		for (let text = 0; text < 5; text += 1) messages.push(assistantText(`a${index}-${text}`));
	}
	assert.equal(countWebDisplayItems(messages), 180);

	const window = selectWebItemWindow(messages, WEB_TIMELINE_MIN_DISPLAY_ITEMS);
	assert.equal(window.visibleMessages[0].id, "u14", "显示最后 17 轮（17×6 = 102）");
	assert.equal(countWebDisplayItems(window.visibleMessages), 102);
	assert.equal(window.hiddenTurnCount, 13);
});

test("web item window always starts on a user message and never splits a turn", () => {
	const messages = [];
	for (let index = 1; index <= 30; index += 1) {
		messages.push(userMessage(`u${index}`));
		for (let text = 0; text < 5; text += 1) messages.push(assistantText(`a${index}-${text}`));
	}
	const window = selectWebItemWindow(messages, WEB_TIMELINE_MIN_DISPLAY_ITEMS);
	assert.equal(window.visibleMessages[0].role, "user", "窗口起点必须是用户消息");
	// 被隐藏的轮次都是完整的：可见尾部与它的 user 起点之间没有缺口
	assert.equal(window.visibleMessages[0].id, `u${window.hiddenTurnCount + 1}`);
});
