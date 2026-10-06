import { expect, test } from "@playwright/test";
import type {} from "./controlledTextarea.fixture";

/**
 * 共享 Textarea 对调用方是受控用法，但打字时不能改写 textarea 的子文本节点：
 * 只要样式表里有任意 :has()，子节点改写就会让 Chromium 重算整页样式（长会话每键 70ms+，
 * 见 docs/long-session-input-lag-fix.md）。同时必须保持 React 受控组件的可观察语义。
 */

test.beforeEach(async ({ page }) => {
	await page.goto("/tests/browser/controlledTextarea.html");
	await expect(page.locator("#plain")).toHaveValue("初始");
	await page.evaluate(() => {
		(window as unknown as { childMutations: number }).childMutations = 0;
		for (const element of document.querySelectorAll("textarea")) {
			new MutationObserver((records) => {
				(window as unknown as { childMutations: number }).childMutations += records.length;
			}).observe(element, { childList: true, characterData: true, subtree: true });
		}
	});
});

const childMutations = (page: import("@playwright/test").Page) =>
	page.evaluate(() => (window as unknown as { childMutations: number }).childMutations);

test("typing updates controlled state without rewriting the textarea's child text", async ({ page }) => {
	const plain = page.locator("#plain");
	await plain.click();
	await plain.press("End");
	await plain.pressSequentially("abc 你好");
	await expect(plain).toHaveValue("初始abc 你好");
	await expect(page.locator("#plain-state")).toHaveText("初始abc 你好");
	// 中间插入：光标不能被同步逻辑挪到末尾。
	await plain.press("Home");
	await plain.press("ArrowRight");
	await plain.pressSequentially("X");
	await expect(plain).toHaveValue("初X始abc 你好");
	expect(await childMutations(page)).toBe(0);
});

test("filtering, rejecting and external updates keep React controlled semantics", async ({ page }) => {
	const filtered = page.locator("#filtered");
	await filtered.pressSequentially("a1b2c3");
	await expect(filtered).toHaveValue("abc");

	const rejecting = page.locator("#rejecting");
	await rejecting.click();
	await rejecting.press("End");
	await rejecting.pressSequentially("xyz");
	await expect(rejecting).toHaveValue("固定");

	await page.evaluate(() => window.textareaFixture?.setExternal("外部回填"));
	await expect(page.locator("#external")).toHaveValue("外部回填");
	await page.evaluate(() => window.textareaFixture?.setExternal(""));
	await expect(page.locator("#external")).toHaveValue("");
	// 转发的 ref 仍指向真实节点。
	expect(await page.evaluate(() => window.textareaFixture?.refNode()?.id)).toBe("external");
	expect(await childMutations(page)).toBe(0);
});

test("IME composition commits correctly through the controlled path", async ({ page }) => {
	const plain = page.locator("#plain");
	await plain.click();
	await plain.press("End");
	const cdp = await page.context().newCDPSession(page);
	for (const step of ["n", "ni", "nih", "niha", "nihao"]) {
		await cdp.send("Input.imeSetComposition", { text: step, selectionStart: step.length, selectionEnd: step.length });
	}
	await cdp.send("Input.insertText", { text: "你好" });
	await expect(plain).toHaveValue("初始你好");
	await expect(page.locator("#plain-state")).toHaveText("初始你好");
	expect(await childMutations(page)).toBe(0);
});

test("uncontrolled usage behaves like a native textarea", async ({ page }) => {
	const uncontrolled = page.locator("#uncontrolled");
	await expect(uncontrolled).toHaveValue("自由");
	await uncontrolled.click();
	await uncontrolled.press("End");
	await uncontrolled.pressSequentially("!");
	await expect(uncontrolled).toHaveValue("自由!");
});

test("autoFocus with initial content keeps the native caret position (start)", async ({ page }) => {
	await page.evaluate(() => window.textareaFixture?.showEditor(true));
	const editor = page.locator("#autofocus");
	await expect(editor).toHaveValue("已有内容");
	await expect(editor).toBeFocused();
	expect(await editor.evaluate((node: HTMLTextAreaElement) => [node.selectionStart, node.selectionEnd])).toEqual([0, 0]);
	await editor.press("End");
	await editor.pressSequentially("！");
	await expect(editor).toHaveValue("已有内容！");
});
