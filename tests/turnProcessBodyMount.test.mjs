import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { shouldMountProcessBody } from "../src/renderer/src/components/session/turn/processBodyMount.ts";

/**
 * 长会话渲染治理：已结束的轮次收起时不挂载思考/工具/中间回答正文。
 *
 * 只隐藏（display:none）等于没治理：节点仍在文档里，输入和拖动都要为它付样式与布局成本。
 * 正在输出的那一轮例外——收起时仍要保留隐藏 DOM，否则打字机会被销毁。
 */

test("ended and collapsed runs do not mount the process body", () => {
	assert.equal(shouldMountProcessBody(false, false), false);
	assert.equal(shouldMountProcessBody(false, undefined), false);
});

test("expanded runs mount the process body regardless of live state", () => {
	assert.equal(shouldMountProcessBody(true, false), true);
	assert.equal(shouldMountProcessBody(true, undefined), true);
	assert.equal(shouldMountProcessBody(true, true), true);
});

test("the running round keeps its hidden DOM so streaming state survives collapse", () => {
	assert.equal(shouldMountProcessBody(false, true), true);
});

test("TurnRow wires the mount decision without dropping the collapsible structure", () => {
	const source = readFileSync(
		"src/renderer/src/components/session/turn/TurnRow.tsx",
		"utf8",
	);
	assert.match(source, /shouldMountProcessBody/, "必须调用共享判定，不能在 JSX 里另写一套");
	assert.match(source, /mountProcessBody &&/, "折叠正文只在挂载条件下渲染");
	// 现有契约：折叠栏仍是 Radix Collapsible + CollapsibleContent（高度过渡动画）。
	assert.match(source, /<Collapsible/);
	assert.match(source, /<CollapsibleContent/);
});

test("live steps still hide via CSS so their internal state is not destroyed", () => {
	const tool = readFileSync(
		"src/renderer/src/components/session/turn/ToolStep.tsx",
		"utf8",
	);
	const thinking = readFileSync(
		"src/renderer/src/components/session/turn/ThinkingStep.tsx",
		"utf8",
	);
	assert.match(tool, /display: props\.hidden \? "none" : undefined/);
	assert.match(thinking, /display: props\.hidden \? "none" : undefined/);
});
