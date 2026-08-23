import assert from "node:assert/strict";
import test from "node:test";

// 外部链接协议网关行为测试：openExternalUrl 是渲染层/更新流程共用的唯一入口，
// 协议路由策略抽在 src/main/browser/externalLinks.ts（纯函数 + 依赖注入）。
import {
	getUrlScheme,
	isAllowedGuestSystemProtocol,
	isAllowedSystemExternalProtocol,
	isHttpLikeExternalUrl,
	NON_HTTP_EXTERNAL_SCHEMES,
	openExternalLink,
} from "../src/main/browser/externalLinks.ts";

/** 记录 openInSystem / openInBrowserPanel 调用的替身。 */
function makeDeps(overrides = {}) {
	const calls = { system: [], panel: [], warns: [] };
	const deps = {
		openInSystem: async (url) => {
			calls.system.push(url);
		},
		openInBrowserPanel: (url) => {
			calls.panel.push(url);
		},
		linkOpenMode: () => "external",
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

test("guest allowlist is narrower than the trusted-UI allowlist", () => {
	// 通信深链允许由网页触发（标准 opaque 形式：无 host、目标在 opaque path）
	assert.equal(isAllowedGuestSystemProtocol("mailto:test@example.com"), true);
	assert.equal(isAllowedGuestSystemProtocol("TEL:+1234567890"), true);
	assert.equal(isAllowedGuestSystemProtocol("sms:+1234567890"), true);
	// query 携带正文/subject 的合法形式同样放行
	assert.equal(isAllowedGuestSystemProtocol("mailto:user@example.com?subject=hi&body=x"), true);
	// authority 形式（sms://host/...、mailto://host/...）是构造的混淆 URI，拒绝
	assert.equal(isAllowedGuestSystemProtocol("sms://1234567890?body=..."), false);
	assert.equal(isAllowedGuestSystemProtocol("mailto://example.com/user@example.com?subject=x"), false);
	assert.equal(isAllowedGuestSystemProtocol("tel://example.com/1234567890"), false);
	// 空 authority 的 path-form（///、/）同样是构造形式，按协议分别拒绝
	assert.equal(isAllowedGuestSystemProtocol("sms:///abc"), false);
	assert.equal(isAllowedGuestSystemProtocol("tel:/123"), false);
	assert.equal(isAllowedGuestSystemProtocol("mailto:///x"), false);
	// 本机工具深链不允许由任意远程网页触发（仅供应用内受信 UI 使用）
	assert.equal(isAllowedGuestSystemProtocol("vscode://open/file"), false);
	assert.equal(isAllowedGuestSystemProtocol("vscode-insiders://file"), false);
	// web 协议不属于 guest system 转发范围（webview 自己导航）
	assert.equal(isAllowedGuestSystemProtocol("https://example.com"), false);
});

test("mailto goes to the system handler instead of being silently dropped", async () => {
	const { deps, calls } = makeDeps();
	await openExternalLink("mailto:test@example.com", deps);
	assert.deepEqual(calls.system, ["mailto:test@example.com"]);
	assert.deepEqual(calls.panel, []);
	assert.deepEqual(calls.warns, []);
});

test("uppercase HTTP(S) is routed as web protocol, not rejected", async () => {
	const { deps, calls } = makeDeps();
	await openExternalLink("HTTPS://example.com/release", deps);
	assert.deepEqual(calls.system, ["HTTPS://example.com/release"]);
	assert.deepEqual(calls.panel, []);

	const internal = makeDeps({ linkOpenMode: () => "internal" });
	await openExternalLink("HTTP://example.com/docs", internal.deps);
	assert.deepEqual(internal.calls.panel, ["HTTP://example.com/docs"]);
	assert.deepEqual(internal.calls.system, []);
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
	assert.deepEqual(calls.panel, []);
	assert.equal(calls.warns.length, 1);
	assert.equal(calls.warns[0].message, "Rejected external link with non-allowlisted protocol");
});

test("http respects linkOpenMode=internal via the browser panel", async () => {
	const { deps, calls } = makeDeps({ linkOpenMode: () => "internal" });
	await openExternalLink("https://example.com/docs", deps);
	assert.deepEqual(calls.panel, ["https://example.com/docs"]);
	assert.deepEqual(calls.system, []);
});

test("forceSystem path (linkOpenMode pinned external) sends https straight to shell", async () => {
	const { deps, calls } = makeDeps();
	await openExternalLink("https://example.com/release", deps);
	assert.deepEqual(calls.system, ["https://example.com/release"]);
	assert.deepEqual(calls.panel, []);
});

test("http(s) open failures still propagate (update flow depends on it)", async () => {
	const { deps } = makeDeps({
		openInSystem: async () => {
			throw new Error("shell exploded");
		},
	});
	await assert.rejects(() => openExternalLink("https://example.com/download", deps), /shell exploded/);
});
