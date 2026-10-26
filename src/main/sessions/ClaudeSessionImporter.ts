import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import type {
	ClaudeImportReport,
	ClaudeImportResult,
	ClaudeImportStatus,
	ClaudeSessionSummary,
} from "../../shared/types";
import {
	defaultSessionImportCopy,
	type SessionImportCopy,
} from "./SessionImportCopy";

/** 扫描时同时读取/解析的 Claude 会话上限：项目下数百个大 JSONL 时避免一次性全部读入内存。 */
const SCAN_CONCURRENCY = 8;

/** 保序并发映射：最多 limit 个任务同时进行；worker 内异常由调用方自行在 mapper 里捕获。 */
async function mapWithConcurrency<T, R>(items: readonly T[], limit: number, mapper: (item: T) => Promise<R>): Promise<R[]> {
	const results: R[] = new Array<R>(items.length);
	let next = 0;
	const worker = async (): Promise<void> => {
		while (next < items.length) {
			const index = next++;
			results[index] = await mapper(items[index]);
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return results;
}

type ParsedClaudeSession = {
	meta: {
		sessionId: string;
		cwd: string;
		firstTimestamp: number;
		lastTimestamp: number;
	};
	entries: Array<Record<string, any>>;
	sourcePath: string;
	sourceSize: number;
	sourceMtime: number;
};

export class ClaudeSessionImporter {
	private readonly claudeRoot: string;
	private readonly piRoot: string;

	constructor(
		private readonly translate: SessionImportCopy = defaultSessionImportCopy,
		homeDir?: string,
	) {
		const home = homeDir ?? homedir();
		this.claudeRoot = join(home, ".claude", "projects");
		this.piRoot = join(home, ".pi", "agent", "sessions");
	}

	async scan(projectPath: string): Promise<ClaudeSessionSummary[]> {
		const projectDir = this.getClaudeProjectDir(projectPath);
		const files = await this.collectJsonl(projectDir).catch(() => []);
		// 读取与转摘要放在同一个受限任务里：解析后的 entries 只在本任务内存活，内存峰值随并发数而非文件数增长。
		const summaries = await mapWithConcurrency(files, SCAN_CONCURRENCY, async (file) => {
			const session = await this.readClaudeSession(file).catch(() => null);
			return session ? this.toSummary(session, projectPath) : null;
		});

		return summaries
			.filter((summary): summary is ClaudeSessionSummary => Boolean(summary))
			.sort((a, b) => b.updatedAt - a.updatedAt);
	}

	async import(projectPath: string, sourcePaths: string[]): Promise<ClaudeImportReport> {
		const results: ClaudeImportResult[] = [];
		for (const sourcePath of sourcePaths) {
			results.push(await this.importOne(projectPath, sourcePath));
		}
		return {
			results,
			imported: results.filter((result) => result.success).length,
			failed: results.filter((result) => !result.success).length,
		};
	}

	private async importOne(
		projectPath: string,
		sourcePath: string,
	): Promise<ClaudeImportResult> {
		try {
			const parsed = await this.readClaudeSession(sourcePath);
			const targetPath = this.getTargetPath(projectPath, parsed);
			const existing = await this.readImportMeta(targetPath);
			const converted = this.convertToPiSession(projectPath, parsed);
			await mkdir(this.getProjectSessionDir(projectPath), { recursive: true });
			await writeFile(targetPath, converted.raw, "utf8");

			return {
				id: parsed.meta.sessionId,
				sourcePath,
				targetPath,
				title: converted.title,
				success: true,
				overwritten: Boolean(existing),
				messageCount: converted.messageCount,
			};
		} catch (error) {
			return {
				id: sourcePath,
				sourcePath,
				success: false,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}

	private async toSummary(
		session: ParsedClaudeSession,
		projectPath: string,
	): Promise<ClaudeSessionSummary> {
		const targetPath = this.getTargetPath(projectPath, session);
		const importMeta = await this.readImportMeta(targetPath);
		const converted = this.convertToPiSession(projectPath, session);
		const status: ClaudeImportStatus = !importMeta
			? "new"
			: importMeta.sourceMtime === session.sourceMtime &&
			  importMeta.sourceSize === session.sourceSize
			? "current"
			: "outdated";

		return {
			id: session.meta.sessionId,
			sourcePath: session.sourcePath,
			targetPath,
			cwd: session.meta.cwd,
			title: converted.title,
			preview: converted.preview,
			createdAt: session.meta.firstTimestamp,
			updatedAt: session.meta.lastTimestamp,
			messageCount: converted.messageCount,
			status,
			sourceSize: session.sourceSize,
			importedSourceMtime: importMeta?.sourceMtime,
		};
	}

	private convertToPiSession(projectPath: string, session: ParsedClaudeSession) {
		const sessionId = session.meta.sessionId;
		const timestamp = new Date(session.meta.firstTimestamp).toISOString();
		const titleState = { title: "", preview: "" };
		const lines: string[] = [];
		let parentId: string | null = null;
		let sequence = 0;
		let messageCount = 0;

		const pushEntry = (entry: Record<string, unknown>) => {
			lines.push(JSON.stringify(entry));
		};

		const pushMessage = (
			role: "user" | "assistant" | "toolResult",
			content: unknown[],
			extra: Record<string, unknown> = {},
			timestampValue?: string,
		) => {
			if (content.length === 0) return;
			const id = this.makeId(sessionId, sequence++);
			const ts = timestampValue || new Date().toISOString();
			pushEntry({
				type: "message",
				id,
				parentId,
				timestamp: ts,
				message: {
					role,
					content,
					timestamp: new Date(ts).getTime(),
					...(role === "assistant" ? { usage: this.zeroUsage() } : {}),
					...extra,
				},
			});
			parentId = id;
			messageCount += 1;

			const text = this.extractPiText(content).trim();
			if (text && !titleState.preview) titleState.preview = text.slice(0, 160);
			if (role === "user" && text && !titleState.title) {
				titleState.title = this.cleanTitle(text);
			}
		};

		// 写入会话头
		pushEntry({
			type: "session",
			version: 3,
			id: sessionId,
			timestamp,
			cwd: projectPath,
		});

		pushEntry({
			type: "claude_import",
			version: 1,
			claudeSessionId: sessionId,
			sourcePath: session.sourcePath,
			sourceMtime: session.sourceMtime,
			sourceSize: session.sourceSize,
			importedAt: new Date().toISOString(),
		});

		// 假设使用 Claude 模型
		const modelChangeId = this.makeId(sessionId, sequence++);
		pushEntry({
			type: "model_change",
			id: modelChangeId,
			parentId,
			timestamp,
			provider: "anthropic",
			modelId: "claude-sonnet-4",
		});
		parentId = modelChangeId;

		// 转换消息
		for (const entry of session.entries) {
			// 跳过非消息类型
			if (entry.type === "file-history-snapshot") continue;
			if (entry.type === "system" && entry.subtype === "turn_duration") continue;
			if (entry.type === "system" && entry.subtype === "api_error") continue;

			if (entry.type === "user") {
				const text = String(entry.message?.content ?? "").trim();
				if (text) {
					pushMessage(
						"user",
						[{ type: "text", text }],
						{},
						entry.timestamp,
					);
				}
				continue;
			}

			if (entry.type === "assistant") {
				const message = entry.message;
				if (!message) continue;

				const content: any[] = [];

				// 处理内容
				if (Array.isArray(message.content)) {
					for (const item of message.content) {
						if (item.type === "text") {
							content.push({ type: "text", text: item.text });
						} else if (item.type === "thinking") {
							content.push({
								type: "thinking",
								thinking: item.thinking,
								thinkingSignature: "claude_thinking",
							});
						} else if (item.type === "tool_use") {
							content.push({
								type: "toolCall",
								id: item.id,
								name: item.name,
								arguments: item.input,
							});
						}
					}
				}

				if (content.length > 0) {
					pushMessage(
						"assistant",
						content,
						{
							api: "claude-import",
							provider: "anthropic",
							model: message.model || "claude-sonnet-4",
							stopReason: message.stop_reason || "stop",
						},
						entry.timestamp,
					);
				}
				continue;
			}

			// 处理工具结果
			if (entry.type === "tool_result") {
				const toolCallId = String(entry.tool_use_id ?? "");
				const output = this.extractToolOutput(entry);
				pushMessage(
					"toolResult",
					[{ type: "text", text: output }],
					{
						toolCallId,
						toolName: "tool",
						isError: Boolean(entry.is_error),
					},
					entry.timestamp,
				);
			}
		}

		const title =
			titleState.title ||
			this.cleanTitle(basename(session.sourcePath)) ||
			this.translate("session.importedTitle", { source: "Claude" });
		// 使用 pi 原生 session_info 格式追加在末尾，避免旧版 sessionName 行（无 type 字段）
		// 在文件头破坏 pi 的首行校验导致会话无法加载（见 #114）。
		const sessionInfoId = randomUUID().slice(0, 8);
		lines.push(JSON.stringify({
			type: "session_info",
			id: sessionInfoId,
			parentId,
			timestamp: new Date().toISOString(),
			name: title,
			cwd: projectPath,
		}));

		return {
			raw: `${lines.join("\n")}\n`,
			title,
			preview: titleState.preview || this.translate("session.importedPreview", { source: "Claude" }),
			messageCount,
		};
	}

	private zeroUsage() {
		return {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
	}

	private async readClaudeSession(filePath: string): Promise<ParsedClaudeSession> {
		this.assertClaudeSourcePath(filePath);
		const [raw, info] = await Promise.all([readFile(filePath, "utf8"), stat(filePath)]);
		// 截断/半行与非对象行逐行跳过，不让单个坏行使整份会话无法扫描/导入（与 pi 会话扫描一致）。
		const entries: Array<Record<string, any>> = [];
		for (const line of raw.split(/\r?\n/)) {
			if (!line) continue;
			try {
				const parsed: unknown = JSON.parse(line);
				if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) entries.push(parsed);
			} catch {
				// 跳过坏行
			}
		}

		// 从第一个 user 消息中提取元数据
		const firstUserEntry = entries.find((e) => e.type === "user");
		if (!firstUserEntry?.sessionId || !firstUserEntry?.cwd) {
			throw new Error("Missing Claude session metadata");
		}

		// 循环求极值：超长会话的时间戳数组用 Math.min(...arr) 展开会触发 RangeError。
		// 语义保持不变：空集为 ±Infinity，含无效日期时为 NaN（与原展开写法一致）。
		let firstTimestamp = Number.POSITIVE_INFINITY;
		let lastTimestamp = Number.NEGATIVE_INFINITY;
		for (const entry of entries) {
			if (!entry.timestamp) continue;
			const time = new Date(entry.timestamp).getTime();
			firstTimestamp = Math.min(firstTimestamp, time);
			lastTimestamp = Math.max(lastTimestamp, time);
		}

		return {
			meta: {
				sessionId: firstUserEntry.sessionId,
				cwd: firstUserEntry.cwd,
				firstTimestamp,
				lastTimestamp,
			},
			entries,
			sourcePath: filePath,
			sourceSize: info.size,
			sourceMtime: info.mtimeMs,
		};
	}

	private assertClaudeSourcePath(filePath: string) {
		const root = this.normalize(this.claudeRoot);
		const target = this.normalize(filePath);
		if (target !== root && !target.startsWith(`${root}/`)) {
			throw new Error("Claude session path is outside ~/.claude/projects");
		}
	}

	private async readImportMeta(targetPath: string) {
		try {
			const raw = await readFile(targetPath, "utf8");
			for (const line of raw.split(/\r?\n/).filter(Boolean).slice(0, 8)) {
				const entry = JSON.parse(line) as any;
				if (entry.type === "claude_import") {
					return {
						sourceMtime: Number(entry.sourceMtime),
						sourceSize: Number(entry.sourceSize),
					};
				}
			}
		} catch {
			return undefined;
		}
		return undefined;
	}

	private async collectJsonl(dir: string): Promise<string[]> {
		try {
			const entries = await readdir(dir, { withFileTypes: true });
			const files: string[] = [];
			for (const entry of entries) {
				const path = join(dir, entry.name);
				if (entry.isDirectory()) {
					files.push(...(await this.collectJsonl(path)));
				} else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
					files.push(path);
				}
			}
			return files;
		} catch {
			return [];
		}
	}

	private getClaudeProjectDir(projectPath: string): string {
		// 将项目路径转换为 Claude 的目录名格式
		// 例如：C:\Users\14012\pi-desktop -> C--Users-14012-pi-desktop
		const normalized = projectPath.replace(/\\/g, "/");
		const win = normalized.match(/^([A-Za-z]):\/(.+)$/);
		if (win) {
			const dirName = `${win[1]}--${win[2].replace(/\//g, "-")}`;
			return join(this.claudeRoot, dirName);
		}
		const dirName = normalized.replace(/^\//, "").replace(/\//g, "-");
		return join(this.claudeRoot, dirName);
	}

	private getTargetPath(projectPath: string, session: ParsedClaudeSession) {
		const id = session.meta.sessionId.replace(/[^a-zA-Z0-9_-]/g, "-");
		return join(this.getProjectSessionDir(projectPath), `claude_${id}.jsonl`);
	}

	private getProjectSessionDir(projectPath: string) {
		return join(this.piRoot, this.safePathToken(projectPath));
	}

	private safePathToken(path: string) {
		const normalized = path.replace(/\\/g, "/");
		const win = normalized.match(/^([A-Za-z]):\/(.+)$/);
		if (win) return `--${win[1]}--${win[2].replace(/\//g, "-")}--`;
		return `--${normalized.replace(/^\//, "").replace(/\//g, "-")}--`;
	}

	private extractToolOutput(payload: Record<string, any>) {
		const output = payload.content ?? payload.output;
		if (typeof output === "string") return output;
		if (Array.isArray(output)) {
			return output
				.map((item) => {
					if (typeof item === "string") return item;
					return String(item?.text ?? item?.content ?? "");
				})
				.filter(Boolean)
				.join("\n");
		}
		try {
			return JSON.stringify(output ?? "", null, 2);
		} catch {
			return String(output ?? "");
		}
	}

	private extractPiText(content: unknown[]) {
		return content
			.map((item: any) => item?.text ?? item?.thinking ?? item?.name ?? "")
			.filter(Boolean)
			.join(" ");
	}

	private cleanTitle(value?: string) {
		const text = value?.replace(/\s+/g, " ").trim();
		if (!text || /^untitled$/i.test(text)) return "";
		return text.length > 40 ? `${text.slice(0, 40)}...` : text;
	}

	private makeId(sessionId: string, sequence: number) {
		return this.hash(`${sessionId}:${sequence}`).slice(0, 8);
	}

	private hash(value: string) {
		return createHash("sha1").update(value).digest("hex");
	}

	private normalize(path?: string) {
		return String(path ?? "")
			.replace(/\\/g, "/")
			.replace(/\/+$/, "")
			.toLowerCase();
	}
}
