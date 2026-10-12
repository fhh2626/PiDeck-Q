import { expect, test } from "@playwright/test";
import type {} from "./inputStyleInvalidation.fixture";

/**
 * 长会话输入卡顿回归：
 * :has() 的参数里含属性选择器或 :empty 时，页面任意位置增删元素都会让 Chromium 重算整页样式；
 * 受控 textarea 每次按键改写子文本节点，只要存在任意 :has() 规则也会触发同样的整页重算。
 * 长会话（数万个元素）里两者都会让每次按键耗时 70ms 以上。
 */

test.beforeEach(async ({ page }) => {
	await page.goto("/tests/browser/inputStyleInvalidation.html");
	await expect(page.locator("#prompt")).toHaveCount(1);
});

test("loaded stylesheets only keep the known-safe :has() rules (shadcn button icon padding)", async ({ page }) => {
	const offenders = await page.evaluate(() => {
		const found: string[] = [];
		const walk = (rules: CSSRuleList) => {
			for (const rule of Array.from(rules)) {
				// 唯一保留的是 shadcn Button 按“直接子元素是否为 svg”收紧内边距的规则：参数只有标签，
				// 实测不触发整页重算。其余 :has()（含只用类名的）在长会话里都曾让输入变慢。
				if (rule instanceof CSSStyleRule && rule.selectorText.includes(":has(") && !/:has\(> svg\)$/.test(rule.selectorText)) {
					found.push(rule.selectorText);
				}
				if ("cssRules" in rule && (rule as CSSGroupingRule).cssRules) walk((rule as CSSGroupingRule).cssRules);
			}
		};
		for (const sheet of Array.from(document.styleSheets)) {
			try {
				walk(sheet.cssRules);
			} catch {
				// 跨源样式表不可读；本测试页只加载同源样式。
			}
		}
		return found;
	});
	expect(offenders).toEqual([]);
});

test("Web composer typing never rewrites the textarea's child text", async ({ page }) => {
	const textarea = page.locator("#prompt");
	await page.evaluate(() => {
		const element = document.querySelector("#prompt")!;
		(window as unknown as { childMutations: number }).childMutations = 0;
		new MutationObserver((records) => {
			(window as unknown as { childMutations: number }).childMutations += records.length;
		}).observe(element, { childList: true, characterData: true, subtree: true });
	});
	const send = page.locator("button[type=submit]");
	await expect(send).toBeDisabled();
	await textarea.pressSequentially("你好 hello world");
	await expect(textarea).toHaveValue("你好 hello world");
	await expect(send).toBeEnabled();
	expect(await page.evaluate(() => (window as unknown as { childMutations: number }).childMutations)).toBe(0);

	await textarea.press("Enter");
	await expect(textarea).toHaveValue("");
	await expect(send).toBeDisabled();
	expect(await page.evaluate(() => window.sentPrompts)).toEqual(["你好 hello world"]);

	await textarea.pressSequentially("   ");
	await expect(send).toBeDisabled();
	await textarea.press("Enter");
	expect(await page.evaluate(() => window.sentPrompts)).toEqual(["你好 hello world"]);
});
