import assert from "node:assert/strict";
import test from "node:test";
import { withTimelineLayout } from "./helpers/virtualTimelineLayoutHarness.mjs";

const user = (id, meta) => ({ kind: "message", message: { id, agentId: "agent", role: "user", text: "Long settled message", timestamp: 1, ...(meta ? { meta } : {}) } });
const run = (id) => ({ kind: "agent-run", id, items: [{ kind: "message", message: { id, agentId: "agent", role: "assistant", text: "Long settled reply", timestamp: 2 } }], startedAt: 1, endedAt: 2 });

for (const kind of ["user", "agent-run"]) {
	test(`mounting an unmeasured long ${kind} above the reader preserves the visible passage before RO`, async () => {
		const items = Array.from({ length: 40 }, (_, index) => kind === "user" ? user(`row-${index}`) : run(`row-${index}`));
		const heights = new Map(items.map((item, index) => [`row-${index}`, 1200]));
		await withTimelineLayout({ items, heights }, async (timeline) => {
			await timeline.settleMeasurements();
			await timeline.jumpTo("row-25");
			await timeline.settleMeasurements();
			const key = kind === "user" ? "message:row-25" : "run:row-25";
			const anchor = timeline.row(key);
			assert.ok(anchor);
			await timeline.scrollTo(timeline.viewport().scrollTop + 550);
			await timeline.settleMeasurements();
			for (let step = 0; step < 30; step += 1) {
				const reading = timeline.adapter().captureReadingAnchor();
				assert.equal(reading.status, "resolved");
				const rowKey = timeline.latest().rowModel.rowKeyByMessageId.get(reading.anchor.messageId);
				const visible = timeline.row(rowKey);
				assert.ok(visible);
				const before = visible.getBoundingClientRect().top;
				const requestedTop = timeline.viewport().scrollTop - 200;
				assert.ok(requestedTop > 0);
				await timeline.scrollTo(requestedTop);
				assert.equal(visible.getBoundingClientRect().top, before + 200,
					`step ${step}: a newly mounted row must be compensated before delayed RO/rAF can absorb its layout shift as reading intent`);
				await timeline.settleMeasurements();
			}
		});
	});
}

test("authoritative user ID takeover retains the reader's offset within an expanded message", async () => {
	const items = [user("before"), user("request-1"), user("after")];
	const heights = new Map([["before", 100], ["request-1", 1200], ["accepted-1", 1200], ["after", 1000]]);
	await withTimelineLayout({ items, heights }, async (timeline) => {
		await timeline.settleMeasurements();
		await timeline.scrollTo(350);
		assert.equal(timeline.adapter().captureReadingAnchor().anchor.offsetTop, -238);
		await timeline.rerender([items[0], user("accepted-1", { optimisticRequestId: "request-1" }), items[2]]);
		assert.equal(timeline.viewport().scrollTop, 350, "the accepted message must retain the same passage instead of aligning its beginning");
		assert.equal(timeline.adapter().captureReadingAnchor().anchor.offsetTop, -238);
		assert.equal(timeline.adapter().captureReadingAnchor().anchor.messageId, "accepted-1");
		assert.equal(timeline.adapter().containsMessage("request-1"), false);
		await timeline.rerender([items[0], user("accepted-1"), items[2]]);
		await timeline.settleMeasurements();
		assert.equal(timeline.viewport().scrollTop, 350);
		assert.equal(timeline.latest().rowModel.rowKeyByMessageId.get("accepted-1"), "message:request-1");
		await timeline.scrollTo(270);
		assert.equal(timeline.adapter().captureReadingAnchor().anchor.offsetTop, -158);
	});
});

test("narrowing the timeline preserves a long row through delayed measurements and further upward input", async () => {
	const items = Array.from({ length: 40 }, (_, index) => index % 2 ? run(`row-${index}`) : user(`row-${index}`));
	const heights = new Map(items.map((_item, index) => [`row-${index}`, 1200]));
	await withTimelineLayout({ items, heights }, async (timeline) => {
		await timeline.resizeList(800);
		await timeline.settleMeasurements();
		await timeline.jumpTo("row-25");
		await timeline.settleMeasurements();
		await timeline.scrollTo(timeline.viewport().scrollTop + 550);
		await timeline.settleMeasurements();
		const visible = timeline.row("run:row-25");
		assert.ok(visible);
		const before = visible.getBoundingClientRect().top;
		for (const id of heights.keys()) heights.set(id, 1800);
		await timeline.resizeList(620);
		assert.equal(visible.getBoundingClientRect().top, before);
		await timeline.scrollTo(timeline.viewport().scrollTop - 80);
		await timeline.notifyRows();
		await timeline.scrollTo(timeline.viewport().scrollTop - 80);
		await timeline.flushFrames();
		await timeline.settleMeasurements();
		assert.equal(visible.getBoundingClientRect().top, before + 160);
	});
});

for (const kind of ["user", "agent-run"]) {
	test(`narrowing a long ${kind} preserves upward input whose scroll notification is still queued`, async () => {
		const items = Array.from({ length: 40 }, (_, index) => kind === "user" ? user(`row-${index}`) : run(`row-${index}`));
		const heights = new Map(items.map((_item, index) => [`row-${index}`, 1200]));
		await withTimelineLayout({ items, heights }, async (timeline) => {
			await timeline.resizeList(800);
			await timeline.settleMeasurements();
			await timeline.jumpTo("row-25");
			await timeline.settleMeasurements();
			await timeline.scrollTo(timeline.viewport().scrollTop + 550);
			await timeline.settleMeasurements();
			const key = kind === "user" ? "message:row-25" : "run:row-25";
			const before = timeline.row(key).getBoundingClientRect().top;
			assert.equal(before, -550);
			// The compositor has applied the wheel input, while its native scroll
			// notification remains queued behind the container resize delivery.
			timeline.viewport().scrollTop -= 80;
			for (const id of heights.keys()) heights.set(id, 1800);
			await timeline.resizeList(600);
			assert.ok(timeline.row(key), "the same row must stay mounted after width invalidation");
			assert.equal(timeline.row(key).getBoundingClientRect().top, before + 80,
				"the pre-invalidation input must be retained before geometry can clamp the viewport");
			await timeline.settleMeasurements();
			assert.equal(timeline.row(key).getBoundingClientRect().top, before + 80);
			await timeline.scrollTo(timeline.viewport().scrollTop);
			assert.equal(timeline.adapter().captureReadingAnchor().anchor.offsetTop, before + 80,
				"the eventual scroll notification must not count the already preserved input twice");
		});
	});
}

for (const { kind, initialHeight, offset } of [
	{ kind: "user", initialHeight: 1200, offset: 200 },
	{ kind: "agent-run", initialHeight: 1200, offset: 200 },
	{ kind: "user", initialHeight: 2000, offset: 550 },
]) {
	test(`widening a ${initialHeight}px ${kind} near the tail preserves its ${offset}px passage through repeated measurement commits`, async () => {
		const items = Array.from({ length: 40 }, (_, index) => kind === "user" ? user(`row-${index}`) : run(`row-${index}`));
		const heights = new Map(items.map((_item, index) => [`row-${index}`, initialHeight]));
		await withTimelineLayout({ items, heights }, async (timeline) => {
			await timeline.resizeList(800);
			await timeline.settleMeasurements();
			await timeline.jumpTo("row-38");
			await timeline.settleMeasurements();
			await timeline.scrollTo(timeline.viewport().scrollTop + offset);
			await timeline.settleMeasurements();
			const key = kind === "user" ? "message:row-38" : "run:row-38";
			assert.equal(timeline.row(key).getBoundingClientRect().top, -offset);
			for (const id of heights.keys()) heights.set(id, 600);
			await timeline.resizeList(1000);
			await timeline.settleMeasurements();
			// Re-read the mounted row after every commit. The original node can be
			// replaced while estimates and newly mounted measurements converge.
			const currentRow = timeline.row(key);
			assert.ok(currentRow);
			const viewport = timeline.viewport();
			const currentOffset = currentRow.getBoundingClientRect().top;
			const desiredTop = viewport.scrollTop + currentOffset + offset;
			assert.ok(desiredTop >= 0 && desiredTop <= viewport.scrollHeight - viewport.clientHeight,
				"the original reading passage must be physically reachable in the resized list");
			assert.equal(currentOffset, -offset, "temporary layout clamping must not become new bottom-follow intent");
			assert.equal(timeline.adapter().captureReadingAnchor().anchor.offsetTop, -offset);
			await timeline.scrollTo(timeline.viewport().scrollTop - 80);
			assert.equal(timeline.row(key).getBoundingClientRect().top, -offset + 80,
				"new reader input must still replace the restored passage after width measurements settle");
		});
	});
}

for (const kind of ["user", "agent-run"]) {
	test(`resizing after sustained upward input keeps the ${kind} passage mounted in the first commit`, async () => {
		const items = Array.from({ length: 160 }, (_, index) => index % 2 ? run(`row-${index}`) : user(`row-${index}`));
		const heights = new Map(items.map((_item, index) => [`row-${index}`, index % 2 ? 2600 : 1900]));
		await withTimelineLayout({ items, heights, viewportHeight: 620 }, async (timeline) => {
			await timeline.resizeList(1000);
			await timeline.settleMeasurements();
			await timeline.jumpTo(kind === "user" ? "row-140" : "row-141");
			await timeline.settleMeasurements();
			await timeline.scrollTo(timeline.viewport().scrollTop + 900);
			for (let step = 0; step < 40; step += 1) {
				await timeline.scrollTo(timeline.viewport().scrollTop - 200);
				await timeline.settleMeasurements();
			}
			const { anchor } = timeline.adapter().captureReadingAnchor();
			const key = timeline.latest().rowModel.rowKeyByMessageId.get(anchor.messageId);
			const offset = timeline.row(key).getBoundingClientRect().top;
			for (const [id, height] of heights) heights.set(id, height + 700);
			await timeline.resizeList(760);
			assert.ok(timeline.row(key), "the reading row cannot disappear while replacement measurements are pending");
			assert.equal(timeline.row(key).getBoundingClientRect().top, offset);
			await timeline.settleMeasurements();
			assert.equal(timeline.row(key).getBoundingClientRect().top, offset);
		});
	});
}
