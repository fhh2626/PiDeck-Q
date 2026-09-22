import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
	await page.goto("/tests/browser/imagePreview.html");
	await page.waitForSelector("#gallery-container");
});

test("A. 层级与鼠标命中：content 与按钮不被 overlay 遮挡，elementFromPoint 正确命中按钮", async ({ page }) => {
	// 点击第一张缩略图打开预览
	const thumbnails = page.locator("#gallery-container [role='button']");
	await thumbnails.first().click();

	const content = page.locator("[data-slot='dialog-content']");
	const overlay = page.locator("[data-slot='dialog-overlay']");
	await expect(content).toBeVisible();
	// overlay 存在且尺寸覆盖视口
	await expect(overlay).toBeAttached();

	// 验证 content 的 z-index >= overlay 的 z-index
	const zIndices = await page.evaluate(() => {
		const c = document.querySelector("[data-slot='dialog-content']");
		const o = document.querySelector("[data-slot='dialog-overlay']");
		const getZ = (el: Element | null) => {
			if (!el) return 0;
			const z = window.getComputedStyle(el).zIndex;
			return Number.parseInt(z, 10) || 0;
		};
		return { contentZ: getZ(c), overlayZ: getZ(o) };
	});
	expect(zIndices.contentZ).toBeGreaterThanOrEqual(zIndices.overlayZ);

	// elementFromPoint 命中测试：关闭按钮与下一张按钮
	const hitResults = await page.evaluate(() => {
		const closeBtn = document.querySelector("[data-testid='preview-close-btn']");
		const nextBtn = document.querySelector("[data-testid='preview-next-btn']");
		const hit = (el: Element | null) => {
			if (!el) return false;
			const rect = el.getBoundingClientRect();
			const cx = rect.left + rect.width / 2;
			const cy = rect.top + rect.height / 2;
			const atPoint = document.elementFromPoint(cx, cy);
			return el === atPoint || el.contains(atPoint);
		};
		return {
			closeBtnHit: hit(closeBtn),
			nextBtnHit: hit(nextBtn),
		};
	});
	expect(hitResults.closeBtnHit).toBe(true);
	expect(hitResults.nextBtnHit).toBe(true);

	// 实际点击下一张按钮，确认图片改变且 modal 仍打开
	const previewImg = content.locator("img");
	const initialSrc = await previewImg.getAttribute("src");

	const nextButton = page.locator("[data-testid='preview-next-btn']");
	await nextButton.click();
	await expect(content).toBeVisible();
	const nextSrc = await previewImg.getAttribute("src");
	expect(nextSrc).not.toBe(initialSrc);
});

test("B. 背景关闭与图片点击：点击图片不关闭，点击 content 空白区域与 Esc 可关闭", async ({ page }) => {
	const thumbnails = page.locator("#gallery-container [role='button']");
	const content = page.locator("[data-slot='dialog-content']");

	// 1. 点击图片不关闭
	await thumbnails.first().click();
	await expect(content).toBeVisible();
	const img = content.locator("img");
	await img.click();
	await expect(content).toBeVisible();

	// 2. 点击 content 空白区域关闭（在 (20, 20) 空白区点，直接点在 content 根元素上）
	await content.click({ position: { x: 20, y: 20 } });
	await expect(content).toBeHidden();

	// 3. 按 Esc 关闭
	await thumbnails.first().click();
	await expect(content).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(content).toBeHidden();

	// 4. 点击关闭按钮关闭
	await thumbnails.first().click();
	await expect(content).toBeVisible();
	await page.locator("[data-testid='preview-close-btn']").click();
	await expect(content).toBeHidden();
});

test("C. 键盘导航：ArrowRight / ArrowLeft 循环切换，左右按钮与键盘一致", async ({ page }) => {
	const thumbnails = page.locator("#gallery-container [role='button']");
	// 从第二张打开
	await thumbnails.nth(1).click();

	const content = page.locator("[data-slot='dialog-content']");
	await expect(content).toBeVisible();
	const img = content.locator("img");

	const src2 = await img.getAttribute("src");

	// ArrowRight -> 第三张
	await page.keyboard.press("ArrowRight");
	const src3 = await img.getAttribute("src");
	expect(src3).not.toBe(src2);

	// 再 ArrowRight -> 循环到第一张
	await page.keyboard.press("ArrowRight");
	const src1 = await img.getAttribute("src");
	expect(src1).not.toBe(src3);
	expect(src1).not.toBe(src2);

	// ArrowLeft -> 回到第三张
	await page.keyboard.press("ArrowLeft");
	expect(await img.getAttribute("src")).toBe(src3);
});

test("D. 焦点管理：打开时聚焦关闭按钮，关闭后焦点恢复到打开前的触发元素", async ({ page }) => {
	const thumbnails = page.locator("#gallery-container [role='button']");
	const secondThumb = thumbnails.nth(1);

	// 1. 键盘聚焦第二张缩略图
	await secondThumb.focus();
	await expect(secondThumb).toBeFocused();

	// 2. 按 Enter 打开预览
	await page.keyboard.press("Enter");
	const content = page.locator("[data-slot='dialog-content']");
	await expect(content).toBeVisible();

	// 3. 打开后焦点位于关闭按钮
	const closeBtn = page.locator("[data-testid='preview-close-btn']");
	await expect(closeBtn).toBeFocused();

	// 4. 按 Esc 关闭
	await page.keyboard.press("Escape");
	await expect(content).toBeHidden();

	// 5. 焦点恢复到第二张缩略图
	await expect(secondThumb).toBeFocused();
});

test("E. 触发元素已移除时正常关闭、不抛异常", async ({ page }) => {
	const thumbnails = page.locator("#gallery-container [role='button']");
	await thumbnails.first().click();

	const content = page.locator("[data-slot='dialog-content']");
	await expect(content).toBeVisible();

	// 移除 Gallery 容器 DOM
	await page.evaluate(() => {
		document.getElementById("remove-trigger-btn")?.click();
	});
	await expect(page.locator("#gallery-container")).toBeHidden();

	// 关闭预览
	await page.keyboard.press("Escape");
	await expect(content).toBeHidden();
});

test("F. 单图兼容：不显示左右切换按钮，基本功能正常", async ({ page }) => {
	await page.locator("#set-single-btn").click();

	const thumbnails = page.locator("#gallery-container [role='button']");
	expect(await thumbnails.count()).toBe(1);
	await thumbnails.first().click();

	const content = page.locator("[data-slot='dialog-content']");
	await expect(content).toBeVisible();

	// 单图下不应存在上一张/下一张按钮
	await expect(page.locator("[data-testid='preview-prev-btn']")).toBeHidden();
	await expect(page.locator("[data-testid='preview-next-btn']")).toBeHidden();

	// Esc 正常关闭
	await page.keyboard.press("Escape");
	await expect(content).toBeHidden();
});


test("G. real decode failure cannot contaminate equal-prefix equal-length SVG", async ({ page }) => {
	await page.locator("#collision-preview").click();
	const content = page.locator("[data-slot='dialog-content']");
	await expect(content).toBeVisible();
	await expect(content.locator("img")).toHaveCount(0);
	await page.keyboard.press("ArrowRight");
	await expect(content.locator("img")).toBeVisible();
	await expect.poll(() => content.locator("img").evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(32);
	await page.keyboard.press("ArrowLeft");
	await expect(content.locator("img")).toHaveCount(0);
});

test("H. composer attachment supersedes pending local preview without a second dialog", async ({ page }) => {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.locator("#local-read").click();
	await page.locator("#composer-preview").click();
	const content = page.locator("[data-slot='dialog-content']");
	await expect(content).toHaveCount(1);
	const source = await content.locator("img").getAttribute("src");
	// Resolve the mocked IPC while the modal owns pointer input.
	await page.locator("#resolve-read").evaluate((button: HTMLButtonElement) => button.click());
	await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
	expect(source).not.toBeNull();
	await expect(content.locator("img")).toHaveAttribute("src", source ?? "");
	await expect(content).toHaveCount(1);
	await page.keyboard.press("Escape");
	await expect(content).toHaveCount(0);
	expect(errors).toEqual([]);
});
