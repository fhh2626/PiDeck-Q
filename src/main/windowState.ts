import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 主窗口 normal bounds 记忆（startupWindowMode="last" 的存储层）。
 * 关闭窗口/退出应用时保存 normal bounds（最大化/全屏时取 normalGeometry），
 * 下次启动按记录的尺寸和位置打开；文件放在 userData/last-window-bounds.json，
 * 与用户设置（settings.json）分离——这是运行时状态而非用户显式配置。
 */

export type LastWindowBounds = {
	width: number;
	height: number;
	/** Optional while reading files written by older versions. */
	x?: number;
	y?: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

/**
 * 读取上次窗口 normal bounds；旧文件只有宽高时仍可正常启动，位置交给
 * Qt 默认值。文件缺失/损坏/尺寸过小（小于最小窗口 880×640）时返回 null。
 */
export function readLastWindowBounds(dir: string): LastWindowBounds | null {
	try {
		const raw = readFileSync(join(dir, "last-window-bounds.json"), "utf8");
		const parsed: unknown = JSON.parse(raw);
		if (!isRecord(parsed)) return null;

		const width = parsed.width;
		const height = parsed.height;
		if (!isFiniteNumber(width) || !isFiniteNumber(height) || width < 880 || height < 640) {
			return null;
		}

		const result: LastWindowBounds = {
			width: Math.round(width),
			height: Math.round(height),
		};
		// Treat coordinates as a pair. A partial/corrupt position must not move the
		// window using a fabricated zero coordinate, but it must not discard a valid
		// legacy size either.
		if (isFiniteNumber(parsed.x) && isFiniteNumber(parsed.y)) {
			result.x = Math.round(parsed.x);
			result.y = Math.round(parsed.y);
		}
		return result;
	} catch {
		// 文件不存在或 JSON 损坏：按无记录处理
	}
	return null;
}

/** 保存上次窗口 normal bounds（取整，防抖由调用方控制）。 */
export function saveLastWindowBounds(dir: string, bounds: LastWindowBounds): void {
	try {
		mkdirSync(dir, { recursive: true });
		const persisted: Record<string, number> = {
			width: Math.round(bounds.width),
			height: Math.round(bounds.height),
		};
		if (isFiniteNumber(bounds.x) && isFiniteNumber(bounds.y)) {
			persisted.x = Math.round(bounds.x);
			persisted.y = Math.round(bounds.y);
		}
		writeFileSync(
			join(dir, "last-window-bounds.json"),
			JSON.stringify(persisted),
			"utf8",
		);
	} catch {
		// 磁盘/权限失败静默：窗口记忆是可选的体验增强，不影响主流程
	}
}
