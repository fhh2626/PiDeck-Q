import { expect, test } from "@playwright/test";

for (const viewport of [{ width: 1280, height: 900 }, { width: 640, height: 480 }]) {
	test(`prompt editor escapes settings bounds and receives input at ${viewport.width}x${viewport.height}`, async ({ page }) => {
		await page.setViewportSize(viewport);
		await page.goto("/tests/browser/promptEditor.html");
		await page.getByRole("button", { name: "/editable", exact: true }).click();
		const editor = page.getByRole("dialog", { name: "editable.md", exact: true });
		await expect(editor).toBeVisible();
		const bounds = await editor.boundingBox();
		expect(bounds).not.toBeNull();
		if (!bounds) throw new Error("Editor has no bounds");
		expect(bounds.width).toBeGreaterThan(520);
		expect(bounds.x).toBeGreaterThanOrEqual(0);
		expect(bounds.y).toBeGreaterThanOrEqual(0);
		expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width);
		expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height);
		const save = editor.getByRole("button", { name: "Save", exact: true });
		await editor.locator(".cm-content").fill("Changed content");
		await expect(editor.locator(".cm-content")).toContainText("Changed content");
		await expect(save).toBeEnabled();
		await expect.poll(() => save.evaluate((element) => {
			const rect = element.getBoundingClientRect();
			return element.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
		})).toBe(true);
		await save.click();
		await expect(editor.getByRole("status")).toContainText("Saved");
		await page.keyboard.press("Escape");
		await expect(editor).toBeHidden();
		await expect(page.getByTestId("settings")).toBeVisible();
	});
}

test("closing the editor restores the settings dialog and permits reopening", async ({ page }) => {
	await page.goto("/tests/browser/promptEditor.html");
	const trigger = page.getByRole("button", { name: "/editable", exact: true });
	await trigger.click();
	const editor = page.getByRole("dialog", { name: "editable.md", exact: true });
	await expect(editor).toBeVisible();
	await editor.getByRole("button", { name: "Close", exact: true }).last().click();
	await expect(editor).toBeHidden();
	await expect(page.getByTestId("settings")).toBeVisible();
	await trigger.click();
	await expect(editor).toBeVisible();
});
