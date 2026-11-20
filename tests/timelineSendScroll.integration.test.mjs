import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { withHookHost } from "./helpers/l5_hookHost.mjs";
import { ControllableResizeObserver } from "./helpers/controllableResizeObserver.mjs";

// The loader uses CommonJS Jotai. Its Provider must own this same context so each
// scenario has an isolated store rather than silently falling back to the default.
const { Provider, createStore } = createRequire(import.meta.url)("jotai");
const message = (id) => ({ id, agentId: "agent", role: "user", text: id, timestamp: 1 });
const rectangle = (top, height) => ({ x: 0, y: top, top, bottom: top + height, left: 0, right: 800, width: 800, height });

/** Exercise the real controller, scroller and virtualizer with controllable browser layout and event delivery. */
async function withSendTimeline(run) {
	await withHookHost(async ({ React, load, mount, window, act, flushFrames }) => {
		ControllableResizeObserver.reset();
		window.matchMedia = () => ({ matches: true });
		const globals = { ResizeObserver: ControllableResizeObserver, Node: window.Node, performance };
		const atoms = load("src/renderer/src/atoms/index.ts");
		const { useSessionTimelineController } = load("src/renderer/src/hooks/useSessionTimelineController.ts", {
			globals,
			stubs: {
				"../atoms": atoms,
				"../desktopApi": { desktopApi: { sessions: {
					readRecordMessagePage: async () => ({ messages: [], total: 0, nextBefore: null }),
				} } },
				"../i18n": { t: (key) => key },
				"../utils/notice": { showNotice() {} },
			},
		});
		const { MessageScroller } = load("src/renderer/src/components/agents/message-scroller.tsx", {
			globals, stubs: { "motion/react": { useReducedMotion: () => true } },
		});
		const { useVirtualTimeline } = load("src/renderer/src/hooks/useVirtualTimeline.ts", { globals });
		const { VirtualTimelineRows } = load("src/renderer/src/components/session/timeline/VirtualTimelineRows.tsx");
		const store = createStore();
		const listRef = { current: null }, adapterRef = { current: null };
		const heights = new Map(Array.from({ length: 12 }, (_, index) => [`old-${index}`, 180]));
		let messages = [...heights.keys()].map(message);
		let controller, virtualizer, viewport, scrollTop = 0;
		const viewportHeight = 500;
		const rowHeight = (row) => heights.get(row.querySelector("[data-message-id]")?.getAttribute("data-message-id")) ?? 0;
		const blockHeight = (block) => block.hasAttribute("data-virtual-spacer")
			? parseFloat(block.style.height) || 0
			: rowHeight(block) + (parseFloat(block.style.paddingBottom) || 0);
		const contentHeight = () => Array.from(listRef.current?.children ?? []).reduce((sum, block) => sum + blockHeight(block), 0);
		const currentTop = () => (scrollTop = Math.max(0, Math.min(scrollTop, contentHeight() - viewportHeight)));
		const blockTop = (block) => {
			let top = 0;
			for (const sibling of listRef.current?.children ?? []) {
				if (sibling === block) break;
				top += blockHeight(sibling);
			}
			return top - currentTop();
		};
		window.HTMLElement.prototype.getBoundingClientRect = function () {
			if (this === viewport) return rectangle(0, viewportHeight);
			if (this === listRef.current) return rectangle(-currentTop(), contentHeight());
			const row = this.closest("[data-timeline-row-key]");
			return row ? rectangle(blockTop(row), this === row ? blockHeight(row) : rowHeight(row)) : rectangle(0, 0);
		};
		window.document.elementFromPoint = (_x, y) => Array.from(listRef.current?.querySelectorAll("[data-timeline-measure-key]") ?? [])
			.find((node) => { const box = node.getBoundingClientRect(); return box.top <= y && box.bottom > y; }) ?? listRef.current;
		const attachViewport = (node) => {
			viewport = node;
			controller.timelineRef.current = node;
			if (!node) return;
			Object.defineProperties(node, {
				scrollTop: { configurable: true, get: currentTop, set: (top) => { scrollTop = Math.max(0, Math.min(top, contentHeight() - viewportHeight)); } },
				clientTop: { configurable: true, value: 0 },
				clientHeight: { configurable: true, value: viewportHeight },
				scrollHeight: { configurable: true, get: contentHeight },
			});
		};
		function Timeline(props) {
			controller = useSessionTimelineController({ sessionId: "send-scroll-session", messages: props.messages });
			const items = React.useMemo(() => props.messages.map((entry) => ({ kind: "message", message: entry })), [props.messages]);
			const applyReaderScrollTop = React.useCallback((top) => controller.scrollerScrollApiRef.current?.restoreAt(top), []);
			virtualizer = useVirtualTimeline({
				items, viewportRef: controller.timelineRef, listRef, adapterRef,
				isFollowing: controller.autoScroll, applyReaderScrollTop, sessionId: "send-scroll-session",
			});
			React.useLayoutEffect(() => controller.registerViewportAdapter(adapterRef.current), []);
			return React.createElement(MessageScroller, {
				viewportRef: attachViewport, scrollApiRef: controller.scrollerScrollApiRef,
				initialFollowOutput: controller.autoScroll, onFollowChange: controller.setAutoScrollFromScroller,
				busy: true, viewportProps: { onScroll: controller.handleTimelineScroll },
			}, React.createElement("div", { ref: virtualizer.registerListNode }, React.createElement(VirtualTimelineRows, {
				renderPlan: virtualizer.renderPlan, registerRowNode: virtualizer.registerRowNode,
				renderRow: (row) => React.createElement("div", { "data-message-id": row.anchorId }, row.anchorId),
			})));
		}
		const mounted = await mount(() => undefined, { messages }, (child) => React.createElement(Provider, { store },
			React.createElement(Timeline, child.props.hookProps)));
		const notifyResize = async () => act(() => {
			for (const observer of ControllableResizeObserver.instances) {
				observer.dispatchEntries(Array.from(observer.observed).map((node) => ControllableResizeObserver.createEntry(node, {
					height: node.hasAttribute("data-timeline-measure-key") ? node.getBoundingClientRect().height
						: node === viewport ? viewportHeight : contentHeight(),
					width: 800,
				})));
			}
		});
		const dispatchScroll = () => act(() => viewport.dispatchEvent(new window.Event("scroll")));
		const settle = async () => {
			for (let index = 0; index < 4; index += 1) {
				await notifyResize();
				await flushFrames();
				await dispatchScroll();
			}
		};
		await settle();
		assert.equal(controller.autoScroll, true);
		const append = async (id, height = 48) => {
			heights.set(id, height);
			messages = [...messages, message(id)];
			await mounted.rerender({ messages });
		};
		await run({
			controller: () => controller, viewport: () => viewport, adapter: () => adapterRef.current,
			gap: () => contentHeight() - viewportHeight - currentTop(), heights,
			append, settle, dispatchScroll, notifyResize,
			async scrollTo(top) { viewport.scrollTop = top; await dispatchScroll(); },
			async wheelUp(top) {
				await act(() => {
					const event = new window.Event("wheel");
					event.deltaY = -80;
					viewport.dispatchEvent(event);
					viewport.scrollTop = top;
				});
				await dispatchScroll();
			},
			async returnToBottom() { await act(() => controller.scrollToBottom()); await settle(); },
		});
	});
}

test("sending after a browser-clamped collapse keeps the real timeline following through late measurements", async () => {
	await withSendTimeline(async (timeline) => {
		const before = timeline.viewport().scrollTop;
		timeline.heights.set("old-11", 20);
		const clamped = timeline.viewport().scrollTop;
		assert.ok(clamped < before - 100, "the previous row must shrink enough to cause browser clamping");
		await timeline.append("sent-1");
		assert.ok(timeline.gap() > 2, "the new bubble must move the live edge after the clamp but before scroll delivery");
		await timeline.dispatchScroll();
		await timeline.settle();
		assert.equal(timeline.controller().autoScroll, true, "layout clamping must not become reader intent through the controller feedback loop");
		assert.ok(timeline.gap() <= 2);
		await timeline.append("sent-2", 220);
		await timeline.settle();
		assert.equal(timeline.controller().autoScroll, true);
		assert.ok(timeline.gap() <= 2, "the next send must also remain visible");
	});
});

test("sending while reading preserves the passage until the reader explicitly returns to the bottom", async () => {
	await withSendTimeline(async (timeline) => {
		await timeline.wheelUp(timeline.viewport().scrollTop - 500);
		assert.equal(timeline.controller().autoScroll, false);
		const reading = timeline.adapter().captureReadingAnchor();
		assert.equal(reading.status, "resolved");
		timeline.heights.set("old-11", 20);
		await timeline.append("sent-while-reading");
		await timeline.settle();
		const after = timeline.adapter().captureReadingAnchor();
		assert.equal(after.status, "resolved");
		assert.equal(after.anchor.messageId, reading.anchor.messageId);
		assert.equal(after.anchor.offsetTop, reading.anchor.offsetTop);
		assert.equal(timeline.controller().autoScroll, false);
		await timeline.returnToBottom();
		await timeline.append("sent-after-return", 220);
		await timeline.settle();
		assert.equal(timeline.controller().autoScroll, true);
		assert.ok(timeline.gap() <= 2);
	});
});

test("a real upward gesture during send wins over collapse compensation and later output", async () => {
	await withSendTimeline(async (timeline) => {
		timeline.heights.set("old-11", 20);
		const clamped = timeline.viewport().scrollTop;
		await timeline.append("sent-before-escape");
		await timeline.wheelUp(clamped - 80);
		const reading = timeline.adapter().captureReadingAnchor();
		assert.equal(reading.status, "resolved");
		await timeline.settle();
		await timeline.append("output-after-escape", 220);
		await timeline.settle();
		const after = timeline.adapter().captureReadingAnchor();
		assert.equal(after.status, "resolved");
		assert.equal(after.anchor.messageId, reading.anchor.messageId);
		assert.equal(after.anchor.offsetTop, reading.anchor.offsetTop);
		assert.equal(timeline.controller().autoScroll, false, "explicit reader input must keep priority over delayed layout events");
	});
});
