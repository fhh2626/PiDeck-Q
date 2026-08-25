import assert from "node:assert/strict";
import test from "node:test";
import * as markdownCore from "../src/renderer/src/components/session/MarkdownLinkCore.ts";
const { remarkLinkifyPaths } = markdownCore;

/**
 * 链接处理修复回归（issue #115 链接问题）：
 * 1. 全角标点不再被吞进路径（src/a.ts， 只匹配 src/a.ts）
 * 2. 中文/Unicode 目录与文件名支持
 * 3. 真实路径仍被识别为 file:// 链接
 * 4. 代码块/行内代码/link 节点不被处理
 */

/** 用 remarkLinkifyPaths 处理 mdast 树，返回转换后的链接列表 */
function linkify(text) {
	const tree = {
		type: "root",
		children: [{ type: "paragraph", children: [{ type: "text", value: text }] }],
	};
	const plugin = remarkLinkifyPaths();
	plugin(tree);
	const links = [];
	const walk = (node) => {
		if (!node || typeof node !== "object") return;
		if (node.type === "link") links.push(node.url);
		if (Array.isArray(node.children)) node.children.forEach(walk);
	};
	walk(tree);
	return links;
}

test("real paths still linkify (relative, absolute, unicode)", () => {
	assert.deepEqual(linkify("看 src/native-node/index.ts"), ["file://src/native-node/index.ts"]);
	// 中文/反斜杠经 encodeURIComponent 编码（解码后还原原路径）
	const absLinks = linkify("路径 D:\\项目\\文件.ts");
	assert.equal(absLinks.length, 1);
	assert.ok(absLinks[0].startsWith("file://D:%5C"));
	assert.equal(decodeURIComponent(absLinks[0].slice(7)), "D:\\项目\\文件.ts");
	assert.deepEqual(linkify("参考 ./docs/guide.md"), ["file://./docs/guide.md"]);
	assert.deepEqual(linkify("上级 ../src/a.ts"), ["file://../src/a.ts"]);
	// 中文目录与文件名
	// 中文目录与文件名（编码后解码还原）
	const zhLinks = linkify("模块 src/项目/工具.ts 已更新");
	assert.equal(zhLinks.length, 1);
	assert.equal(decodeURIComponent(zhLinks[0].slice(7)), "src/项目/工具.ts");
	// 多级目录
	assert.deepEqual(linkify("组件 src/components/Button.tsx"), ["file://src/components/Button.tsx"]);
});

test("full-width punctuation is not swallowed into the path", () => {
	// 修复前：src/a.ts， 会匹配 src/a.ts， （全角逗号被吞）→ 点击打开不存在的文件
	assert.deepEqual(linkify("改了 src/a.ts，src/b.ts"), [
		"file://src/a.ts",
		"file://src/b.ts",
	]);
	assert.deepEqual(linkify("见 foo/bar.md：说明"), ["file://foo/bar.md"]);
	assert.deepEqual(linkify("a.ts）说明"), []);
	assert.deepEqual(linkify("完成（src/ok.ts）了"), ["file://src/ok.ts"]);
	assert.deepEqual(linkify("参考 docs/guide.md。"), ["file://docs/guide.md"]);
});

test("special symbols are excluded (arrows, multiplication, ellipsis)", () => {
	assert.deepEqual(linkify("升级 src/a.ts → src/b.ts"), [
		"file://src/a.ts",
		"file://src/b.ts",
	]);
	assert.deepEqual(linkify("对比 a.ts × b.ts"), []);
	assert.deepEqual(linkify("见 src/x.ts…"), ["file://src/x.ts"]);
});

test("code blocks and inline code are not linkified", () => {
	const tree = {
		type: "root",
		children: [
			{ type: "code", value: "const p = 'src/a.ts';" },
			{ type: "paragraph", children: [{ type: "inlineCode", value: "src/b.ts" }] },
		],
	};
	const plugin = remarkLinkifyPaths();
	plugin(tree);
	const links = [];
	const walk = (node) => {
		if (!node || typeof node !== "object") return;
		if (node.type === "link") links.push(node.url);
		if (Array.isArray(node.children)) node.children.forEach(walk);
	};
	walk(tree);
	assert.deepEqual(links, []);
});

test("markdown links (link nodes) are not double-processed", () => {
	const tree = {
		type: "root",
		children: [
			{
				type: "paragraph",
				children: [
					{
						type: "link",
						url: "docs/guide.md",
						children: [{ type: "text", value: "guide" }],
					},
				],
			},
		],
	};
	const plugin = remarkLinkifyPaths();
	plugin(tree);
	const links = [];
	const walk = (node) => {
		if (!node || typeof node !== "object") return;
		if (node.type === "link") links.push(node.url);
		if (Array.isArray(node.children)) node.children.forEach(walk);
	};
	walk(tree);
	// link 节点原样保留（无 file:// 前缀），由 MarkdownLink 点击时按本地路径处理
	assert.deepEqual(links, ["docs/guide.md"]);
});

test("file name without directory segment is not linkified (avoid false positives)", () => {
	assert.deepEqual(linkify("file.ts 和 main.ts 都改了"), []);
	assert.deepEqual(linkify("版本 2.0 发布"), []);
});

test("isLocalPathRef: protocol-less hrefs are local paths, real URLs are not", () => {
	const { isLocalPathRef } = markdownCore;
	assert.equal(isLocalPathRef("docs/guide.md"), true);
	assert.equal(isLocalPathRef("./src/a.ts"), true);
	assert.equal(isLocalPathRef("D:/x/y.md"), true);
	assert.equal(isLocalPathRef("https://example.com/a.md"), false);
	assert.equal(isLocalPathRef("http://x"), false);
	assert.equal(isLocalPathRef("mailto:a@b.com"), false);
	assert.equal(isLocalPathRef("file:///x"), false);
	assert.equal(isLocalPathRef("javascript:alert(1)"), false);
	assert.equal(isLocalPathRef("#section"), false);
	assert.equal(isLocalPathRef("//cdn.example.com/x"), false);
	assert.equal(isLocalPathRef(""), false);
});
