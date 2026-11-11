import { expect, test } from "@playwright/test";

/** Unknown outcomes must remain visible and neutral on both presentation surfaces. */
test("incomplete history stays neutral, including groups and ask_question, until an actual outcome arrives", async ({ page }) => {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.goto("/tests/browser/incompleteToolHistory.html");
	const single = page.locator("#desktop-single .tool-card");
	await expect(single).toHaveAttribute("data-status", "unknown");
	await expect(single).toContainText(/未记录结果|No result recorded/);
	await expect(page.locator('#desktop-single [data-marker-tone="neutral"]')).toHaveCount(1);
	await expect(single.locator(".tool-card-spinner,[data-tool-duration],.animate-tool-sweep")).toHaveCount(0);
	await single.locator("button[aria-expanded]").click();
	await expect(single.locator('section[data-status="success"]')).toHaveCount(0);
	const desktopGroup = page.locator("#desktop-group .tool-group-card");
	await expect(desktopGroup.locator(":scope > button")).toContainText(/未记录结果|No result recorded/);
	await desktopGroup.locator(":scope > button").click();
	const web = page.locator("#web-timeline");
	await web.locator(".execution-summary-toggle").click();
	const webGroup = web.locator(".tool-group-card");
	await expect(webGroup.locator(":scope > button")).toContainText(/未记录结果|No result recorded/);
	await webGroup.locator(":scope > button").click();
	await expect(web.locator('[data-tool-name="ask_question"]')).toHaveAttribute("data-status", "unknown");
	await expect(web.locator("input,textarea")).toHaveCount(0);
	await expect(web.locator('.tool-card[data-status="unknown"] .tool-card-spinner')).toHaveCount(0);

	for (const phase of ["running", "done", "error"]) {
		await page.locator(`#phase-${phase}`).click();
		await expect(single).toHaveAttribute("data-status", phase);
		await expect(page.locator('#desktop-single [data-marker-kind="tool"]')).toHaveAttribute("data-marker-tone",
			phase === "running" ? "active" : phase === "done" ? "success" : "error");
		await expect(desktopGroup.locator('[data-message-id="desktop-sub"]')).toHaveAttribute("data-status", phase);
		await expect(web.locator('[data-tool-name="subagent"]')).toHaveCount(1);
		await expect(web.locator('[data-tool-name="subagent"]')).toHaveAttribute("data-status", phase);
		// The other incomplete call must not turn into a completed card or a form.
		await expect(web.locator('[data-tool-name="ask_question"]')).toHaveAttribute("data-status", "unknown");
		if (phase === "done") {
			await expect(desktopGroup.locator(":scope > button")).toContainText(/未记录结果|No result recorded/);
			await expect(webGroup.locator(":scope > button")).toContainText(/未记录结果|No result recorded/);
		}
	}
	expect(errors).toEqual([]);
});
