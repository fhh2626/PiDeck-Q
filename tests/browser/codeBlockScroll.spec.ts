import { expect, test, type Locator, type Page } from "@playwright/test";

/** Wait for wheel animation and measurement compensation to finish, not a fixed timer. */
async function waitForScrollSettled(timeline: Locator): Promise<void> {
	await timeline.evaluate(async (element) => {
		const deadline = performance.now() + 2000;
		let lastTop = element.scrollTop;
		let quietFrames = 0;
		while (performance.now() < deadline) {
			await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
			const nextTop = element.scrollTop;
			quietFrames = Math.abs(nextTop - lastTop) < 0.1 ? quietFrames + 1 : 0;
			lastTop = nextTop;
			if (quietFrames >= 4) return;
		}
		throw new Error("timeline scrolling did not settle");
	});
}

/** Scroll the actual MessageScroller/virtual rows, optionally interleaving tail commits. */
async function checkHistoryScroll(page: Page, appendTail: boolean): Promise<void> {
	await page.goto("/tests/browser/desktopVirtualTimeline.html?longCode");
	await page.locator("#btn-toggle-integrated").click();
	const timeline = page.locator("#integrated-viewport-container .message-timeline");
	await expect(timeline).toBeVisible();
	await timeline.evaluate((element) => { element.scrollTop = element.scrollHeight; });
	await page.waitForTimeout(250);
	const box = await timeline.boundingBox();
	if (!box) throw new Error("integrated timeline must have a layout box");
	await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
	// Exceed the overscan distance so previously unmeasured rows enter view.
	const scrollStep = 600;
	let checkedCodePositions = 0;
	for (let step = 0; step < 45; step += 1) {
		const before = await timeline.evaluate((viewport) => {
			const rect = viewport.getBoundingClientRect();
			const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
			const block = hit?.closest('[data-streamdown="code-block"]');
			const row = block?.closest("[data-timeline-row-key]");
			return block && row ? {
				key: row.getAttribute("data-timeline-row-key"),
				top: block.getBoundingClientRect().top,
				rowTop: row.getBoundingClientRect().top,
				height: block.getBoundingClientRect().height,
				scrollTop: viewport.scrollTop,
			} : null;
		});
		await page.mouse.wheel(0, -scrollStep);
		if (appendTail && step % 7 === 2) {
			// Dispatch without moving the mouse/viewport to the header button.
			await page.locator("#btn-integrated-append").dispatchEvent("click");
		}
		await waitForScrollSettled(timeline);
		if (!before?.key || before.scrollTop < scrollStep) continue;
		const block = timeline.locator(`[data-timeline-row-key="${before.key}"] [data-streamdown="code-block"]`);
		await expect(block).toHaveCount(1);
		const after = await block.evaluate((element) => ({
			top: element.getBoundingClientRect().top,
			rowTop: element.closest("[data-timeline-row-key]")!.getBoundingClientRect().top,
			height: element.getBoundingClientRect().height,
		}));
		// Compare visible movement to user intent, not the raw scrollTop delta:
		// mounting taller rows above legitimately changes scrollTop to compensate.
		expect(Math.abs(after.top - before.top - scrollStep), JSON.stringify({ step, before, after })).toBeLessThan(3);
		checkedCodePositions += 1;
	}
	expect(checkedCodePositions).toBeGreaterThan(10);
	expect(Number(await timeline.getAttribute("data-passive-anchor-reads"))).toBeGreaterThan(10);
	if (appendTail) await expect(page.locator("#integrated-total-turns")).toContainText("107");
}

test("reading settled history upward preserves position inside virtualized code blocks", async ({ page }) => {
	await checkHistoryScroll(page, false);
});

test("tail updates during upward history scrolling do not shift virtualized code blocks", async ({ page }) => {
	await checkHistoryScroll(page, true);
});
