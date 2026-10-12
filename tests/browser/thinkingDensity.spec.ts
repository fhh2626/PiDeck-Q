import { test, expect } from "@playwright/test";

test("touch Web thinking header keeps a compact row and a 44px effective hit area", async ({ browser }) => {
	const context = await browser.newContext({
		viewport: { width: 390, height: 844 },
		isMobile: true,
		hasTouch: true,
	});
	const page = await context.newPage();
	try {
		await page.goto("/tests/browser/thinkingDensity.html");
		const button = page.locator("button[data-web-compact-hit-area]");
		const slot = page.locator("[data-web-thinking-header-slot]");
		await expect(button).toBeVisible();
		await expect(button).toHaveAttribute("aria-expanded", "false");

		const collapsedSlot = await slot.boundingBox();
		const collapsedButton = await button.boundingBox();
		if (!collapsedSlot || !collapsedButton) throw new Error("collapsed thinking header must have layout boxes");
		expect(collapsedSlot.height).toBe(24);
		expect(collapsedButton.height).toBe(44);
		const extendedHit = await page.evaluate(({ x, y }) => {
			const element = document.querySelector("button[data-web-compact-hit-area]");
			const hit = document.elementFromPoint(x, y);
			return {
				position: element ? getComputedStyle(element).position : "missing",
				hitsButton: hit === element || Boolean(element?.contains(hit)),
			};
		}, {
			x: collapsedButton.x + collapsedButton.width / 2,
			y: collapsedSlot.y + collapsedSlot.height + 10,
		});
		expect(extendedHit).toEqual({ position: "absolute", hitsButton: true });

		await page.touchscreen.tap(collapsedButton.x + collapsedButton.width / 2, collapsedSlot.y + collapsedSlot.height + 10);
		await expect(button).toHaveAttribute("aria-expanded", "true");
		const expandedSlot = await slot.boundingBox();
		const expandedButton = await button.boundingBox();
		expect(expandedSlot?.height).toBe(44);
		expect(expandedButton?.height).toBeGreaterThanOrEqual(43.5);
		expect(expandedButton?.height).toBeLessThan(44.5);
	} finally {
		await context.close();
	}
});

test("narrow mouse Web keeps the preview exposed to hover and text selection", async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto("/tests/browser/thinkingDensity.html");
	const button = page.locator("button[data-web-compact-hit-area]");
	const slot = page.locator("[data-web-thinking-header-slot]");
	const preview = page.getByTitle("A concise preview of the current reasoning.");
	await expect(button).toBeVisible();
	const slotBox = await slot.boundingBox();
	const buttonBox = await button.boundingBox();
	const previewBox = await preview.boundingBox();
	if (!slotBox || !buttonBox || !previewBox) throw new Error("thinking preview must have layout boxes");
	expect(slotBox.height).toBe(24);
	expect(buttonBox.height).toBe(24);

	const previewHit = await page.evaluate(({ x, y }) => {
		const previewElement = document.querySelector('.message-list [title="A concise preview of the current reasoning."]');
		const hit = document.elementFromPoint(x, y);
		return {
			position: getComputedStyle(document.querySelector("button[data-web-compact-hit-area]")!).position,
			hitsPreview: hit === previewElement || Boolean(previewElement?.contains(hit)),
		};
	}, { x: previewBox.x + previewBox.width / 2, y: previewBox.y + previewBox.height / 2 });
	expect(previewHit).toEqual({ position: "static", hitsPreview: true });

	await page.mouse.move(previewBox.x + 8, previewBox.y + previewBox.height / 2);
	await page.mouse.down();
	await page.mouse.move(previewBox.x + Math.min(previewBox.width - 4, 150), previewBox.y + previewBox.height / 2, { steps: 8 });
	await page.mouse.up();
	expect(await page.evaluate(() => window.getSelection()?.toString() ?? "")).not.toBe("");

	await button.hover();
	await expect(button).toHaveAttribute("title", /思考|thinking/i);
	await button.click();
	await expect(button).toHaveAttribute("aria-expanded", "true");
});
