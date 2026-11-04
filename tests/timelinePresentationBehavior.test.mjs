import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "jotai";
import {
	getRunExecutionAtom,
	getToolGroupAtom,
	getThinkingPresentationAtom,
	getUserBubblePresentationAtom,
	getEditPresentationAtom,
	removeSessionPresentationState,
} from "../src/renderer/src/atoms/timeline-presentation.ts";

test("步骤5展示状态生命周期测试: 写入多个 presentation family 后，清理指定会话必须完整释放 atomFamily", () => {
	const store = createStore();
	const sessA = "sess-lifecycle-A";
	const sessB = "sess-lifecycle-B";

	// 1. 写入 A 的各项展示状态
	const execAtomA = getRunExecutionAtom(sessA, "row-1");
	store.set(execAtomA, {
		stepsVisible: true,
		userOverride: true,
		wasRunning: false,
		lastCollapseTick: 0,
		initialized: true,
	});

	const toolAtomA = getToolGroupAtom(sessA, "row-1", "tg-1");
	store.set(toolAtomA, {
		expanded: true,
		pageIndex: 2,
		anchorMessageId: "tool-msg-99",
	});

	const thinkAtomA = getThinkingPresentationAtom(sessA, "row-1", "think-1");
	store.set(thinkAtomA, { expanded: true, hasHandledEnd: true });

	const bubbleAtomA = getUserBubblePresentationAtom(sessA, "row-user");
	store.set(bubbleAtomA, { messageExpanded: true, visionDetailOpen: true });

	// 2. 写入 B 的状态
	const execAtomB = getRunExecutionAtom(sessB, "row-1");
	store.set(execAtomB, {
		stepsVisible: true,
		userOverride: true,
		wasRunning: false,
		lastCollapseTick: 0,
		initialized: true,
	});

	// 断言写入生效
	assert.equal(store.get(execAtomA).stepsVisible, true);
	assert.equal(store.get(toolAtomA).pageIndex, 2);
	assert.equal(store.get(thinkAtomA).expanded, true);
	assert.equal(store.get(bubbleAtomA).messageExpanded, true);

	// 3. 执行 A 的清理
	removeSessionPresentationState(sessA);

	// 4. 再次获取 A 的 atom，必须是全新默认值实例！
	const newExecAtomA = getRunExecutionAtom(sessA, "row-1");
	assert.equal(store.get(newExecAtomA).stepsVisible, false, "清理后获取必须重置为初始默认值 false！");
	assert.equal(store.get(newExecAtomA).initialized, false);

	const newToolAtomA = getToolGroupAtom(sessA, "row-1", "tg-1");
	assert.equal(store.get(newToolAtomA).pageIndex, 0);

	const newThinkAtomA = getThinkingPresentationAtom(sessA, "row-1", "think-1");
	assert.equal(store.get(newThinkAtomA).expanded, false);

	// 5. 校验 B 的状态不受影响
	assert.equal(store.get(execAtomB).stepsVisible, true, "清理会话 A 绝不得影响会话 B！");
});
