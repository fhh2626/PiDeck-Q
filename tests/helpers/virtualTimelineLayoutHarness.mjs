import assert from "node:assert/strict";
import { withHookHost } from "./l5_hookHost.mjs";
import { ControllableResizeObserver } from "./controllableResizeObserver.mjs";

const rectangle = (top, height) => ({
	x: 0, y: top, top, bottom: top + height, left: 0, right: 800, width: 800, height,
	toJSON() { return {}; },
});

/** Real React rows with deterministic normal-flow layout and separately delivered RO/rAF. */
export async function withTimelineLayout({ items, heights, viewportHeight = 300 }, run) {
	await withHookHost(async ({ React, load, mount, window, act, flushFrames, pendingFrames }) => {
		ControllableResizeObserver.reset();
		const { useVirtualTimeline } = load("src/renderer/src/hooks/useVirtualTimeline.ts", {
			globals: { ResizeObserver: ControllableResizeObserver },
		});
		const { VirtualTimelineRows } = load("src/renderer/src/components/session/timeline/VirtualTimelineRows.tsx");
		const viewportRef = { current: null };
		const listRef = { current: null };
		const adapterRef = { current: null };
		const scrollWrites = [];
		let latest;
		let scrollTop = 0;
		const rowHeight = (row) => {
			const body = row.querySelector("[data-actual-height]");
			return heights.get(body?.getAttribute("data-actual-message-id")) ?? Number(body?.getAttribute("data-actual-height") ?? 0);
		};
		const blockHeight = (block) => block.hasAttribute("data-virtual-spacer")
			? parseFloat(block.style.height) || 0
			: rowHeight(block) + (parseFloat(block.style.paddingBottom) || 0);
		const listHeight = () => Array.from(listRef.current?.children ?? []).reduce((sum, child) => sum + blockHeight(child), 0);
		const currentScrollTop = () => {
			scrollTop = Math.max(0, Math.min(scrollTop, listHeight() - viewportHeight));
			return scrollTop;
		};
		const blockTop = (block) => {
			let top = 0;
			for (const sibling of listRef.current?.children ?? []) {
				if (sibling === block) break;
				top += blockHeight(sibling);
			}
			return top - currentScrollTop();
		};
		window.HTMLElement.prototype.getBoundingClientRect = function () {
			if (this === viewportRef.current) return rectangle(0, viewportHeight);
			if (this === listRef.current) return rectangle(-currentScrollTop(), listHeight());
			const row = this.closest("[data-timeline-row-key]");
			if (row) return rectangle(blockTop(row), this === row ? blockHeight(row) : rowHeight(row));
			return rectangle(0, 0);
		};
		window.document.elementFromPoint = (_x, y) => {
			if (y < 0 || y >= viewportHeight) return null;
			return Array.from(listRef.current?.querySelectorAll("[data-timeline-measure-key]") ?? [])
				.find((node) => {
					const box = node.getBoundingClientRect();
					return box.top <= y && box.bottom > y;
				}) ?? listRef.current;
		};
		const attachViewport = (node) => {
			viewportRef.current = node;
			if (!node) return;
			Object.defineProperties(node, {
				scrollTop: { configurable: true, get: currentScrollTop, set: (top) => { scrollTop = Math.max(0, Math.min(top, listHeight() - viewportHeight)); } },
				clientTop: { configurable: true, value: 0 },
				clientHeight: { configurable: true, value: viewportHeight },
				scrollHeight: { configurable: true, get: listHeight },
			});
		};
		function Timeline(props) {
			latest = useVirtualTimeline({
				items: props.items, viewportRef, listRef, adapterRef, isFollowing: false,
				sessionId: "layout-session",
				applyReaderScrollTop(top, reason) {
					scrollWrites.push({ top, reason });
					if (viewportRef.current) viewportRef.current.scrollTop = top;
				},
			});
			return React.createElement("div", { ref: attachViewport },
				React.createElement("div", { ref: latest.registerListNode },
					React.createElement(VirtualTimelineRows, {
						renderPlan: latest.renderPlan, registerRowNode: latest.registerRowNode,
						renderRow: (row) => React.createElement("div", { "data-actual-message-id": row.anchorId, "data-actual-height": heights.get(row.anchorId) ?? 100 }, row.anchorId),
					})),
			);
		}
		const mounted = await mount(() => undefined, { items }, (child) => React.createElement(Timeline, child.props.hookProps));
		const notifyRows = async () => {
			await act(() => {
				for (const observer of ControllableResizeObserver.instances) {
					observer.dispatchEntries(Array.from(observer.observed)
						.filter((node) => node.hasAttribute("data-timeline-measure-key"))
						.map((node) => ControllableResizeObserver.createEntry(node, { height: node.getBoundingClientRect().height })));
				}
			});
		};
		const settleMeasurements = async () => {
			for (let round = 0; round < 12; round += 1) {
				await notifyRows();
				if (!pendingFrames()) return;
				await flushFrames();
			}
			assert.fail("row measurement did not settle");
		};
		await run({
			latest: () => latest,
			viewport: () => viewportRef.current,
			adapter: () => adapterRef.current,
			row: (key) => Array.from(listRef.current.querySelectorAll("[data-timeline-measure-key]"))
				.find((node) => node.getAttribute("data-timeline-measure-key") === key),
			scrollWrites, notifyRows, settleMeasurements, flushFrames,
			rerender: (nextItems) => mounted.rerender({ items: nextItems }),
			async resizeList(width) {
				await act(() => {
					for (const observer of ControllableResizeObserver.instances) {
						if (observer.observed.has(listRef.current)) observer.dispatchEntries([
							ControllableResizeObserver.createEntry(listRef.current, { width, height: listHeight() }),
						]);
					}
				});
			},
			async scrollTo(top) {
				await act(() => {
					viewportRef.current.scrollTop = top;
					viewportRef.current.dispatchEvent(new window.Event("scroll"));
				});
			},
			async jumpTo(messageId) {
				await act(() => assert.equal(adapterRef.current.jumpToMessage(messageId), true));
			},
		});
	});
}
