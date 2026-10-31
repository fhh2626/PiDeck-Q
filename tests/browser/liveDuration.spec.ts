import { test, expect, type Page } from "@playwright/test";

/** formatDuration 输出反解成毫秒，用于断言单调性（不依赖内部实现）。 */
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

async function sampleDuration(page: Page, testId: string): Promise<number> {
	return parseDuration(await page.locator(`[data-testid="${testId}"]`).innerText());
}

test("LiveDuration: 起点被上游刷新时读数不倒退（powershell/subagent 计时跳变回归）", async ({ page }) => {
	await page.goto("/tests/browser/liveDuration.html");
	await expect(page.locator('[data-testid="refreshing"]')).toHaveText(/\d/);

	const samples: number[] = [];
	// 24 次采样已足够：夹具每 150ms 刷新一次起点，回退会在样本里反复出现。
	// 不取 40+ 是为了在并发负载下也稳落在 30s 单测超时内。
	for (let index = 0; index < 24; index += 1) {
		samples.push(await sampleDuration(page, "refreshing"));
		await page.waitForTimeout(30);
	}

	for (let index = 1; index < samples.length; index += 1) {
		expect(
			samples[index],
			`sample#${index} 回退：${samples[index - 1]}ms -> ${samples[index]}ms（全部样本：${samples.join(",")}）`,
		).toBeGreaterThanOrEqual(samples[index - 1]);
	}
});

test("LiveDuration: 起点稳定时读数持续增长", async ({ page }) => {
	await page.goto("/tests/browser/liveDuration.html");
	await expect(page.locator('[data-testid="stable"]')).toHaveText(/\d/);

	const first = await sampleDuration(page, "stable");
	await page.waitForTimeout(450);
	const second = await sampleDuration(page, "stable");

	expect(first).toBeGreaterThanOrEqual(2_000);
	// 余量留足：450ms 窗口内即使丢一拍 tick 也应明显增长（阀值降到 200ms 防 CI 抓拍）
	expect(second - first).toBeGreaterThanOrEqual(200);
});
