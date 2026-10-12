import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { createNativeReloadUrl } = loadTsCommonJs(
	"src/renderer/src/native/nativeReloadUrl.ts",
);
const rendererBootstrap = readFileSync(
	"src/renderer/src/native/initializeNativeDesktop.ts",
	"utf8",
);

test("native renderer resync restores the token before navigation", () => {
	const url = new URL(createNativeReloadUrl(
		"http://127.0.0.1:1234/?runtime=native",
		"secret",
	));
	assert.equal(url.searchParams.get("runtime"), "native");
	assert.equal(url.searchParams.get("token"), "secret");
	assert.match(rendererBootstrap, /window\.location\.replace\(createNativeReloadUrl\(window\.location\.href, token\)\)/);
	assert.doesNotMatch(rendererBootstrap, /onResyncRequired: \(\) => window\.location\.reload\(\)/);
});

test("native renderer resync keeps the page when the server sends a structured gap", () => {
	// 正常断层载荷是对象；只有畸形载荷才允许走整页重载兜底。
	assert.doesNotMatch(rendererBootstrap, /onResyncRequired: \(\) => reloadNativeRenderer\(token\)/);
	assert.match(rendererBootstrap, /onResyncRequired: \(payload\) => \{/);
	assert.match(rendererBootstrap, /if \(isUnknownRecord\(payload\)\) return;/);
	assert.match(rendererBootstrap, /reloadNativeRenderer\(token\);/);
});

test("native reload URL preserves unrelated query parameters and hash", () => {
	const url = new URL(createNativeReloadUrl(
		"http://127.0.0.1:1234/?foo=bar#section",
		"secret",
	));
	assert.equal(url.searchParams.get("foo"), "bar");
	assert.equal(url.searchParams.get("runtime"), "native");
	assert.equal(url.searchParams.get("token"), "secret");
	assert.equal(url.hash, "#section");
});
