import { expect, test } from "@playwright/test";
import type {} from "./composerInput.fixture";

test.beforeEach(async ({ page }) => {
  await page.goto("/tests/browser/composerInput.html");
  await expect(page.locator(".ProseMirror")).toHaveCount(1);
  await expect.poll(() => page.evaluate(() => Boolean(window.composerInputFixture))).toBe(true);
  // Allow editor creation/StrictMode and the initial panel-registration frame to settle.
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await page.evaluate(() => window.composerInputFixture?.reset());
});

test("real typing does not reconfigure TipTap or measure unchanged extras", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.locator(".ProseMirror").pressSequentially("abcdefghijklmnopqrst");
  await expect(page.getByTestId("draft")).toHaveText("abcdefghijklmnopqrst");
  const metrics = await page.evaluate(() => window.composerInputFixture?.snapshot());
  expect(metrics?.optionUpdates).toBe(0);
  expect(metrics?.extraReads).toBe(0);
  expect(metrics?.changes).toHaveLength(20);
  expect(errors).toEqual([]);
});

test("external draft replacement and paired caret survive stable initialization", async ({ page }) => {
  await page.evaluate(() => window.composerInputFixture?.replace("restored draft", 3));
  await expect(page.locator(".ProseMirror")).toHaveText("restored draft");
  await expect.poll(() => page.evaluate(() => window.composerInputFixture?.snapshot().caret)).toBe(4);
  await page.locator(".ProseMirror").press("x");
  await expect(page.getByTestId("draft")).toHaveText("resxtored draft");
  await page.evaluate(() => window.composerInputFixture?.replace(""));
  await expect(page.locator(".ProseMirror")).toHaveText("");
  await page.locator(".ProseMirror").press("y");
  await expect(page.getByTestId("draft")).toHaveText("y");
});

test("configuration changes update disabled state and placeholder while callbacks stay fresh", async ({ page }) => {
  await page.evaluate(() => window.composerInputFixture?.configure(true, "blocked"));
  await expect(page.locator(".ProseMirror")).toHaveAttribute("contenteditable", "false");
  await expect(page.locator(".ProseMirror")).toHaveAttribute("data-placeholder", "blocked");
  await page.evaluate(() => window.composerInputFixture?.configure(false, "ready"));
  await expect(page.locator(".ProseMirror")).toHaveAttribute("contenteditable", "true");
  await expect(page.locator(".ProseMirror")).toHaveAttribute("data-placeholder", "ready");
  await page.evaluate(() => window.composerInputFixture?.callbacks("latest"));
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  await page.locator(".ProseMirror").press("z");
  await expect(page.getByTestId("draft")).toHaveText("z");
  const metrics = await page.evaluate(() => window.composerInputFixture?.snapshot());
  expect(metrics?.changes.at(-1)).toBe("latest:z");
  expect(metrics?.keys.at(-1)).toBe("latest:z");
});

test("IME composition publishes committed text without resetting content", async ({ page }) => {
  const editor = page.locator(".ProseMirror");
  await editor.focus();
  await editor.dispatchEvent("compositionstart", { data: "" });
  await page.keyboard.insertText("中文");
  await editor.dispatchEvent("compositionend", { data: "中文" });
  await expect(page.getByTestId("draft")).toHaveText("中文");
  await expect(editor).toHaveText("中文");
  await editor.press("x");
  await expect(page.getByTestId("draft")).toHaveText("中文x");
});

test("real ResizeObserver grows and shrinks extras without typing and cleans up", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.evaluate(() => window.composerInputFixture?.extras(48, true));
  await expect.poll(() => page.evaluate(() => window.composerInputFixture?.snapshot().reports.at(-1))).toBe(88);
  await page.evaluate(() => window.composerInputFixture?.extras(24, false));
  await expect.poll(() => page.evaluate(() => window.composerInputFixture?.snapshot().reports.at(-1))).toBe(24);
  await page.evaluate(() => window.composerInputFixture?.extras(0, false));
  await expect.poll(() => page.evaluate(() => window.composerInputFixture?.snapshot().reports.at(-1))).toBe(0);
  await page.evaluate(() => window.composerInputFixture?.extras(24, true));
  await expect.poll(() => page.evaluate(() => window.composerInputFixture?.snapshot().reports.at(-1))).toBe(64);
  await page.evaluate(() => window.composerInputFixture?.unmount());
  await expect(page.locator(".ProseMirror")).toHaveCount(0);
  expect(errors).toEqual([]);
});
