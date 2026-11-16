import assert from "node:assert/strict";
import test from "node:test";
import { withHookHost } from "./helpers/l5_hookHost.mjs";
import { ControllableResizeObserver as ResizeObserver } from "./helpers/controllableResizeObserver.mjs";

for (const replacement of ["session", "list ref"]) {
	test(`a late container notification after ${replacement} replacement preserves current row measurement`, async () => {
		await withHookHost(async ({ load, mount, window, act, flushFrames }) => {
			ResizeObserver.reset();
			const { useVirtualTimeline } = load("src/renderer/src/hooks/useVirtualTimeline.ts", {
				globals: { ResizeObserver },
			});
			const viewport = window.document.createElement("div");
			Object.defineProperties(viewport, {
				scrollTop: { value: 0, writable: true }, clientHeight: { value: 600 }, scrollHeight: { value: 3000 },
			});
			const list = window.document.createElement("div");
			const viewportRef = { current: viewport };
			const listRef = { current: list };
			const items = [{ kind: "message", message: { id: "m-1", agentId: "agent", role: "user", text: "hello", timestamp: 1 } }];
			const probe = await mount((props) => useVirtualTimeline({
				items, viewportRef, listRef: props.listRef, isFollowing: true, applyReaderScrollTop() {}, sessionId: props.sessionId,
			}), { sessionId: "A", listRef });
			const oldContainer = ResizeObserver.instances.find((observer) => observer.observed.has(list));
			await act(() => oldContainer.dispatchEntries([ResizeObserver.createEntry(list, { width: 800 })]));
			await probe.rerender({ sessionId: replacement === "session" ? "B" : "A", listRef: replacement === "list ref" ? { current: list } : listRef });
			assert.equal(oldContainer.disconnected, true, "the replaced container observer must be released");
			const row = window.document.createElement("div");
			row.setAttribute("data-timeline-measure-key", "message:m-1");
			await act(() => { probe.result().registerRowNode("message:m-1", row); });
			const currentRows = ResizeObserver.instances.findLast((observer) => observer.observed.has(row));
			await act(() => currentRows.dispatchEntries([ResizeObserver.createEntry(row, { height: 900 })]));
			await flushFrames();
			assert.equal(probe.result().geometry.heights[0], 900);
			// A browser may already have queued a delivery when disconnect runs. The
			// stale width must neither reset current heights nor replace its observer.
			await act(() => oldContainer.dispatchLateEntries([ResizeObserver.createEntry(list, { width: 620 })]));
			assert.equal(probe.result().geometry.heights[0], 900, "a retired container cannot clear the active height cache");
			await act(() => currentRows.dispatchEntries([ResizeObserver.createEntry(row, { height: 1500 })]));
			await flushFrames();
			assert.equal(probe.result().geometry.heights[0], 1500, "the active session must keep receiving row growth");
		});
	});
}
