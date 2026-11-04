import { test, expect } from "@playwright/test";

test.describe("长会话虚拟化时间线 (Desktop Virtual Timeline)", () => {
	test.beforeEach(async ({ page }) => {
		await page.goto("/tests/browser/desktopVirtualTimeline.html");
		await page.waitForSelector("#scroll-viewport");
	});

	test("2000 行超长列表首屏挂载 DOM 节点数严格受限且无全量挂载", async ({ page }) => {
		// 等待首屏 ResizeObserver 与初始测量稳定
		await page.waitForTimeout(60);
		const renderedCountText = await page.locator("#rendered-count").innerText();
		const count = parseInt(renderedCountText.replace(/[^\d]/g, ""), 10);

		// 视口高度约 800px，单项高度约 60-120px，加上上下超载预渲染（300px），
		// 首屏渲染节点数应严格处于 10 ~ 60 范围内，绝不能是 2000。
		expect(count).toBeGreaterThan(0);
		expect(count).toBeLessThan(70);

		const domItemCount = await page.locator(".timeline-item").count();
		expect(domItemCount).toBe(count);
	});

	test("快速滚动到 25000px 处，虚拟窗口平滑滑动并动态替换节点", async ({ page }) => {
		await page.click("#btn-scroll-middle");
		await page.waitForTimeout(100);

		const renderedCountText = await page.locator("#rendered-count").innerText();
		const count = parseInt(renderedCountText.replace(/[^\d]/g, ""), 10);
		expect(count).toBeGreaterThan(0);
		expect(count).toBeLessThan(70);

		// 验证当前挂载的第一项已经不是开头的消息（开头为 msg-user-0）
		const firstMountedKey = await page.locator(".timeline-item").first().locator("strong").innerText();
		expect(firstMountedKey).not.toBe("msg-user-0");
	});

	test("离屏 Pin 保护：远距离行在设置 pin 后即使超出可视区依然保留在 DOM 中", async ({ page }) => {
		// 1. 确保在首屏，此时 msg-user-10 包含在可视区附近
		// 2. 点击 Pin 按钮锁定 msg-user-10
		await page.click("#btn-pin-item-10");

		// 3. 滚动到 25000px 远处
		await page.click("#btn-scroll-middle");
		await page.waitForTimeout(100);

		// 4. 验证 msg-user-10 虽然在离屏位置，但由于离屏 Pin 机制依然挂载在 DOM 中
		const pinnedRow = page.locator('.timeline-item[data-message-id="msg-user-10"]');
		await expect(pinnedRow).toHaveCount(1);
	});

	test("流式尾部新增消息响应流畅，测量高度随之递增", async ({ page }) => {
		const initialCountText = await page.locator("#total-rows").innerText();
		const initialCount = parseInt(initialCountText.replace(/[^\d]/g, ""), 10);

		await page.click("#btn-append-stream");
		await page.waitForTimeout(60);

		const nextCountText = await page.locator("#total-rows").innerText();
		const nextCount = parseInt(nextCountText.replace(/[^\d]/g, ""), 10);

		expect(nextCount).toBe(initialCount + 1);

		// 确保新加入的消息在列表中能够被检索到
		const lastRow = page.locator('.timeline-item[data-message-id="stream-msg-2000"]');
		// 滚动到底部使其进入视口
		await page.evaluate(() => {
			const el = document.getElementById("scroll-viewport");
			if (el) el.scrollTop = el.scrollHeight;
		});
		await expect(lastRow).toBeVisible();
	});

	test("真实 SessionMessageTimeline 装配：100 轮会话挂载，DOM 节点严格虚拟化且支持动态追加", async ({ page }) => {
		// 切换到真实 SessionMessageTimeline 装配
		await page.click("#btn-toggle-integrated");
		await page.waitForSelector("#integrated-viewport-container");

		// 验证真实渲染节点存在（生产视口类名为 message-timeline）
		const timelineContainer = page.locator("#integrated-viewport-container .message-timeline");
		await expect(timelineContainer).toBeVisible();

		// 验证虚拟化行数严格受限：100 轮共 200 条消息，挂载行数必须严格处于 3 ~ 45 之间，绝非 200
		const mountedRows = page.locator("#integrated-viewport-container [data-timeline-row-key]");
		const mountedCount = await mountedRows.count();
		expect(mountedCount).toBeGreaterThanOrEqual(3);
		expect(mountedCount).toBeLessThan(45);

		// 验证真实虚拟占位 spacer 存在（生产属性为 data-virtual-spacer）
		const virtualSpacers = page.locator("#integrated-viewport-container [data-virtual-spacer]");
		const spacerCount = await virtualSpacers.count();
		expect(spacerCount).toBeGreaterThanOrEqual(1);

		// 1. 点击追加新轮次之前，动态追加的问题节点不得存在于 DOM 中
		const dynRowBefore = page.locator('#integrated-viewport-container [data-timeline-row-key="message:u-dyn-100"]');
		await expect(dynRowBefore).toHaveCount(0);

		// 2. 点击追加新轮次
		await page.click("#btn-integrated-append");
		await page.waitForTimeout(60);

		// 3. 验证标题包含 101 轮
		const turnsText = await page.locator("#integrated-total-turns").innerText();
		expect(turnsText).toContain("101");

		// 4. 处于顶部视口未滚动时，追加的末尾消息仍不被挂载到 DOM 中（证明无全量 DOM 挂载）
		const dynRowAtTop = page.locator('#integrated-viewport-container [data-timeline-row-key="message:u-dyn-100"]');
		await expect(dynRowAtTop).toHaveCount(0);

		// 5. 滚动到底部，使动态追加的末尾行进入视口
		await page.evaluate(() => {
			const el = document.querySelector("#integrated-viewport-container .message-timeline");
			if (el) el.scrollTop = el.scrollHeight;
		});
		await page.waitForTimeout(100);

		// 6. 滚动后末尾动态行必须被真实挂载（数量变为 1）
		const dynRowAtBottom = page.locator('#integrated-viewport-container [data-timeline-row-key="message:u-dyn-100"]');
		await expect(dynRowAtBottom).toHaveCount(1);

		// 7. 滚动后挂载节点总数依然严格受限于虚拟化窗口 (< 45)
		const mountedCountAfterScroll = await mountedRows.count();
		expect(mountedCountAfterScroll).toBeLessThan(45);
	});
});
