import { appendFile, mkdir, readFile, readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type { AppLogEntry, AppLogLevel, AppLogPage, AppLogQuery } from "../../shared/types";
import {
	DEFAULT_PAGE_SIZE,
	LOG_FILE_PATTERN,
	MAX_FILE_LINES,
	filterLogFiles,
	queryLogLines,
	toAppLogPage,
} from "./logQuery";
import { LogLineCache } from "./logLineCache";

const MAX_LOG_FILES = 14;

function formatDate(value: Date) {
	const year = value.getFullYear();
	const month = String(value.getMonth() + 1).padStart(2, "0");
	const day = String(value.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

function normalizeDetail(detail: unknown) {
	if (detail instanceof Error) {
		return { name: detail.name, message: detail.message, stack: detail.stack };
	}
	return detail;
}

export interface AppLoggerOptions {
	directory?: string;
}

/**
 * 主进程应用日志服务。
 * 日志按天写入 userData/logs,既避免 renderer 崩溃丢失关键诊断信息,
 * 也避免记录到项目目录导致用户代码仓库被污染。
 */
export class AppLogger {
	private readonly dir: string;
	private writeQueue: Promise<void> = Promise.resolve();
	/** 历史日志文件行缓存：查询只重读指纹变化的文件（当天 append 文件），避免每次进设置日志 tab 全量读盘 */
	private readonly lineCache = new LogLineCache(
		{ readFile: (p) => readFile(p, "utf8"), stat },
		32,
		MAX_FILE_LINES,
	);

	constructor(options: AppLoggerOptions = {}) {
		this.dir = options.directory ?? join(homedir(), ".pi-desktop", "logs");
	}

	getDirectory(): string {
		return this.dir;
	}

	async ensureDirectory(): Promise<void> {
		await mkdir(this.dir, { recursive: true });
	}

	log(level: AppLogLevel, scope: string, message: string, detail?: unknown) {
		const entry: AppLogEntry = {
			id: crypto.randomUUID(),
			time: Date.now(),
			level,
			scope,
			message,
			detail: normalizeDetail(detail),
		};
		// 串行写入队列，fire-and-forget，绝不 await 阻塞调用方
		this.writeQueue = this.writeQueue
			.then(() => this.writeEntry(entry))
			.catch((error) => {
				console.warn("Failed to write app log:", error);
			});
		return this.writeQueue;
	}

	debug(scope: string, message: string, detail?: unknown) {
		return this.log("debug", scope, message, detail);
	}

	info(scope: string, message: string, detail?: unknown) {
		return this.log("info", scope, message, detail);
	}

	warn(scope: string, message: string, detail?: unknown) {
		return this.log("warn", scope, message, detail);
	}

	error(scope: string, message: string, detail?: unknown) {
		return this.log("error", scope, message, detail);
	}

	/**
	 * 分页查询日志（时间倒序，最新在前）。
	 * - 按 from/to 先收敛日期文件，避免全量读盘；
	 * - 过滤发生在分页之前，任意时间范围的旧日志都能翻到（旧实现 5000 行截断
	 *   导致选较早日期时查不到——时间筛选"失灵"的根因）；
	 * - 单文件读取有行数防御上限（MAX_FILE_LINES），防畸形超大文件拖垮查询。
	 */
	async listPage(query: AppLogQuery = {}): Promise<AppLogPage> {
		await this.ensureDirectory();
		const files = filterLogFiles(
			(await readdir(this.dir)).filter((file) => LOG_FILE_PATTERN.test(file)).sort().slice(-MAX_LOG_FILES),
			query.from,
			query.to,
		);
		const lines: string[] = [];
		for (const file of files) {
			lines.push(...(await this.lineCache.linesOf(join(this.dir, file))));
		}
		const pageSize = Math.max(1, Math.min(query.pageSize ?? DEFAULT_PAGE_SIZE, 200));
		const page = Math.max(0, query.page ?? 0);
		const result = queryLogLines(lines, query);
		return toAppLogPage(result, page, pageSize);
	}

	async list(query: AppLogQuery = {}): Promise<AppLogEntry[]> {
		const page = await this.listPage(query);
		return page.entries;
	}

	async clear() {
		await this.ensureDirectory();
		const files = await readdir(this.dir);
		const before = files.filter((file) => LOG_FILE_PATTERN.test(file));
		await Promise.all(
			before.map((file) => unlink(join(this.dir, file)).catch(() => undefined)),
		);
		// 清日志后行缓存必须清空：旧行来自已删除文件，残留会导致重查时读到旧内容
		this.lineCache.clear();
		// 清日志属敏感操作，留痕记录清除前的文件数/大小，便于事后审计
		await this.info("logs", "Logs cleared", { files: before.length });
	}

	/** 计算所有应用日志文件的总字节数 */
	async getSize(): Promise<number> {
		await this.ensureDirectory();
		const files = (await readdir(this.dir))
			.filter((file) => LOG_FILE_PATTERN.test(file));
		let total = 0;
		for (const file of files) {
			try { total += (await stat(join(this.dir, file))).size; } catch { /* 单个文件统计失败不影响整体 */ }
		}
		return total;
	}

	getDir(): string {
		return this.dir;
	}

	private async writeEntry(entry: AppLogEntry) {
		await this.ensureDirectory();
		await this.cleanupOldFiles();
		const filePath = join(this.dir, `app-${formatDate(new Date(entry.time))}.log`);
		await appendFile(filePath, `${JSON.stringify(entry)}\n`, "utf8");
	}

	private async cleanupOldFiles() {
		const files = (await readdir(this.dir).catch(() => []))
			.filter((file) => LOG_FILE_PATTERN.test(file))
			.sort();
		const expired = files.slice(0, Math.max(0, files.length - MAX_LOG_FILES));
		await Promise.all(expired.map((file) => unlink(join(this.dir, file)).catch(() => undefined)));
	}
}
