import assert from "node:assert/strict";
import test from "node:test";
import { withFileDiffReact } from "./helpers/fileDiffReactHarness.mjs";

/**
 * FileDiff 的惰性行输入：`lineSource` 优先于 `lines`，且**只在正文挂载时才调用 getLines**。
 *
 * 这保证了「收起的长会话不为每个文件预先拆全文」这一目标不被破坏——
 * 只断言渲染结果不够，必须断言 getLines 的调用次数。
 */

const LINES = [
	{ id: "added-0", type: "added", content: "const a = 1;" },
	{ id: "removed-0", type: "removed", content: "old" },
];

/** 记录调用的 source 替身。 */
function makeSource(lines, counts = { additions: 1, deletions: 1 }) {
	const calls = { getLines: 0 };
	return {
		calls,
		source: {
			additions: counts.additions,
			deletions: counts.deletions,
			getLines: () => {
				calls.getLines += 1;
				return lines;
			},
		},
	};
}

test("collapsed complete diff never calls getLines", async () => {
	await withFileDiffReact(async ({ React, act, root, loadFileDiff, bodyCount }) => {
		const { FileDiff } = loadFileDiff();
		const { calls, source } = makeSource(LINES);
		await act(() =>
			root.render(
				React.createElement(FileDiff, {
					file: "a.ts",
					lineSource: source,
					status: "complete",
					defaultOpen: false,
				}),
			),
		);
		assert.equal(bodyCount(), 0);
		assert.equal(calls.getLines, 0, "collapsed diff must not build line data");
	});
});

test("collapsed streaming diff never calls getLines", async () => {
	await withFileDiffReact(async ({ React, act, root, loadFileDiff, bodyCount }) => {
		const { FileDiff } = loadFileDiff();
		const { calls, source } = makeSource(LINES);
		await act(() =>
			root.render(
				React.createElement(FileDiff, {
					file: "a.ts",
					lineSource: source,
					status: "streaming",
					defaultOpen: false,
				}),
			),
		);
		assert.equal(bodyCount(), 0);
		assert.equal(calls.getLines, 0, "running state must not build line data either");
	});
});

test("expanding calls getLines and renders the body", async () => {
	await withFileDiffReact(async ({ React, act, root, loadFileDiff, bodyCount, trigger, click, window }) => {
		const { FileDiff } = loadFileDiff();
		const { calls, source } = makeSource(LINES);
		await act(() =>
			root.render(
				React.createElement(FileDiff, {
					file: "a.ts",
					lineSource: source,
					status: "complete",
					defaultOpen: false,
				}),
			),
		);
		await click(trigger());
		assert.equal(bodyCount(), 1);
		assert.ok(calls.getLines >= 1, "expanding must build line data");
		assert.match(window.document.body.textContent, /const a = 1;/);
	});
});

test("lineSource takes precedence over lines", async () => {
	await withFileDiffReact(async ({ React, act, root, loadFileDiff, window }) => {
		const { FileDiff } = loadFileDiff();
		const { source } = makeSource([{ id: "added-0", type: "added", content: "FROM_SOURCE" }]);
		await act(() =>
			root.render(
				React.createElement(FileDiff, {
					file: "a.ts",
					lines: [{ id: "added-0", type: "added", content: "FROM_LINES" }],
					lineSource: source,
					status: "complete",
					defaultOpen: true,
				}),
			),
		);
		assert.match(window.document.body.textContent, /FROM_SOURCE/);
		assert.doesNotMatch(window.document.body.textContent, /FROM_LINES/);
	});
});

test("header counts come from lineSource without calling getLines", async () => {
	await withFileDiffReact(async ({ React, act, root, loadFileDiff, window }) => {
		const { FileDiff } = loadFileDiff();
		const { calls, source } = makeSource(LINES, { additions: 7, deletions: 3 });
		await act(() =>
			root.render(
				React.createElement(FileDiff, {
					file: "a.ts",
					lineSource: source,
					status: "complete",
					defaultOpen: false,
				}),
			),
		);
		assert.equal(calls.getLines, 0);
		assert.match(window.document.body.textContent, /\+7/);
		assert.match(window.document.body.textContent, /−3/);
	});
});

test("legacy lines prop still renders and counts", async () => {
	await withFileDiffReact(async ({ React, act, root, loadFileDiff, window }) => {
		const { FileDiff } = loadFileDiff();
		await act(() =>
			root.render(
				React.createElement(FileDiff, {
					file: "a.ts",
					lines: LINES,
					status: "complete",
					defaultOpen: true,
				}),
			),
		);
		assert.match(window.document.body.textContent, /const a = 1;/);
		assert.match(window.document.body.textContent, /\+1/);
		assert.match(window.document.body.textContent, /−1/);
	});
});

test("empty lines are tolerated when neither prop is given", async () => {
	await withFileDiffReact(async ({ React, act, root, loadFileDiff, bodyCount }) => {
		const { FileDiff } = loadFileDiff();
		await act(() =>
			root.render(
				React.createElement(FileDiff, { file: "a.ts", status: "complete", defaultOpen: true }),
			),
		);
		assert.equal(bodyCount(), 1);
	});
});
