import { test, expect, type Page } from "@playwright/test";

/** formatDuration 输出反解成毫秒（断言只依赖用户可见文本）。 */
function parseDuration(text: string): number {
	const value = text.trim();
	const ms = /^(\d+)ms$/.exec(value);
	if (ms) return Number(ms[1]);
	const seconds = /^(\d+)\.(\d)s$/.exec(value);
	if (seconds) return Number(seconds[1]) * 1_000 + Number(seconds[2]) * 100;
	const minutesSeconds = /^(\d+)m(\d+)s$/.exec(value);
	if (minutesSeconds) return Number(minutesSeconds[1]) * 60_000 + Number(minutesSeconds[2]) * 1_000;
	const minutes = /^(\d+)m$/.exec(value);
	if (minutes) return Number(minutes[1]) * 60_000;
	throw new Error(`unexpected duration text: ${value}`);
}

async function readToolDuration(page: Page): Promise<number> {
	return parseDuration(await page.locator('[data-tool-duration="running"]').innerText());
}

test("ToolCard 运行中时长取 meta.startedAt，不随 timestamp 刷新归零", async ({ page }) => {
	await page.goto("/tests/browser/toolCardDuration.html");
	const duration = page.locator('[data-tool-duration="running"]');
	await expect(duration).toBeVisible();

	// meta.startedAt = 挂载时刻 -3s：正确实现必然 ≥ 2.5s；
	// 若误用被刷新的 message.timestamp，这里只会是 0~150ms（"Xms"）。
	await expect(duration).toHaveText(/\d+(\.\d)?s/);
	const first = await readToolDuration(page);
	expect(first).toBeGreaterThanOrEqual(2_500);

	// 高频刷新 timestamp 的一秒内，读数不得倒退（24 次采样已能揭穿 150ms 周期的回退）
	const samples: number[] = [];
	for (let index = 0; index < 24; index += 1) {
		samples.push(await readToolDuration(page));
		await page.waitForTimeout(30);
	}
	for (let index = 1; index < samples.length; index += 1) {
		expect(
			samples[index],
			`sample#${index} 回退：${samples[index - 1]}ms -> ${samples[index]}ms（全部样本：${samples.join(",")}）`,
		).toBeGreaterThanOrEqual(samples[index - 1]);
	}
});
