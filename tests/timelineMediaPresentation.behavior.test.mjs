import test from "node:test";
import assert from "node:assert/strict";
import { withHookHost } from "./helpers/l5_hookHost.mjs";

test("步骤6媒体展示状态测试: load -> 卸载 -> 重挂 首帧立即赋 src，跨会话隔离与清理正确", async () => {
	await withHookHost(async ({ React, load, mount, act, window }) => {
		const presMod = load("src/renderer/src/components/session/timeline/timelinePresentationContext.tsx");
		const { TimelinePresentationProvider } = presMod;

		const atomMod = load("src/renderer/src/atoms/timeline-presentation.ts");
		const { getMediaPresentationAtom, removeSessionPresentationState } = atomMod;

		let observeCount = 0;
		let observerInstance = null;

		class MockIntersectionObserver {
			constructor(callback) {
				this.callback = callback;
				observerInstance = this;
			}
			observe() {
				observeCount++;
			}
			unobserve() {}
			disconnect() {}
		}

		globalThis.IntersectionObserver = MockIntersectionObserver;
		window.IntersectionObserver = MockIntersectionObserver;

		const imgMod = load("src/renderer/src/components/session/MessageImage.tsx", {
			globals: {
				IntersectionObserver: MockIntersectionObserver,
			},
			stubs: {
				"@/lib/utils": { cn: (...args) => args.filter(Boolean).join(" ") },
				"../ui-shadcn/dialog": {
					Dialog: ({ children }) => React.createElement("div", null, children),
					DialogContent: ({ children }) => React.createElement("div", null, children),
				},
				"../ui-shadcn/button": {
					Button: ({ children, ...props }) => React.createElement("button", props, children),
				},
				"./timeline/timelinePresentationContext": presMod,
				"../../atoms/timeline-presentation": atomMod,
			},
		});
		const { MessageImage } = imgMod;

		// 1. 初次挂载：未进入视口（inView=false），img src 必须为 undefined
		let currentProps = { mounted: true };
		const probe = await mount(
			() => {},
			currentProps,
			() => {
				if (!currentProps.mounted) return null;
				return React.createElement(
					TimelinePresentationProvider,
					{ sessionId: "sess-media-1", rowKey: "message:msg-1" },
					React.createElement(MessageImage, {
						src: "data:image/png;base64,AAA==",
						alt: "test-img",
						className: "test-class",
						messageId: "msg-1",
						imageIndex: 0,
					}),
				);
			},
		);

		const firstImg = window.document.querySelector("img");
		assert.ok(firstImg, "img 标签必须存在于 DOM 中");
		assert.equal(firstImg.getAttribute("src"), null, "初次挂载未进入视口时绝不得预先赋 src！");

		// 2. 模拟 IntersectionObserver 触发相交 -> inView 变为 true，赋 src
		await act(() => {
			if (observerInstance) {
				observerInstance.callback([{ isIntersecting: true }]);
			}
		});

		assert.equal(firstImg.getAttribute("src"), "data:image/png;base64,AAA==", "相交后必须赋真实 src");

		// 3. 模拟图片真实 onLoad 事件触发
		await act(() => {
			if (typeof firstImg.onload === "function") {
				firstImg.onload({ type: "load" });
			}
			firstImg.dispatchEvent(new window.Event("load", { bubbles: true }));
		});

		// 4. 模拟虚拟列表将该行卸载（滚动出视口）
		currentProps = { mounted: false };
		await probe.rerender(currentProps);
		assert.equal(window.document.querySelector("img"), null, "行卸载后 img 已从 DOM 移除");

		// 5. 模拟虚拟列表将该行重新挂载（滚动回视口）
		// 此时无需等待 IntersectionObserver，首帧即已识别已加载状态并赋予真实 src！
		currentProps = { mounted: true };
		await probe.rerender(currentProps);

		const remountedImg = window.document.querySelector("img");
		assert.ok(remountedImg, "重挂后 img 重新存在");
		assert.equal(
			remountedImg.getAttribute("src"),
			"data:image/png;base64,AAA==",
			"已加载图片在虚拟卸载重挂后，首帧必须立即可用无需再次懒加载！",
		);

		// 6. 验证会话隔离与清理
		removeSessionPresentationState("sess-media-1");
		// 清理后再重挂，媒体状态已重置为 idle
		currentProps = { mounted: false };
		await probe.rerender(currentProps);
		currentProps = { mounted: true };
		await probe.rerender(currentProps);

		const afterCleanupImg = window.document.querySelector("img");
		assert.equal(
			afterCleanupImg.getAttribute("src"),
			null,
			"会话清理后媒体状态必须重置，重新挂载恢复懒加载初始状态",
		);
	});
});
