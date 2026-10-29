import test from "node:test";
import assert from "node:assert/strict";
import { withHookHost } from "./helpers/l5_hookHost.mjs";
import { ControllableResizeObserver } from "./helpers/controllableResizeObserver.mjs";
import { resolveAnchorScrollTop } from "../src/renderer/src/components/session/timeline/virtualTimelineGeometry.ts";

test("步骤3回归红测: 捕获->前插(prepend)->恢复完整往返，遵循 targetScrollTop = listOrigin + rowStart - offsetTop", async () => {
	await withHookHost(async ({ load, mount, window, act }) => {
		ControllableResizeObserver.reset();
		globalThis.ResizeObserver = ControllableResizeObserver;
		window.ResizeObserver = ControllableResizeObserver;

		const mod = load("src/renderer/src/hooks/useVirtualTimeline.ts", {
			globals: { ResizeObserver: ControllableResizeObserver },
		});
		const { useVirtualTimeline } = mod;

		const viewport = window.document.createElement("div");
		// 视口初始 scrollTop = 242
		Object.defineProperty(viewport, "scrollTop", { value: 242, writable: true });
		Object.defineProperty(viewport, "clientHeight", { value: 600, writable: true });

		const makeItem = (id) => ({
			kind: "message",
			message: { id, role: "user", text: `Message ${id}`, timestamp: 1 },
		});

		// 初始两行，每行假定高度 180 + gap 12 = 192
		// row-0: [0, 180], row-1: [192, 372]
		// 当 scrollTop = 242 时，视口顶部落在 row-1 (192 ~ 372) 内部，
		// 行顶 192 相对视口顶部 242 的偏移 offsetTop = -(242 - 192) = -50
		let recordedScrollTop = null;
		let recordedReason = null;
		let adapter = { current: null };

		const probe = await mount(
			(props) => {
				return useVirtualTimeline({
					items: props.items,
					viewportRef: { current: viewport },
					isFollowing: false,
					applyReaderScrollTop: (top, reason) => {
						recordedScrollTop = top;
						recordedReason = reason;
					},
					sessionId: "sess-anchor-roundtrip",
					adapterRef: adapter,
				});
			},
			{ items: [makeItem("row-0"), makeItem("row-1")] },
		);

		// 1. 捕获锚点
		const reading = adapter.current.captureReadingAnchor();
		assert.equal(reading.status, "resolved");
		assert.equal(reading.anchor.messageId, "row-1");
		// 校验 offsetTop 符号：依约定 offsetTop = -50 (表示行顶在视口上方 50px 处)
		assert.equal(reading.anchor.offsetTop, -50);

		// 2. 前插一行 row-new (180 + 12 = 192px)
		// 新序列：row-new [0, 180], row-0 [192, 372], row-1 [384, 564]
		// row-1 的新 rowStart 变成 192 + 192 = 384
		// 期望恢复到的 targetScrollTop = 0 + 384 - (-50) = 434！
		await act(async () => {
			await probe.rerender({
				items: [makeItem("row-new"), makeItem("row-0"), makeItem("row-1")],
			});
		});

		assert.equal(recordedReason, "preserve-anchor");
		assert.equal(
			recordedScrollTop,
			434,
			"前插 192px 后，同一阅读锚点的 targetScrollTop 必须纠偏到 434，绝不能反转成 334！",
		);
	});
});
