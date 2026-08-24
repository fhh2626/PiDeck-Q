import assert from "node:assert/strict";
import test from "node:test";

// 外部链接协议网关行为测试：openExternalUrl 是渲染层/更新流程共用的唯一入口，
// 协议路由策略抽在 src/main/browser/externalLinks.ts（纯函数 + 依赖注入）。
import {
	getUrlScheme,
	isAllowedSystemExternalProtocol,
	isHttpLikeExternalUrl,
	NON_HTTP_EXTERNAL_SCHEMES,
	openExternalLink,
} from "../src/main/browser/externalLinks.ts";

/** 记录 openInSystem 调用的替身。 */
function makeDeps(overrides = {}) {
	const calls = { system: [], warns: [] };
	const deps = {
		openInSystem: async (url) => {
			calls.system.push(url);
		},
		logger: {
			warn: (scope, message, detail) => {
				calls.warns.push({ scope, message, detail });
			},
		},
		...overrides,
	};
	return { deps, calls };
}

test("getUrlScheme parses via WHATWG URL and lowercases", () => {
	assert.equal(getUrlScheme("HTTPS://example.com"), "https:");
	assert.equal(getUrlScheme("MailTo:test@example.com"), "mailto:");
	assert.equal(getUrlScheme("not a url"), null);
	assert.equal(getUrlScheme(""), null);
});

test("isHttpLikeExternalUrl accepts web protocols case-insensitively", () => {
	assert.equal(isHttpLikeExternalUrl("https://example.com"), true);
	assert.equal(isHttpLikeExternalUrl("HTTPS://example.com"), true);
	assert.equal(isHttpLikeExternalUrl("Http://example.com"), true);
	assert.equal(isHttpLikeExternalUrl("mailto:test@example.com"), false);
	assert.equal(isHttpLikeExternalUrl("file:///C:/x"), false);
});

test("trusted-UI allowlist covers communication and editor schemes", () => {
	for (const scheme of NON_HTTP_EXTERNAL_SCHEMES) {
		const url = `${scheme}rest`;
		assert.equal(isAllowedSystemExternalProtocol(url), true, url);
	}
	assert.equal(isAllowedSystemExternalProtocol("MAILTO:test@example.com"), true);
	assert.equal(isAllowedSystemExternalProtocol("VSCode://open"), true);
});

test("dangerous or unknown protocols are rejected before reaching the OS", () => {
	for (const url of ["file:///C:/Windows/System32/config", "search-ms:query=x", "ms-settings:display", "javascript:alert(1)", "ftp://host/x"]) {
		assert.equal(isAllowedSystemExternalProtocol(url), false, url);
	}
});

test("allowlisted non-http schemes go to the system handler", async () => {
	const { deps, calls } = makeDeps();
	for (const url of ["mailto:test@example.com", "tel:+1234567890", "sms:+1234567890", "vscode://open"]) {
		await openExternalLink(url, deps);
	}
	assert.deepEqual(calls.system, [
		"mailto:test@example.com",
		"tel:+1234567890",
		"sms:+1234567890",
		"vscode://open",
	]);
	assert.deepEqual(calls.warns, []);
});

test("uppercase HTTP(S) goes to the system browser", async () => {
	const { deps, calls } = makeDeps();
	await openExternalLink("HTTPS://example.com/release", deps);
	assert.deepEqual(calls.system, ["HTTPS://example.com/release"]);
});

test("non-http open failure is downgraded to a warn log, not propagated", async () => {
	const { deps, calls } = makeDeps({
		openInSystem: async () => {
			throw new Error("no handler for scheme");
		},
	});
	await openExternalLink("tel:+1234567890", deps);
	assert.equal(calls.warns.length, 1);
	assert.equal(calls.warns[0].message, "Failed to open non-http external link");
});

test("rejected protocol produces an observable warn instead of silence", async () => {
	const { deps, calls } = makeDeps();
	await openExternalLink("search-ms:query=secret", deps);
	assert.deepEqual(calls.system, []);
	assert.equal(calls.warns.length, 1);
	assert.equal(calls.warns[0].message, "Rejected external link with non-allowlisted protocol");
});

test("https sends directly to the system browser", async () => {
	const { deps, calls } = makeDeps();
	await openExternalLink("https://example.com/release", deps);
	assert.deepEqual(calls.system, ["https://example.com/release"]);
});

test("http(s) open failures still propagate (update flow depends on it)", async () => {
	const { deps } = makeDeps({
		openInSystem: async () => {
			throw new Error("shell exploded");
		},
	});
	await assert.rejects(() => openExternalLink("https://example.com/download", deps), /shell exploded/);
});
