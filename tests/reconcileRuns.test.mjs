import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

/**
 * 阶段0补强：历史 run 引用稳定。
 *
 * groupToolMessages 每次全量重建所有 run；reconcileRuns 对比新旧列表，
 * 对「内容未变化」的 run 复用旧对象引用。这样 TurnRow 的 memo 比较
 * （sameAgentRunForRender）的 `previous === next` 快速路径命中，历史 run
 * 比较退化为 O(1)，不再每次流式增量都深度遍历全部历史消息。
 */

// AppUtils 依赖 chips 模块，用 transpileModule + vm 沙箱加载
//（与 tests/turnSegments.test.mjs 的 loadAppUtils 同套路）。
function loadAppUtils() {
	const source = readFileSync("src/renderer/src/components/app/AppUtils.ts", "utf8");
	const { outputText } = ts.transpileModule(source, {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
	});
	const sandbox = {
		exports: {},
		location: { href: "file:///Users/test/app" },
		require: (id) => {
			if (id === "../session/composer/chips") return { formatFilePathRef: (p) => p };
			return {};
		},
	};
	vm.runInNewContext(outputText, sandbox, { filename: "AppUtils.ts" });
	return sandbox.exports;
}

function makeRun(id, text) {
	return {
		kind: "agent-run",
		id,
		items: [
			{
				kind: "message",
				message: {
					id: `${id}-m1`,
					agentId: "agent",
					role: "assistant",
					text,
					timestamp: 1,
				},
			},
		],
		startedAt: 1,
		endedAt: 2,
	};
}

test("sameAgentRunForRender returns true when references are identical", () => {
	const { sameAgentRunForRender } = loadAppUtils();
	const run = makeRun("run-1", "hello");
	assert.equal(sameAgentRunForRender(run, run), true);
});

test("sameAgentRunForRender deep-compares content when references differ", () => {
	const { sameAgentRunForRender } = loadAppUtils();
	const a = makeRun("run-1", "hello");
	const b = makeRun("run-1", "hello");
	const c = makeRun("run-1", "world");
	assert.equal(sameAgentRunForRender(a, b), true);
	assert.equal(sameAgentRunForRender(a, c), false);
});

test("reconcileRuns reuses unchanged run references and keeps new runs", () => {
	const { reconcileRuns } = loadAppUtils();
	const run1 = makeRun("run-1", "first answer");
	const run2 = makeRun("run-2", "second answer");

	// 第一次：无 previous，全部用新对象
	const first = reconcileRuns(undefined, [run1]);
	assert.equal(first[0], run1);

	// 第二次：run-1 未变化 → 复用旧引用；run-2 新增 → 新对象
	const second = reconcileRuns(first, [run1, run2]);
	assert.equal(second[0], run1, "unchanged run should reuse old reference");
	assert.equal(second[1], run2);

	// 第三次：全部未变化 → 整体复用 previous 数组（引用相等）
	const third = reconcileRuns(second, [run1, run2]);
	assert.equal(third, second, "all unchanged should return previous array itself");
});

test("reconcileRuns detects content changes inside a run", () => {
	const { reconcileRuns } = loadAppUtils();
	const run1 = makeRun("run-1", "first answer");
	const first = reconcileRuns(undefined, [run1]);

	// run-1 内容变化（流式增量）：不能复用旧引用
	const run1Changed = makeRun("run-1", "first answer with more text");
	const second = reconcileRuns(first, [run1Changed]);
	assert.notEqual(second[0], run1, "changed run must use new reference");
	assert.equal(second[0], run1Changed);
});

test("reconcileRuns removes stale runs when next shrinks", () => {
	const { reconcileRuns } = loadAppUtils();
	const run1 = makeRun("run-1", "a");
	const run2 = makeRun("run-2", "b");
	const first = reconcileRuns(undefined, [run1, run2]);
	const second = reconcileRuns(first, [run1]);
	assert.equal(second.length, 1);
	assert.equal(second[0], run1);
});

// 契约：SessionMessageTimeline 用 reconcileRuns 复用引用，TurnRow memo 走快速路径
test("timeline wires reconcileRuns and TurnRow memo fast path", () => {
	const timeline = readFileSync(
		"src/renderer/src/components/session/SessionMessageTimeline.tsx",
		"utf8",
	);
	assert.match(timeline, /reconcileRuns\(prevRenderedRunsRef\.current, renderedRuns\)/);
	assert.match(timeline, /prevRenderedRunsRef = useRef<RenderMessage\[\] \| undefined>/);

	const turnRow = readFileSync(
		"src/renderer/src/components/session/turn/TurnRow.tsx",
		"utf8",
	);
	assert.match(turnRow, /sameAgentRunForRender\(prev\.run, next\.run\)/);
});

function makeMsg(id, text, role = "user") {
	return {
		kind: "message",
		message: {
			id,
			agentId: "agent",
			role,
			text,
			timestamp: 10,
		},
	};
}

test("reconcileRuns updates rendered text on same-length ordinary message replacement", () => {
	const { reconcileRuns } = loadAppUtils();
	const prevMsg = makeMsg("msg-1", "old text");
	const nextMsg = makeMsg("msg-1", "NEW text");
	const previous = [prevMsg];
	const next = [nextMsg];

	const result = reconcileRuns(previous, next);
	assert.notEqual(result, previous, "must not return stale previous array");
	assert.equal(result[0], nextMsg, "must take incoming changed message");
	assert.equal(result[0].message.text, "NEW text");
});

test("reconcileRuns preserves new order on same-length ordinary message reorder", () => {
	const { reconcileRuns } = loadAppUtils();
	const msgA = makeMsg("msg-a", "A");
	const msgB = makeMsg("msg-b", "B");
	const previous = [msgA, msgB];
	const next = [msgB, msgA];

	const result = reconcileRuns(previous, next);
	assert.notEqual(result, previous, "must not return previous array when order changed");
	assert.equal(result[0], msgB);
	assert.equal(result[1], msgA);
});

test("reconcileRuns preserves new order on same-length agent-run reorder while runs unchanged", () => {
	const { reconcileRuns } = loadAppUtils();
	const runA = makeRun("run-a", "Answer A");
	const runB = makeRun("run-b", "Answer B");
	const previous = [runA, runB];
	const next = [runB, runA];

	const result = reconcileRuns(previous, next);
	assert.notEqual(result, previous, "must not return previous array when run order changed");
	assert.equal(result[0], runB);
	assert.equal(result[1], runA);
	assert.equal(result[0].id, "run-b");
	assert.equal(result[1].id, "run-a");
});

test("reconcileRuns handles non-run replacement mixed with unchanged run", () => {
	const { reconcileRuns } = loadAppUtils();
	const msg1 = makeMsg("msg-1", "user original");
	const run1 = makeRun("run-1", "assistant answer");
	const previous = [msg1, run1];

	const msg1New = makeMsg("msg-1", "user edited");
	const run1Identical = makeRun("run-1", "assistant answer");
	const next = [msg1New, run1Identical];

	const result = reconcileRuns(previous, next);
	assert.notEqual(result, previous);
	assert.equal(result[0], msg1New, "changed message must use incoming reference");
	assert.equal(result[1], run1, "unchanged run must retain previous reference");
});

test("reconcileRuns returns new array when message identity changes with equal text", () => {
	const { reconcileRuns } = loadAppUtils();
	const msgA1 = makeMsg("msg-a", "same text");
	const msgA2 = makeMsg("msg-a", "same text");
	const previous = [msgA1];
	const next = [msgA2];

	const result = reconcileRuns(previous, next);
	assert.notEqual(result, previous);
	assert.equal(result[0], msgA2);
});

test("reconcileRuns returns new array when top-level kind changes at same position", () => {
	const { reconcileRuns } = loadAppUtils();
	const msg = makeMsg("entry-1", "hello");
	const run = makeRun("entry-1", "hello");
	const previous = [msg];
	const next = [run];

	const result = reconcileRuns(previous, next);
	assert.notEqual(result, previous);
	assert.equal(result[0], run);
});

test("reconcileRuns returns previous array when references and order are completely unchanged", () => {
	const { reconcileRuns } = loadAppUtils();
	const msg = makeMsg("msg-1", "hello");
	const run = makeRun("run-1", "world");
	const previous = [msg, run];
	const next = [msg, makeRun("run-1", "world")]; // run is content-identical, msg is exact ref

	const result = reconcileRuns(previous, next);
	assert.equal(result, previous, "must return exact previous array");
});

test("reconcileRuns does not mutate inputs", () => {
	const { reconcileRuns } = loadAppUtils();
	const msg = makeMsg("msg-1", "hello");
	const run = makeRun("run-1", "world");
	const previous = Object.freeze([msg, run]);
	const next = Object.freeze([makeMsg("msg-1", "new"), run]);

	assert.doesNotThrow(() => {
		reconcileRuns(previous, next);
	});
});
