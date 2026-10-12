import assert from "node:assert/strict";
import test from "node:test";
import { withFileDiffReact } from "./helpers/fileDiffReactHarness.mjs";

/**
 * FileDiff 正文挂载的行为测试：真实执行组件的 effect 与 JSX 条件。
 *
 * 规则（本次修改的目标）：
 * - 正文只由开合状态决定，运行状态（streaming）不强制挂载正文；
 * - complete → streaming 的状态上升沿不再自动展开所有文件；
 * - streaming → complete 且 collapseOnComplete 时仍自动收起。
 *
 * 只做源码字符串断言无法覆盖这些行为，因此这里挂载真实组件。
 */

const LINES = [
	{ id: "added-0", type: "added", content: "const a = 1;" },
	{ id: "added-1", type: "added", content: "const b = 2;" },
];

const baseProps = { file: "a.ts", lines: LINES };

test("collapsed complete diff mounts no body", async () => {
	await withFileDiffReact(async ({ React, act, root, loadFileDiff, bodyCount }) => {
		const { FileDiff } = loadFileDiff();
		await act(() =>
			root.render(
				React.createElement(FileDiff, { ...baseProps, status: "complete", defaultOpen: false }),
			),
		);
		assert.equal(bodyCount(), 0);
	});
});

test("collapsed streaming diff mounts no body", async () => {
	await withFileDiffReact(async ({ React, act, root, loadFileDiff, bodyCount }) => {
		const { FileDiff } = loadFileDiff();
		await act(() =>
			root.render(
				React.createElement(FileDiff, { ...baseProps, status: "streaming", defaultOpen: false }),
			),
		);
		assert.equal(bodyCount(), 0);
	});
});

test("defaultOpen diff mounts its body", async () => {
	await withFileDiffReact(async ({ React, act, root, loadFileDiff, bodyCount }) => {
		const { FileDiff } = loadFileDiff();
		await act(() =>
			root.render(
				React.createElement(FileDiff, { ...baseProps, status: "complete", defaultOpen: true }),
			),
		);
		assert.equal(bodyCount(), 1);
	});
});

test("clicking the trigger opens and closes the body while streaming", async () => {
	await withFileDiffReact(async ({ React, act, root, loadFileDiff, bodyCount, trigger, click }) => {
		const { FileDiff } = loadFileDiff();
		await act(() =>
			root.render(
				React.createElement(FileDiff, { ...baseProps, status: "streaming", defaultOpen: false }),
			),
		);
		assert.equal(bodyCount(), 0);
		await click(trigger());
		assert.equal(bodyCount(), 1, "user can expand a streaming diff");
		await click(trigger());
		assert.equal(bodyCount(), 0, "user can collapse it again");
	});
});

test("complete to streaming does not auto-expand collapsed files", async () => {
	await withFileDiffReact(async ({ React, act, root, loadFileDiff, bodyCount }) => {
		const { FileDiff } = loadFileDiff();
		const render = (status) =>
			act(() =>
				root.render(
					React.createElement(FileDiff, { ...baseProps, defaultOpen: false, status }),
				),
			);
		await render("complete");
		assert.equal(bodyCount(), 0);
		await render("streaming");
		assert.equal(bodyCount(), 0, "streaming must not force the body open");
	});
});

test("streaming to complete collapses a user-opened diff", async () => {
	await withFileDiffReact(async ({ React, act, root, loadFileDiff, bodyCount, trigger, click }) => {
		const { FileDiff } = loadFileDiff();
		const render = (status) =>
			act(() =>
				root.render(
					React.createElement(FileDiff, { ...baseProps, defaultOpen: false, status }),
				),
			);
		await render("streaming");
		await click(trigger());
		assert.equal(bodyCount(), 1, "user opened it while running");
		await render("complete");
		assert.equal(bodyCount(), 0, "completion collapses it again");
	});
});

test("controlled open=false keeps the body unmounted even while streaming", async () => {
	await withFileDiffReact(async ({ React, act, root, loadFileDiff, bodyCount }) => {
		const { FileDiff } = loadFileDiff();
		await act(() =>
			root.render(
				React.createElement(FileDiff, {
					...baseProps,
					status: "streaming",
					open: false,
					onOpenChange: () => {},
				}),
			),
		);
		assert.equal(bodyCount(), 0);
	});
});

test("collapseOnComplete false keeps the diff open after completion", async () => {
	await withFileDiffReact(async ({ React, act, root, loadFileDiff, bodyCount }) => {
		const { FileDiff } = loadFileDiff();
		const render = (status) =>
			act(() =>
				root.render(
					React.createElement(FileDiff, {
						...baseProps,
						defaultOpen: true,
						collapseOnComplete: false,
						status,
					}),
				),
			);
		await render("streaming");
		await render("complete");
		assert.equal(bodyCount(), 1);
	});
});
