import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";

// 每页独立收集未捕获的页面运行时异常（按 Page 隔离，避免测试间串扰）。
const pageErrors = new WeakMap<Page, string[]>();

test.describe("WebSidebar, Desktop ToolGroupCard, and WebTimeline Interaction Tests", () => {
	test.beforeEach(async ({ page }) => {
		// 必须先于导航注册，否则会漏掉初次加载期间抛出的异常。
		const errors: string[] = [];
		pageErrors.set(page, errors);
		page.on("pageerror", (error) => {
			errors.push(error.message);
		});

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

	test("6. WebTimeline: 空助手占位不打断连续工具分组，折叠/展开正常，占位出现正文后拆开", async ({ page }) => {
		const section = page.locator("#web-timeline-placeholder-section");

		// 用户消息与最终正文独立渲染
		await expect(section.locator(".user-turn")).toBeVisible();
		await expect(section.locator(".timeline-inline-text")).toContainText("All checks complete.");

		// 1. 空占位时：恰好一个工具组，默认折叠
		const groupCard = section.locator(".tool-group-card");
		await expect(groupCard).toHaveCount(1);
		const groupToggle = groupCard.locator("button").first();
		await expect(groupToggle).toBeVisible();
		await expect(groupToggle).toHaveAttribute("aria-expanded", "false");
		await expect(groupCard.locator(".tool-card")).toHaveCount(0);

		// 2. 点击展开：两个子工具卡按顺序可见（powershell → read）
		await groupToggle.click();
		await expect(groupToggle).toHaveAttribute("aria-expanded", "true");
		await expect(groupCard.locator(".tool-card")).toHaveCount(2);
		const toolNames = groupCard.locator(".tool-card");
		await expect(toolNames.nth(0)).toHaveAttribute("data-tool-name", "powershell");
		await expect(toolNames.nth(1)).toHaveAttribute("data-tool-name", "read");
		await expect(toolNames.nth(0)).toBeVisible();
		await expect(toolNames.nth(1)).toBeVisible();

		// 3. 再次点击折叠
		await groupToggle.click();
		await expect(groupToggle).toHaveAttribute("aria-expanded", "false");
		await expect(groupCard.locator(".tool-card")).toHaveCount(0);

		// 4. 占位获得可见正文后：两个工具不再同组，正文只出现一次
		await page.click("#toggle-placeholder-text");
		await expect(section.locator(".tool-group-card")).toHaveCount(0);
		await expect(section.locator("[data-tool-name=powershell]")).toHaveCount(1);
		await expect(section.locator("[data-tool-name=read]")).toHaveCount(1);
		await expect(section.locator("[data-tool-name=powershell]")).toBeVisible();
		await expect(section.locator("[data-tool-name=read]")).toBeVisible();
		const placeholderText = section.getByText("Let me look at the file content", { exact: true });
		await expect(placeholderText).toHaveCount(1);
		await expect(placeholderText).toBeVisible();

		// 5. 切回空占位：重新合并为工具组（纯函数重算的展示行为）
		await page.click("#toggle-placeholder-text");
		await expect(section.locator(".tool-group-card")).toHaveCount(1);

		// 6. 整个用例无未捕获的页面运行时异常
		const errors = pageErrors.get(page);
		expect(errors).toBeDefined();
		expect(errors).toEqual([]);
	});

	test("7. WebTimeline: 60 轮会话只挂载最近 50 轮，展开按钮按 10 轮步长还原更早内容且不重复", async ({ page }) => {
		const section = page.locator("#web-timeline-turn-window-section");

		// 60 轮 = 120 条消息；窗口只挂载最近 50 轮 = 100 条（首轮 = Question 11）
		await expect(section.getByText("Question 11", { exact: true })).toHaveCount(1);
		await expect(section.getByText("Question 10", { exact: true })).toHaveCount(0);
		await expect(section.getByText("Question 60", { exact: true })).toHaveCount(1);

		// 隐藏 10 轮：按钮文案带轮数，点击后展开 10 轮（到 Question 1）
		const revealButton = section.locator("button", { hasText: /显示更早的 10 轮对话|Show 10 earlier turns/ });
		await expect(revealButton).toHaveCount(1);
		await revealButton.click();

		await expect(section.getByText("Question 1", { exact: true })).toHaveCount(1);
		await expect(section.getByText("Question 11", { exact: true })).toHaveCount(1);
		// 已加载内容全部可见：按钮消失（底层无更多磁盘历史）
		await expect(section.locator("button", { hasText: /显示更早的|Show \d+ earlier turns/ })).toHaveCount(0);

		// 展开后无重复渲染（同一消息只能出现一次）
		await expect(section.getByText("Question 30", { exact: true })).toHaveCount(1);
		await expect(section.getByText("Answer 30", { exact: true })).toHaveCount(1);

		const errors = pageErrors.get(page);
		expect(errors).toEqual([]);
	});

	test("8. WebTimeline: 消息先于加载状态落地时，旧页可见且阅读位置稳定", async ({ page }) => {
		const section = page.locator("#web-timeline-async-section");
		const timeline = section.locator(".message-timeline");

		// 初始 50 轮：只挂载最近 50 轮（Question 6..55），Question 0..5 等更早轮次尚未加载
		await expect(section.getByText("Question 55", { exact: true })).toHaveCount(1);

		// 点击时间线内「加载更多」：触发 revealOlder → 登记 pendingDiskRevealRef + loadingMore=true。
		// Playwright 点击时间线顶部按钮时会自动把容器滚到顶部（scrollTop=0），
		// 这与真实用户点完按钮后的位置一致；锚点在「前插落地时」才捕获，不受点击瞬间位置影响。
		const loadButton = section.locator("button", { hasText: /加载更多对话|Load more conversations/ });
		await expect(loadButton).toHaveCount(1);
		await loadButton.click();
		// 文案切换为「加载中…」：loadingMore=true
		await expect(section.locator("button", { hasText: /加载中|Loading/ })).toHaveCount(1);

		// 请求等待期间，用户把阅读位置滚到中间（Question 30 居中）：
		// 锚点将在「前插落地」时按此刻位置捕获，验证阅读位置稳定。
		const scrollAnchorToCenter = () =>
			timeline.evaluate((el) => {
				const anchor = el.querySelector('[data-web-message-id="aw-u-30"]');
				if (!anchor) return false;
				const anchorTop = anchor.getBoundingClientRect().top - el.getBoundingClientRect().top;
				el.scrollTop += anchorTop - el.clientHeight / 2;
				return true;
			});
		await expect.poll(scrollAnchorToCenter).toBeTruthy();
		const readAnchor = async () =>
			section.getByText("Question 30", { exact: true }).evaluate((node) => {
				const container = node.closest(".message-timeline");
				return node.getBoundingClientRect().top - (container ? container.getBoundingClientRect().top : 0);
			});
		const anchorOffset = await readAnchor();
		expect(anchorOffset).toBeGreaterThan(0);

		// 请求期间（loadingMore=true）前插 6 个更早轮次（Question 0..5）
		await page.click("#async-prepend");

		// 消息先提交，稍后请求返回成功的新头并复位 loadingMore。
		await page.click("#async-complete");
		await expect(section.locator("button", { hasText: /加载中|Loading/ })).toHaveCount(0);
		// 新页落地：旧页消息可见（Question 0..5），且无重复
		await expect(section.getByText("Question 5", { exact: true })).toHaveCount(1);
		await expect(section.getByText("Question 0", { exact: true })).toHaveCount(1);
		await expect(section.getByText("Question 30", { exact: true })).toHaveCount(1);

		// 锚点补偿：Question 30 相对滚动容器顶部的偏移应基本不变（允许少量像素误差）
		const anchorOffsetAfter = await readAnchor();
		expect(Math.abs(anchorOffsetAfter - anchorOffset)).toBeLessThan(2);

		const errors = pageErrors.get(page);
		expect(errors).toEqual([]);
	});

	test("8b. WebTimeline: 加载状态先复位、旧页稍后落地时仍显示旧页并保持阅读位置", async ({ page }) => {
		const section = page.locator("#web-timeline-async-section");
		const timeline = section.locator(".message-timeline");
		await expect(section.getByText("Question 55", { exact: true })).toHaveCount(1);
		await section.locator("button", { hasText: /加载更多对话|Load more conversations/ }).click();
		await expect(section.locator("button", { hasText: /加载中|Loading/ })).toHaveCount(1);
		// 模拟请求等待期间用户继续阅读中部；不能因 loadingMore 先复位丢失锚点。
		await timeline.evaluate((el) => {
			const anchor = el.querySelector('[data-web-message-id="aw-u-30"]');
			if (!anchor) throw new Error("reading anchor missing");
			el.scrollTop += anchor.getBoundingClientRect().top - el.getBoundingClientRect().top - el.clientHeight / 2;
		});
		const anchorOffset = await section.getByText("Question 30", { exact: true }).evaluate((node) => {
			const container = node.closest(".message-timeline");
			if (!container) throw new Error("timeline missing");
			return node.getBoundingClientRect().top - container.getBoundingClientRect().top;
		});
		expect(await timeline.evaluate((el) => el.scrollTop)).toBeGreaterThan(24);
		await page.click("#async-complete-before-messages");
		await expect(section.locator("button", { hasText: /加载中|Loading/ })).toHaveCount(0);
		await expect(section.getByText("Question 0", { exact: true })).toHaveCount(0);
		await page.click("#async-prepend");
		await expect(section.getByText("Question 0", { exact: true })).toHaveCount(1);
		await expect(section.getByText("Question 5", { exact: true })).toHaveCount(1);
		const after = await section.getByText("Question 30", { exact: true }).evaluate((node) => {
			const container = node.closest(".message-timeline");
			if (!container) throw new Error("timeline missing");
			return node.getBoundingClientRect().top - container.getBoundingClientRect().top;
		});
		expect(Math.abs(after - anchorOffset)).toBeLessThan(2);
		expect(pageErrors.get(page)).toEqual([]);
	});

	test("9. WebTimeline: 短时间线点「加载更多」后不会重新跟底，新消息追加不拉回底部", async ({ page }) => {
		const section = page.locator("#web-timeline-short-section");

		// 初始仅 2 轮（Question 7、8，内容不足一屏）：贴底
		await expect(section.getByText("Question 7", { exact: true })).toHaveCount(1);
		await expect(section.getByText("Question 8", { exact: true })).toHaveCount(1);

		// 点击「加载更多」：前插 6 轮并复位 loading
		const loadButton = section.locator("button", { hasText: /加载更多对话|Load more conversations/ });
		await expect(loadButton).toHaveCount(1);
		await loadButton.click();

		// 新页可见：Question 1..8 全部出现，无重复
		await expect(section.getByText("Question 1", { exact: true })).toHaveCount(1);
		await expect(section.getByText("Question 8", { exact: true })).toHaveCount(1);

		// 主动看历史后：追加新消息不得把视口拉回底部（「回到底部」入口应出现）
		await page.click("#short-append");
		await expect(section.getByText("Question 9", { exact: true })).toHaveCount(1);
		const scrollBtn = section.locator("[aria-label*='滚动到底部'], [aria-label*='Scroll to bottom']");
		await expect(scrollBtn).toBeVisible();

		// 点「回到底部」后才恢复跟底，入口消失
		await scrollBtn.click();
		await expect(scrollBtn).toBeHidden();

		const errors = pageErrors.get(page);
		expect(errors).toEqual([]);
	});

	for (const outcome of ["fail", "empty"] as const) {
		test(`10. WebTimeline: ${outcome} 后无关头部变更不会误展开旧页`, async ({ page }) => {
			const section = page.locator("#web-timeline-async-section");
			await expect(section.getByText("Question 55", { exact: true })).toHaveCount(1);
			await section.locator("button", { hasText: /加载更多对话|Load more conversations/ }).click();
			await expect(section.locator("button", { hasText: /加载中|Loading/ })).toHaveCount(1);
			// 失败/空页必须清掉请求状态；之后没有新请求的头部变更不得被当作旧页落地。
			await page.click(`#async-${outcome}`);
			await expect(section.locator("button", { hasText: /加载中|Loading/ })).toHaveCount(0);
			await expect(section.getByText("Question 0", { exact: true })).toHaveCount(0);
			const oldHead = section.getByText("Question 6", { exact: true });
			const before = await oldHead.evaluate((node) => {
				const container = node.closest(".message-timeline");
				if (!container) throw new Error("timeline missing");
				return node.getBoundingClientRect().top - container.getBoundingClientRect().top;
			});
			await page.click("#async-unrelated-head");
			await expect(section.getByText("Unrelated earlier message", { exact: true })).toHaveCount(0);
			await expect(oldHead).toHaveCount(1);
			const after = await oldHead.evaluate((node) => {
				const container = node.closest(".message-timeline");
				if (!container) throw new Error("timeline missing");
				return node.getBoundingClientRect().top - container.getBoundingClientRect().top;
			});
			expect(Math.abs(after - before)).toBeLessThan(2);
			// 尾部正常追加不会触发待加载旧页逻辑；保持窗口不变。
			await page.click("#async-append");
			await expect(section.getByText("Question 56", { exact: true })).toHaveCount(1);
			await expect(section.getByText("Unrelated earlier message", { exact: true })).toHaveCount(0);
			expect(pageErrors.get(page)).toEqual([]);
		});
	}
});
