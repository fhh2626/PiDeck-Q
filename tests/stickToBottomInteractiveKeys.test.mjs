import assert from "node:assert/strict";
import test from "node:test";
import { withHookHost } from "./helpers/l5_hookHost.mjs";

/** Keep button activation distinct from the browser's vertical navigation keys. */
async function withKeyboardEngine(run) {
	await withHookHost(async (host) => {
		const viewport = host.window.document.createElement("section");
		const content = host.window.document.createElement("div");
		viewport.append(content);
		host.window.document.body.append(viewport);
		host.window.getComputedStyle = () => ({ overflowY: "visible", overscrollBehaviorY: "auto" });
		Object.defineProperties(viewport, {
			scrollHeight: { value: 2000 }, clientHeight: { value: 500 },
			scrollTop: { value: 1500, writable: true },
		});
		class ResizeObserver { observe() {} disconnect() {} }
		const { useStickToBottom } = host.load("src/renderer/src/lib/stick-to-bottom/useStickToBottom.ts", {
			globals: { ResizeObserver, Node: host.window.Node, performance },
		});
		const mounted = await host.mount(useStickToBottom, { initial: "instant", resize: "smooth" });
		await host.act(() => {
			mounted.result().scrollRef(viewport);
			mounted.result().contentRef(content);
			mounted.result().stopScroll();
		});
		await run({
			state: mounted.result().state,
			control(tag, role) {
				const element = host.window.document.createElement(tag);
				if (role) element.setAttribute("role", role);
				content.append(element);
				return element;
			},
			key(target, key, shiftKey = false) {
				return host.act(() => {
					const event = new host.window.Event("keydown", { bubbles: true, cancelable: true });
					Object.assign(event, { key, shiftKey });
					target.dispatchEvent(event);
				});
			},
		});
		await host.act(() => {
			mounted.result().scrollRef(null);
			mounted.result().contentRef(null);
		});
	});
}

for (const [tag, role] of [["button"], ["summary"], ["div", "button"]]) {
	test(`Space activation on ${role ? `role=${role}` : tag} does not restore timeline following`, async () => {
		await withKeyboardEngine(async (engine) => {
			const control = engine.control(tag, role);
			await engine.key(control, " ");
			assert.equal(engine.state.isAtBottom, false, "activating a transcript control must preserve the reader's intent");
		});
	});
}

test("a focused button still permits directional keyboard scrolling", async () => {
	await withKeyboardEngine(async (engine) => {
		const control = engine.control("button");
		await engine.key(control, "ArrowDown");
		assert.equal(engine.state.isAtBottom, true);
		await engine.key(control, "ArrowUp");
		assert.equal(engine.state.isAtBottom, false);
	});
});
