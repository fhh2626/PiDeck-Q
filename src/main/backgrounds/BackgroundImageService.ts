import { copyFile, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { TrashPath } from "../fs/trash";

export interface BackgroundImageLogger {
	info(category: string, message: string, meta?: Record<string, unknown>): unknown;
}

export interface BackgroundImageServiceDeps {
	directory: string;
	trashPath: TrashPath;
	logger?: BackgroundImageLogger | null;
}

export class BackgroundImageService {
	private readonly directory: string;
	private readonly trashPath: TrashPath;
	private readonly logger?: BackgroundImageLogger | null;
	private lastImageTimestamp = 0;

	constructor(deps: BackgroundImageServiceDeps) {
		this.directory = deps.directory;
		this.trashPath = deps.trashPath;
		this.logger = deps.logger;
	}

	getDirectory(): string {
		return this.directory;
	}

	async importImage(pickedPath: string): Promise<string> {
		if (!pickedPath) return "";
		try {
			await mkdir(this.directory, { recursive: true });
			const ext = pickedPath.includes(".") ? pickedPath.slice(pickedPath.lastIndexOf(".")) : "";
			// 保持既有 bg-<timestamp> 文件名格式，同时保证快速/并发导入不会在同一毫秒覆盖新文件。
			const now = Date.now();
			const timestamp = Math.max(now, this.lastImageTimestamp + 1);
			this.lastImageTimestamp = timestamp;
			const name = `bg-${timestamp}${ext.toLowerCase()}`;
			await copyFile(pickedPath, join(this.directory, name));

			// 清理旧背景图（仅本目录，文件名前缀 bg-）；替换场景失败不阻塞新图生效。
			const files = await readdir(this.directory).catch(() => [] as string[]);
			for (const f of files) {
				if (f !== name && f.startsWith("bg-")) {
					await this.trashPath(join(this.directory, f), { source: "backgrounds:cleanup" }).catch(() => undefined);
				}
			}
			return name;
		} catch {
			// 复制失败（磁盘/权限）按取消处理，调用方停留在无背景图状态
			return "";
		}
	}

	async remove(name: string): Promise<void> {
		if (!/^bg-[a-zA-Z0-9.]+$/.test(name)) return;
		await this.trashPath(join(this.directory, name), { source: "backgrounds:remove" });
		this.logger?.info("backgrounds", "Background image removed", { name });
	}
}
