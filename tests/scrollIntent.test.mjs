import assert from "node:assert/strict";
import test from "node:test";
import {
	findNearestVerticalScrollableAncestor,
	isContentShrinkClamp,
	isEditableOrInteractiveTarget,
	isTimelineUpwardKeyIntent,
} from "../src/renderer/src/lib/stick-to-bottom/scrollIntent.ts";

test("findNearestVerticalScrollableAncestor detects nested scrollable element by overflowY and scrollHeight", () => {
	// 模拟 DOM 节点
	const boundary = { parentElement: null };
	const nestedScroll = {
		nodeType: 1, // Node.ELEMENT_NODE
		parentElement: boundary,
		scrollHeight: 500,
		clientHeight: 200,
	};
	const childTarget = {
		nodeType: 1,
		parentElement: nestedScroll,
	};

	globalThis.Node = { ELEMENT_NODE: 1 };
	globalThis.window = {
		getComputedStyle: (el) => {
			if (el === nestedScroll) return { overflowY: "auto" };
			return { overflowY: "visible" };
		},
	};

	const found = findNearestVerticalScrollableAncestor(childTarget, boundary);
	assert.equal(found, nestedScroll);

	// 若未超过 clientHeight，不判定为可滚动
	nestedScroll.scrollHeight = 200;
	const notFound = findNearestVerticalScrollableAncestor(childTarget, boundary);
	assert.equal(notFound, null);
});

test("isEditableOrInteractiveTarget detects inputs, textareas, and contenteditable elements", () => {
	const plainDiv = {
		isContentEditable: false,
		tagName: "DIV",
		closest: () => null,
	};
	assert.equal(isEditableOrInteractiveTarget(plainDiv), false);

	const inputEl = {
		isContentEditable: false,
		tagName: "INPUT",
		closest: () => null,
	};
	assert.equal(isEditableOrInteractiveTarget(inputEl), true);

	const proseMirrorChild = {
		isContentEditable: false,
		tagName: "SPAN",
		closest: (sel) => (sel.includes("ProseMirror") ? {} : null),
	};
	assert.equal(isEditableOrInteractiveTarget(proseMirrorChild), true);
});

test("isTimelineUpwardKeyIntent identifies upward keys and ignores modifier or interactive targets", () => {
	const plainTarget = {
		isContentEditable: false,
		tagName: "DIV",
		closest: () => null,
	};

	// 明确的 PageUp / ArrowUp
	assert.equal(
		isTimelineUpwardKeyIntent({
			key: "PageUp",
			target: plainTarget,
			ctrlKey: false,
			altKey: false,
			metaKey: false,
			shiftKey: false,
			defaultPrevented: false,
		}),
		true,
	);

	assert.equal(
		isTimelineUpwardKeyIntent({
			key: "ArrowUp",
			target: plainTarget,
			ctrlKey: false,
			altKey: false,
			metaKey: false,
			shiftKey: false,
			defaultPrevented: false,
		}),
		true,
	);

	// 带 Ctrl / Meta 则忽略（如 Ctrl+ArrowUp）
	assert.equal(
		isTimelineUpwardKeyIntent({
			key: "ArrowUp",
			target: plainTarget,
			ctrlKey: true,
			altKey: false,
			metaKey: false,
			shiftKey: false,
			defaultPrevented: false,
		}),
		false,
	);

	// 目标在输入框内忽略
	const inputTarget = {
		isContentEditable: false,
		tagName: "TEXTAREA",
		closest: () => null,
	};
	assert.equal(
		isTimelineUpwardKeyIntent({
			key: "PageUp",
			target: inputTarget,
			ctrlKey: false,
			altKey: false,
			metaKey: false,
			shiftKey: false,
			defaultPrevented: false,
		}),
		false,
	);
});

test("isContentShrinkClamp tolerates subpixel bottom clamping but not real upward scrolling", () => {
	assert.equal(
		isContentShrinkClamp({ scrollTop: 100, lastScrollTop: 102, maxScrollTop: 100.6, isFollowing: true }),
		true,
		"亚像素夹取不能被判成用户上滚",
	);
	assert.equal(
		isContentShrinkClamp({ scrollTop: 100, lastScrollTop: 102, maxScrollTop: 100.6, isFollowing: false }),
		false,
	);
	assert.equal(
		isContentShrinkClamp({ scrollTop: 100, lastScrollTop: 102, maxScrollTop: 96, isFollowing: true }),
		false,
		"离底部超过容差必须视为真实上滚",
	);
	assert.equal(
		isContentShrinkClamp({ scrollTop: 103, lastScrollTop: 102, maxScrollTop: 103, isFollowing: true }),
		false,
	);
});

test("isContentShrinkClamp does not swallow a real 1-2px upward scroll at the bottom", () => {
	assert.equal(
		isContentShrinkClamp({
			scrollTop: 998,
			lastScrollTop: 1_000,
			maxScrollTop: 1_000,
			isFollowing: true,
		}),
		false,
		"内容高度未缩短时，轻微上滚仍是用户意图，不能按 clamp 忽略",
	);
});

test("isContentShrinkClamp accepts a proven content shrink with a subpixel bottom gap", () => {
	assert.equal(
		isContentShrinkClamp({
			scrollTop: 998.5,
			lastScrollTop: 999,
			maxScrollTop: 998.5,
			previousMaxScrollTop: 1_000,
			isFollowing: true,
		}),
		true,
		"上一帧最大滚动距离缩短时，即使贴底有亚像素差也应维持锁底",
	);
	assert.equal(
		isContentShrinkClamp({
			scrollTop: 998.5,
			lastScrollTop: 999,
			maxScrollTop: 998.5,
			previousMaxScrollTop: 998.5,
			isFollowing: true,
		}),
		false,
		"最大滚动距离未缩短就不能按 clamp 吞掉上滚",
	);
});
