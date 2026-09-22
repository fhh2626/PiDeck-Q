import assert from "node:assert/strict";
import { unified } from "unified";
import remarkParse from "remark-parse";
import {
	filePathFromHref,
	toInternalFileHref,
	normalizeLocalFilePath,
	stripFileLocation,
	filePathToUri,
	normalizeLocalFileTarget,
} from "../src/renderer/src/utils/fileLinks.ts";

const localTargets = [
	"C:/Users/Administrator/.pi/agent/settings.json",
	"C:\\Users\\Administrator\\.pi\\agent\\settings.json",
	"/C:/Users/Administrator/project/src/App.tsx:392",
	"/home/user/project/src/app.py:12:4",
	"./src/app.ts",
	"../docs/README.md",
	"src/components/App.tsx:42",
	"settings.json",
	"settings.json:8",
];

for (const target of localTargets) {
	const normalized = normalizeLocalFilePath(target);
	assert.ok(normalized, `expected local file target: ${target}`);
	assert.equal(filePathFromHref(toInternalFileHref(target), "win32"), normalized?.replace(/\\/g, "/"));
}

const externalTargets = [
	"https://example.com/docs/readme.md",
	"http://example.com/file.json",
	"mailto:user@example.com",
	"#section",
	"/docs/getting-started",
	"//example.com/docs/file.md",
];

for (const target of externalTargets) {
	assert.equal(normalizeLocalFilePath(target), null, `expected external target: ${target}`);
	assert.equal(toInternalFileHref(target), null);
	assert.equal(filePathFromHref(target), null);
}

assert.equal(normalizeLocalFilePath("/C:/Users/Test/file.ts:9"), "C:/Users/Test/file.ts:9");
assert.equal(stripFileLocation("C:/Users/Test/file.ts:9:3"), "C:/Users/Test/file.ts");
assert.equal(stripFileLocation("C:/Users/Test/file.ts"), "C:/Users/Test/file.ts");

// 标准 URI 转换往返测试
const winUri = filePathToUri("C:/Users/Test/My File.ts");
assert.equal(winUri, "file:///C:/Users/Test/My%20File.ts");
const normWin = normalizeLocalFileTarget(winUri, "win32");
assert.equal(normWin.ok, true);
if (normWin.ok) {
	assert.equal(normWin.path, "C:/Users/Test/My File.ts");
}

const markdownTargets = [
	"[settings.json](C:/Users/Administrator/.pi/agent/settings.json)",
	"[App.tsx](/C:/Users/Administrator/project/src/App.tsx:392)",
	"[app.py](/home/user/project/app.py:12:4)",
	"[README](../docs/README.md)",
];
const markdownParser = unified().use(remarkParse);
for (const markdown of markdownTargets) {
	const tree = markdownParser.parse(markdown);
	const paragraph = tree.children[0];
	assert.equal(paragraph?.type, "paragraph");
	if (paragraph?.type !== "paragraph") throw new Error("Expected paragraph");
	const link = paragraph.children[0];
	assert.equal(link?.type, "link", `expected Markdown link node: ${markdown}`);
	if (link?.type !== "link") throw new Error("Expected link");
	assert.equal(filePathFromHref(toInternalFileHref(link.url), "win32"), normalizeLocalFilePath(link.url));
}

console.log("file link roundtrip and rejection assertions passed");
