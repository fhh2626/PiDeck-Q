import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { childPathEnvironment, environmentPath, qtBinDirectory } from "./helpers/native2BackendHarness.mjs";
import { joinPathParts } from "./helpers/native2FakeProcess.mjs";
import { nativeBuildPaths } from "./helpers/nativeBuildPaths.mjs";

const pinned = process.env.PIDECK_DESKTOP_PROXY_TEST_EXECUTABLE;
const sources = [
	"native/tests/DesktopProxyPolicyTest.cpp", "xmake.lua",
	"native/backend/domain/net/DesktopProxy.cpp", "native/backend/domain/net/DesktopProxy.h",
];
const candidates = nativeBuildPaths("PiDeck-DesktopProxyPolicyTest", { pinned });
const executable = candidates.map((path) => resolve(path)).find((path) => existsSync(path)
	&& sources.every((source) => statSync(path).mtimeMs >= statSync(source).mtimeMs));
const required = Boolean(pinned) || process.env.PIDECK_REQUIRE_BACKEND_TESTS === "1";
const skip = !executable && !required ? "Build PiDeck-DesktopProxyPolicyTest to verify native proxy routing" : false;

/** Inspect the real installed Qt factory. No network request or DNS lookup occurs. */
function native(fixtures) {
	assert.ok(executable, "A fresh PiDeck-DesktopProxyPolicyTest executable is required");
	const env = childPathEnvironment(process.env, joinPathParts([qtBinDirectory(), environmentPath()]));
	const result = spawnSync(executable, [], {
		windowsHide: true,
		env, input: JSON.stringify(fixtures), encoding: "utf8", timeout: 20_000,
	});
	assert.equal(result.status, 0, result.stderr || String(result.error ?? ""));
	return JSON.parse(result.stdout);
}

const cases = [
	["exact hostname", "bypass.test", "bypass.test", true],
	["hostname suffix", "bypass.test", "sub.bypass.test", true],
	["wildcard root", "*.bypass.test", "bypass.test", true],
	["wildcard subdomain", "*.bypass.test", "sub.bypass.test", true],
	["wildcard nested subdomain", "*.bypass.test", "a.sub.bypass.test", true],
	["case insensitive wildcard", "*.BYPASS.TEST", "sub.bypass.test", true],
	["hostname boundary", "bypass.test", "notbypass.test", false],
	["wildcard boundary", "*.bypass.test", "notbypass.test", false],
	["suffix boundary", "bypass.test", "bypass.test.other.test", false],
	["multiple separators", "other.test, *.bypass.test\nthird.test", "sub.bypass.test", true],
	["local host rule", "<local>", "intranet", true],
	["local host excludes domains", "<local>", "intranet.example.test", false],
	["port is not a hostname rule", "bypass.test:80", "bypass.test", false],
	["leading dot is literal", ".bypass.test", "sub.bypass.test", false],
	["loopback hostname", "", "localhost", true],
	["loopback IPv4", "", "127.42.0.1", true],
	["loopback IPv6", "", "[::1]", true],
	["hostname resembling loopback", "", "127.0.0.1.example.test", false],
];

for (const [name, bypass, hostname, direct] of cases) {
	test(`native desktop proxy follows the routing contract for ${name}`, { skip }, async () => {
		const fixtures = [{
			settings: { desktopProxyEnabled: true, desktopProxyUrl: "http://127.0.0.1:7890", desktopProxyBypass: bypass },
			url: `http://${hostname}/v1/models`,
		}];
		const [actual] = native(fixtures);
		assert.equal(actual.bypassed, direct);
		assert.equal(actual.direct, direct);
		assert.equal(actual.factoryDirect, direct);
		if (!direct) {
			assert.equal(actual.proxyHost, "127.0.0.1");
			assert.equal(actual.proxyPort, 7890);
		}
	});
}

test("native installed proxy factory observes settings changes without retaining an old bypass", { skip }, async () => {
	const settings = { desktopProxyEnabled: true, desktopProxyUrl: "127.0.0.1:7890", desktopProxyBypass: "bypass.test" };
	const fixtures = [
		settings,
		{ ...settings, desktopProxyBypass: "" },
		{ ...settings, desktopProxyEnabled: false },
		{ ...settings, desktopProxyBypass: "", desktopProxyUrl: "http://" },
		{ ...settings, desktopProxyBypass: "" },
	].map((value) => ({ settings: value, url: "http://sub.bypass.test/v1/models" }));
	const expected = [true, false, true, true, false];
	const actual = native(fixtures);
	assert.deepEqual(actual.map((result) => result.direct), expected);
	assert.deepEqual(actual.map((result) => result.factoryDirect), expected);
});
