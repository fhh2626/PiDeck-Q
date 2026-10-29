import assert from "node:assert/strict";
import test from "node:test";
import {
	findNearestVerticalScrollableAncestor,
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
