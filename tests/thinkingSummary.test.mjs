import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { twMerge } from "tailwind-merge";
import { getRecipe } from "./_densityRecipe.mjs";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { firstLine, latestLine } = loadTsCommonJs("src/renderer/src/utils/thinkingSummary.ts");

test("firstLine 取第一行，无换行返回全文", () => {
	assert.equal(firstLine("abc\ndef"), "abc");
	assert.equal(firstLine("单行思考"), "单行思考");
	assert.equal(firstLine(""), "");
});

test("firstLine 跳过文本首部空白（思考 delta 裸拼接常以换行开头，结束态摘要不能是空行）", () => {
	assert.equal(firstLine("\n我是这样想的\ndef"), "我是这样想的");
	assert.equal(firstLine("\n\nfoo\nbar"), "foo");
	assert.equal(firstLine("  \nfoo\nbar"), "foo");
});

test("latestLine 取最新一行（尾部，tail -f 语义）", () => {
	assert.equal(latestLine("abc\ndef"), "def");
	// 结尾换行被 trimEnd 吃掉，仍取最后一个非空行
	assert.equal(latestLine("abc\ndef\n"), "def");
	assert.equal(latestLine("单行思考"), "单行思考");
});

test("thinking preview retains chat font size and line height after class merging", () => {
	const recipe = getRecipe("CARD_PREVIEW_PADDING");
	for (const state of ["text-ellipsis", "text-clip"]) {
		const classes = twMerge("relative min-w-0 overflow-hidden whitespace-nowrap", state, recipe).split(" ");
		assert.ok(classes.includes("text-[length:var(--font-size-chat)]"), `chat font size lost in ${state}`);
		assert.ok(classes.includes("leading-[var(--chat-body-line-height)]"), `chat line height lost in ${state}`);
		assert.ok(classes.includes("text-text-tertiary"), `preview color lost in ${state}`);
	}
});

test("SingleLinePreview does not recreate ResizeObserver for every text delta", () => {
	const source = readFileSync(
		"src/renderer/src/components/session/SingleLinePreview.tsx",
		"utf8",
	);
	const observerEffect = source.slice(
		source.indexOf("const ro = new ResizeObserver"),
		source.indexOf("// 文本增量只更新滚动位置"),
	);
	assert.match(observerEffect, /const ro = new ResizeObserver\(follow\);[\s\S]*?\}, \[props\.running\]\);/);
	assert.doesNotMatch(observerEffect, /summary/);
});
