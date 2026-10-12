import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 惰性行数据源：计数不拆行、行数组只在需要时构造且引用稳定。
 *
 * 计数必须与 fileChangeToDiffLines 的行语义逐项一致，否则文件名行上的
 * `+n / −n` 会和展开后的正文对不上。
 */

const sourceModule = loadTsCommonJs(
	"src/renderer/src/components/session/turn/turnFileDiffSource.ts",
);
const { createTurnFileDiffSource } = sourceModule;
const { fileChangeToDiffLines } = loadTsCommonJs(
	"src/renderer/src/components/session/TimelineFormat.ts",
);

test("write (no original content) counts all-new lines and zero deletions", () => {
	const source = createTurnFileDiffSource({ originalContent: "", content: "a\nb\nc" });
	assert.equal(source.additions, 3);
	assert.equal(source.deletions, 0);
});

test("edit counts removed and added lines", () => {
	const source = createTurnFileDiffSource({ originalContent: "old1\nold2", content: "new1" });
	assert.equal(source.additions, 1);
	assert.equal(source.deletions, 2);
});

test("empty new content still counts as one added line", () => {
	const source = createTurnFileDiffSource({ originalContent: "", content: "" });
	assert.equal(source.additions, 1);
	assert.equal(source.deletions, 0);
});

test("trailing newline counts as an extra line", () => {
	const source = createTurnFileDiffSource({ originalContent: "", content: "a\n" });
	assert.equal(source.additions, 2);
});

test("CRLF is not split further than the existing algorithm", () => {
	// fileChangeToDiffLines 只按 \n 切；\r 留在行内容里，计数也必须一致。
	const source = createTurnFileDiffSource({ originalContent: "", content: "a\r\nb" });
	const lines = source.getLines();
	assert.equal(source.additions, 2);
	assert.equal(lines.length, 2);
	assert.equal(lines[0].content, "a\r");
});

test("getLines matches fileChangeToDiffLines exactly", () => {
	const entry = { originalContent: "old1\nold2", content: "new1\nnew2" };
	const source = createTurnFileDiffSource(entry);
	// 两个模块各自在独立 vm 上下文加载，行对象原型不同，因此比较结构化值。
	assert.deepEqual(
		JSON.parse(JSON.stringify(source.getLines())),
		JSON.parse(JSON.stringify(fileChangeToDiffLines(entry))),
	);
});

test("getLines returns a stable array reference and does not recompute", () => {
	const source = createTurnFileDiffSource({ originalContent: "", content: "a\nb" });
	const first = source.getLines();
	assert.equal(source.getLines(), first);
});

test("separate sources do not share line data", () => {
	const first = createTurnFileDiffSource({ originalContent: "", content: "a" });
	const second = createTurnFileDiffSource({ originalContent: "", content: "b" });
	assert.notEqual(first.getLines(), second.getLines());
	assert.equal(first.getLines()[0].content, "a");
	assert.equal(second.getLines()[0].content, "b");
});

test("source captures a snapshot of the content it was created with", () => {
	const entry = { originalContent: "", content: "before" };
	const source = createTurnFileDiffSource(entry);
	entry.content = "after";
	assert.equal(source.additions, 1);
	assert.equal(source.getLines()[0].content, "before");
});
