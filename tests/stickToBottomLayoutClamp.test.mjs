import assert from "node:assert/strict";
import test from "node:test";
import { withHookHost } from "./helpers/l5_hookHost.mjs";
import { isVerticalScrollbarPress } from "../src/renderer/src/lib/stick-to-bottom/scrollIntent.ts";

const NativeEvent = globalThis.Event;

/** Model browser layout clamping separately from its delayed scroll notification. */
class LayoutViewport extends EventTarget {
	#top = 1499;
	#height = 2000;
	clientHeight = 500;
	clientWidth = 400;
	clientLeft = 0;
	clientTop = 0;
	offsetWidth = 416;
	offsetHeight = 500;
	parentElement = null;

	getBoundingClientRect() { return { left: 0, top: 0, width: 416, height: 500 }; }

	get scrollTop() { return this.#top; }
	set scrollTop(value) { this.#top = Math.max(0, Math.min(value, this.#height - this.clientHeight)); }
	get scrollHeight() { return this.#height; }
	set scrollHeight(value) {
		this.#height = value;
		this.scrollTop = this.#top;
	}
}

/** Mount the production hook with independent layout, observer and scroll steps. */
async function mountLayoutEngine(host, initialScrollDelivered = true) {
	const observers = [];
	const timers = [];
	class ResizeObserver {
		constructor(callback) { this.callback = callback; observers.push(this); }
		observe() {}
		disconnect() {}
	}
	const { useStickToBottom } = host.load(
		"src/renderer/src/lib/stick-to-bottom/useStickToBottom.ts",
		{ globals: {
			ResizeObserver,
			setTimeout: (callback) => timers.push(callback),
			clearTimeout: () => undefined,
			performance: { now: () => 1000 },
		} },
	);
	const mounted = await host.mount(useStickToBottom, { initial: "instant", resize: "instant" });
	const viewport = new LayoutViewport();
	const notifyScroll = () => viewport.dispatchEvent(new NativeEvent("scroll"));
	const notifyResize = () => observers.at(-1).callback([{ contentRect: { height: viewport.scrollHeight } }]);
	await host.act(async () => {
		mounted.result().scrollRef(viewport);
		mounted.result().contentRef({});
		if (initialScrollDelivered) notifyScroll();
		notifyResize();
		if (initialScrollDelivered) notifyScroll();
	});
	return {
		viewport, notifyScroll, notifyResize, state: mounted.result().state,
		setViewport: (next) => mounted.result().scrollRef(next),
		restoreAt: (top) => mounted.result().restoreAt(top),
		async unmount() {
			await host.act(async () => {
				mounted.result().scrollRef(null);
				mounted.result().contentRef(null);
			});
			await mounted.unmount();
		},
		async flushFrame() {
			await host.flushFrames();
			await host.act(async () => {
				for (const callback of timers.splice(0)) callback();
			});
		},
	};
}

/** Dispatch only real input evidence, separately from the resulting scroll event. */
function dispatchInput(viewport, type, fields) {
	const event = new NativeEvent(type);
	Object.assign(event, fields);
	viewport.dispatchEvent(event);
}

for (const initialScrollDelivered of [false, true]) {
	for (const observerFirst of [false, true]) {
		test(`a send preserves following with initial scroll ${initialScrollDelivered ? "delivered" : "pending"} and ${observerFirst ? "resize then scroll" : "scroll then resize"}`, async () => {
			await withHookHost(async (host) => {
				const engine = await mountLayoutEngine(host, initialScrollDelivered);
				await host.act(async () => {
					engine.viewport.scrollHeight = 1500;
					assert.equal(engine.viewport.scrollTop, 1000, "the browser clamps the former bottom during collapse");
					engine.viewport.scrollHeight += 48;
					if (observerFirst) engine.notifyResize();
					engine.notifyScroll();
					if (!observerFirst) engine.notifyResize();
				});
				assert.equal(engine.state.isAtBottom, true, "layout movement must retain the existing follow intent");
				assert.equal(engine.state.escapedFromLock, false);
				await host.act(async () => {
					engine.viewport.scrollHeight += 300;
					engine.notifyResize();
				});
				assert.equal(engine.viewport.scrollTop, engine.viewport.scrollHeight - engine.viewport.clientHeight - 1);
				await engine.flushFrame();
			});
		});
	}
}

test("a scrollbar move without a wheel still escapes before the next resize", async () => {
	await withHookHost(async (host) => {
		const engine = await mountLayoutEngine(host);
		await host.act(async () => {
			engine.viewport.scrollTop = 1300;
			engine.notifyScroll();
			engine.viewport.scrollHeight += 300;
			engine.notifyResize();
		});
		assert.equal(engine.state.isAtBottom, false);
		assert.equal(engine.viewport.scrollTop, 1300);
		await engine.flushFrame();
	});
});

test("a bottom restoration retains its range before the first scroll notification", async () => {
	await withHookHost(async (host) => {
		const engine = await mountLayoutEngine(host, false);
		await host.act(async () => {
			engine.restoreAt(1499);
			engine.viewport.scrollHeight = 1500;
			engine.viewport.scrollHeight += 48;
			engine.notifyScroll();
			engine.notifyResize();
		});
		assert.equal(engine.state.isAtBottom, true);
		assert.equal(engine.viewport.scrollTop, 1047);
		await engine.flushFrame();
	});
});

for (const input of ["wheel", "scrollbar", "touch", "keyboard"]) {
	test(`${input} intent still escapes when content shrinks before the scroll notification`, async () => {
		await withHookHost(async (host) => {
			const engine = await mountLayoutEngine(host);
			await host.act(async () => {
				if (input === "wheel") dispatchInput(engine.viewport, "wheel", { deltaY: -40 });
				if (input === "scrollbar") dispatchInput(engine.viewport, "pointerdown", { button: 0, clientX: 410, clientY: 250 });
				if (input === "touch") {
					dispatchInput(engine.viewport, "touchstart", { touches: [{ clientY: 200 }] });
					dispatchInput(engine.viewport, "touchmove", { touches: [{ clientY: 230 }] });
				}
				if (input === "keyboard") dispatchInput(engine.viewport, "keydown", { key: "PageUp" });
				engine.viewport.scrollHeight = 1500;
				engine.viewport.scrollTop = 900;
				engine.notifyScroll();
				engine.notifyResize();
				engine.viewport.scrollHeight += 300;
				engine.notifyResize();
			});
			assert.equal(engine.state.isAtBottom, false);
			assert.equal(engine.state.escapedFromLock, true);
			assert.equal(engine.viewport.scrollTop, 900);
			await engine.flushFrame();
		});
	});
}

test("a content press keeps following through an automatic collapse", async () => {
	await withHookHost(async (host) => {
		const engine = await mountLayoutEngine(host);
		await host.act(async () => {
			dispatchInput(engine.viewport, "pointerdown", { button: 0, clientX: 200, clientY: 250 });
			engine.viewport.scrollHeight = 1500;
			engine.viewport.scrollHeight += 48;
			engine.notifyScroll();
			engine.notifyResize();
		});
		assert.equal(engine.state.isAtBottom, true);
		assert.equal(engine.viewport.scrollTop, 1047);
		await engine.flushFrame();
	});
});

test("replacing the viewport removes old input listeners", async () => {
	await withHookHost(async (host) => {
		const engine = await mountLayoutEngine(host);
		const replacement = new LayoutViewport();
		await host.act(async () => {
			engine.setViewport(replacement);
			dispatchInput(engine.viewport, "wheel", { deltaY: -40 });
		});
		assert.equal(engine.state.isAtBottom, true, "a detached viewport cannot change the current reader intent");
		await host.act(async () => {
			dispatchInput(replacement, "pointerdown", { button: 0, clientX: 410, clientY: 250 });
		});
		assert.equal(engine.state.isAtBottom, false, "the replacement viewport owns the scrollbar input");
		await engine.flushFrame();
	});
});

test("unmounting removes the former viewport's input listeners", async () => {
	await withHookHost(async (host) => {
		const engine = await mountLayoutEngine(host);
		await engine.unmount();
		dispatchInput(engine.viewport, "wheel", { deltaY: -40 });
		dispatchInput(engine.viewport, "pointerdown", { button: 0, clientX: 410, clientY: 250 });
		assert.equal(engine.state.isAtBottom, true);
		assert.equal(engine.state.escapedFromLock, false);
		await engine.flushFrame();
	});
});

test("native scrollbar hit testing distinguishes its gutter from content and nested targets", () => {
	const viewport = new LayoutViewport();
	const press = { target: viewport, button: 0, clientX: 410, clientY: 250 };
	assert.equal(isVerticalScrollbarPress(press, viewport), true);
	assert.equal(isVerticalScrollbarPress({ ...press, clientX: 200 }, viewport), false);
	assert.equal(isVerticalScrollbarPress({ ...press, target: {} }, viewport), false);
	assert.equal(isVerticalScrollbarPress({ ...press, button: 2 }, viewport), false);
	assert.equal(isVerticalScrollbarPress({ ...press, clientX: 420 }, viewport), false);
	assert.equal(isVerticalScrollbarPress({ ...press, clientY: 510 }, viewport), false);
	assert.equal(isVerticalScrollbarPress(press, null), false);
	viewport.scrollHeight = 400;
	assert.equal(isVerticalScrollbarPress(press, viewport), false);
});

test("native scrollbar hit testing supports a left scrollbar in an RTL viewport", () => {
	const viewport = new LayoutViewport();
	viewport.clientLeft = 16;
	const press = { target: viewport, button: 0, clientX: 8, clientY: 250 };
	assert.equal(isVerticalScrollbarPress(press, viewport), true);
	assert.equal(isVerticalScrollbarPress({ ...press, clientX: 100 }, viewport), false);
	assert.equal(isVerticalScrollbarPress({ ...press, clientX: 410 }, viewport), false);
});
