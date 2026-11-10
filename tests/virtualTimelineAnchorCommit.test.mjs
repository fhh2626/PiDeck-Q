import test from "node:test";
import assert from "node:assert/strict";
import { withHookHost } from "./helpers/l5_hookHost.mjs";
import { ControllableResizeObserver } from "./helpers/controllableResizeObserver.mjs";

/** Full rectangles keep viewport borders/list offsets independent of row estimates. */
function rect(top, height) {
	return { x: 0, y: top, top, bottom: top + height, left: 0, right: 800, width: 800, height, toJSON() { return {}; } };
}

test("programmatic preservation scrolls do not replace the pending reader anchor", async () => {
	await withHookHost(async ({ load, mount, window, act, flushFrames }) => {
		ControllableResizeObserver.reset();
		globalThis.ResizeObserver = ControllableResizeObserver;
		window.ResizeObserver = ControllableResizeObserver;
		const { useVirtualTimeline } = load("src/renderer/src/hooks/useVirtualTimeline.ts", {
			globals: { ResizeObserver: ControllableResizeObserver },
		});
		const viewport = window.document.createElement("div");
		Object.defineProperties(viewport, {
			scrollTop: { value: 50, writable: true }, clientTop: { value: 0 },
			clientHeight: { value: 300 }, scrollHeight: { value: 3000 },
		});
		viewport.getBoundingClientRect = () => rect(0, 300);
		const list = window.document.createElement("div");
		list.getBoundingClientRect = () => rect(-viewport.scrollTop, 1500);
		const viewportRef = { current: viewport }, listRef = { current: list };
		const item = (i) => ({ kind: "message", message: { id: `m-${i}`, agentId: "agent", role: "user", text: "fixture", timestamp: i } });
		const items = [0, 1, 2, 3].map(item);
		const probe = await mount((props) => useVirtualTimeline({
			items: props.items, viewportRef, listRef, isFollowing: false, sessionId: "preserve-scroll-not-input",
			applyReaderScrollTop(top) { viewport.scrollTop = top; },
		}), { items });
		let firstHeight = 100;
		const first = window.document.createElement("div");
		first.setAttribute("data-timeline-row-key", "message:m-0");
		first.setAttribute("data-timeline-measure-key", "message:m-0");
		first.getBoundingClientRect = () => rect(-viewport.scrollTop, firstHeight);
		const tall = window.document.createElement("div");
		tall.setAttribute("data-timeline-row-key", "message:m-1");
		tall.setAttribute("data-timeline-measure-key", "message:m-1");
		tall.getBoundingClientRect = () => rect(firstHeight + 12 - viewport.scrollTop, 800);
		viewport.append(first, tall);
		window.document.elementFromPoint = () => tall;
		// The earlier row is still a virtual placeholder when intent is captured.
		probe.result().registerRowNode("message:m-1", tall);
		assert.equal(probe.result().captureReadingAnchor().anchor.offsetTop, 62);

		firstHeight = 80;
		probe.result().registerRowNode("message:m-0", first);
		await probe.rerender({ items: [...items, item(4)] });
		assert.equal(viewport.scrollTop, 30);
		// That preservation write emits a native scroll notification. It is not
		// another user gesture, even though the topmost hit is now a different row.
		window.document.elementFromPoint = () => first;
		await act(() => viewport.dispatchEvent(new window.Event("scroll")));
		assert.equal(probe.result().captureReadingAnchor().anchor.messageId, "m-1");

		firstHeight = 60;
		const observer = ControllableResizeObserver.instances.find((entry) => entry.observed.has(first));
		await act(() => observer.dispatchEntries([
			ControllableResizeObserver.createEntry(first, { height: 60 }),
			ControllableResizeObserver.createEntry(tall, { height: 800 }),
		]));
		await flushFrames();
		assert.equal(viewport.scrollTop, 10);
		assert.equal(tall.getBoundingClientRect().top, 62);
	});
});

const cases = [
	{ name: "tail append before height commit", append: true, growth: 0, listOrigin: 0, viewportTop: 0, border: 0 },
	{ name: "same-id tail update before height commit with a viewport border and list offset", append: false, growth: 0, listOrigin: 20, viewportTop: 50, border: 2 },
	{ name: "additional DOM growth before tail append and height commit", append: true, growth: 40, listOrigin: 0, viewportTop: 0, border: 0 },
	{ name: "partial measurement batches separated by another tail update", append: true, growth: 0, listOrigin: 0, viewportTop: 0, border: 0, partial: true },
	{ name: "a pending user scroll event before the tail render", append: true, growth: 0, listOrigin: 0, viewportTop: 0, border: 0, pendingScroll: -20 },
];

for (const scenario of cases) {
	test(`DOM reading anchor remains stable through ${scenario.name}`, async () => {
		await withHookHost(async ({ load, mount, window, act, flushFrames }) => {
			ControllableResizeObserver.reset();
			globalThis.ResizeObserver = ControllableResizeObserver;
			window.ResizeObserver = ControllableResizeObserver;
			const { useVirtualTimeline } = load("src/renderer/src/hooks/useVirtualTimeline.ts", {
				globals: { ResizeObserver: ControllableResizeObserver },
			});
			const viewport = window.document.createElement("div");
			Object.defineProperties(viewport, {
				scrollTop: { value: 250, writable: true }, clientTop: { value: scenario.border },
				clientHeight: { value: 300 }, scrollHeight: { value: 3000 },
			});
			const viewportOrigin = scenario.viewportTop + scenario.border;
			viewport.getBoundingClientRect = () => rect(scenario.viewportTop, 300 + scenario.border);
			const list = window.document.createElement("div");
			list.getBoundingClientRect = () => rect(viewportOrigin + scenario.listOrigin - viewport.scrollTop, 1500);
			const viewportRef = { current: viewport }, listRef = { current: list };
			const item = (i) => ({ kind: "message", message: {
				id: `m-${i}`, agentId: "agent", role: "user", text: "fixture", timestamp: i,
			} });
			const items = [0, 1, 2, 3].map(item);
			const probe = await mount((props) => useVirtualTimeline({
				items: props.items, viewportRef, listRef, isFollowing: false, sessionId: "anchor-commit-order",
				applyReaderScrollTop(top) { viewport.scrollTop = top; },
			}), { items });

			let firstHeight = 100;
			const first = window.document.createElement("div");
			first.setAttribute("data-timeline-row-key", "message:m-0");
			first.setAttribute("data-timeline-measure-key", "message:m-0");
			first.getBoundingClientRect = () => rect(viewportOrigin + scenario.listOrigin - viewport.scrollTop, firstHeight);
			const tall = window.document.createElement("div");
			tall.setAttribute("data-timeline-row-key", "message:m-1");
			tall.setAttribute("data-timeline-measure-key", "message:m-1");
			tall.getBoundingClientRect = () => rect(viewportOrigin + scenario.listOrigin + firstHeight + 12 - viewport.scrollTop, 800);
			viewport.append(first, tall);
			window.document.elementFromPoint = () => tall;
			probe.result().registerRowNode("message:m-0", first);
			probe.result().registerRowNode("message:m-1", tall);
			const reading = probe.result().captureReadingAnchor();
			const originalRowTop = tall.getBoundingClientRect().top;
			assert.equal(reading.anchor.offsetTop, originalRowTop - viewportOrigin);

			// Only DOM changes are available here; no row measurement was delivered.
			firstHeight += scenario.growth;
			const pendingScroll = scenario.pendingScroll ?? 0;
			viewport.scrollTop += pendingScroll;
			const expectedScrollTop = 250 + scenario.growth + pendingScroll;
			const expectedRowTop = originalRowTop - pendingScroll;
			assert.equal(probe.result().captureReadingAnchor().anchor.offsetTop, reading.anchor.offsetTop - pendingScroll);
			const nextItems = scenario.append ? [...items, item(4)] : items.map((entry, index) =>
				index === 3 ? { ...entry, message: { ...entry.message, text: "updated tail" } } : entry);
			await probe.rerender({ items: nextItems });
			assert.equal(viewport.scrollTop, expectedScrollTop, "a tail render must not resolve a real DOM anchor through stale prefix estimates or undo pending user input");
			assert.equal(tall.getBoundingClientRect().top, expectedRowTop);

			// A browser scroll event after the interim commit must not make a wrong
			// correction sticky before the ResizeObserver batch finally commits.
			await act(() => viewport.dispatchEvent(new window.Event("scroll")));
			const observer = () => ControllableResizeObserver.instances.find((entry) => entry.observed.has(tall));
			assert.ok(observer());
			if (scenario.partial) {
				await act(() => observer().dispatchEntries([
					ControllableResizeObserver.createEntry(first, { height: firstHeight }),
				]));
				await flushFrames();
				assert.equal(viewport.scrollTop, expectedScrollTop);
				assert.equal(tall.getBoundingClientRect().top, expectedRowTop);
				await probe.rerender({ items: [...nextItems, item(5)] });
				assert.equal(viewport.scrollTop, expectedScrollTop);
				assert.equal(tall.getBoundingClientRect().top, expectedRowTop);
			}
			await act(() => observer().dispatchEntries([
				ControllableResizeObserver.createEntry(first, { height: firstHeight }),
				ControllableResizeObserver.createEntry(tall, { height: 800 }),
			]));
			await flushFrames();
			assert.equal(viewport.scrollTop, expectedScrollTop);
			assert.equal(tall.getBoundingClientRect().top, expectedRowTop);
		});
	});
}
