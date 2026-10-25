import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { loadNativeBootstrapForReload } from "./helpers/l1b_nativeBootstrapReloadHarness.mjs";

const { createNativeReloadUrl } = loadTsCommonJs(
	"src/renderer/src/native/nativeReloadUrl.ts",
);

/** 解析 navigation.replaced 里记录的跳转地址。 */
function onlyReplacedUrl(navigation) {
	assert.equal(navigation.replaced.length, 1, "expected exactly one navigation");
	return new URL(navigation.replaced[0]);
}

test("native renderer resync restores the token before navigation", () => {
	const url = new URL(createNativeReloadUrl(
		"http://127.0.0.1:1234/?runtime=native",
		"secret",
	));
	assert.equal(url.searchParams.get("runtime"), "native");
	assert.equal(url.searchParams.get("token"), "secret");
});

test("malformed resync payload reloads through location.replace with the in-memory token restored", async () => {
	const { module, navigation, transports } = loadNativeBootstrapForReload();
	await module.initializeNativeDesktop();
	// token 在 bootstrap 时已从地址栏抹掉，裸 reload 会丢认证；必须走带 token 的 replace
	transports[0].options.onResyncRequired(undefined);
	const url = onlyReplacedUrl(navigation);
	assert.equal(url.searchParams.get("token"), "secret");
	assert.equal(url.searchParams.get("runtime"), "native");
	assert.equal(navigation.reloads, 0, "must not use bare location.reload()");
});

test("array and primitive resync payloads are treated as malformed and trigger the reload fallback", async () => {
	for (const payload of [[], "gap", 42, null]) {
		const { module, navigation, transports } = loadNativeBootstrapForReload();
		await module.initializeNativeDesktop();
		transports[0].options.onResyncRequired(payload);
		assert.equal(navigation.replaced.length, 1, `payload ${JSON.stringify(payload)}`);
	}
});

test("structured resync gap keeps the page: no navigation of any kind", async () => {
	const { module, navigation, transports } = loadNativeBootstrapForReload();
	await module.initializeNativeDesktop();
	// 正常断层载荷是对象；整页重载会丢滚动位置与输入内容，只有畸形载荷才允许兜底重载
	transports[0].options.onResyncRequired({ reason: "history-trimmed", eventSeq: 9 });
	transports[0].options.onResyncRequired({ channel: "x", bytes: 5 });
	assert.deepEqual(navigation.replaced, []);
	assert.equal(navigation.reloads, 0);
});

test("bootstrap strips the token from the address bar before any reload can happen", async () => {
	const { module, navigation } = loadNativeBootstrapForReload();
	await module.initializeNativeDesktop();
	assert.equal(navigation.historyUrls.length, 1);
	assert.ok(!navigation.historyUrls[0].includes("token="), navigation.historyUrls[0]);
	assert.ok(navigation.historyUrls[0].includes("foo=bar"));
});

test("reloadDesktopRenderer after bootstrap navigates with the token instead of bare reload", async () => {
	const { module, navigation } = loadNativeBootstrapForReload();
	await module.initializeNativeDesktop();
	module.reloadDesktopRenderer();
	assert.equal(onlyReplacedUrl(navigation).searchParams.get("token"), "secret");
	assert.equal(navigation.reloads, 0);
});

test("reloadDesktopRenderer without a native token (web/preview) falls back to a plain reload", () => {
	const { module, navigation } = loadNativeBootstrapForReload();
	module.reloadDesktopRenderer();
	assert.equal(navigation.reloads, 1);
	assert.deepEqual(navigation.replaced, []);
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

test("native reload URL overwrites a stale token instead of duplicating it", () => {
	const url = new URL(createNativeReloadUrl("http://127.0.0.1:1234/?token=old&runtime=web", "fresh"));
	assert.deepEqual(url.searchParams.getAll("token"), ["fresh"]);
	assert.deepEqual(url.searchParams.getAll("runtime"), ["native"]);
});