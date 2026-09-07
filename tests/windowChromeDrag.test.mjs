import assert from "node:assert/strict";
import test from "node:test";

import {
	ancestorMatchesSelector,
	shouldBeginWindowDragFromAncestors,
} from "../src/renderer/src/utils/windowChromeDrag.ts";

test("simple selectors match class, tag, and role independently", () => {
	assert.equal(
		ancestorMatchesSelector({ className: "app-badge brand" }, ".app-badge"),
		true,
	);
	assert.equal(ancestorMatchesSelector({ tagName: "BUTTON" }, "button"), true);
	assert.equal(ancestorMatchesSelector({ role: "tab" }, "[role='tab']"), true);
	assert.equal(ancestorMatchesSelector({ className: "app-badge" }, ".window-controls"), false);
});

test("a nested logo node still starts a window drag", () => {
	assert.equal(
		shouldBeginWindowDragFromAncestors([
			{ tagName: "canvas" },
			{ tagName: "div", className: "app-badge" },
			{ tagName: "div", className: "list-toolbar" },
		]),
		true,
	);
	assert.equal(
		shouldBeginWindowDragFromAncestors([
			{ tagName: "div", className: "session-tabs-scroll" },
			{ tagName: "div", className: "session-tabs-bar" },
		]),
		true,
	);
});

test("window controls win over the overlapping drag layer", () => {
	assert.equal(
		shouldBeginWindowDragFromAncestors([
			{ tagName: "button", className: "window-control" },
			{ tagName: "div", className: "window-controls" },
			{ tagName: "div", className: "window-drag-layer" },
		]),
		false,
	);
});

test("tabs and toolbar buttons do not start a window drag", () => {
	assert.equal(
		shouldBeginWindowDragFromAncestors([
			{ tagName: "svg" },
			{ tagName: "button", className: "list-toggle-native" },
			{ tagName: "div", className: "list-toolbar" },
		]),
		false,
	);
	assert.equal(
		shouldBeginWindowDragFromAncestors([
			{ tagName: "span" },
			{ tagName: "button", role: "tab" },
			{ tagName: "div", className: "session-tabs-bar" },
		]),
		false,
	);
	assert.equal(
		shouldBeginWindowDragFromAncestors([
			{ tagName: "svg" },
			{ tagName: "button", className: "tab-close" },
			{ tagName: "div", role: "tab" },
			{ tagName: "div", className: "session-tabs-bar" },
		]),
		false,
	);
	assert.equal(
		shouldBeginWindowDragFromAncestors([
			{ tagName: "span", className: "session-tab-badge" },
			{ tagName: "button", role: "tab" },
			{ tagName: "div", className: "session-tabs-bar" },
		]),
		false,
	);
});

test("non-titlebar content never starts a window drag", () => {
	assert.equal(shouldBeginWindowDragFromAncestors([]), false);
	assert.equal(
		shouldBeginWindowDragFromAncestors([{ tagName: "div", className: "composer" }]),
		false,
	);
});
