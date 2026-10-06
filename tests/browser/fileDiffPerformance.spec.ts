import { expect, test } from "@playwright/test";
import type {} from "./fileDiffPerformance.fixture";

export interface PerfTypingSample {
	key: string;
	isTrusted: boolean;
	durationMs: number;
}

declare global {
	interface Window {
		__perfTypingSamples?: PerfTypingSample[];
		__perfTypingCleanup?: () => void;
	}
}

/** 供 page.evaluate 调用的清理函数：解绑键盘监听、取消未执行的采样帧并移除输入框。 */
export function cleanupPerfTypingSampler(): void {
	window.__perfTypingCleanup?.();
}

/** 供 page.evaluate 调用的安装函数：挂载测试输入框与按键到下一帧的采样器。 */
export function installPerfTypingSampler(): void {
	const existing = document.getElementById("perf-typing");
	if (existing) existing.remove();

	const input = document.createElement("input");
	input.id = "perf-typing";

	window.__perfTypingSamples = [];
	const pendingFrames = new Set<number>();

	const handleKeyDown = (event: KeyboardEvent) => {
		if (event.key.length !== 1) return;
		const start = event.timeStamp;
		const key = event.key;
		const isTrusted = event.isTrusted;
		const frameId = requestAnimationFrame(() => {
			pendingFrames.delete(frameId);
			const durationMs = performance.now() - start;
			window.__perfTypingSamples?.push({ key, isTrusted, durationMs });
		});
		pendingFrames.add(frameId);
	};

	window.__perfTypingCleanup = () => {
		input.removeEventListener("keydown", handleKeyDown);
		for (const frameId of pendingFrames) {
			cancelAnimationFrame(frameId);
		}
		pendingFrames.clear();
		input.remove();
		delete window.__perfTypingSamples;
		delete window.__perfTypingCleanup;
	};

	input.addEventListener("keydown", handleKeyDown);
	document.body.prepend(input);
}

/**
 * FileDiff 长会话性能的真实浏览器验收。
 *
 * 这里量的是「结论」而不是实现细节：
 * - 收起态不产生正文节点（长会话底部不再攒几万节点）；
 * - 展开只增加一个文件的正文；
 * - 大段代码高亮不会把主线程占住。
 */

test.beforeEach(async ({ page }) => {
	await page.goto("/tests/browser/fileDiffPerformance.html");
	await expect(page.locator("#root")).toHaveCount(1);
	await expect
		.poll(async () => {
			try {
				return await page.evaluate(() => Boolean(window.fileDiffPerfFixture));
			} catch {
				return false;
			}
		})
		.toBe(true);
	await page.evaluate(() =>
		new Promise<void>((resolve) =>
			requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
		),
	);
	// 每例从 30 个文件、每个 40 行开始。
	await page.evaluate(() => window.fileDiffPerfFixture?.setFiles(30, 40));
	await expect(page.locator("[data-fixture-file]")).toHaveCount(30);
});

test("collapsed file rows keep their diff body out of the DOM", async ({ page }) => {
	const before = await page.evaluate(() => window.fileDiffPerfFixture?.domNodes() ?? 0);
	expect(await page.evaluate(() => window.fileDiffPerfFixture?.bodyCount())).toBe(0);
	expect(await page.evaluate(() => window.fileDiffPerfFixture?.fileRowCount())).toBe(30);

	// 30 个文件全部收起时，节点数应远低于「每行一个节点」的规模（40 行 × 30 文件 × 数节点）。
	expect(before).toBeLessThan(30 * 40 * 2);
});

test("expanding one file mounts exactly one diff body", async ({ page }) => {
	await page.evaluate(() => window.fileDiffPerfFixture?.openFile(3));
	await expect.poll(() => page.evaluate(() => window.fileDiffPerfFixture?.bodyCount())).toBe(1);
	await expect(page.getByText("value_3_0")).toBeVisible();

	await page.evaluate(() => window.fileDiffPerfFixture?.openFile(7));
	await expect.poll(() => page.evaluate(() => window.fileDiffPerfFixture?.bodyCount())).toBe(2);

	await page.evaluate(() => window.fileDiffPerfFixture?.closeFile(3));
	await expect.poll(() => page.evaluate(() => window.fileDiffPerfFixture?.bodyCount())).toBe(1);
	// 关掉的正文必须真的离开 DOM，而不是被 CSS 藏起来。
	await expect(page.getByText("value_3_0")).toHaveCount(0);
});

test("a large batch of collapsed files stays cheap to render", async ({ page }) => {
	// 60 个文件 × 200 行 = 12000 行：全部收起时不应产生 12000 个行节点。
	await page.evaluate(() => window.fileDiffPerfFixture?.setFiles(60, 200));
	await expect(page.locator("[data-fixture-file]")).toHaveCount(60);
	expect(await page.evaluate(() => window.fileDiffPerfFixture?.bodyCount())).toBe(0);
	const nodes = await page.evaluate(() => window.fileDiffPerfFixture?.domNodes() ?? 0);
	expect(nodes).toBeLessThan(12000);
});

test("highlighting a large code block does not block the main thread", async ({ page }) => {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	// render=false：只测「分词是否离开主线程」。把 2000 行渲染成节点本身要几百毫秒，
	// 那是 DOM 成本，与本次要验证的 Worker 结论无关，因此分开量。
	await page.evaluate(() => window.fileDiffPerfFixture?.resetFrameMetrics());
	await page.evaluate(() => window.fileDiffPerfFixture?.runHighlightProbe(2000, false));
	await expect.poll(() => page.evaluate(() => window.fileDiffPerfFixture?.probeReady()), {
		timeout: 20000,
	}).toBe(true);
	const gap = await page.evaluate(() => window.fileDiffPerfFixture?.maxFrameGapMs() ?? 0);
	// 2000 行同步分词在主线程实测 ~350ms（见下面那个反证用例）；Worker 下只应有帧级抖动。
	expect(gap).toBeLessThan(100);
	expect(errors).toEqual([]);

	// 再渲染真实高亮行，确认结果可用（这部分允许有 DOM 成本）。
	await page.evaluate(() => window.fileDiffPerfFixture?.runHighlightProbe(2000, true));
	await expect
		.poll(() => page.locator('[data-testid="probe"]').innerText(), { timeout: 20000 })
		.toContain("function probe_0");
	expect(errors).toEqual([]);
});

test("falsification: the same work on the main thread does block it", async ({ page }) => {
	// 反证用例：证明上一个断言有区分度，而不是恒真。同一段 2000 行代码、同一套主题，
	// 直接在主线程同步分词，帧间隔必然大幅超过 Worker 路径的 100ms 阀值。
	const result = await page.evaluate(async () => {
		// 用变量包一层，避免 TS 把该字符串当成可解析的模块声明。
		const shikiPath = ["", "node_modules", "shiki", "dist", "index.mjs"].join("/");
		const shiki: unknown = await import(/* @vite-ignore */ shikiPath);
		if (typeof shiki !== "object" || shiki === null) throw new Error("shiki did not load");
		const createHighlighter = Reflect.get(shiki, "createHighlighter");
		if (typeof createHighlighter !== "function") throw new Error("shiki has no createHighlighter");
		const highlighter: unknown = await createHighlighter({
			themes: ["github-light-high-contrast", "github-dark-high-contrast"],
			langs: ["typescript"],
		});
		if (typeof highlighter !== "object" || highlighter === null) {
			throw new Error("shiki returned no highlighter");
		}
		const tokenize = Reflect.get(highlighter, "codeToTokensWithThemes");
		if (typeof tokenize !== "function") throw new Error("highlighter cannot tokenize");
		const code = Array.from(
			{ length: 2000 },
			(_, line) => `function probe_${line}(input: number): number { return input * ${line}; }`,
		).join("\n");
		let last = performance.now();
		let maxGap = 0;
		const tick = () => {
			const now = performance.now();
			if (now - last > maxGap) maxGap = now - last;
			last = now;
			requestAnimationFrame(tick);
		};
		requestAnimationFrame(tick);
		const start = performance.now();
		tokenize(code, {
			lang: "typescript",
			themes: { light: "github-light-high-contrast", dark: "github-dark-high-contrast" },
		});
		const syncMs = performance.now() - start;
		await new Promise((resolve) => setTimeout(resolve, 100));
		return { syncMs, maxGap };
	});
	expect(result.syncMs).toBeGreaterThan(100);
	expect(result.maxGap).toBeGreaterThan(100);
});

test("highlight results are still correct after worker reuse and teardown", async ({ page }) => {
	// 生产环境空闲回收为 30s；本用例实际等待 Worker 释放并重新拉起，设置独立超时。
	test.setTimeout(90_000);

	const getHighlightWorkers = () =>
		page.workers().filter((worker) => worker.url().includes("agentCodeHighlight.worker"));

	// 初始状态：尚未触发高亮，无高亮 Worker
	expect(getHighlightWorkers().length).toBe(0);

	// 发起第一次高亮请求
	await page.evaluate(() => window.fileDiffPerfFixture?.runHighlightProbe(200));
	await expect
		.poll(() => page.evaluate(() => window.fileDiffPerfFixture?.probeReady()), {
			timeout: 20000,
		})
		.toBe(true);

	// 此时真实高亮 Worker 已就绪
	const workersAfterFirst = getHighlightWorkers();
	expect(workersAfterFirst.length).toBe(1);
	const firstWorker = workersAfterFirst[0];

	// 不发起新请求，等待 30s 空闲回收触发；Playwright 检测到 Worker 终止后从 page.workers() 移除
	await expect
		.poll(() => getHighlightWorkers().length, {
			timeout: 45_000,
			intervals: [1000, 2000],
		})
		.toBe(0);

	// 回收后再发起第二次高亮请求，验证能够创建全新 Worker 并正常返回
	await page.evaluate(() => window.fileDiffPerfFixture?.runHighlightProbe(400));
	await expect
		.poll(() => page.evaluate(() => window.fileDiffPerfFixture?.probeReady()), {
			timeout: 20000,
		})
		.toBe(true);

	const workersAfterSecond = getHighlightWorkers();
	expect(workersAfterSecond.length).toBe(1);
	const secondWorker = workersAfterSecond[0];

	// 证明创建的是全新 Worker，而非旧实例残留
	expect(secondWorker).not.toBe(firstWorker);
	await expect
		.poll(() => page.locator('[data-testid="probe"]').innerText(), { timeout: 20000 })
		.toContain("function probe_399");
});

test("typing stays responsive while many collapsed files are mounted", async ({ page }) => {
	await page.evaluate(() => window.fileDiffPerfFixture?.setFiles(60, 200));
	await expect(page.locator("[data-fixture-file]")).toHaveCount(60);

	const textToType = "abcdefghijklmnopqrst";
	const inputLocator = page.locator("#perf-typing");

	try {
		// 在页面内安装测试输入框与真实键盘采样器
		await page.evaluate(installPerfTypingSampler);
		await inputLocator.focus();

		for (let i = 0; i < textToType.length; i++) {
			const char = textToType[i];
			await inputLocator.press(char);
			// 等待本按键对应的一帧渲染完成并记录样本
			await expect
				.poll(
					() =>
						page.evaluate(() => {
							const samples = window.__perfTypingSamples;
							if (!samples) throw new Error("typing sampler is not installed");
							return samples.length;
						}),
					{ timeout: 5000 },
				)
				.toBe(i + 1);
		}

		// 检查最终输入框文本
		await expect(inputLocator).toHaveValue(textToType);

		// 获取全部样本并做严格断言
		const samples = await page.evaluate(() => {
			const current = window.__perfTypingSamples;
			if (!current) throw new Error("typing sampler is not installed");
			return current;
		});

		expect(samples).toHaveLength(20);
		for (let i = 0; i < samples.length; i++) {
			const sample = samples[i];
			expect(sample.key).toBe(textToType[i]);
			expect(sample.isTrusted).toBe(true);
			expect(typeof sample.durationMs).toBe("number");
			expect(Number.isFinite(sample.durationMs)).toBe(true);
			expect(sample.durationMs).toBeGreaterThanOrEqual(0);
		}

		const worstDuration = Math.max(...samples.map((s) => s.durationMs));
		// 收起态下真实按键到下一帧耗时不得超过 100ms
		expect(worstDuration).toBeLessThan(100);

		// 确认在打字过程中没有任何 diff 正文被挂载
		const bodyCount = await page.evaluate(() => {
			const fixture = window.fileDiffPerfFixture;
			if (!fixture) throw new Error("fixture is not mounted");
			return fixture.bodyCount();
		});
		expect(bodyCount).toBe(0);
	} finally {
		await page.evaluate(cleanupPerfTypingSampler);
	}
});
