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

		// A new one-pixel gesture can arrive before its own scroll event.
		viewport.scrollTop = 29;
		firstHeight = 60;
		const observer = ControllableResizeObserver.instances.find((entry) => entry.observed.has(first));
		await act(() => observer.dispatchEntries([
			ControllableResizeObserver.createEntry(first, { height: 60 }),
			ControllableResizeObserver.createEntry(tall, { height: 800 }),
		]));
		await flushFrames();
		assert.equal(viewport.scrollTop, 9);
		assert.equal(tall.getBoundingClientRect().top, 63);
	});
});

async function checkUpwardSpacerLanding(mode) {
	await withHookHost(async ({ React, load, mount, window, act, flushFrames }) => {
		ControllableResizeObserver.reset();
		const { useVirtualTimeline } = load("src/renderer/src/hooks/useVirtualTimeline.ts", {
			globals: { ResizeObserver: ControllableResizeObserver },
		});
		const viewport = window.document.createElement("div");
		Object.defineProperties(viewport, {
			scrollTop: { value: 1300, writable: true }, clientTop: { value: 0 },
			clientHeight: { value: 300 }, scrollHeight: { value: 4000 },
		});
		viewport.getBoundingClientRect = () => rect(0, 300);
		const list = window.document.createElement("div");
		list.getBoundingClientRect = () => rect(-viewport.scrollTop, 4000);
		viewport.append(list);
		window.document.elementFromPoint = () => list;
		const items = Array.from({ length: 20 }, (_, i) => ({ kind: "message", message: {
			id: `m-${i}`, agentId: "agent", role: "user", text: "fixture", timestamp: i,
		} }));
		const viewportRef = { current: viewport }, listRef = { current: list }, adapterRef = { current: null };
		const key = "message:m-2";
		const probe = await mount((props) => {
			// Simulate the row ref's measurement during the commit, before the
			// virtualizer's own layout effect sees this render's geometry.
			React.useLayoutEffect(() => {
				if (props.node) timeline.registerRowNode(key, props.node);
			}, [props.node]);
			const timeline = useVirtualTimeline({
				items: props.items, viewportRef, listRef, adapterRef, isFollowing: false,
				applyReaderScrollTop(top) { viewport.scrollTop = top; },
			});
			return timeline;
		}, { items });
		const { prefixOffsets, heights } = probe.result().geometry;
		const index = 2;
		const distanceFromEnd = 114;
		const node = window.document.createElement("div");
		node.setAttribute("data-timeline-row-key", key);
		node.setAttribute("data-timeline-measure-key", key);
		const lazy = ["lazy code expansion", "width change during lazy expansion", "width change with settled Markdown", "resize returns to cached height"].includes(mode);
		let realHeight = lazy ? 312 : 900;
		const placeholder = window.document.createElement("div");
		placeholder.setAttribute("data-md-plain-stream", "1");
		if (lazy) node.append(placeholder);
		node.getBoundingClientRect = () => rect(prefixOffsets[index] - viewport.scrollTop, realHeight);
		const landing = prefixOffsets[index] + heights[index] - distanceFromEnd;
		const spacer = window.document.createElement("div");
		spacer.setAttribute("data-virtual-spacer", "spacer:0-3");
		spacer.getBoundingClientRect = () => rect(-viewport.scrollTop, prefixOffsets[3]);
		list.append(spacer);
		if (mode === "lower mounted hit") {
			const lower = window.document.createElement("div");
			lower.setAttribute("data-timeline-row-key", "message:m-3");
			lower.getBoundingClientRect = () => rect(prefixOffsets[3] - viewport.scrollTop, 180);
			list.append(lower);
			await act(() => probe.result().registerRowNode("message:m-3", lower));
			window.document.elementFromPoint = (_x, y) => y >= lower.getBoundingClientRect().top ? lower : list;
		}
		if (mode === "pending scroll before append") probe.result().captureReadingAnchor();
		await act(() => {
			viewport.scrollTop = landing;
			if (mode !== "pending scroll before append") viewport.dispatchEvent(new window.Event("scroll"));
			if (mode === "small reversal") {
				viewport.scrollTop += 20;
				viewport.dispatchEvent(new window.Event("scroll"));
			}
		});
		const appended = [...items, { kind: "message", message: { ...items[0].message, id: "tail" } }];
		if (mode === "pending scroll before append") await probe.rerender({ items: appended });
		spacer.remove();
		if (mode === "lower mounted hit") list.prepend(node);
		else list.append(node);
		if (mode === "ref measurement during append") await probe.rerender({ items: appended, node });
		else await act(() => probe.result().registerRowNode(key, node));
		await flushFrames();
		const containerObserver = ControllableResizeObserver.instances.find((entry) => entry.observed.has(list));
		const notifyWidth = (width) => act(() => containerObserver.dispatchEntries([
			ControllableResizeObserver.createEntry(list, { width, height: 4000 }),
		]));
		if (lazy) {
			assert.equal(node.getBoundingClientRect().bottom, distanceFromEnd);
			if (mode === "width change during lazy expansion") {
				await notifyWidth(800);
				realHeight = 360;
				await notifyWidth(600);
			}
			if (mode === "resize returns to cached height") {
				const observer = ControllableResizeObserver.instances.find((entry) => entry.observed.has(node));
				await act(() => {
					observer.dispatchEntries([ControllableResizeObserver.createEntry(node, { height: 900 })]);
					observer.dispatchEntries([ControllableResizeObserver.createEntry(node, { height: realHeight })]);
				});
				await flushFrames();
				assert.equal(probe.result().geometry.heights[index], realHeight);
				return;
			}
			if (mode === "width change with settled Markdown") await notifyWidth(800);
			placeholder.remove();
			realHeight = 900;
			if (mode === "width change with settled Markdown") await notifyWidth(600);
			else {
				const observer = ControllableResizeObserver.instances.find((entry) => entry.observed.has(node));
				await act(() => observer.dispatchEntries([ControllableResizeObserver.createEntry(node, { height: realHeight })]));
				await flushFrames();
			}
		}
		const expected = distanceFromEnd - (mode === "small reversal" ? 20 : 0);
		assert.equal(node.getBoundingClientRect().bottom, expected);
		assert.equal(probe.result().captureReadingAnchor().anchor.offsetTop, expected - 900);
		if (["later width reflow", "width change with settled Markdown", "width change after restoring the mounted row"].includes(mode)) {
			await notifyWidth(800);
			if (mode === "width change after restoring the mounted row") {
				await act(() => assert.equal(adapterRef.current.restoreMessage("m-2", expected - 900, { offsetBottom: expected }), true));
			}
			realHeight = 1200;
			await notifyWidth(600);
			assert.equal(node.getBoundingClientRect().top, expected - 900);
		}
	});
}

for (const mode of ["plain landing", "lower mounted hit", "pending scroll before append", "ref measurement during append", "small reversal", "lazy code expansion", "width change during lazy expansion", "width change with settled Markdown", "resize returns to cached height", "later width reflow", "width change after restoring the mounted row"]) {
	test(`upward input keeps the distance to a newly mounted tall row's end: ${mode}`, () => checkUpwardSpacerLanding(mode));
}

const cases = [
	{ name: "tail append before height commit", append: true, growth: 0, listOrigin: 0, viewportTop: 0, border: 0 },
	{ name: "same-id tail update before height commit with a viewport border and list offset", append: false, growth: 0, listOrigin: 20, viewportTop: 50, border: 2 },
	{ name: "additional DOM growth before tail append and height commit", append: true, growth: 40, listOrigin: 0, viewportTop: 0, border: 0 },
	{ name: "partial measurement batches separated by another tail update", append: true, growth: 0, listOrigin: 0, viewportTop: 0, border: 0, partial: true },
	{ name: "a pending user scroll event before the tail render", append: true, growth: 0, listOrigin: 0, viewportTop: 0, border: 0, pendingScroll: -20 },
	{ name: "a native user scroll before the preceding row's growth is committed", append: true, growth: 40, listOrigin: 0, viewportTop: 0, border: 0, pendingScroll: -20, deliverScroll: true },
	{ name: "a one-pixel move into the gap during preceding-row growth", append: true, growth: 40, listOrigin: 0, viewportTop: 0, border: 0, pendingScroll: -1, deliverScroll: true, startsAtRowTop: true },
	{ name: "a native user scroll after jumping to a row while its prefix grows", append: true, growth: 40, listOrigin: 0, viewportTop: 0, border: 0, pendingScroll: 120, deliverScroll: true, jumpFirst: true },
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
			const initialScrollTop = scenario.startsAtRowTop ? 112 : 250;
			Object.defineProperties(viewport, {
				scrollTop: { value: initialScrollTop, writable: true }, clientTop: { value: scenario.border },
				clientHeight: { value: 300 }, scrollHeight: { value: 3000 },
			});
			const viewportOrigin = scenario.viewportTop + scenario.border;
			viewport.getBoundingClientRect = () => rect(scenario.viewportTop, 300 + scenario.border);
			const list = window.document.createElement("div");
			list.getBoundingClientRect = () => rect(viewportOrigin + scenario.listOrigin - viewport.scrollTop, 1500);
			const viewportRef = { current: viewport }, listRef = { current: list }, adapterRef = { current: null };
			const item = (i) => ({ kind: "message", message: {
				id: `m-${i}`, agentId: "agent", role: "user", text: "fixture", timestamp: i,
			} });
			const items = [0, 1, 2, 3].map(item);
			const probe = await mount((props) => useVirtualTimeline({
				items: props.items, viewportRef, listRef, adapterRef, isFollowing: false, sessionId: "anchor-commit-order",
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
			await act(() => {
				probe.result().registerRowNode("message:m-0", first);
				probe.result().registerRowNode("message:m-1", tall);
			});
			if (scenario.jumpFirst) await act(() => assert.equal(adapterRef.current.jumpToMessage("m-1"), true));
			const beforeScrollTop = viewport.scrollTop;
			const reading = probe.result().captureReadingAnchor();
			const originalRowTop = tall.getBoundingClientRect().top;
			assert.equal(reading.anchor.offsetTop, originalRowTop - viewportOrigin);

			// Only DOM changes are available here; no row measurement was delivered.
			firstHeight += scenario.growth;
			const pendingScroll = scenario.pendingScroll ?? 0;
			viewport.scrollTop += pendingScroll;
			if (scenario.startsAtRowTop) window.document.elementFromPoint = () => first;
			if (scenario.deliverScroll) await act(() => viewport.dispatchEvent(new window.Event("scroll")));
			const expectedScrollTop = beforeScrollTop + scenario.growth + pendingScroll;
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
