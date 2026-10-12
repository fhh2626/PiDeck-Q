import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

/**
 * 验证浏览器输入测试中采样器的生命周期：
 * 提取 tests/browser/fileDiffPerformance.spec.ts 中的 installPerfTypingSampler 与 cleanupPerfTypingSampler，
 * 确保未执行的 rAF 能被真实取消，解绑后不残留任何 listener、帧与全局状态。
 */

function extractSamplerCode() {
	const specSource = readFileSync("tests/browser/fileDiffPerformance.spec.ts", "utf8");
	const sourceFile = ts.createSourceFile(
		"fileDiffPerformance.spec.ts",
		specSource,
		ts.ScriptTarget.ESNext,
		true,
	);

	let installNode;
	let cleanupNode;

	for (const statement of sourceFile.statements) {
		if (ts.isFunctionDeclaration(statement)) {
			const name = statement.name?.text;
			if (name === "installPerfTypingSampler") installNode = statement;
			if (name === "cleanupPerfTypingSampler") cleanupNode = statement;
		}
	}

	if (!installNode || !cleanupNode) {
		throw new Error("Cannot find installPerfTypingSampler or cleanupPerfTypingSampler in spec");
	}

	const codeToTranspile = `${installNode.getText(sourceFile)}\n${cleanupNode.getText(sourceFile)}`;
	return ts.transpileModule(codeToTranspile, {
		compilerOptions: {
			target: ts.ScriptTarget.ES2022,
			module: ts.ModuleKind.CommonJS,
		},
	}).outputText;
}

function createHarness() {
	const listeners = new Map();
	const pendingFrames = new Map();
	let nextFrameId = 0;
	let inputRemoved = false;

	const fakeInput = {
		id: "",
		addEventListener(name, handler) {
			listeners.set(name, handler);
		},
		removeEventListener(name, handler) {
			if (listeners.get(name) === handler) {
				listeners.delete(name);
			}
		},
		remove() {
			inputRemoved = true;
		},
	};

	let prependedInput = null;
	const fakeDocument = {
		getElementById(id) {
			if (prependedInput && prependedInput.id === id) return prependedInput;
			return null;
		},
		createElement(tagName) {
			if (tagName === "input") return fakeInput;
			return {};
		},
		body: {
			prepend(element) {
				prependedInput = element;
			},
		},
	};

	const fakeWindow = {};
	const fakeExports = {};
	let nowValue = 1000;

	const context = vm.createContext({
		exports: fakeExports,
		window: fakeWindow,
		document: fakeDocument,
		performance: {
			now() {
				return nowValue;
			},
		},
		requestAnimationFrame(callback) {
			nextFrameId += 1;
			const id = nextFrameId;
			pendingFrames.set(id, callback);
			return id;
		},
		cancelAnimationFrame(id) {
			pendingFrames.delete(id);
		},
	});

	const code = extractSamplerCode();
	vm.runInContext(code, context);

	return {
		window: fakeWindow,
		pendingFrames,
		getListener: (name) => listeners.get(name),
		hasListener: (name) => listeners.has(name),
		isInputRemoved: () => inputRemoved,
		setNow: (val) => {
			nowValue = val;
		},
		install: () => {
			if (typeof fakeExports.installPerfTypingSampler === "function") {
				fakeExports.installPerfTypingSampler();
			} else {
				vm.runInContext("installPerfTypingSampler()", context);
			}
		},
		cleanup: () => {
			if (typeof fakeExports.cleanupPerfTypingSampler === "function") {
				fakeExports.cleanupPerfTypingSampler();
			} else {
				vm.runInContext("cleanupPerfTypingSampler()", context);
			}
		},
		/** 手动执行指定 ID 或最早的一个帧回调。 */
		flushFrame: (frameId) => {
			const id = frameId ?? pendingFrames.keys().next().value;
			if (id === undefined) throw new Error("No pending frame to flush");
			const cb = pendingFrames.get(id);
			pendingFrames.delete(id);
			cb();
		},
	};
}

test("cleanup cancels unexecuted sampling frames (regression test A)", () => {
	const harness = createHarness();
	harness.install();

	const onKeyDown = harness.getListener("keydown");
	assert.ok(typeof onKeyDown === "function", "keydown listener must be bound");

	// 发送按键事件：安排了一次 rAF，但不执行
	onKeyDown({ key: "a", timeStamp: 100, isTrusted: true });
	assert.equal(harness.pendingFrames.size, 1, "must have 1 pending rAF");

	// 执行清理
	harness.cleanup();

	assert.equal(harness.pendingFrames.size, 0, "unexecuted rAF must be cancelled");
	assert.equal(harness.hasListener("keydown"), false, "listener must be removed");
	assert.equal(harness.isInputRemoved(), true, "input must be removed from document");
	assert.equal("__perfTypingSamples" in harness.window, false, "samples must be deleted");
	assert.equal("__perfTypingCleanup" in harness.window, false, "cleanup must be deleted");
});

test("executed frame records sample and is then cleaned up (test B)", () => {
	const harness = createHarness();
	harness.install();

	const onKeyDown = harness.getListener("keydown");
	harness.setNow(120);
	onKeyDown({ key: "x", timeStamp: 100, isTrusted: true });

	assert.equal(harness.pendingFrames.size, 1);
	// 模拟浏览器绘制触发 rAF
	harness.flushFrame();
	assert.equal(harness.pendingFrames.size, 0);

	assert.deepEqual(JSON.parse(JSON.stringify(harness.window.__perfTypingSamples)), [
		{ key: "x", isTrusted: true, durationMs: 20 },
	]);

	harness.cleanup();
	assert.equal(harness.hasListener("keydown"), false);
	assert.equal("__perfTypingSamples" in harness.window, false);
});

test("cleanup cancels multiple unexecuted frames (test C)", () => {
	const harness = createHarness();
	harness.install();

	const onKeyDown = harness.getListener("keydown");
	onKeyDown({ key: "a", timeStamp: 100, isTrusted: true });
	onKeyDown({ key: "b", timeStamp: 110, isTrusted: true });

	assert.equal(harness.pendingFrames.size, 2, "must have 2 pending rAFs");

	harness.cleanup();
	assert.equal(harness.pendingFrames.size, 0, "all pending frames must be cancelled");
});

test("repeated cleanup is safe and idempotent (test D)", () => {
	const harness = createHarness();
	harness.install();
	assert.doesNotThrow(() => harness.cleanup());
	assert.doesNotThrow(() => harness.cleanup());
	assert.equal(harness.pendingFrames.size, 0);
	assert.equal(harness.hasListener("keydown"), false);
});

test("non-single-character keys are not sampled (test E)", () => {
	const harness = createHarness();
	harness.install();

	const onKeyDown = harness.getListener("keydown");
	onKeyDown({ key: "Shift", timeStamp: 100, isTrusted: true });
	onKeyDown({ key: "Enter", timeStamp: 105, isTrusted: true });

	assert.equal(harness.pendingFrames.size, 0, "non-character keys must not schedule rAF");
	harness.cleanup();
});
