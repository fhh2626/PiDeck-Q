import assert from "node:assert/strict";
import test from "node:test";
import { withHookHost } from "./helpers/l5_hookHost.mjs";

/** Run the real engine with DOM bubbling and independently delivered frames/scrolls. */
async function withNestedEngine(run) {
	await withHookHost(async (host) => {
		const observers = [], timers = new Map(), styles = new WeakMap();
		let timerId = 0, now = 10_000, top = 1499;
		class ResizeObserver {
			constructor(callback) { this.callback = callback; observers.push(this); }
			observe() {}
			disconnect() {}
		}
		class ClockDate extends Date { static now() { return now; } }
		const viewport = host.window.document.createElement("section");
		const content = host.window.document.createElement("div");
		viewport.append(content);
		host.window.document.body.append(viewport);
		host.window.getComputedStyle = (node) => styles.get(node)
			?? { overflowY: "visible", overscrollBehaviorY: "auto" };
		Object.defineProperties(viewport, {
			scrollHeight: { value: 2000, writable: true },
			clientHeight: { value: 500 },
			scrollTop: {
				get: () => (top = Math.max(0, Math.min(viewport.scrollHeight - viewport.clientHeight, top))),
				set: (value) => { top = Math.max(0, Math.min(viewport.scrollHeight - viewport.clientHeight, Math.round(value))); },
			},
		});
		const { useStickToBottom } = host.load("src/renderer/src/lib/stick-to-bottom/useStickToBottom.ts", {
			globals: {
				ResizeObserver, Node: host.window.Node, Date: ClockDate, performance: { now: () => now },
				setTimeout: (callback, delay = 0) => { const id = ++timerId; timers.set(id, { callback, at: now + delay }); return id; },
				clearTimeout: (id) => timers.delete(id),
			},
		});
		const mounted = await host.mount(useStickToBottom, { initial: "instant", resize: "smooth" });
		const resize = () => observers.at(-1).callback([{ contentRect: { height: viewport.scrollHeight } }]);
		const scroll = () => viewport.dispatchEvent(new host.window.Event("scroll"));
		const dispatch = (target, type, fields = {}, prevented = false) => {
			const event = new host.window.Event(type, { bubbles: true, cancelable: true });
			Object.assign(event, fields);
			if (prevented) event.preventDefault();
			target.dispatchEvent(event);
		};
		const frame = async () => {
			now += 16;
			await host.flushFrames();
			await host.act(() => {
				for (const [id, timer] of timers) {
					if (timer.at > now) continue;
					timers.delete(id);
					timer.callback();
				}
			});
		};
		await host.act(() => {
			mounted.result().scrollRef(viewport);
			mounted.result().contentRef(content);
			resize();
			scroll();
		});
		await frame();
		await run({
			viewport, content, state: mounted.result().state,
			/** Add a scroll container without conflating its range with its overflow policy. */
			nested({ parent = content, scrollTop = 0, range = 350, overflowY = "auto", overscrollBehaviorY = "auto" } = {}) {
				const node = host.window.document.createElement("pre");
				Object.defineProperties(node, {
					scrollTop: { value: scrollTop, writable: true },
					scrollHeight: { value: 150 + range },
					clientHeight: { value: 150 },
				});
				styles.set(node, { overflowY, overscrollBehaviorY });
				parent.append(node);
				return node;
			},
			async input(kind, target, direction = "up") {
				await host.act(() => {
					if (kind === "wheel") dispatch(target, "wheel", { deltaY: direction === "up" ? -80 : 80 });
					if (kind === "keyboard") dispatch(target, "keydown", { key: direction === "up" ? "PageUp" : "PageDown" });
					if (kind === "touch") {
						dispatch(target, "touchstart", { touches: [{ clientY: 200 }] });
						dispatch(target, "touchmove", { touches: [{ clientY: direction === "up" ? 230 : 170 }] });
					}
				});
			},
			emit: (target, type, fields, prevented) => host.act(() => dispatch(target, type, fields, prevented)),
			retain: () => host.act(resize),
			enterReaderAtBottom: () => host.act(() => mounted.result().stopScroll()),
			restoreAt: (value, options) => host.act(() => mounted.result().restoreAt(value, options)),
			returnToBottom: () => host.act(() => { void mounted.result().scrollToBottom({ animation: "smooth" }); }),
			notifyScroll: () => host.act(scroll),
			frame,
			async settle() {
				for (let index = 0; index < 100 && host.pendingFrames(); index += 1) await frame();
				assert.equal(host.pendingFrames(), 0, "the idle spring must settle within the bounded frame drain");
			},
		});
		await host.act(() => {
			mounted.result().scrollRef(null);
			mounted.result().contentRef(null);
		});
	});
}

for (const kind of ["wheel", "touch", "keyboard"]) {
	test(`${kind} chaining above an inner top escapes before an idle animation can overwrite the scroll`, async () => {
		await withNestedEngine(async (engine) => {
			const inner = engine.nested();
			await engine.retain();
			await engine.input(kind, inner);
			engine.viewport.scrollTop -= 80;
			const readingTop = engine.viewport.scrollTop;
			await engine.frame();
			await engine.notifyScroll();
			await engine.settle();
			assert.equal(engine.state.isAtBottom, false);
			assert.equal(engine.viewport.scrollTop, readingTop, "a retained idle spring cannot erase the outer reading gesture");
		});
	});

	test(`${kind} remains owned by an inner container that can still scroll upward`, async () => {
		await withNestedEngine(async (engine) => {
			const inner = engine.nested({ scrollTop: 120 });
			await engine.retain();
			await engine.input(kind, inner);
			inner.scrollTop -= 80;
			await engine.settle();
			assert.equal(engine.state.isAtBottom, true);
			assert.equal(engine.viewport.scrollTop, 1499);
		});
	});

	test(`${kind} checks intermediate ancestors before assigning the gesture to the timeline`, async () => {
		await withNestedEngine(async (engine) => {
			const middle = engine.nested({ scrollTop: 120 });
			const inner = engine.nested({ parent: middle });
			await engine.input(kind, inner);
			middle.scrollTop -= 80;
			assert.equal(engine.state.isAtBottom, true);
			assert.equal(engine.viewport.scrollTop, 1499);
		});
	});
}

for (const overscrollBehaviorY of ["contain", "none"]) {
	for (const range of [0, 350]) {
		test(`${overscrollBehaviorY} blocks upward chaining even with an inner range of ${range}`, async () => {
			await withNestedEngine(async (engine) => {
				const inner = engine.nested({ range, overscrollBehaviorY });
				await engine.input("wheel", inner);
				assert.equal(engine.state.isAtBottom, true);
				assert.equal(engine.viewport.scrollTop, 1499);
			});
		});
	}
}

for (const overflowY of ["visible", "clip"]) {
	test(`${overflowY} is not a scroll container even when its overscroll declaration is contain`, async () => {
		await withNestedEngine(async (engine) => {
			const inner = engine.nested({ overflowY, overscrollBehaviorY: "contain" });
			await engine.input("wheel", inner);
			assert.equal(engine.state.isAtBottom, false);
		});
	});
}

test("a text event target follows its element ancestors when deciding scroll ownership", async () => {
	await withNestedEngine(async (engine) => {
		const inner = engine.nested();
		const text = inner.ownerDocument.createTextNode("code");
		inner.append(text);
		await engine.input("wheel", text);
		assert.equal(engine.state.isAtBottom, false);
	});
});

for (const kind of ["wheel", "touch", "keyboard"]) {
	test(`${kind} down inside a nested scroll owner cannot restore outer following`, async () => {
		await withNestedEngine(async (engine) => {
			const inner = engine.nested();
			await engine.enterReaderAtBottom();
			await engine.input(kind, inner, "down");
			assert.equal(engine.state.isAtBottom, false);
		});
	});

	test(`${kind} down can return a physically bottomed reader to following without a scroll event`, async () => {
		await withNestedEngine(async (engine) => {
			const inner = engine.nested({ scrollTop: 350 });
			await engine.enterReaderAtBottom();
			await engine.input(kind, inner, "down");
			assert.equal(engine.state.isAtBottom, true);
			assert.equal(engine.state.escapedFromLock, false);
		});
	});

	test(`${kind} down can resume following after content shrinks below the viewport height`, async () => {
		await withNestedEngine(async (engine) => {
			await engine.enterReaderAtBottom();
			engine.viewport.scrollHeight = 400;
			assert.equal(engine.viewport.scrollTop, 0);
			await engine.input(kind, engine.viewport, "down");
			assert.equal(engine.state.isAtBottom, true);
			assert.equal(engine.state.escapedFromLock, false);
		});
	});
}

test("an obsolete reader correction leaves a newer return-to-bottom animation running", async () => {
	await withNestedEngine(async (engine) => {
		await engine.restoreAt(1100);
		await engine.returnToBottom();
		await engine.frame();
		const before = engine.viewport.scrollTop;
		await engine.restoreAt(800, { preserveFollowState: true });
		assert.equal(engine.viewport.scrollTop, before, "the older anchor must not write over the new navigation");
		await engine.settle();
		assert.equal(engine.viewport.scrollTop, 1499, "the current spring must still finish without another resize");
		assert.equal(engine.state.isAtBottom, true);
	});
});

test("small touch movements accumulate enough upward intent to leave following", async () => {
	await withNestedEngine(async (engine) => {
		await engine.emit(engine.viewport, "touchstart", { touches: [{ clientY: 200 }] });
		await engine.emit(engine.viewport, "touchmove", { touches: [{ clientY: 201 }] });
		await engine.emit(engine.viewport, "touchmove", { touches: [{ clientY: 202 }] });
		await engine.emit(engine.viewport, "touchmove", { touches: [{ clientY: 203 }] });
		assert.equal(engine.state.isAtBottom, false);
	});
});

test("a touch gesture can resume at the bottom and reverse upward before a scroll notification", async () => {
	await withNestedEngine(async (engine) => {
		await engine.enterReaderAtBottom();
		await engine.emit(engine.viewport, "touchstart", { touches: [{ clientY: 200 }] });
		await engine.emit(engine.viewport, "touchmove", { touches: [{ clientY: 160 }] });
		assert.equal(engine.state.isAtBottom, true);
		await engine.retain();
		await engine.emit(engine.viewport, "touchmove", { touches: [{ clientY: 170 }] });
		engine.viewport.scrollTop -= 10;
		await engine.frame();
		await engine.notifyScroll();
		await engine.settle();
		assert.equal(engine.state.isAtBottom, false);
		assert.equal(engine.viewport.scrollTop, 1489);
	});
});

test("ordinary, modified and prevented editor keys do not change timeline follow intent", async () => {
	await withNestedEngine(async (engine) => {
		const input = engine.content.ownerDocument.createElement("textarea");
		engine.content.append(input);
		await engine.emit(input, "keydown", { key: "PageUp" });
		assert.equal(engine.state.isAtBottom, true);
		await engine.enterReaderAtBottom();
		await engine.emit(input, "keydown", { key: "PageDown" });
		await engine.emit(engine.viewport, "keydown", { key: "PageDown", ctrlKey: true });
		await engine.emit(engine.viewport, "keydown", { key: "PageDown" }, true);
		assert.equal(engine.state.isAtBottom, false);
	});
});

test("modified and prevented wheel gestures cannot restore following at the bottom", async () => {
	await withNestedEngine(async (engine) => {
		await engine.enterReaderAtBottom();
		await engine.emit(engine.viewport, "wheel", { deltaY: 80, ctrlKey: true });
		await engine.emit(engine.viewport, "wheel", { deltaY: 80, shiftKey: true });
		await engine.emit(engine.viewport, "wheel", { deltaY: 80 }, true);
		assert.equal(engine.state.isAtBottom, false);
	});
});
