import assert from "node:assert/strict";
import test from "node:test";
import { loadPiProcess } from "./helpers/loadPiProcess.mjs";

// 只替换版本命令边界和时钟，使用公开预热入口验证缓存；不读写私有静态字段。
function fixture() {
	let now = 100_000;
	let calls = 0;
	let fail = true;
	const { PiProcess } = loadPiProcess([], {
		now: () => now,
		versionResult: () => {
			calls += 1;
			return { error: fail ? new Error("temporary failure") : null, stdout: fail ? "" : "1.4.0" };
		},
	});
	const locator = {
		resolveCommand: () => "test-pi",
		createInvocation: (command, args) => ({ command, args }),
		createProcessEnv: () => ({}),
	};
	return {
		probe: () => PiProcess.warmVersionCache(undefined, locator),
		advance: (ms) => { now += ms; },
		recover: () => { fail = false; },
		calls: () => calls,
	};
}

test("a failed version probe is reused briefly then retried after recovery", async () => {
	const h = fixture();
	assert.equal(await h.probe(), false);
	h.recover();
	h.advance(29_999);
	assert.equal(await h.probe(), false);
	assert.equal(h.calls(), 1, "a failure must not create a retry storm");
	h.advance(1);
	assert.equal(await h.probe(), true, "a transient failure must not poison the whole app lifetime");
	assert.equal(h.calls(), 2);
});

test("successful version probes remain cached beyond the failure retry interval", async () => {
	const h = fixture();
	h.recover();
	assert.equal(await h.probe(), true);
	h.advance(60_000);
	assert.equal(await h.probe(), true);
	assert.equal(h.calls(), 1);
});
