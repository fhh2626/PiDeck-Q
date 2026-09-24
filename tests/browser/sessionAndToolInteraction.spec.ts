import { test, expect } from "@playwright/test";

test.describe("WebSidebar, Desktop ToolGroupCard, and WebTimeline Interaction Tests", () => {
	test.beforeEach(async ({ page }) => {
		await page.goto("http://127.0.0.1:5189/tests/browser/sessionAndToolInteraction.html");
		await page.waitForSelector("#event-monitor");
		// 确保会话列表已展开（如果未展开则点击折叠箭头展开）
		const sessionRow = page.locator(".session-row-wrapper").first();
		if (!(await sessionRow.isVisible())) {
			await page.locator(".project-fold").first().click();
		}
		await expect(page.locator(".session-row-wrapper").first()).toBeVisible();
	});

	test("1. WebSidebar: 激活中状态禁用删除且不弹窗，运行中显示关闭按钮，启动中禁用关闭", async ({ page }) => {
		// 1. 激活中会话 (sess-activating)
		const activatingRow = page.locator(".session-row-wrapper").filter({ hasText: "Activating Session" });
		await expect(activatingRow).toBeVisible();
		const activatingActionBtn = activatingRow.locator(".session-action");
		await expect(activatingActionBtn).toBeDisabled();

		// 监听 confirm：如果被意外触发，测试抛错
		let confirmTriggered = false;
		page.on("dialog", (dialog) => {
			confirmTriggered = true;
			void dialog.dismiss();
		});

		// 尝试点击禁用的激活删除按钮（强制点击）
		await activatingActionBtn.click({ force: true });
		expect(confirmTriggered).toBe(false);
		await expect(page.locator("#val-deleted-session")).toHaveText("none");

		// 2. 启动中会话 (sess-starting)
		const startingRow = page.locator(".session-row-wrapper").filter({ hasText: "Starting Session" });
		const startingActionBtn = startingRow.locator(".session-action");
		await expect(startingActionBtn).toBeDisabled();
		await expect(startingActionBtn).toHaveAttribute("aria-label", /关闭 Agent|Close agent/);

		// 3. 运行中会话 (sess-running)
		const runningRow = page.locator(".session-row-wrapper").filter({ hasText: "Running Session" });
		const runningActionBtn = runningRow.locator(".session-action");
		await expect(runningActionBtn).toBeEnabled();
		await expect(runningActionBtn).toHaveAttribute("aria-label", /关闭 Agent|Close agent/);

		// 点击关闭按钮：应触发 onCloseSession，且 stopPropagation 不改变原本选中的 session
		await runningActionBtn.click();
		await expect(page.locator("#val-closed-session")).toHaveText("sess-running");
		// 依然是初始的 sess-idle，未因为点击而切换到 sess-running
		await expect(page.locator("#val-selected-session")).toHaveText("sess-idle");
	});

	test("2. WebSidebar: 闲置会话删除弹窗包含关联子会话警告，取消不删除，确定才删除且不触发选择", async ({ page }) => {
		const idleRow = page.locator(".session-row-wrapper").filter({ hasText: "Idle Session" });
		const idleActionBtn = idleRow.locator(".session-action");
		await expect(idleActionBtn).toBeEnabled();
		await expect(idleActionBtn).toHaveAttribute("aria-label", /删除会话|Delete session/);

		let lastDialogMessage = "";

		// A. 第一次点击：取消删除
		page.once("dialog", async (dialog) => {
			lastDialogMessage = dialog.message();
			await dialog.dismiss();
		});
		await idleActionBtn.click();

		// 验证确认文案包含子会话警示
		expect(lastDialogMessage).toMatch(/子会话|child sessions/i);
		await expect(page.locator("#val-deleted-session")).toHaveText("none");
		await expect(page.locator("#val-selected-session")).toHaveText("sess-idle");

		// B. 第二次点击：确认删除
		page.once("dialog", async (dialog) => {
			await dialog.accept();
		});
		await idleActionBtn.click();

		await expect(page.locator("#val-deleted-session")).toHaveText("sess-idle");
		// 验证点击操作按钮阻止冒泡，未改变选中的会话
		await expect(page.locator("#val-selected-session")).toHaveText("sess-idle");
	});

	test("3. WebSidebar: 兼容旧服务端缺少 activatingSessionIds 时，闲置会话依然可以正常删除", async ({ page }) => {
		// 点击切换按钮将 activatingSessionIds 置为 undefined
		await page.click("#toggle-omit-activating");

		const idleRow = page.locator(".session-row-wrapper").filter({ hasText: "Idle Session" });
		const idleActionBtn = idleRow.locator(".session-action");
		await expect(idleActionBtn).toBeEnabled();

		page.once("dialog", async (dialog) => {
			await dialog.accept();
		});
		await idleActionBtn.click();
		await expect(page.locator("#val-deleted-session")).toHaveText("sess-idle");
	});

	test("4. 桌面 ToolGroupCard: 默认折叠不挂载详细卡片，折叠态图片可预览，展开后图片互斥不重复", async ({ page }) => {
		const multiSection = page.locator("#desktop-multi-group");
		const toggleBtn = multiSection.locator(".tool-group-card > button");
		await expect(toggleBtn).toBeVisible();
		await expect(toggleBtn).toHaveAttribute("aria-expanded", "false");

		// 1. 默认折叠态：内部详细 ToolCard 未挂载，整个组内恰好只有 1 个画廊、1 张缩略图（位于折叠摘要下方）
		await expect(multiSection.locator(".tool-card")).toHaveCount(0);
		await expect(multiSection.locator(".message-image-gallery")).toHaveCount(1);
		await expect(multiSection.locator(".message-image-gallery img")).toHaveCount(1);

		// 2. 折叠态：外部折叠头下方展示图片画廊，点击图片触发 onPreviewImage
		const galleryImg = multiSection.locator(".message-image-gallery img, .message-image-gallery button");
		await expect(galleryImg.first()).toBeVisible();
		await galleryImg.first().click();
		await expect(page.locator("#val-preview-image")).toHaveText("image/png");

		// 3. 点击展开
		await toggleBtn.click();
		await expect(toggleBtn).toHaveAttribute("aria-expanded", "true");
		// 详细 ToolCard 挂载（2 个工具卡片）
		await expect(multiSection.locator(".tool-card")).toHaveCount(2);

		// 关键互斥验证：展开后，外部摘要区的画廊被卸载，画廊由内部 ToolCard 独立渲染；
		// 整个组内画廊总数仍严格为 1，缩略图总数仍严格为 1，绝不重复展示！
		await expect(multiSection.locator(".message-image-gallery")).toHaveCount(1);
		await expect(multiSection.locator(".tool-card .message-image-gallery")).toHaveCount(1);
		await expect(multiSection.locator(".message-image-gallery img")).toHaveCount(1);

		// 4. 再次点击折叠：详细 ToolCard 卸载，画廊总数与缩略图总数仍为 1，恢复在折叠摘要下方
		await toggleBtn.click();
		await expect(toggleBtn).toHaveAttribute("aria-expanded", "false");
		await expect(multiSection.locator(".tool-card")).toHaveCount(0);
		await expect(multiSection.locator(".message-image-gallery")).toHaveCount(1);
		await expect(multiSection.locator(".message-image-gallery img")).toHaveCount(1);

		// 5. 单工具组退化：不显示折叠切换按钮
		const singleSection = page.locator("#desktop-single-group");
		await expect(singleSection.locator(".tool-group-card > button")).toHaveCount(0);
		await expect(singleSection.locator(".tool-card")).toHaveCount(1);
	});

	test("5. WebTimeline: 连续纯工具消息自动合并为 WebToolGroupCard，点击可展开工具列表", async ({ page }) => {
		const timelineSection = page.locator("#web-timeline-section");

		// 验证普通用户消息与最终文本消息独立渲染
		await expect(timelineSection.locator(".user-turn")).toBeVisible();
		await expect(timelineSection.locator(".timeline-inline-text")).toContainText("Here is the result.");

		// 验证 2 个连续工具合并为 WebToolGroupCard
		const groupCard = timelineSection.locator(".tool-group-card");
		await expect(groupCard).toHaveCount(1);

		// 默认折叠：不显示详细工具项
		const groupToggle = groupCard.locator("button");
		await expect(groupCard.locator(".tool-card")).toHaveCount(0);

		// 点击展开工具组
		await groupToggle.click();
		// 展开后显示 2 个工具项
		await expect(groupCard.locator(".tool-card")).toHaveCount(2);
	});
});
