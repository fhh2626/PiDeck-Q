import assert from "node:assert/strict";
import test from "node:test";
import { resolveLiveInterimId } from "../src/renderer/src/components/session/timeline/liveMount.ts";

/**
 * Live 正文挂载判定测试。
 *
 * 核心规则：流式正文必须按 assistantMessageId 精确绑定消息，不能再通过“最后一个 agent-run”猜它属于哪一轮。
 * - assistant skeleton id === live stream messageId 才允许显示；
 * - live text 已到但对应 skeleton 还没进入 history 时，绝不挂到旧 run（宁可短暂等待 skeleton，也不挂到错误轮次）；
 * - skeleton 到达后，新 assistant 正确挂载 live text。
 */

const base = {
	sessionId: "s1",
	lastInterimId: "msg-1",
	streamingMessageId: "msg-1",
	liveTextActive: true,
	lastMessageText: "",
	agentRunning: false,
	isStreaming: false,
};

test("skeleton id === streamingMessageId + 空文本骨架 + 活动流 → 挂载 live", () => {
	assert.equal(resolveLiveInterimId(base), "msg-1");
});

test("skeleton id !== streamingMessageId → 不挂载（新一轮流式绝不挂到旧轮 assistant）", () => {
	assert.equal(
		resolveLiveInterimId({
			...base,
			lastInterimId: "msg-old",
			streamingMessageId: "msg-new",
		}),
		undefined,
	);
});

test("streamingMessageId 缺失或未就绪 → 不挂载", () => {
	assert.equal(
		resolveLiveInterimId({
			...base,
			streamingMessageId: undefined,
		}),
		undefined,
	);
});

test("skeleton id === streamingMessageId + 已落定正文 + 流式中 → 保持挂载", () => {
	assert.equal(
		resolveLiveInterimId({ ...base, lastMessageText: "已落定的正文", isStreaming: true }),
		"msg-1",
	);
});

test("skeleton id === streamingMessageId + 已落定正文 + 无流式 → 不挂载（settled，落回容器内渲染）", () => {
	assert.equal(
		resolveLiveInterimId({ ...base, lastMessageText: "已落定的正文" }),
		undefined,
	);
});

test("无活动流 → 不挂载", () => {
	assert.equal(resolveLiveInterimId({ ...base, liveTextActive: false }), undefined);
});

test("无会话 / 无挂载点 → 不挂载", () => {
	assert.equal(resolveLiveInterimId({ ...base, sessionId: undefined }), undefined);
	assert.equal(resolveLiveInterimId({ ...base, lastInterimId: undefined }), undefined);
});

test("核心回归：new user 已发送，新流式已到达但 new skeleton 尚未进入 history 时，新 live text 不能挂到 old assistant", () => {
	// 时序 1：新问题刚发送，history 仅有 [old assistant, new user]
	// streamingText 已经收到新 assistant 的流式正文 (messageId: "new-assistant-id")
	// 此时 old assistant run 计算 liveInterimId
	// （即使它仍是历史里的最后一个 agent-run，也绝不挂载——归属只由 id 精确匹配决定）
	const oldAssistantRunLiveId = resolveLiveInterimId({
		sessionId: "session-1",
		lastInterimId: "old-assistant-id",
		streamingMessageId: "new-assistant-id",
		liveTextActive: true,
		lastMessageText: "",
		isStreaming: true,
	});
	assert.equal(
		oldAssistantRunLiveId,
		undefined,
		"新 live text 绝不能挂到 old assistant",
	);

	// 时序 2：new assistant skeleton 到达前端消息列表
	// 新轮次计算 liveInterimId
	const newAssistantRunLiveId = resolveLiveInterimId({
		sessionId: "session-1",
		lastInterimId: "new-assistant-id",
		streamingMessageId: "new-assistant-id",
		liveTextActive: true,
		lastMessageText: "",
		isStreaming: true,
	});
	assert.equal(
		newAssistantRunLiveId,
		"new-assistant-id",
		"skeleton 到达后，新 assistant 正常挂载 live text",
	);
});
