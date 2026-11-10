import test from "node:test";
import assert from "node:assert/strict";
import { withHookHost } from "./helpers/l5_hookHost.mjs";
import { ControllableResizeObserver } from "./helpers/controllableResizeObserver.mjs";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { captureMountedTimelineAnchor, resolveMountedTimelineAnchorScrollTop } = loadTsCommonJs("src/renderer/src/hooks/timelineMountedAnchor.ts");
const { buildTimelineRowModel, computeTimelineGeometry } = loadTsCommonJs("src/renderer/src/components/session/timeline/virtualTimelineGeometry.ts");

/** A real DOM position independent of the virtualizer's pending height cache. */
function rect(top, height) {
	return { x: 0, y: top, top, bottom: top + height, left: 0, right: 800, width: 800, height, toJSON() { return {}; } };
}

function mountedFixture(boxes, overrides = {}) {
	const items = [0, 1, 2].map((i) => ({ kind: "message", message: {
		id: `m-${i}`, agentId: "agent", role: "user", text: "fixture", timestamp: i,
	} }));
	const geometry = overrides.geometry ?? computeTimelineGeometry(buildTimelineRowModel(items).rows, new Map(), 12);
	const nodes = new Map(boxes.map(({ index, top, height, ...fields }, lease) => {
		const key = `message:m-${index}`;
		const node = {
			getBoundingClientRect: () => rect(top, height),
			getAttribute: (name) => name === "data-timeline-row-key" ? key : null,
			closest() { return this; },
			contains(other) { return other === this; },
		};
		return [key, { key, lease, contextId: 1, widthEpoch: 0, node, ...fields }];
	}));
	return {
		geometry, nodes, contextId: 1, widthEpoch: 0,
		viewport: {
			clientTop: 2, clientHeight: 300, getBoundingClientRect: () => rect(100, 304),
			contains: (hit) => [...nodes.values()].some((registration) => registration.node === hit),
			ownerDocument: { elementFromPoint: (_x, y) => {
				const box = boxes.find(({ index, top, height }) => {
					const gap = index < geometry.rows.length - 1 ? geometry.gap : 0;
					return height > 0 && y >= top && y < top + height + gap;
				});
				return box ? nodes.get(`message:m-${box.index}`).node : null;
			} },
		},
		...overrides,
	};
}

test("DOM anchor restoration measures only its row and accounts for viewport borders", () => {
	const input = mountedFixture([
		{ index: 0, top: -800, height: 100 },
		{ index: 1, top: 90, height: 200 },
		{ index: 2, top: 1000, height: 200 },
	]);
	input.viewport.scrollTop = 250;
	let reads = 0;
	for (const registration of input.nodes.values()) {
		const readRect = registration.node.getBoundingClientRect;
		registration.node.getBoundingClientRect = () => { reads += 1; return readRect(); };
	}
	const target = resolveMountedTimelineAnchorScrollTop({ ...input, anchor: { rowKey: "message:m-1", offsetTop: -52 } });
	assert.equal(target, 290);
	assert.equal(reads, 1);
});

test("DOM anchor restoration rejects missing, stale, hidden or foreign registrations", () => {
	for (const invalid of ["missing", "context", "width", "hidden", "foreign", "viewport"]) {
		const input = mountedFixture([{ index: 1, top: 50, height: invalid === "hidden" ? 0 : 200,
			contextId: invalid === "context" ? 2 : 1, widthEpoch: invalid === "width" ? 1 : 0 }]);
		input.viewport.scrollTop = 250;
		if (invalid === "missing") input.nodes.clear();
		if (invalid === "foreign") input.viewport.contains = () => false;
		if (invalid === "viewport") input.viewport.clientHeight = 0;
		assert.equal(resolveMountedTimelineAnchorScrollTop({ ...input, anchor: { rowKey: "message:m-1", offsetTop: -52 } }), null);
	}
});

test("mounted anchor ignores offscreen pins and includes the viewport border offset", () => {
	const anchor = captureMountedTimelineAnchor(mountedFixture([
		{ index: 0, top: -800, height: 100 },
		{ index: 1, top: 50, height: 200 },
		{ index: 2, top: 262, height: 200 },
	]));
	assert.deepEqual({ ...anchor }, { rowKey: "message:m-1", offsetTop: -52 });
});

test("mounted anchor includes the row gap at the viewport top", () => {
	const anchor = captureMountedTimelineAnchor(mountedFixture([
		{ index: 0, top: -30, height: 125 },
		{ index: 1, top: 107, height: 200 },
	]));
	assert.deepEqual({ ...anchor }, { rowKey: "message:m-0", offsetTop: -132 });
});

test("mounted anchor rejects stale contexts, width epochs and zero-height boxes", () => {
	const anchor = captureMountedTimelineAnchor(mountedFixture([
		{ index: 0, top: 50, height: 200, contextId: 2 },
		{ index: 1, top: 50, height: 200, widthEpoch: 1 },
		{ index: 2, top: 150, height: 0 },
	]));
	assert.equal(anchor, null);
});

test("mounted anchor does not invent a gap after the final row", () => {
	const input = mountedFixture([{ index: 2, top: 0, height: 100 }]);
	// An overflowing descendant can be hit below the row's content box. Force
	// that hit so the helper's last-row gap guard, not the hit-test mock, decides.
	input.viewport.ownerDocument.elementFromPoint = () => input.nodes.get("message:m-2").node;
	assert.equal(captureMountedTimelineAnchor(input), null);
});

test("mounted anchor keeps a positive offset when the first visible row starts below the viewport top", () => {
	const anchor = captureMountedTimelineAnchor(mountedFixture([
		{ index: 1, top: 150, height: 200 },
	]));
	assert.deepEqual({ ...anchor }, { rowKey: "message:m-1", offsetTop: 48 });
});

test("mounted anchor finds visible content below a temporary top virtual spacer", () => {
	const anchor = captureMountedTimelineAnchor(mountedFixture([
		{ index: 1, top: 200, height: 200 },
	]));
	assert.deepEqual({ ...anchor }, { rowKey: "message:m-1", offsetTop: 98 });
});

test("mounted anchor only measures the hit row, independent of mounted row count", () => {
	const items = Array.from({ length: 40 }, (_, i) => ({ kind: "message", message: {
		id: `m-${i}`, agentId: "agent", role: "user", text: "fixture", timestamp: i,
	} }));
	const input = mountedFixture(Array.from({ length: 40 }, (_, index) => ({
		index, top: 102 + (index - 20) * 200, height: 188,
	})), { geometry: computeTimelineGeometry(buildTimelineRowModel(items).rows, new Map(), 12) });
	let reads = 0;
	for (const registration of input.nodes.values()) {
		const getRect = registration.node.getBoundingClientRect;
		registration.node.getBoundingClientRect = () => { reads += 1; return getRect(); };
	}
	assert.deepEqual({ ...captureMountedTimelineAnchor(input) }, { rowKey: "message:m-20", offsetTop: 0 });
	assert.ok(reads <= 2, `anchor capture read ${reads} row rectangles instead of only the hit row`);
});

test("unavailable or obstructed hit tests never scan registered rows as a fallback", () => {
	for (const blocked of ["unavailable", "outside"]) {
		const input = mountedFixture([{ index: 1, top: 50, height: 200 }]);
		let reads = 0;
		for (const registration of input.nodes.values()) {
			registration.node.getBoundingClientRect = () => { reads += 1; return rect(50, 200); };
		}
		if (blocked === "unavailable") input.viewport.ownerDocument.elementFromPoint = undefined;
		else input.viewport.contains = () => false;
		assert.equal(captureMountedTimelineAnchor(input), null);
		assert.equal(reads, 0);
	}
});

test("reading a newly mounted tall row uses DOM bounds before its height cache catches up", async () => {
	await withHookHost(async ({ load, mount, window, act, flushFrames }) => {
		ControllableResizeObserver.reset();
		globalThis.ResizeObserver = ControllableResizeObserver;
		window.ResizeObserver = ControllableResizeObserver;
		const { useVirtualTimeline } = load("src/renderer/src/hooks/useVirtualTimeline.ts", {
			globals: { ResizeObserver: ControllableResizeObserver },
		});
		const viewport = window.document.createElement("div");
		Object.defineProperties(viewport, {
			scrollTop: { value: 250, writable: true },
			clientHeight: { value: 300 },
			clientTop: { value: 0 },
			scrollHeight: { value: 3000 },
		});
		viewport.getBoundingClientRect = () => rect(0, 300);
		const list = window.document.createElement("div");
		list.getBoundingClientRect = () => rect(-viewport.scrollTop, 1500);
		const items = Array.from({ length: 4 }, (_, i) => ({
			kind: "message", message: { id: `m-${i}`, role: "user", text: "fixture", timestamp: i },
		}));
		const scrollCalls = [];
		const probe = await mount(() => useVirtualTimeline({
			items, viewportRef: { current: viewport }, listRef: { current: list },
			isFollowing: false, sessionId: "mounted-code-anchor",
			applyReaderScrollTop(top, reason) { scrollCalls.push({ top, reason }); viewport.scrollTop = top; },
		}), {});

		const first = window.document.createElement("div");
		first.setAttribute("data-timeline-measure-key", "message:m-0");
		first.getBoundingClientRect = () => rect(-viewport.scrollTop, 100);
		const tall = window.document.createElement("div");
		tall.setAttribute("data-timeline-measure-key", "message:m-1");
		// Real start = 100px previous row + 12px gap, not 180px estimate + gap.
		tall.getBoundingClientRect = () => rect(112 - viewport.scrollTop, 800);
		first.setAttribute("data-timeline-row-key", "message:m-0");
		tall.setAttribute("data-timeline-row-key", "message:m-1");
		viewport.append(first, tall);
		window.document.elementFromPoint = () => tall;
		probe.result().registerRowNode("message:m-0", first);
		probe.result().registerRowNode("message:m-1", tall);

		const reading = probe.result().captureReadingAnchor();
		assert.equal(reading.status, "resolved");
		assert.equal(reading.anchor.messageId, "m-1");
		assert.equal(reading.anchor.offsetTop, -138, "capture must reflect what the reader actually sees, not stale estimates");

		const ro = ControllableResizeObserver.instances.find((observer) => observer.observed.has(tall));
		assert.ok(ro);
		await act(() => ro.dispatchEntries([
			ControllableResizeObserver.createEntry(first, { height: 100 }),
			ControllableResizeObserver.createEntry(tall, { height: 800 }),
		]));
		await flushFrames();
		const preserved = scrollCalls.filter((call) => call.reason === "preserve-anchor").at(-1);
		assert.equal(preserved?.top, 250, "committing height measurements must not shift the reader toward the code block start");
	});
});

test("passive anchor reads preserve pending height compensation for already measured rows", async () => {
	await withHookHost(async ({ load, mount, window, act, flushFrames }) => {
		ControllableResizeObserver.reset();
		globalThis.ResizeObserver = ControllableResizeObserver;
		window.ResizeObserver = ControllableResizeObserver;
		const { useVirtualTimeline } = load("src/renderer/src/hooks/useVirtualTimeline.ts", {
			globals: { ResizeObserver: ControllableResizeObserver },
		});
		const viewport = window.document.createElement("div");
		Object.defineProperties(viewport, {
			scrollTop: { value: 250, writable: true }, clientTop: { value: 0 },
			clientHeight: { value: 300 }, scrollHeight: { value: 3000 },
		});
		viewport.getBoundingClientRect = () => rect(0, 300);
		const list = window.document.createElement("div");
		list.getBoundingClientRect = () => rect(-viewport.scrollTop, 1500);
		const viewportRef = { current: viewport }, listRef = { current: list };
		const items = Array.from({ length: 4 }, (_, i) => ({ kind: "message", message: {
			id: `m-${i}`, agentId: "agent", role: "user", text: "fixture", timestamp: i,
		} }));
		const adapterRef = { current: null };
		const probe = await mount(() => useVirtualTimeline({
			items, viewportRef, listRef, adapterRef, isFollowing: false, sessionId: "passive-anchor",
			applyReaderScrollTop(top) { viewport.scrollTop = top; },
		}), {});
		let firstHeight = 100;
		const first = window.document.createElement("div");
		first.setAttribute("data-timeline-measure-key", "message:m-0");
		first.getBoundingClientRect = () => rect(-viewport.scrollTop, firstHeight);
		const tall = window.document.createElement("div");
		tall.setAttribute("data-timeline-measure-key", "message:m-1");
		tall.getBoundingClientRect = () => rect(firstHeight + 12 - viewport.scrollTop, 800);
		first.setAttribute("data-timeline-row-key", "message:m-0");
		tall.setAttribute("data-timeline-row-key", "message:m-1");
		viewport.append(first, tall);
		window.document.elementFromPoint = () => tall;
		probe.result().registerRowNode("message:m-0", first);
		probe.result().registerRowNode("message:m-1", tall);
		const rowObserver = () => ControllableResizeObserver.instances.find((observer) => observer.observed.has(first));
		await act(() => rowObserver().dispatchEntries([
			ControllableResizeObserver.createEntry(first, { height: 100 }),
			ControllableResizeObserver.createEntry(tall, { height: 800 }),
		]));
		await flushFrames();
		assert.equal(adapterRef.current.captureReadingAnchor().anchor.offsetTop, -138);
		let passiveRectReads = 0;
		const readTallRect = tall.getBoundingClientRect;
		tall.getBoundingClientRect = () => { passiveRectReads += 1; return readTallRect(); };

		// A queued controller snapshot runs after DOM growth, before the RO batch.
		// No user scroll occurred, so this read must not reset the reader's intent.
		firstHeight = 180;
		assert.equal(adapterRef.current.captureReadingAnchor().anchor.offsetTop, -138);
		assert.equal(adapterRef.current.captureReadingAnchor().anchor.offsetTop, -138);
		assert.equal(passiveRectReads, 0, "controller snapshots must not remeasure or reset the intent");
		await act(() => rowObserver().dispatchEntries([
			ControllableResizeObserver.createEntry(first, { height: 180 }),
		]));
		await flushFrames();
		assert.equal(viewport.scrollTop, 330);
		assert.equal(tall.getBoundingClientRect().top, -138);
		// A subsequent real scroll must still replace the intent, unlike a read.
		await act(() => {
			viewport.scrollTop = 370;
			viewport.dispatchEvent(new window.Event("scroll"));
		});
		assert.equal(adapterRef.current.captureReadingAnchor().anchor.offsetTop, -178);
	});
});
