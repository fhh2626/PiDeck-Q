import test from "node:test";
import assert from "node:assert/strict";
import { withHookHost } from "./helpers/l5_hookHost.mjs";

test("修复验证1: Timeline 内联 applyReaderScrollTop 不会引发无限渲染循环", async () => {
	await withHookHost(async ({ load, mount, window }) => {
		class MockRO {
			observe() {}
			unobserve() {}
			disconnect() {}
		}
		globalThis.ResizeObserver = MockRO;
		window.ResizeObserver = MockRO;

		const mod = load("src/renderer/src/hooks/useVirtualTimeline.ts", {
			globals: { ResizeObserver: MockRO },
		});
		const { useVirtualTimeline } = mod;

		const viewport = window.document.createElement("div");
		Object.defineProperty(viewport, "scrollTop", { value: 0, writable: true });
		Object.defineProperty(viewport, "clientHeight", { value: 600, writable: true });

		let renderCount = 0;
		let hitMaxUpdateDepth = false;

		try {
			await mount(
				(props) => {
					renderCount++;
					// 内联回调每次 render 都是新函数
					const inlineApply = (top) => {
						viewport.scrollTop = top;
					};
					return useVirtualTimeline({
						items: props.items,
						viewportRef: { current: viewport },
						isFollowing: false,
						applyReaderScrollTop: inlineApply,
						sessionId: "test-session",
					});
				},
				{ items: [] },
			);
		} catch (err) {
			if (err?.message?.includes("Maximum update depth exceeded")) {
				hitMaxUpdateDepth = true;
			} else {
				throw err;
			}
		}

		assert.equal(hitMaxUpdateDepth, false, "不能出现 Maximum update depth exceeded 异常");
		assert.ok(renderCount <= 3, `渲染次数应当收敛，实际渲染次数: ${renderCount}`);
	});
});

test("修复验证2: useVirtualTimeline restoreMessage 正确保留 offsetTop", async () => {
	await withHookHost(async ({ load, mount, window }) => {
		class MockRO {
			observe() {}
			unobserve() {}
			disconnect() {}
		}
		globalThis.ResizeObserver = MockRO;
		window.ResizeObserver = MockRO;

		const mod = load("src/renderer/src/hooks/useVirtualTimeline.ts", {
			globals: { ResizeObserver: MockRO },
		});
		const { useVirtualTimeline } = mod;

		const viewport = window.document.createElement("div");
		let appliedTop = null;
		const adapterRef = { current: null };

		const userItem = {
			kind: "message",
			message: { id: "msg-1", role: "user", text: "hello", timestamp: 1 },
		};

		const stableApply = (top) => {
			appliedTop = top;
		};

		await mount(
			() => {
				return useVirtualTimeline({
					items: [userItem],
					viewportRef: { current: viewport },
					isFollowing: false,
					applyReaderScrollTop: stableApply,
					sessionId: "test-session",
					adapterRef,
				});
			},
			{},
		);

		assert.ok(adapterRef.current, "adapter 应当被注册");

		// 行顶相对视口原点在下方 24px (offsetTop = +24) -> targetScrollTop = 0 - 24 = -24
		adapterRef.current.restoreMessage("msg-1", 24);
		assert.equal(appliedTop, -24, "正 offsetTop 恢复计算正确");

		// 行顶相对视口原点在上方 24px (offsetTop = -24) -> targetScrollTop = 0 - (-24) = 24
		adapterRef.current.restoreMessage("msg-1", -24);
		assert.equal(appliedTop, 24, "负 offsetTop 恢复计算正确");
	});
});
