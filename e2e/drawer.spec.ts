import { test, expect } from "./fixtures";
import { openFirstSession, makeSeedProject } from "./open-session";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const seedProject = makeSeedProject("DrawerE2E");
test.use({ seedProjects: [seedProject] });

// 回归测试专用：文件树超高（必然跨过滚动条阈值），验证切 tab 内容宽度不跳变
const MANY_FILES = 300;
for (let i = 0; i < MANY_FILES; i++) {
	writeFileSync(join(seedProject.path, `seed-${String(i).padStart(3, "0")}.ts`), `export const n${i} = ${i};\n`);
}

/**
 * 右侧抽屉 + 活动栏回归守卫：
 * 打开抽屉默认 files；已经删除的 browser 入口不应再出现。
 * 注：seed 项目无 git 上下文，这里只断言 files。
 */
test("right drawer opens on files and the activity rail switches panels", async ({ window }) => {
	// 新建会话打开工作台后，头部抽屉开关才出现
	await openFirstSession(window);
	const toggle = window.locator(".header-drawer-toggle").first();
	await expect(toggle).toBeVisible();
	await toggle.click();

	const drawer = window.locator(".detail-drawer");
	await expect(drawer).toHaveAttribute("data-open", "true");
	// 活动栏只保留 files 等仍存在的工作区入口
	const filesTab = window.getByTestId("drawer-rail-files");
	await expect(filesTab).toBeVisible();
	await expect(window.getByTestId("drawer-rail-browser")).toHaveCount(0);
	await expect(filesTab).toHaveAttribute("aria-selected", "true");
});

/**
 * 抽屉内容宽度稳定性回归（切 tab「呼吸式」宽度摆动）：
 * 根因：files/sessions 面板自身 overflow-y-auto，滚动条出现时内容区收窄 ~10px；
 * 切 tab 重挂时占位（无滚动条 320）→ 内容（有滚动条 310）瞬间跳变，树高度跨阈值时
 * 滚动条反复出现/消失形成宽度摆动。修复：滚动层上移 LazyWrapper + scrollbar-gutter: stable，
 * 内容宽度全程恒定。此处断言切回 files 后内容宽度只出现一个稳定值（无两段式跳变）。
 */
test("drawer content width stays constant across tab switches (no scrollbar jitter)", async ({ window }) => {
	// 进入预置项目（有 300 个文件的超高文件树），打开抽屉
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });
	const projectItem = window.locator(".conversation", { hasText: "pideck-e2e-drawere2e-" }).first();
	await expect(projectItem).toBeVisible({ timeout: 20_000 });
	await projectItem.click();
	const toggle = window.locator(".header-drawer-toggle").first();
	await toggle.click();
	const drawer = window.locator(".detail-drawer");
	await expect(drawer).toHaveAttribute("data-open", "true", { timeout: 5000 });
	await window.waitForTimeout(1500);

	// 稳定态：文件树滚动条已出现，内容宽度收敛为单一值
	const steady = await window.evaluate(() => {
		const aside = document.querySelector(".detail-drawer") as HTMLElement | null;
		const panel = aside?.querySelector(".files-panel") as HTMLElement | null;
		return panel ? { cw: panel.clientWidth, hasVScroll: panel.scrollHeight > panel.clientHeight } : null;
	});
	expect(steady).not.toBeNull();
	expect(steady!.hasVScroll).toBe(true);

	// files → 关闭抽屉 → 重新打开 files，从重新打开开始逐帧采样内容宽度
	const filesTab = window.getByTestId("drawer-rail-files");
	await toggle.click();
	await expect(drawer).toHaveAttribute("data-open", "false", { timeout: 3000 });

	// 先安装等待器，只有抽屉真正重新打开后才采样，避免把关闭动画中的宽度记入结果。
	const sampling = window.evaluate(async () => {
		const aside = document.querySelector(".detail-drawer") as HTMLElement | null;
		if (!aside) return [];

		const widths: number[] = [];
		await new Promise<void>((resolve) => {
			let started = false;
			let observer: MutationObserver | undefined;

			const startSampling = () => {
				if (started) return;
				started = true;
				observer?.disconnect();
				const start = performance.now();
				const tick = () => {
					const panel = aside.querySelector(".files-panel") as HTMLElement | null;
					if (panel) widths.push(panel.clientWidth);
					if (performance.now() - start < 1200) requestAnimationFrame(tick);
					else resolve();
				};
				requestAnimationFrame(tick);
			};

			observer = new MutationObserver(() => {
				if (aside.dataset.open === "true") startSampling();
			});
			observer.observe(aside, { attributes: true, attributeFilter: ["data-open"] });

			// 处理 observer 安装前已经完成打开的边界，仍不会采到关闭状态。
			if (aside.dataset.open === "true") startSampling();
		});
		return widths;
	});

	await toggle.click();
	await expect(drawer).toHaveAttribute("data-open", "true", { timeout: 3000 });
	await expect(filesTab).toHaveAttribute("aria-selected", "true", { timeout: 3000 });

	const widths = await sampling;

	// 内容挂载后宽度必须是单一稳定值：任何两段式（占位宽 → 滚动条宽）都视为回归
	expect(widths.length).toBeGreaterThan(5);
	const distinct = [...new Set(widths)];
	expect(distinct, `content width jumped between ${JSON.stringify(distinct)}`).toHaveLength(1);
});
