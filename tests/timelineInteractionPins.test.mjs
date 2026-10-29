import test from "node:test";
import assert from "node:assert/strict";
import { withHookHost } from "./helpers/l5_hookHost.mjs";

test("步骤8 Pin 回归测试: editing pin 权威派生自 sessionEditingRowKeysFamily，失焦绝不丢失", async () => {
	await withHookHost(async ({ load, mount, window, act, React }) => {
		const mod = load("src/renderer/src/hooks/useTimelineInteractionPins.ts");
		const { useTimelineInteractionPins } = mod;
		// useTimelineInteractionPins.ts 内部 require("../atoms/timeline-presentation")
		// 通过 loadTsCommonJs 加载，我们把它的 exports 取出即可
		const { sessionEditingRowKeysFamily } = mod;

		const viewport = window.document.createElement("div");
		const sessionId = "sess-pins-test";

		let hookRes;
		let setKeysExternal;
		const jotai = load("node_modules/jotai/index.js");
		const { useSetAtom } = jotai;

		function HostComponent() {
			hookRes = useTimelineInteractionPins({
				viewportRef: { current: viewport },
				sessionId,
			});
			setKeysExternal = useSetAtom(sessionEditingRowKeysFamily(sessionId));
			return hookRes;
		}

		const probe = await mount(
			HostComponent,
			{},
		);

		assert.equal(probe.result().pinnedKeys.size, 0);

		// 模拟用户进入编辑模式（通过组件内部相同 Jotai 作用域写入 sessionEditingRowKeysFamily）
		await act(async () => {
			setKeysExternal(new Set(["row-editing-1"]));
		});

		assert.ok(hookRes.pinnedKeys.has("row-editing-1"), "editing keys 必须被自动钉住！");

		// 模拟焦点进来又失去焦点
		await act(async () => {
			hookRes.acquirePin("row-editing-1", "focus", "dom-focus");
		});
		assert.ok(hookRes.pinnedKeys.has("row-editing-1"));

		await act(async () => {
			hookRes.releasePin("row-editing-1", "focus", "dom-focus");
		});
		assert.ok(hookRes.pinnedKeys.has("row-editing-1"), "失焦后，editing pin 绝不能被卸载！");
	});
});
