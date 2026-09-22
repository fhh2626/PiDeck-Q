import test from "node:test";
import assert from "node:assert/strict";
import { remarkLinkifyPaths } from "../src/renderer/src/components/session/MarkdownLinkCore.ts";
import { normalizeLocalFileTarget, resolveFileLinkPath } from "../src/renderer/src/utils/fileLinks.ts";

test("G1/Pipeline: bare Windows path creates valid file URI and resolves correctly", () => {
	const text = String.raw`C:\Users\Alice\image.png`;
	const tree = { type: "root", children: [{ type: "text", value: text }] };
	remarkLinkifyPaths()(tree);
	const linkNode = tree.children.find((child) => child.type === "link");
	assert.ok(linkNode, "should create link");
	assert.match(linkNode.url, /^file:\/\/\/[A-Za-z]:\//);
	assert.doesNotMatch(linkNode.url, /%5c/i);

	const target = normalizeLocalFileTarget(linkNode.url, "win32");
	assert.equal(target.ok, true);
	if (target.ok) {
		assert.equal(target.path, "C:/Users/Alice/image.png");
		const resolved = resolveFileLinkPath(target.path, "D:\\workspace");
		assert.equal(resolved, "C:/Users/Alice/image.png");
	}
});

test("G1/Pipeline: UNC path is recognized as absolute and not prepended with basePath", () => {
	const uncUri = "file://server/share/photos/pic.png";
	const target = normalizeLocalFileTarget(uncUri, "win32");
	assert.equal(target.ok, true);
	if (target.ok) {
		assert.equal(target.path, "\\\\server\\share\\photos\\pic.png");
		const resolved = resolveFileLinkPath(target.path, "C:\\my-project");
		assert.equal(resolved, "\\\\server\\share\\photos\\pic.png");
	}
});

test("G1/Pipeline: relative path does not become UNC authority", () => {
	const relText = "src/components/App.tsx";
	const tree = { type: "root", children: [{ type: "text", value: relText }] };
	remarkLinkifyPaths()(tree);
	const linkNode = tree.children.find((child) => child.type === "link");
	assert.ok(linkNode);
	assert.equal(linkNode.url, "src/components/App.tsx");

	const target = normalizeLocalFileTarget(linkNode.url, "win32");
	assert.equal(target.ok, true);
	if (target.ok) {
		assert.equal(target.path, "src/components/App.tsx");
		const resolved = resolveFileLinkPath(target.path, "D:\\workspace");
		assert.match(resolved, /^D:[\\/]workspace[\\/]src[\\/]components[\\/]App\.tsx$/);
	}
});

test("G1/Pipeline: invalid file URL with encoded separator or illegal percent is rejected", () => {
	const invalidSep = "file:///C:/path/%5Cbad.png";
	const resSep = normalizeLocalFileTarget(invalidSep, "win32");
	assert.equal(resSep.ok, false);
	if (!resSep.ok) {
		assert.equal(resSep.code, "ENCODED_SEPARATOR");
	}

	const invalidEncoding = "file:///C:/path/%ZZ.png";
	const resEnc = normalizeLocalFileTarget(invalidEncoding, "win32");
	assert.equal(resEnc.ok, false);
	if (!resEnc.ok) {
		assert.equal(resEnc.code, "INVALID_ENCODING");
	}
});

test("G1/Pipeline: POSIX platform rejects remote authority and handles %5c safely", () => {
	const remote = "file://remote-host/share/pic.png";
	const resRemote = normalizeLocalFileTarget(remote, "linux");
	assert.equal(resRemote.ok, false);
	if (!resRemote.ok) {
		assert.equal(resRemote.code, "UNSUPPORTED_TARGET");
	}

	const posixLocal = "file:///home/user/images/%5Cfile.png";
	const resPosix = normalizeLocalFileTarget(posixLocal, "linux");
	// 在 POSIX 下，%5c 是文件名合法字符（反斜杠不是路径分隔符）
	assert.equal(resPosix.ok, true);
	if (resPosix.ok) {
		assert.equal(resPosix.path, "/home/user/images/\\file.png");
	}
});
