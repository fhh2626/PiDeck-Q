import test from "node:test";
import assert from "node:assert/strict";
import { withHookHost } from "./helpers/l5_hookHost.mjs";
import { ControllableResizeObserver } from "./helpers/controllableResizeObserver.mjs";

test("步骤4分流与三态测试: 在底部跟流时 captureReadingAnchor 返回 at-bottom，清除持久化锚点", async () => {
	await withHookHost(async ({ load, mount, window }) => {
		ControllableResizeObserver.reset();
		globalThis.ResizeObserver = ControllableResizeObserver;
		window.ResizeObserver = ControllableResizeObserver;

		const mod = load("src/renderer/src/hooks/useVirtualTimeline.ts", {
			globals: { ResizeObserver: ControllableResizeObserver },
		});
		const { useVirtualTimeline } = mod;

		const viewport = window.document.createElement("div");
		Object.defineProperty(viewport, "scrollTop", { value: 1000, writable: true });
		Object.defineProperty(viewport, "clientHeight", { value: 600, writable: true });

		let adapter = { current: null };
		const probe = await mount(
			(props) => {
				return useVirtualTimeline({
					items: [{ kind: "message", message: { id: "m-bot", role: "user", text: "bot", timestamp: 1 } }],
					viewportRef: { current: viewport },
					isFollowing: props.isFollowing,
					applyReaderScrollTop: () => undefined,
					sessionId: "sess-step4-following",
					adapterRef: adapter,
				});
			},
			{ isFollowing: true },
		);

		const reading = adapter.current.captureReadingAnchor();
		assert.equal(reading.status, "at-bottom", "跟底状态下捕获锚点必须返回 status: 'at-bottom'！");

		// 退出跟底后，再次捕获应返回 resolved
		await probe.rerender({ isFollowing: false });
		const readerReading = adapter.current.captureReadingAnchor();
		assert.equal(readerReading.status, "resolved");
	});
});
