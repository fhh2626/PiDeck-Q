import assert from "node:assert/strict";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";
import { readFileSync } from "node:fs";

// 确认流状态测试（真实行为，非源码匹配）：
// 渲染层只持有 { id, url } 用于展示；应答时只回传 id（URL 权威值在主进程
// pending 注册表），渲染层无法在确认瞬间替换目标。
const source = readFileSync("src/renderer/src/hooks/useExternalProtocolConfirm.ts", "utf8");

function compileHook(reactStub, desktopApiStub) {
	const output = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
			esModuleInterop: true,
		},
		fileName: "src/renderer/src/hooks/useExternalProtocolConfirm.ts",
	}).outputText;
	const module = { exports: {} };
	vm.runInNewContext(output, {
		module,
		exports: module.exports,
		require: (specifier) => {
			if (specifier === "react") return reactStub;
			if (specifier === "../desktopApi") return desktopApiStub;
			return {};
		},
	}, { filename: "useExternalProtocolConfirm.ts" });
	return module.exports;
}

/** 极简 React 替身：useState/useEffect/useCallback 按调用序展开。 */
function createHarness(responses) {
	const states = [];
	let cursor = 0;
	let effectCleanup = null;
	let effectFactory = null;
	const react = {
		useState(initial) {
			const index = cursor++;
			states[index] ??= typeof initial === "function" ? initial() : initial;
			const setter = (next) => {
				states[index] = typeof next === "function" ? next(states[index]) : next;
			};
			return [states[index], setter];
		},
		useCallback(fn) {
			cursor++;
			return fn;
		},
		// useEffect 与 useState/useCallback 一样占 hook 槽位，必须推进 cursor。
		useEffect(factory) {
			cursor++;
			effectFactory = factory;
		},
	};
	const desktopApi = {
		app: {
			onConfirmExternalProtocol: (cb) => { harness.pushedFrom = cb; return () => { harness.pushedFrom = null; }; },
			respondExternalProtocol: (id, action) => responses.push({ id, action }),
		},
	};
	const hooks = compileHook(react, { desktopApi });
	const harness = {
		pushedFrom: null,
		render() {
			cursor = 0;
			return hooks.useExternalProtocolConfirm();
		},
		/** 模拟 React 提交：先渲染 hook 体，再运行 effect。 */
		runEffect() {
			this.render();
			if (effectCleanup) { effectCleanup(); effectCleanup = null; }
			effectCleanup = effectFactory?.() ?? undefined;
		},
	};
	return harness;
}

test("newest push replaces renderer view; confirm answers with that request's id only", () => {
	const responses = [];
	const h = createHarness(responses);
	h.runEffect();

	let r = h.render();
	assert.equal(r.pending, null);

	h.pushedFrom({ id: "req-a", url: "mailto:first@example.com" });
	r = h.render();
	assert.deepEqual(r.pending, { id: "req-a", url: "mailto:first@example.com" });

	// 主进程同 guest 去重后仍可能推新请求（前一条被 cancel 后）：渲染层以最新为准
	h.pushedFrom({ id: "req-b", url: "tel:+9876543210" });
	r = h.render();
	assert.equal(r.pending.id, "req-b");

	r.confirm();
	// 只回传 id，不回传 URL
	assert.deepEqual(responses, [{ id: "req-b", action: "confirm" }]);
	assert.equal(h.render().pending, null);
});

test("dismiss answers cancel; responding twice is impossible after state clears", () => {
	const responses = [];
	const h = createHarness(responses);
	h.runEffect();
	h.pushedFrom({ id: "req-a", url: "sms:+1234567890" });
	let r = h.render();
	r.dismiss();
	assert.deepEqual(responses, [{ id: "req-a", action: "cancel" }]);
	assert.equal(h.render().pending, null);

	// pending 已清空：重复 confirm 不应答（幂等）
	h.render().confirm();
	assert.deepEqual(responses, [{ id: "req-a", action: "cancel" }]);
});

test("confirm without any pending request is a no-op", () => {
	const responses = [];
	const h = createHarness(responses);
	h.runEffect();
	h.render().confirm();
	assert.deepEqual(responses, []);
});
