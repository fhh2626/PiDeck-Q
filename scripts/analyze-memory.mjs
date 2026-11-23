#!/usr/bin/env node
/**
 * analyze-memory.mjs —— 内存采样 CSV 分析报告生成器。
 *
 * 用法：
 *   node scripts/analyze-memory.mjs                    # 自动找最新一份采样（dev/正式 userData 都找）
 *   node scripts/analyze-memory.mjs <path/to/csv>      # 指定文件
 *   node scripts/analyze-memory.mjs <csv1> <csv2>      # 对比两次会话（可选）
 *
 * 输出：进程级 起始→末尾/峰值/增长 排行 + 全体 RSS 趋势 + JS 堆趋势。
 * 判读口诀：
 *   - growth 为正且持续 = 该进程在观察期内只涨不缩（泄漏嫌疑）；
 *   - 渲染进程 RSS 涨而 jsHeap 不涨 = 问题在 DOM/图片/缓存等 native 侧；
 *   - 两者同涨 = JS 对象泄漏（优先查全局 state / 未清理 listener / 未销毁组件）。
 *
 * 注意：解析逻辑与 scripts/lib/memoryProfileCsv.ts 的 parseMemoryCsv 保持同步，
 * 修改一侧必须同步另一侧（tests/memoryProfileCsv.test.mjs 会回归验证脚本行为）。
 */
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";

import { parseMemoryCsv as parseCsv, aggregateMemoryProfile as aggregate, totalRssSeries as totalSeries } from "./lib/memoryProfileCsv.ts";

const KB = 1024;
const MB = KB * 1024; // 1048576：1GB 的 KB 数（变量名沿旧，勿被误导）

function fmtKB(kb) {
	if (kb === null || kb === undefined) return "-";
	// kb 以 KB 计：<1GB 时除以 1024 得 MB；>=1GB 时除以 1048576 得 GB（此前 1.4GB 被显示成 1.4MB）
	if (kb >= MB) return (kb / MB).toFixed(1) + " GB";
	return (kb / KB).toFixed(1) + " MB";
}

/** 自动定位最新采样 CSV：dev/正式 userData 都找，取最新的 */
async function findLatestCsv() {
	const candidates = [];
	for (const dir of ["pi-desktop-dev", "pi-desktop"]) {
		const base = join(os.homedir(), "AppData", "Roaming", dir, "memory-profile");
		if (!existsSync(base)) continue;
		const { readdir } = await import("node:fs/promises");
		for (const f of (await readdir(base)).filter((f) => f.endsWith(".csv"))) {
			candidates.push(join(base, f));
		}
	}
	if (!candidates.length) return null;
	candidates.sort(); // 文件名带时间戳，字典序即时间序
	return candidates[candidates.length - 1];
}

function report(rows, label) {
	const tsList = [...new Set(rows.map((r) => r.ts))].sort((a, b) => a - b);
	const first = tsList[0];
	const last = tsList[tsList.length - 1];
	const duration = last - first;
	const totals = totalSeries(rows);
	const tStart = totals[0]?.totalKB ?? null;
	const tEnd = totals[totals.length - 1]?.totalKB ?? null;
	const tPeak = totals.length ? Math.max(...totals.map((t) => t.totalKB)) : null;
	const aggs = aggregate(rows);

	const lines = [];
	lines.push(`## ${label}`);
	lines.push(`- 采样点数：${rows.length}（${tsList.length} 轮，间隔约 ${duration ? Math.round(duration / tsList.length / 1000) : "-"}s）`);
	lines.push(`- 全体进程 RSS：起始 ${fmtKB(tStart)} → 末尾 ${fmtKB(tEnd)}，峰值 ${fmtKB(tPeak)}，增长 ${fmtKB(tEnd !== null && tStart !== null ? tEnd - tStart : null)}`);
	lines.push("");
	lines.push("| 进程 | 起始 RSS | 末尾 RSS | 峰值 | 增长 | V8堆(末) | DOM(末) | worker(末) | 采样数 |");
	lines.push("|---|---|---|---|---|---|---|---|---|");
	for (const a of aggs) {
		if (a.growthKB === null) continue;
		// V8 堆：Browser 行显示主进程 V8 堆（heapUsed），其余显示 JS 堆（jsHeap）
		const v8Heap = a.type === "Browser" ? a.endHeapUsedKB : a.endJsHeapKB;
		// DOM 节点数：仅渲染进程有；千分位分隔便于读数
		const dom = a.endDomNodes === null ? "-" : a.endDomNodes.toLocaleString("en-US");
		// worker：count(JS 堆合计)；count -1 表示未探测
		const wk = a.endWorkerCount === null || a.endWorkerCount < 0 ? "-" : `${a.endWorkerCount}(${fmtKB(a.endWorkerJSHeapKB)})`;
		lines.push(
			`| ${a.label}#${a.pid} (${a.type}) | ${fmtKB(a.startRssKB)} | ${fmtKB(a.endRssKB)} | ${fmtKB(a.peakRssKB)} | ${fmtKB(a.growthKB)} | ${fmtKB(v8Heap)} | ${dom} | ${wk} | ${a.samples} |`,
		);
	}
	return lines.join("\n");
}

async function main() {
	const args = process.argv.slice(2);
	let files = args;
	if (!files.length) {
		const latest = await findLatestCsv();
		if (!latest) {
			console.error("未找到采样 CSV。先开启采样运行应用：PIDECK_MEMORY_PROFILE=1 npm run dev");
			process.exit(1);
		}
		files = [latest];
	}

	const parts = [];
	for (const f of files) {
		const text = await readFile(f, "utf8");
		const rows = parseCsv(text);
		parts.push(report(rows, `报告：${f}`));
	}
	console.log(parts.join("\n\n"));
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
