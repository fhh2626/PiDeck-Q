import test from "node:test";
import assert from "node:assert/strict";
import { withHookHost } from "./helpers/l5_hookHost.mjs";

test("步骤7动效Pin测试: animationend/cancel 释放、600ms 超时兜底、reduced-motion 旁路与 messageId 映射", async () => {
	await withHookHost(async ({ React, load, mount, act, window }) => {
		const atomMod = load("src/renderer/src/atoms/timeline-presentation.ts");
		const mod = load("src/renderer/src/hooks/useTimelineInteractionPins.ts", {
			stubs: {
				"../atoms/timeline-presentation": atomMod,
			},
		});
		const { useTimelineInteractionPins } = mod;

		const viewportRef = { current: window.document.createElement("div") };
		window.document.body.appendChild(viewportRef.current);

		let hookResult;
		let reducedMotion = false;

		window.matchMedia = (query) => ({
			matches: query.includes("prefers-reduced-motion") ? reducedMotion : false,
			media: query,
			onchange: null,
			addListener: () => {},
			removeListener: () => {},
			addEventListener: () => {},
			removeEventListener: () => {},
			dispatchEvent: () => false,
		});

		const probe = await mount(() => {
			hookResult = useTimelineInteractionPins({
				viewportRef,
				sessionId: "sess-anim-1",
			});
			return hookResult;
		});

		assert.equal(probe.result().pinnedKeys.size, 0, "初始状态下 pinnedKeys 为空");

		// 1. 正常动画流程：绑定元素与 animationend
		const animTarget = window.document.createElement("div");
		viewportRef.current.appendChild(animTarget);

		let cleanupAnim;
		act(() => {
			cleanupAnim = probe.result().pinActiveAnimation("row:anim-1", animTarget);
		});

		assert.ok(probe.result().pinnedKeys.has("row:anim-1"), "动画开始后必须将 rowKey 钉住");

		// 触发 animationend
		act(() => {
			animTarget.dispatchEvent(new window.Event("animationend"));
		});

		assert.ok(
			!probe.result().pinnedKeys.has("row:anim-1"),
			"animationend 触发后必须立即释放动画 Pin",
		);

		// 2. 600ms 超时兜底测试（如果目标元素未触发任何动效事件）
		act(() => {
			probe.result().pinActiveAnimation("row:timeout-1", null);
		});
		assert.ok(probe.result().pinnedKeys.has("row:timeout-1"), "无元素时也先暂扣 pin");

		// 等待 650ms 超过 600ms 兜底计时器
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 650));
		});

		assert.ok(
			!probe.result().pinnedKeys.has("row:timeout-1"),
			"超过 600ms 安全兜底时间后，无事件响应的动画 Pin 必须自动释放！",
		);

		// 3. prefers-reduced-motion 减弱动效测试
		reducedMotion = true;
		act(() => {
			cleanupAnim = probe.result().pinActiveAnimation("row:reduced-1", animTarget);
		});
		assert.ok(
			!probe.result().pinnedKeys.has("row:reduced-1"),
			"开启 prefers-reduced-motion 时必须跳过动画 Pin！",
		);
		reducedMotion = false;

		// 4. messageId 映射到顶层 rowKey
		const rowKeyByMessageId = new Map([
			["msg-child-10", "run:parent-run-1"],
			["msg-child-20", "run:parent-run-1"],
		]);

		act(() => {
			probe.result().pinAnimationByMessageId("msg-child-10", rowKeyByMessageId, animTarget);
		});
		assert.ok(
			probe.result().pinnedKeys.has("run:parent-run-1"),
			"messageId 必须映射并钉住顶层父行 run:parent-run-1",
		);

		// 未知 messageId 不产生 pin
		act(() => {
			probe.result().pinAnimationByMessageId("unknown-message-id", rowKeyByMessageId, animTarget);
		});
		assert.equal(
			probe.result().pinnedKeys.has("unknown-message-id"),
			false,
			"未知 messageId 绝不能直接作为 pin key 推入",
		);
	});
});
