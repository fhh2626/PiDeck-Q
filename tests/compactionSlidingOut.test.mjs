import assert from "node:assert/strict";
import test from "node:test";
import { createStore } from "jotai";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

function loadAtoms() {
	return loadTsCommonJs("src/renderer/src/atoms/session-atoms.ts");
}

test("方案 B 回归：[old1, old2, old3] -> compaction -> [summary, new1] 保持 sliding-out 并能平滑清理", () => {
	const atoms = loadAtoms();
	const store = createStore();
	const emit = (payload) =>
		store.set(atoms.applySessionRuntimeEventAtom, {
			sessionId: "session-1",
			agentId: "agent-1",
			runtimeGeneration: 1,
			sourceChannel: "agents:message",
			payload,
		});
	const entry = () => store.get(atoms.sessionMessagesCacheAtom)["session-1"];

	// 1. 初始状态：展示 3 条旧消息
	emit({
		agentId: "agent-1",
		messages: [
			{ id: "old1", role: "user", text: "question 1", timestamp: 1000 },
			{ id: "old2", role: "assistant", text: "answer 1", timestamp: 2000 },
			{ id: "old3", role: "user", text: "question 2", timestamp: 3000 },
		],
	});

	assert.equal(entry().messages.length, 3);
	assert.deepEqual(
		entry().messages.map((m) => m.id),
		["old1", "old2", "old3"],
	);

	// 2. 发生 compaction：主进程只发送 canonical messages [summary, new1]（不带 slideOut 副本）
	emit({
		agentId: "agent-1",
		fileVersion: "200:5000",
		preserveHistory: true,
		stickyHistory: true,
		messages: [
			{ id: "summary", role: "system", text: "已压缩", timestamp: 4000, meta: { type: "compaction" } },
			{ id: "new1", role: "assistant", text: "retained answer", timestamp: 3500 },
		],
	});

	// 验证：renderer 短时间内显示 old1/old2/old3(sliding-out) + summary/new1，且按原有顺序组织
	const currentMsgs = entry().messages;
	assert.equal(currentMsgs.length, 5);
	assert.deepEqual(
		[...currentMsgs.map((m) => m.id)],
		["old1", "old2", "old3", "summary", "new1"],
	);
	assert.equal(currentMsgs[0].meta?.slidingOut, true);
	assert.equal(currentMsgs[1].meta?.slidingOut, true);
	assert.equal(currentMsgs[2].meta?.slidingOut, true);
	assert.equal(currentMsgs[3].meta?.slidingOut, undefined);
	assert.equal(currentMsgs[4].meta?.slidingOut, undefined);

	// 3. 动画未结束时，立刻收到第二次 full snapshot [summary, new1, new2]
	emit({
		agentId: "agent-1",
		fileVersion: "200:5000",
		messages: [
			{ id: "summary", role: "system", text: "已压缩", timestamp: 4000, meta: { type: "compaction" } },
			{ id: "new1", role: "assistant", text: "retained answer", timestamp: 3500 },
			{ id: "new2", role: "user", text: "new question", timestamp: 5000 },
		],
	});

	// 验证：第二次 snapshot 必须继续保留已有的 sliding-out 消息，不能直接清掉
	const secondMsgs = entry().messages;
	assert.equal(secondMsgs.length, 6);
	assert.deepEqual(
		[...secondMsgs.map((m) => m.id)],
		["old1", "old2", "old3", "summary", "new1", "new2"],
	);
	assert.equal(secondMsgs[0].meta?.slidingOut, true);
	assert.equal(secondMsgs[1].meta?.slidingOut, true);
	assert.equal(secondMsgs[2].meta?.slidingOut, true);
	assert.equal(secondMsgs[3].meta?.slidingOut, undefined);
	assert.equal(secondMsgs[4].meta?.slidingOut, undefined);
	assert.equal(secondMsgs[5].meta?.slidingOut, undefined);

	// 4. 动画结束后，renderer 自己根据 message ID 删除旧消息
	const cleaned = store.set(atoms.removeSessionSlidingOutMessagesAtom, {
		sessionId: "session-1",
		messageIds: ["old1", "old2", "old3"],
	});
	assert.equal(cleaned, true);

	// 验证：仅 sliding-out 消息被删除，canonical 消息完好保留
	const finalMsgs = entry().messages;
	assert.equal(finalMsgs.length, 3);
	assert.deepEqual(
		[...finalMsgs.map((m) => m.id)],
		["summary", "new1", "new2"],
	);
});

test("方案 B 回归：compact 后立即收到新 assistant 消息，旧消息不会瞬间消失", () => {
	const atoms = loadAtoms();
	const store = createStore();
	const emit = (payload) =>
		store.set(atoms.applySessionRuntimeEventAtom, {
			sessionId: "session-1",
			agentId: "agent-1",
			runtimeGeneration: 1,
			sourceChannel: "agents:message",
			payload,
		});
	const entry = () => store.get(atoms.sessionMessagesCacheAtom)["session-1"];

	emit({
		agentId: "agent-1",
		messages: [
			{ id: "old1", role: "user", text: "q1", timestamp: 1000 },
			{ id: "old2", role: "assistant", text: "a1", timestamp: 2000 },
		],
	});

	// compaction snapshot
	emit({
		agentId: "agent-1",
		fileVersion: "2:2",
		preserveHistory: true,
		stickyHistory: true,
		messages: [
			{ id: "summary", role: "system", text: "compacted", timestamp: 3000, meta: { type: "compaction" } },
		],
	});

	assert.deepEqual(
		[...entry().messages.map((m) => m.id)],
		["old1", "old2", "summary"],
	);
	assert.equal(entry().messages[0].meta?.slidingOut, true);
	assert.equal(entry().messages[1].meta?.slidingOut, true);

	// 紧接着新 assistant 消息到来（full flush）
	emit({
		agentId: "agent-1",
		fileVersion: "2:2",
		messages: [
			{ id: "summary", role: "system", text: "compacted", timestamp: 3000, meta: { type: "compaction" } },
			{ id: "new-user", role: "user", text: "next question", timestamp: 4000 },
			{ id: "new-assistant", role: "assistant", text: "streaming answer", timestamp: 4050 },
		],
	});

	// 旧消息依然稳稳保留在 state 中进行退出动画
	assert.deepEqual(
		[...entry().messages.map((m) => m.id)],
		["old1", "old2", "summary", "new-user", "new-assistant"],
	);
	assert.equal(entry().messages[0].meta?.slidingOut, true);
	assert.equal(entry().messages[1].meta?.slidingOut, true);
});

test("方案 B 回归：如果 message ID 重新出现在 canonical 中，应取消 sliding-out 状态避免双份", () => {
	const atoms = loadAtoms();
	const store = createStore();
	const emit = (payload) =>
		store.set(atoms.applySessionRuntimeEventAtom, {
			sessionId: "session-1",
			agentId: "agent-1",
			runtimeGeneration: 1,
			sourceChannel: "agents:message",
			payload,
		});
	const entry = () => store.get(atoms.sessionMessagesCacheAtom)["session-1"];

	emit({
		agentId: "agent-1",
		messages: [
			{ id: "m1", role: "user", text: "q1", timestamp: 1000 },
			{ id: "m2", role: "assistant", text: "a1", timestamp: 2000 },
		],
	});

	// snapshot 1: m2 disappeared
	emit({
		agentId: "agent-1",
		messages: [
			{ id: "m1", role: "user", text: "q1", timestamp: 1000 },
		],
	});
	assert.equal(entry().messages.find((m) => m.id === "m2")?.meta?.slidingOut, true);

	// snapshot 2: m2 reappears in canonical
	emit({
		agentId: "agent-1",
		messages: [
			{ id: "m1", role: "user", text: "q1", timestamp: 1000 },
			{ id: "m2", role: "assistant", text: "a1 updated", timestamp: 2000 },
		],
	});

	const m2 = entry().messages.find((m) => m.id === "m2");
	assert.ok(m2);
	assert.equal(m2.text, "a1 updated");
	assert.equal(m2.meta?.slidingOut, undefined, "slidingOut flag must be cleared");
	assert.equal(entry().messages.length, 2, "must not produce duplicate m2 copies");
});

test("方案 B 回归：removeSlidingOutMessages 绝不能删除 canonical 消息", () => {
	const atoms = loadAtoms();
	const store = createStore();
	const emit = (payload) =>
		store.set(atoms.applySessionRuntimeEventAtom, {
			sessionId: "session-1",
			agentId: "agent-1",
			runtimeGeneration: 1,
			sourceChannel: "agents:message",
			payload,
		});
	const entry = () => store.get(atoms.sessionMessagesCacheAtom)["session-1"];

	emit({
		agentId: "agent-1",
		messages: [
			{ id: "canonical-1", role: "user", text: "keep me", timestamp: 1000 },
		],
	});

	// Attempt to delete canonical message by ID
	const changed = store.set(atoms.removeSessionSlidingOutMessagesAtom, {
		sessionId: "session-1",
		messageIds: ["canonical-1"],
	});
	assert.equal(changed, false);
	assert.equal(entry().messages.length, 1);
	assert.equal(entry().messages[0].id, "canonical-1");
});
