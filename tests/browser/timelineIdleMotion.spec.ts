import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";

for (const reducedMotion of ["no-preference", "reduce"] as const) {
	test(`mounted running tool and status stop animating (${reducedMotion})`, async ({ page }) => {
		await page.emulateMedia({ reducedMotion });
		await page.goto("/tests/browser/timelineIdleMotion.html");
		const tool = page.locator('[data-message-id="quiet-tool"]');
		await expect(tool).toHaveAttribute("data-status", "running");
		const status = page.locator('.responding-indicator[role="status"]');
		await expect(status).toHaveAttribute("data-kind", "executing");
		await expect(status).not.toBeEmpty();
		// Ignore finished `fill: both` effects; neither CSS nor JS should keep the quiet UI animating.
		await expect.poll(() => page.evaluate(() => document.getAnimations().filter((a) => a.playState === "running").length)).toBe(0);
		await page.getByRole("button", { name: "Stop fixture" }).click();
		await expect(tool).toHaveAttribute("data-status", "stopped");
		await expect(status).toHaveCount(0);
	});
}

// Exercise the legacy selectors that previously ran forever even with no incoming text.
test("running timeline affordances settle without continuous animation", async ({ page }) => {
	const css = await readFile("src/renderer/src/styles/timeline.css", "utf8");
	await page.emulateMedia({ reducedMotion: "no-preference" });
	await page.setContent(`<style>:root{--color-accent:#3580dd;--color-warning:#b98222;--radius-md:8px}${css}</style>
		<article class="turn-row turn-row--running">
			<span class="timeline-marker-node timeline-marker-node-active" style="display:inline-block;width:12px;height:12px"></span>
			<section class="tool-card tool-card--running" data-status="running"><span class="tool-card-icon">T</span></section>
			<div class="tool-group-card tone-running"><span class="tool-group-card-dot" style="display:inline-block;width:8px;height:8px"></span></div>
			<div class="composer-bottom-bar"><button class="composer-bar-btn compacting" disabled>Compacting</button></div>
		</article>`);
	const continuous = () => page.evaluate(() => document.getAnimations()
		.filter((animation) => animation.effect?.getTiming().iterations === Infinity)
		.map((animation) => animation instanceof CSSAnimation ? animation.animationName : animation.id));
	await expect.poll(continuous).toEqual([]);
	await expect(page.locator(".timeline-marker-node-active")).toHaveCSS("background-color", "rgb(53, 128, 221)");
	await expect(page.locator(".tool-group-card-dot")).toHaveCSS("background-color", "rgb(185, 130, 34)");
});
