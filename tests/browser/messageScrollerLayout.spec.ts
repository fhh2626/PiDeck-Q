import { expect, test, type Page } from "@playwright/test";
import type { fixture } from "./messageScrollerLayout.fixture";

// Headless Chromium defaults to --hide-scrollbars; a stable gutter by itself is not a thumb.
test.use({ launchOptions: { ignoreDefaultArgs: ["--hide-scrollbars"] } });

declare global {
	interface Window { scrollerFixture: typeof fixture }
}

const viewport = (page: Page) => page.locator("#viewport");
const gap = (page: Page) => viewport(page).evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop);
const following = (page: Page) => page.evaluate(() => window.scrollerFixture.following());
const height = (page: Page, id: string, px: number) => page.locator(id).evaluate((el, value) => { el.style.height = `${value}px`; }, px);

async function frames(page: Page) {
	await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
}

test.beforeEach(async ({ page }) => {
	await page.emulateMedia({ reducedMotion: "reduce" });
	await page.goto("/tests/browser/messageScrollerLayout.html");
	await expect.poll(() => gap(page)).toBeLessThanOrEqual(2);
	await expect.poll(() => following(page)).toBe(true);
	await frames(page);
});

test("composer-only growth keeps the tail visible without a content resize", async ({ page }) => {
	const before = await viewport(page).evaluate((el) => [el.clientHeight, el.scrollHeight]);
	await height(page, "#composer", 200);
	const after = await viewport(page).evaluate((el) => [el.clientHeight, el.scrollHeight]);
	expect(after).toEqual([before[0] - 80, before[1]]);
	expect(await following(page)).toBe(true);
	await expect.poll(() => gap(page)).toBeLessThanOrEqual(2);
});

for (const source of ["viewport", "card"] as const) {
	test(`transient ${source} layout cannot clamp the followed offset before native scroll delivery`, async ({ page }) => {
		if (source === "viewport") {
			await page.goto("/tests/browser/messageScrollerLayout.html?timelineBox");
			await expect.poll(() => gap(page)).toBeLessThanOrEqual(2);
			await frames(page);
		}
		const observed = await viewport(page).evaluate((el, source) => {
			const changed = document.getElementById(source === "viewport" ? "composer" : "card")!;
			const before = { top: el.scrollTop, height: el.scrollHeight, client: el.clientHeight };
			const previous = changed.style.height;
			let delivered = 0;
			el.addEventListener("scroll", () => { delivered++; }, { once: true });
			changed.style.height = "40px";
			// Force the intermediate Chromium layout without writing scrollTop or
			// dispatching synthetic scroll events. Without the guard this clamps.
			const intermediate = { top: el.scrollTop, height: changed.offsetHeight };
			changed.style.height = previous;
			return { before, intermediate, after: { height: el.scrollHeight, client: el.clientHeight }, delivered };
		}, source);
		expect(observed.intermediate.height).toBe(40);
		expect(observed.intermediate.top).toBe(observed.before.top);
		expect(observed.after).toEqual({ height: observed.before.height, client: observed.before.client });
		expect(observed.delivered).toBe(0);
		await frames(page);
		await height(page, "#tail", 90);
		await frames(page);
		expect(await following(page)).toBe(true);
		await expect.poll(() => gap(page)).toBeLessThanOrEqual(2);
	});
}

test("persistent content and viewport shrinks expose the true tail by resize delivery", async ({ page }) => {
	const before = await viewport(page).evaluate((el) => el.scrollHeight);
	await height(page, "#card", 40);
	await frames(page);
	expect(await viewport(page).evaluate((el) => el.scrollHeight)).toBe(before - 200);
	expect(await gap(page)).toBeLessThanOrEqual(2);
	await height(page, "#composer", 40);
	await frames(page);
	expect(await viewport(page).evaluate((el) => el.scrollHeight)).toBe(before - 200);
	expect(await gap(page)).toBeLessThanOrEqual(2);
	expect(await following(page)).toBe(true);
});

test("wheel-up stays in history across viewport and content changes; End resumes", async ({ page }) => {
	await viewport(page).hover();
	await page.mouse.wheel(0, -160);
	await expect.poll(() => following(page)).toBe(false);
	await height(page, "#composer", 185);
	await height(page, "#tail", 80);
	await expect.poll(() => gap(page)).toBeGreaterThan(100);
	await viewport(page).focus();
	await page.keyboard.press("End");
	await expect.poll(() => following(page)).toBe(true);
	await expect.poll(() => gap(page)).toBeLessThanOrEqual(2);
});

test("small output growth still follows smoothly without reduced motion", async ({ page }) => {
	await page.emulateMedia({ reducedMotion: "no-preference" });
	await page.goto("/tests/browser/messageScrollerLayout.html");
	await expect.poll(() => gap(page)).toBeLessThanOrEqual(2);
	const gapAtDelivery = await viewport(page).evaluate((el) => new Promise<number>((resolve) => {
		const content = el.querySelector('[role="log"]')!;
		const observer = new ResizeObserver(() => {
			observer.disconnect();
			resolve(el.scrollHeight - el.clientHeight - el.scrollTop);
		});
		observer.observe(content);
		el.querySelector<HTMLElement>("#tail")!.style.height = "54px";
	}));
	expect(gapAtDelivery).toBeGreaterThan(2);
	await expect.poll(() => gap(page)).toBeLessThanOrEqual(2);
});

test("subpixel reflow cannot disarm the floor before a later transient clamp", async ({ page }) => {
	await page.emulateMedia({ reducedMotion: "no-preference" });
	await page.goto("/tests/browser/messageScrollerLayout.html");
	await expect.poll(() => gap(page)).toBeLessThanOrEqual(2);
	await frames(page);
	const observed = await viewport(page).evaluate(async (el) => {
		const originalTop = el.scrollTop;
		const card = el.querySelector<HTMLElement>("#card")!;
		card.style.height = "240.125px";
		await new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())));
		const roundedTop = el.scrollTop;
		card.style.height = "40px";
		const afterShrink = el.scrollTop;
		card.style.height = "240.125px";
		return { originalTop, roundedTop, afterShrink };
	});
	expect(observed.roundedTop).toBe(observed.originalTop);
	expect(observed.afterShrink).toBe(observed.originalTop);
	await frames(page);
	expect(await following(page)).toBe(true);
});

test("explicit reader restoration clears the guard before a subsequent collapse", async ({ page }) => {
	const before = await viewport(page).evaluate((el) => el.scrollHeight);
	await page.evaluate(() => window.scrollerFixture.restoreAt(500));
	await height(page, "#card", 40);
	await frames(page);
	expect(await following(page)).toBe(false);
	expect(await viewport(page).evaluate((el) => [el.scrollHeight, el.scrollTop])).toEqual([before - 200, 500]);
	await page.evaluate(() => window.scrollerFixture.scrollToBottom());
	expect(await following(page)).toBe(true);
	await expect.poll(() => gap(page)).toBeLessThanOrEqual(2);
});

test("native thumb drag without pointer intent breaks following", async ({ page }) => {
	// Keep Chromium's default drag but withhold the pointerdown from the engine.
	// This exercises the raw native scroll event, not a simulated scrollTop write.
	await page.evaluate(() => document.addEventListener("pointerdown", (event) => {
		event.stopPropagation();
	}, { capture: true }));
	const scrollbar = await viewport(page).evaluate((el) => {
		const rect = el.getBoundingClientRect();
		return { x: rect.right - (rect.width - el.clientWidth) / 2, y: rect.bottom - 35, width: rect.width - el.clientWidth };
	});
	expect(scrollbar.width).toBeGreaterThan(0);
	await page.mouse.move(scrollbar.x, scrollbar.y);
	await page.mouse.down();
	expect(await following(page)).toBe(true);
	await page.mouse.move(scrollbar.x, scrollbar.y - 70, { steps: 5 });
	await page.mouse.up();
	await expect.poll(() => following(page)).toBe(false);
	await expect.poll(() => gap(page)).toBeGreaterThan(100);
	await height(page, "#tail", 90);
	await expect.poll(() => gap(page)).toBeGreaterThan(100);
});
