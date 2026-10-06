import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * 收起态 FileDiff 必须整块不挂载正文。
 *
 * 背景：TurnFileChanges 会给一轮里的每个改动文件都挂一个 FileDiff，而
 * AgentDisclosure 收起时用 height:0（不卸载子节点）。逐行 DOM 与 Shiki 高亮
 * 若留在文档里，长会话每轮底部可以攒出几万节点，按键要等布局。
 *
 * 这里只做源码契约断言（项目惯例，不挂载浏览器）。
 */

const fileDiffPath = "src/renderer/src/components/agents/file-diff.tsx";
const disclosurePath = "src/renderer/src/components/agents/agent-disclosure.tsx";

const fileDiffSource = readFileSync(fileDiffPath, "utf8");
const disclosureSource = readFileSync(disclosurePath, "utf8");

/** 取 `function <name>(` 到下一个顶层 `export function` / `function` 之间的正文。 */
function bodyOf(source, name) {
	const start = source.indexOf(`function ${name}(`);
	assert.ok(start >= 0, `${name} not found`);
	const rest = source.slice(start);
	const nextMatch = rest.slice(1).match(/\nexport function |\nfunction /);
	return nextMatch ? rest.slice(0, nextMatch.index + 1) : rest;
}

test("FileDiff: useAgentCodeTokens runs only inside FileDiffBody", () => {
	const bodyFn = bodyOf(fileDiffSource, "FileDiffBody");
	const diffFn = bodyOf(fileDiffSource, "FileDiff");

	assert.match(
		bodyFn,
		/useAgentCodeTokens\(/,
		"FileDiffBody must run the Shiki tokenizer",
	);
	assert.doesNotMatch(
		diffFn,
		/useAgentCodeTokens\(/,
		"FileDiff must not run the Shiki tokenizer while collapsed",
	);
});

test("FileDiff: full-text join lives in FileDiffBody, not in FileDiff", () => {
	const bodyFn = bodyOf(fileDiffSource, "FileDiffBody");
	const diffFn = bodyOf(fileDiffSource, "FileDiff");

	assert.match(
		bodyFn,
		/lines\.map\(\(line\) => line\.content\)\.join\("\\n"\)/,
		"FileDiffBody must build the joined diff text for highlighting",
	);
	assert.doesNotMatch(
		diffFn,
		/lines\.map\(\(line\) => line\.content\)\.join/,
		"FileDiff must not join the whole diff text while collapsed",
	);
});

test("FileDiff: body is mounted only while open or streaming", () => {
	const gate = "{(currentOpen || streaming) && (";
	assert.ok(
		fileDiffSource.includes(gate),
		"body mount gate must be (currentOpen || streaming)",
	);

	const gateIndex = fileDiffSource.indexOf(gate);
	const bodyIndex = fileDiffSource.indexOf("<FileDiffBody", gateIndex);
	assert.ok(
		bodyIndex > gateIndex,
		"FileDiffBody must be rendered behind the mount gate",
	);
});

test("FileDiff: no display:none hiding for the body", () => {
	assert.doesNotMatch(
		fileDiffSource,
		/display:\s*["']none["']/,
		"must unmount rather than hide with display:none",
	);
	assert.doesNotMatch(
		fileDiffSource,
		/display:none/,
		"must unmount rather than hide with display:none",
	);
});

test("AgentDisclosure keeps its height:0 contract (shared with todo-list)", () => {
	assert.match(
		disclosureSource,
		/height:\s*open \? openHeight : 0/,
		"AgentDisclosure must keep the animated height contract",
	);
	assert.doesNotMatch(
		disclosureSource,
		/if \(!open\) return null/,
		"AgentDisclosure must not early-return null when closed",
	);
});

test("FileDiff keeps density classes and viewport slot", () => {
	for (const needle of [
		"min-h-7",
		"py-0.5",
		"gap-1.5",
		"pl-5 pt-1",
		"rounded-md bg-muted/80",
		'data-slot="file-diff-viewport"',
	]) {
		assert.ok(
			fileDiffSource.includes(needle),
			`file-diff.tsx must keep "${needle}"`,
		);
	}
});
