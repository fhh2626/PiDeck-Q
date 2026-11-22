import { expect, test, type Locator, type Page } from "@playwright/test";

const viewportSelector = "#integrated-viewport-container .message-timeline";

/** Capture a visible production row, including the passage offset inside a long row. */
async function readingSample(viewport: Locator) {
	return viewport.evaluate((element) => {
		const box = element.getBoundingClientRect();
		const top = box.top + element.clientTop;
		for (const offset of [1, 16, 48]) {
			const hit = document.elementFromPoint(box.left + box.width / 2, top + offset);
			const row = hit?.closest("[data-timeline-row-key]");
			const measured = row?.querySelector("[data-timeline-measure-key]");
			const key = row?.getAttribute("data-timeline-row-key");
			if (measured && key && element.contains(measured)) return { key, top: measured.getBoundingClientRect().top - top };
		}
		throw new Error("The viewport did not contain a readable timeline row");
	});
}

async function rowOffset(viewport: Locator, key: string) {
	return viewport.evaluate((element, rowKey) => {
		const row = Array.from(element.querySelectorAll<HTMLElement>("[data-timeline-row-key]"))
			.find((candidate) => candidate.getAttribute("data-timeline-row-key") === rowKey);
		const measured = row?.querySelector("[data-timeline-measure-key]");
		if (!measured) throw new Error(`Visible anchor ${rowKey} was unmounted`);
		return measured.getBoundingClientRect().top - element.getBoundingClientRect().top - element.clientTop;
	}, key);
}

async function openLongTimeline(page: Page, identityTakeover = false) {
	await page.goto(`/tests/browser/desktopVirtualTimeline.html?longRows=1${identityTakeover ? "&identityTakeover=1" : ""}`);
	await page.locator("#btn-toggle-integrated").click();
	const viewport = page.locator(viewportSelector);
	await expect(viewport).toBeVisible();
	await page.evaluate(async () => { await document.fonts.ready; });
	return viewport;
}

async function enterPassage(viewport: Locator, messageId: string, navigate?: () => Promise<void>) {
	const offset = 900;
	await viewport.evaluate((element, target) => {
		const message = Array.from(element.querySelectorAll("[data-message-id]"))
			.find((candidate) => candidate.getAttribute("data-message-id") === target.messageId);
		const measured = message?.closest("[data-timeline-row-key]")?.querySelector("[data-timeline-measure-key]");
		if (!measured || measured.getBoundingClientRect().height <= target.offset + element.clientHeight) {
			throw new Error("The target must be a genuinely long, mounted message");
		}
		if (target.rawScroll) {
			element.scrollTop += measured.getBoundingClientRect().top - element.getBoundingClientRect().top - element.clientTop + target.offset;
		}
	}, { messageId, offset, rawScroll: !navigate });
	await navigate?.();
	await expect.poll(async () => Math.abs((await readingSample(viewport)).top + offset)).toBeLessThan(4);
}

for (const kind of ["user", "agent-run"]) {
	test(`settled long ${kind} rows preserve each passage during continuous upward wheel input`, async ({ page }) => {
		test.setTimeout(60_000);
		const viewport = await openLongTimeline(page);
		await page.locator(kind === "user" ? "#btn-integrated-user-reader" : "#btn-integrated-reader").click();
		const messageId = kind === "user" ? "u-70" : "a-70";
		await expect(viewport.locator(`[data-message-id="${messageId}"]`).first()).toBeAttached();
		await enterPassage(viewport, messageId);
		const bounds = await viewport.boundingBox();
		if (!bounds) throw new Error("Timeline viewport is missing");
		await page.mouse.move(bounds.x + 8, bounds.y + bounds.height / 2);
		const visited = new Set<string>();
		for (let step = 0; step < 40; step += 1) {
			const before = await readingSample(viewport);
			visited.add(before.key);
			await page.mouse.wheel(0, -200);
			await expect.poll(async () => Math.abs((await rowOffset(viewport, before.key)) - before.top - 200),
				{ message: `The reading passage jumped at upward step ${step}`, intervals: [16, 32, 64] }).toBeLessThan(4);
		}
		expect(visited.size).toBeGreaterThan(2);
		expect(await viewport.locator("[data-timeline-row-key]").count()).toBeLessThan(45);
		const beforeWidthChange = await readingSample(viewport);
		await page.locator("#btn-integrated-narrow").click();
		await expect.poll(async () => Math.abs((await rowOffset(viewport, beforeWidthChange.key)) - beforeWidthChange.top)).toBeLessThan(4);
	});
}

test("an expanded user passage survives authoritative ID takeover and same-store remount", async ({ page }) => {
	const viewport = await openLongTimeline(page, true);
	await page.locator("#btn-integrated-reader").click();
	const optimistic = viewport.locator('[data-message-id="request-user-70"]');
	const toggleName = /^(展开全文|Show full message|收起|Collapse)$/;
	await optimistic.getByRole("button", { name: toggleName }).click();
	await expect(optimistic.getByRole("button", { name: toggleName })).toHaveAttribute("aria-expanded", "true");
	await enterPassage(viewport, "request-user-70", () => page.locator("#btn-integrated-identity-passage").dispatchEvent("click"));
	const before = await readingSample(viewport);
	await page.locator("#btn-integrated-accept").click();
	const accepted = viewport.locator('[data-message-id="accepted-user-70"]');
	await expect(accepted.getByRole("button", { name: toggleName })).toHaveAttribute("aria-expanded", "true");
	await expect.poll(async () => Math.abs((await rowOffset(viewport, before.key)) - before.top)).toBeLessThan(4);
	await page.locator("#btn-integrated-drop-request").click();
	await expect.poll(async () => Math.abs((await rowOffset(viewport, before.key)) - before.top)).toBeLessThan(4);
	await page.locator("#btn-integrated-remount").click();
	await expect(page.locator("#integrated-viewport-container")).toHaveAttribute("data-timeline-mount", "1");
	await page.locator("#btn-integrated-reader").click();
	await expect(accepted.getByRole("button", { name: toggleName })).toHaveAttribute("aria-expanded", "true");
});
