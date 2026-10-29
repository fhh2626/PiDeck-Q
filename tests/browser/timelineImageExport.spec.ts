import { test, expect } from "@playwright/test";

test.describe("长图导出独立只读树 (Timeline Image Export)", () => {
	test.beforeEach(async ({ page }) => {
		await page.goto("/tests/browser/timelineImageExport.html");
		await page.waitForSelector("#btn-build-export");
	});

	test("构建独立只读模型并在 DOM 中全量展开完整思考、工具明细与只读 Markdown", async ({ page }) => {
		// 1. 点击生成导出
		await page.click("#btn-build-export");
		await page.waitForSelector("#export-render-container");

		// 2. 验证内部只读内容容器拥有 data-markdown-readonly="true" 标记，以完全与全局 FormulaCopyLayer 隔离
		const readonlyContent = page.locator('.export-content[data-markdown-readonly="true"]');
		await expect(readonlyContent).toBeVisible();

		// 3. 验证思考过程被完整展现，没有遗漏
		const thinkingBlock = page.locator(".export-thinking-block");
		await expect(thinkingBlock).toContainText("这里是长思考过程，绝不能在长图导出时被截断或遗漏。");

		// 4. 验证工具调用无 40 张分页限制，直接展示完整结果文本
		const toolCard = page.locator(".export-tool-card");
		await expect(toolCard).toContainText("TOOL: analyze_data");

		// 5. 验证只读 Markdown 内容正常渲染出段落文本
		const answerContent = page.locator(".export-answer-content");
		await expect(answerContent).toContainText("这是最终的 Markdown 回答内容");
	});
});
