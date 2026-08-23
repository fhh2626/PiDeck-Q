import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readFile, readdir, rename, stat, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { homedir } from "node:os";
import { createInterface } from "node:readline";
import type {
	CodexImportReport,
	CodexImportResult,
	CodexImportStatus,
	CodexSessionSummary,
} from "../../shared/types";
import { getCodexSessionThreadInfo } from "../../shared/codexSessionMeta";
import {
	defaultSessionImportCopy,
	type SessionImportCopy,
} from "./SessionImportCopy";

// 扫描阶段只读每个文件头部：session_meta / 首条用户消息 / preview 都在前部，
// 全量解析会让内存峰值随 ~/.codex/sessions 总大小线性增长（rollouts 轨迹文件常达几十 MB），
// 曾导致扫描时 OOM、应用被系统静默杀死（无任何日志）——超大会话的 summary 按头部近似。
const SCAN_HEAD_LIMIT = 1024 * 1024;
// 扫描并发上限：限制同时驻留内存的头部缓冲数量（与 SCAN_HEAD_LIMIT 配合防 OOM）。
const SCAN_CONCURRENCY = 6;
// 预过滤阶段只读每个文件头部 64KB 提取 session_meta（codex 会话首行即 session_meta，
// 64KB 足够容纳；超出行数/大小视为无 meta 跳过）。
const META_HEAD_LIMIT = 64 * 1024;

type ParsedCodexSession = {
	meta: Record<string, any>;
	entries: Array<Record<string, any>>;
	sourcePath: string;
	sourceSize: number;
	sourceMtime: number;
};

export class CodexSessionImporter {
	private readonly codexRoot: string;
	private readonly piRoot: string;

	constructor(
		private readonly translate: SessionImportCopy = defaultSessionImportCopy,
		homeDir?: string,
	) {
		const home = homeDir ?? homedir();
		this.codexRoot = join(home, ".codex", "sessions");
		this.piRoot = join(home, ".pi", "agent", "sessions");
	}

	async scan(projectPath: string): Promise<CodexSessionSummary[]> {
		const files = await this.collectJsonl(this.codexRoot).catch(() => []);
		const normalizedProject = this.normalize(projectPath);

		// 阶段 1：预过滤——每个文件只读头部 64KB 提取 session_meta.cwd，定位属于当前项目的会话。
		// 注意：~/.codex/sessions 下是所有项目的会话（codex 按 cwd 归档、目录名是 UUID），
		// 只能全目录预过滤后再按项目筛选；非当前项目的会话（可能成百上千）不读正文，
		// 巨型会话（几百 MB~1GB）也只读这 64KB 即丢弃——扫描开销与目录总大小解耦。
		const candidates: string[] = [];
		for (let i = 0; i < files.length; i += SCAN_CONCURRENCY) {
			const chunk = files.slice(i, i + SCAN_CONCURRENCY);
			const metas = await Promise.all(
				chunk.map((file) => this.readCodexMetaOnly(file).catch(() => null)),
			);
			metas.forEach((meta, index) => {
				if (meta && this.normalize(meta.meta.cwd) === normalizedProject) {
					candidates.push(chunk[index]);
				}
			});
		}

		// 阶段 2：候选会话读头部（1MB）生成 summary；分块并发限制驻留缓冲；
		// 单会话解析/转换失败跳过，不影响其余会话。
		const sessions: Array<ParsedCodexSession | null> = [];
		for (let i = 0; i < candidates.length; i += SCAN_CONCURRENCY) {
			const chunk = candidates.slice(i, i + SCAN_CONCURRENCY);
			const results = await Promise.all(
				chunk.map((file) => this.readCodexSession(file).catch(() => null)),
			);
			sessions.push(...results);
		}

		const summaries = await Promise.all(
			sessions
				.filter((session): session is ParsedCodexSession => Boolean(session))
				.map((session) => this.toSummary(session, projectPath).catch(() => null)),
		);
		return summaries
			.filter((summary): summary is CodexSessionSummary => Boolean(summary))
			.sort((a, b) => b.updatedAt - a.updatedAt);
	}

	/**
	 * 只读文件头部提取完整 session_meta（codex 会话第一行即 session_meta）用于项目预过滤
	 * 与导入元信息；坏行/截断容忍。头部没有 meta 视为不可扫描（返回 null）。
	 */
	private async readCodexMetaOnly(
		filePath: string,
	): Promise<ParsedCodexSession | null> {
		this.assertCodexSourcePath(filePath);
		const info = await stat(filePath);
		const raw = await this.readFileHead(filePath, META_HEAD_LIMIT);
		for (const line of raw.split(/\r?\n/).filter(Boolean).slice(0, 8)) {
			try {
				const entry = JSON.parse(line) as ParsedCodexSession["entries"][number];
				if (entry.type === "session_meta" && entry.payload?.id && entry.payload?.cwd) {
					return {
						meta: entry.payload,
						entries: [],
						sourcePath: filePath,
						sourceSize: info.size,
						sourceMtime: info.mtimeMs,
					};
				}
			} catch {
				// 坏行跳过（与 headOnly 解析同策略）
			}
		}
		return null;
	}

	async import(projectPath: string, sourcePaths: string[]): Promise<CodexImportReport> {
		const results: CodexImportResult[] = [];
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
	): Promise<CodexImportResult> {
		try {
			// 轻量读 meta（只读头部 64KB + stat），不加载正文——巨型会话（几百 MB~1GB）
			// 全量解析会 OOM 导致应用被系统静默杀死，导入改为流式转换（见 convertToPiSessionStreaming）
			const info = await this.readCodexMetaOnly(sourcePath);
			if (!info) throw new Error("Missing Codex session metadata");
			const sourceCwd = this.normalize(info.meta.cwd);
			if (sourceCwd !== this.normalize(projectPath)) {
				throw new Error("Codex session cwd does not match selected project");
			}

			const targetPath = this.getTargetPath(projectPath, info);
			const existing = await this.readImportMeta(targetPath);
			await mkdir(this.getProjectSessionDir(projectPath), { recursive: true });
			const converted = await this.convertToPiSessionStreaming(projectPath, info, targetPath);

			return {
				id: String(info.meta.id ?? sourcePath),
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
		session: ParsedCodexSession,
		projectPath: string,
	): Promise<CodexSessionSummary> {
		const targetPath = this.getTargetPath(projectPath, session);
		const importMeta = await this.readImportMeta(targetPath);
		const converted = this.convertToPiSession(projectPath, session);
		const status: CodexImportStatus = !importMeta
			? "new"
			: importMeta.sourceMtime === session.sourceMtime &&
				  importMeta.sourceSize === session.sourceSize
				? "current"
				: "outdated";

		const originalTimestamp = Date.parse(String(session.meta.timestamp ?? "")) || session.sourceMtime;
		const threadInfo = getCodexSessionThreadInfo(session.meta);
		return {
			id: String(session.meta.id ?? session.sourcePath),
			sourcePath: session.sourcePath,
			targetPath,
			cwd: String(session.meta.cwd ?? ""),
			title: converted.title,
			preview: converted.preview,
			createdAt: originalTimestamp,
			updatedAt: originalTimestamp,
			messageCount: converted.messageCount,
			status,
			sourceSize: session.sourceSize,
			importedSourceMtime: importMeta?.sourceMtime,
			threadSource: threadInfo.threadSource,
			parentThreadId: threadInfo.parentThreadId,
			agentRole: threadInfo.agentRole,
			agentNickname: threadInfo.agentNickname,
		};
	}

	private convertToPiSession(projectPath: string, session: ParsedCodexSession) {
		const sessionId = String(session.meta.id ?? this.hash(session.sourcePath));
		const threadInfo = getCodexSessionThreadInfo(session.meta);
		const timestamp = new Date(
			Date.parse(String(session.meta.timestamp ?? "")) || session.sourceMtime,
		).toISOString();
		const titleState = { title: "", preview: "" };
		const toolNames = new Map<string, string>();
		const toolStartedAt = new Map<string, number>();
		const lines: string[] = [];
		let parentId: string | null = null;
		let sequence = 0;
		let messageCount = 0;
		let pendingThinking = "";

		const pushEntry = (entry: Record<string, unknown>) => {
			lines.push(JSON.stringify(entry));
		};
		const pushMessage = (
			role: "user" | "assistant" | "toolResult",
			content: unknown[],
			extra: Record<string, unknown> = {},
			timestampValue?: unknown,
		) => {
			if (content.length === 0) return;
			const id = this.makeId(sessionId, sequence++);
			const messageTimestamp =
				this.parseTimestamp(timestampValue) ?? session.sourceMtime + sequence;
			const ts = new Date(messageTimestamp).toISOString();
			pushEntry({
				type: "message",
				id,
				parentId,
				timestamp: ts,
				message: {
					role,
					content,
					timestamp: messageTimestamp,
					// pi 的上下文统计会读取 assistant.usage.totalTokens；Codex 原始历史没有该字段，导入时用 0 值占位保证可继续对话。
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

		pushEntry({
			type: "session",
			version: 3,
			id: sessionId,
			timestamp,
			cwd: projectPath,
		});
		pushEntry({
			type: "codex_import",
			version: 1,
			codexSessionId: sessionId,
			sourcePath: session.sourcePath,
			sourceMtime: session.sourceMtime,
			sourceSize: session.sourceSize,
			importedAt: new Date().toISOString(),
			threadSource: threadInfo.threadSource,
			parentThreadId: threadInfo.parentThreadId,
			agentRole: threadInfo.agentRole,
			agentNickname: threadInfo.agentNickname,
		});
		const modelChangeId = this.makeId(sessionId, sequence++);
		pushEntry({
			type: "model_change",
			id: modelChangeId,
			parentId,
			timestamp,
			provider: String(session.meta.model_provider ?? "codex"),
			modelId: String(session.meta.model ?? "codex"),
		});
		parentId = modelChangeId;

		for (const entry of session.entries) {
			if (entry.type === "event_msg" && entry.payload?.type === "user_message") {
				const text = String(entry.payload.message ?? "").trim();
				if (text) pushMessage("user", [{ type: "text", text }], {}, entry.timestamp);
				continue;
			}

			if (entry.type !== "response_item") continue;
			const payload = entry.payload ?? {};

			if (payload.type === "reasoning") {
				const reasoning = this.extractCodexText(payload).trim();
				if (reasoning) pendingThinking = this.joinText(pendingThinking, reasoning);
				continue;
			}

			if (payload.type === "message" && payload.role === "assistant") {
				const text = this.extractCodexText(payload).trim();
				const content = [
					...(pendingThinking
						? [{ type: "thinking", thinking: pendingThinking, thinkingSignature: "codex_reasoning" }]
						: []),
					...(text ? [{ type: "text", text }] : []),
				];
				pendingThinking = "";
				pushMessage(
					"assistant",
					content,
					{
						api: "codex-import",
						provider: String(session.meta.model_provider ?? "codex"),
						model: String(session.meta.model ?? "codex"),
						stopReason: "stop",
					},
					entry.timestamp,
				);
				continue;
			}

			if (payload.type === "function_call") {
				const callId = String(payload.call_id ?? payload.id ?? this.makeId(sessionId, sequence));
				const toolName = String(payload.name ?? "tool");
				toolNames.set(callId, toolName);
				const callStartedAt = this.parseTimestamp(entry.timestamp);
				if (callStartedAt !== undefined) toolStartedAt.set(callId, callStartedAt);
				const args = this.parseArguments(payload.arguments);
				const content = [
					...(pendingThinking
						? [{ type: "thinking", thinking: pendingThinking, thinkingSignature: "codex_reasoning" }]
						: []),
					{ type: "toolCall", id: callId, name: toolName, arguments: args },
				];
				pendingThinking = "";
				pushMessage(
					"assistant",
					content,
					{
						api: "codex-import",
						provider: String(session.meta.model_provider ?? "codex"),
						model: String(session.meta.model ?? "codex"),
						stopReason: "toolUse",
					},
					entry.timestamp,
				);
				continue;
			}

			if (payload.type === "function_call_output") {
				const callId = String(payload.call_id ?? payload.id ?? this.makeId(sessionId, sequence));
				const output = this.extractToolOutput(payload);
				const completedAt = this.parseTimestamp(entry.timestamp);
				const startedAt = toolStartedAt.get(callId);
				pushMessage(
					"toolResult",
					[{ type: "text", text: output }],
					{
						toolCallId: callId,
						toolName: toolNames.get(callId) ?? "tool",
						isError: Boolean(payload.is_error),
						// Codex 历史只有 function_call / output 时间戳，导入时保存派生耗时，
						// 让桌面端工具卡片与原生 pi 会话保持一致。
						...(startedAt !== undefined ? { startedAt } : {}),
						...(startedAt !== undefined && completedAt !== undefined
							? { durationMs: Math.max(0, completedAt - startedAt) }
							: {}),
					},
					entry.timestamp,
				);
			}
		}

		if (pendingThinking) {
			pushMessage("assistant", [
				{ type: "thinking", thinking: pendingThinking, thinkingSignature: "codex_reasoning" },
			]);
		}

		const title = titleState.title || this.cleanTitle(basename(session.sourcePath)) ||
			this.translate("session.importedTitle", { source: "Codex" });
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
			preview: titleState.preview || this.translate("session.importedPreview", { source: "Codex" }),
			messageCount,
		};
	}

	/**
	 * 流式导入转换：逐行读源文件、逐行写目标文件，内存峰值 O(单行)，
	 * 支持数百 MB~1GB 巨型会话（全量版会在 JSON.parse 时 OOM，被系统静默杀进程）。
	 * 状态机（title/preview/messageCount/parentId/sequence/pendingThinking）与
	 * convertToPiSession 保持一致——scan 预览与 import 结果必须等价。
	 */
	private async convertToPiSessionStreaming(
		projectPath: string,
		session: ParsedCodexSession,
		targetPath: string,
	): Promise<{ title: string; preview: string; messageCount: number }> {
		const sessionId = String(session.meta.id ?? this.hash(session.sourcePath));
		const threadInfo = getCodexSessionThreadInfo(session.meta);
		const timestamp = new Date(
			Date.parse(String(session.meta.timestamp ?? "")) || session.sourceMtime,
		).toISOString();
		const titleState = { title: "", preview: "" };
		const toolNames = new Map<string, string>();
		const toolStartedAt = new Map<string, number>();
		let parentId: string | null = null;
		let sequence = 0;
		let messageCount = 0;
		let pendingThinking = "";

		// 不能直接截断正式会话：源 JSONL 可能在转换中途损坏或磁盘写入失败。
		// 先在同目录完整写入并落盘，再原子替换；失败时旧导入结果始终可用。
		const tempPath = join(
			dirname(targetPath),
			`.${basename(targetPath)}.${process.pid}.${randomUUID()}.tmp`,
		);
		const handle = await open(tempPath, "wx");
		let handleClosed = false;
		let renamed = false;
		// 1MB 写缓冲：巨型会话可达几十万行，逐行系统调用太慢
		let writeBuffer = "";
		const flushBuffer = async () => {
			if (writeBuffer) {
				await handle.write(writeBuffer);
				writeBuffer = "";
			}
		};
		const pushEntry = async (entry: Record<string, unknown>) => {
			writeBuffer += `${JSON.stringify(entry)}\n`;
			if (writeBuffer.length >= 1024 * 1024) await flushBuffer();
		};
		const pushMessage = async (
			role: "user" | "assistant" | "toolResult",
			content: unknown[],
			extra: Record<string, unknown> = {},
			timestampValue?: unknown,
		) => {
			if (content.length === 0) return;
			const id = this.makeId(sessionId, sequence++);
			const messageTimestamp =
				this.parseTimestamp(timestampValue) ?? session.sourceMtime + sequence;
			const ts = new Date(messageTimestamp).toISOString();
			await pushEntry({
				type: "message",
				id,
				parentId,
				timestamp: ts,
				message: {
					role,
					content,
					timestamp: messageTimestamp,
					// pi 的上下文统计会读取 assistant.usage.totalTokens；Codex 原始历史没有该字段，导入时用 0 值占位保证可继续对话。
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

		try {
			await pushEntry({
				type: "session",
				version: 3,
				id: sessionId,
				timestamp,
				cwd: projectPath,
			});
			await pushEntry({
				type: "codex_import",
				version: 1,
				codexSessionId: sessionId,
				sourcePath: session.sourcePath,
				sourceMtime: session.sourceMtime,
				sourceSize: session.sourceSize,
				importedAt: new Date().toISOString(),
				threadSource: threadInfo.threadSource,
				parentThreadId: threadInfo.parentThreadId,
				agentRole: threadInfo.agentRole,
				agentNickname: threadInfo.agentNickname,
			});
			const modelChangeId = this.makeId(sessionId, sequence++);
			await pushEntry({
				type: "model_change",
				id: modelChangeId,
				parentId,
				timestamp,
				provider: String(session.meta.model_provider ?? "codex"),
				modelId: String(session.meta.model ?? "codex"),
			});
			parentId = modelChangeId;

			// 逐行流式转换；session_meta 行在循环中被自然跳过（非 event_msg/response_item）
			const rl = createInterface({
				input: createReadStream(session.sourcePath, { encoding: "utf8" }),
				crlfDelay: Infinity,
			});
			for await (const line of rl) {
				let entry: ParsedCodexSession["entries"][number];
				try {
					entry = JSON.parse(line) as ParsedCodexSession["entries"][number];
				} catch (error) {
					// 导入严格语义：坏行即失败（与旧全量实现一致）；错误信息截断行前缀防刷屏
					throw new Error(
						`Invalid line in Codex session: ${line.slice(0, 120)} (${error instanceof Error ? error.message : String(error)})`,
					);
				}

				if (entry.type === "event_msg" && entry.payload?.type === "user_message") {
					const text = String(entry.payload.message ?? "").trim();
					if (text) await pushMessage("user", [{ type: "text", text }], {}, entry.timestamp);
					continue;
				}

				if (entry.type !== "response_item") continue;
				const payload = entry.payload ?? {};

				if (payload.type === "reasoning") {
					const reasoning = this.extractCodexText(payload).trim();
					if (reasoning) pendingThinking = this.joinText(pendingThinking, reasoning);
					continue;
				}

				if (payload.type === "message" && payload.role === "assistant") {
					const text = this.extractCodexText(payload).trim();
					const content = [
						...(pendingThinking
							? [{ type: "thinking", thinking: pendingThinking, thinkingSignature: "codex_reasoning" }]
							: []),
						...(text ? [{ type: "text", text }] : []),
					];
					pendingThinking = "";
					await pushMessage(
						"assistant",
						content,
						{
							api: "codex-import",
							provider: String(session.meta.model_provider ?? "codex"),
							model: String(session.meta.model ?? "codex"),
							stopReason: "stop",
						},
						entry.timestamp,
					);
					continue;
				}

				if (payload.type === "function_call") {
					const callId = String(payload.call_id ?? payload.id ?? this.makeId(sessionId, sequence));
					const toolName = String(payload.name ?? "tool");
					toolNames.set(callId, toolName);
					const callStartedAt = this.parseTimestamp(entry.timestamp);
					if (callStartedAt !== undefined) toolStartedAt.set(callId, callStartedAt);
					const args = this.parseArguments(payload.arguments);
					const content = [
						...(pendingThinking
							? [{ type: "thinking", thinking: pendingThinking, thinkingSignature: "codex_reasoning" }]
							: []),
						{ type: "toolCall", id: callId, name: toolName, arguments: args },
					];
					pendingThinking = "";
					await pushMessage(
						"assistant",
						content,
						{
							api: "codex-import",
							provider: String(session.meta.model_provider ?? "codex"),
							model: String(session.meta.model ?? "codex"),
							stopReason: "toolUse",
						},
						entry.timestamp,
					);
					continue;
				}

				if (payload.type === "function_call_output") {
					const callId = String(payload.call_id ?? payload.id ?? this.makeId(sessionId, sequence));
					const output = this.extractToolOutput(payload);
					const completedAt = this.parseTimestamp(entry.timestamp);
					const startedAt = toolStartedAt.get(callId);
					await pushMessage(
						"toolResult",
						[{ type: "text", text: output }],
						{
							toolCallId: callId,
							toolName: toolNames.get(callId) ?? "tool",
							isError: Boolean(payload.is_error),
							// Codex 历史只有 function_call / output 时间戳，导入时保存派生耗时，
							// 让桌面端工具卡片与原生 pi 会话保持一致。
							...(startedAt !== undefined ? { startedAt } : {}),
							...(startedAt !== undefined && completedAt !== undefined
								? { durationMs: Math.max(0, completedAt - startedAt) }
								: {}),
						},
						entry.timestamp,
					);
				}
			}

			if (pendingThinking) {
				await pushMessage("assistant", [
					{ type: "thinking", thinking: pendingThinking, thinkingSignature: "codex_reasoning" },
				]);
			}

			const title =
				titleState.title ||
				this.cleanTitle(basename(session.sourcePath)) ||
				this.translate("session.importedTitle", { source: "Codex" });
			// 使用 pi 原生 session_info 格式追加在末尾，避免旧版 sessionName 行（无 type 字段）
			// 在文件头破坏 pi 的首行校验导致会话无法加载（见 #114）。
			const sessionInfoId = randomUUID().slice(0, 8);
			await pushEntry({
				type: "session_info",
				id: sessionInfoId,
				parentId,
				timestamp: new Date().toISOString(),
				name: title,
				cwd: projectPath,
			});
			await flushBuffer();
			await handle.sync();
			await handle.close();
			handleClosed = true;
			await rename(tempPath, targetPath);
			renamed = true;

			return {
				title,
				preview: titleState.preview || this.translate("session.importedPreview", { source: "Codex" }),
				messageCount,
			};
		} finally {
			if (!handleClosed) await handle.close().catch(() => undefined);
			if (!renamed) await unlink(tempPath).catch(() => undefined);
		}
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

	private async readCodexSession(filePath: string): Promise<ParsedCodexSession> {
		this.assertCodexSourcePath(filePath);
		const info = await stat(filePath);
		// 扫描只读头部：头部截断可能切在行中间/多字节字符上，坏行直接跳过（近似扫描）
		const raw = await this.readFileHead(filePath, SCAN_HEAD_LIMIT);
		const entries: ParsedCodexSession["entries"] = [];
		for (const line of raw.split(/\r?\n/).filter(Boolean)) {
			try {
				entries.push(JSON.parse(line) as ParsedCodexSession["entries"][number]);
			} catch {
				// 坏行跳过（近似扫描语义）
			}
		}
		const meta = entries.find((entry) => entry.type === "session_meta")?.payload;
		if (!meta?.id || !meta?.cwd) throw new Error("Missing Codex session metadata");
		return {
			meta,
			entries,
			sourcePath: filePath,
			sourceSize: info.size,
			sourceMtime: info.mtimeMs,
		};
	}

	/** 只读文件前 limit 字节（扫描用，避免全量加载大文件）。 */
	private async readFileHead(filePath: string, limit: number): Promise<string> {
		const handle = await open(filePath, "r");
		try {
			const buffer = Buffer.alloc(limit);
			const { bytesRead } = await handle.read(buffer, 0, limit, 0);
			return buffer.subarray(0, bytesRead).toString("utf8");
		} finally {
			await handle.close();
		}
	}

	private assertCodexSourcePath(filePath: string) {
		const root = this.normalize(this.codexRoot);
		const target = this.normalize(filePath);
		if (target !== root && !target.startsWith(`${root}/`)) {
			throw new Error("Codex session path is outside ~/.codex/sessions");
		}
	}

	private async readImportMeta(targetPath: string) {
		try {
			const raw = await readFile(targetPath, "utf8");
			for (const line of raw.split(/\r?\n/).filter(Boolean).slice(0, 8)) {
				const entry = JSON.parse(line) as any;
				if (entry.type === "codex_import") {
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
		const entries = await readdir(dir, { withFileTypes: true });
		const files: string[] = [];
		for (const entry of entries) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) {
				// codex CLI 的 rollouts/ 是每轮 agentic 轨迹文件，体积巨大且不是独立会话，
				// 扫描跳过（否则一次扫描会全量读入几十 MB 的轨迹文件）。
				if (entry.name === "rollouts") continue;
				files.push(...(await this.collectJsonl(path)));
			} else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(path);
		}
		return files;
	}

	private getTargetPath(
		projectPath: string,
		session: Pick<ParsedCodexSession, "meta" | "sourcePath">,
	) {
		const id = String(session.meta.id ?? this.hash(session.sourcePath)).replace(/[^a-zA-Z0-9_-]/g, "-");
		return join(this.getProjectSessionDir(projectPath), `codex_${id}.jsonl`);
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

	private extractCodexText(payload: Record<string, any>) {
		const content = payload.content ?? payload.summary ?? payload.text ?? payload.output;
		if (typeof content === "string") return content;
		if (!Array.isArray(content)) return "";
		return content
			.map((item) => {
				if (typeof item === "string") return item;
				if (!item || typeof item !== "object") return "";
				return String(item.text ?? item.message ?? item.content ?? "");
			})
			.filter(Boolean)
			.join("\n");
	}

	private extractToolOutput(payload: Record<string, any>) {
		const output = payload.output ?? payload.content;
		if (typeof output === "string") return output;
		if (Array.isArray(output)) return this.extractCodexText({ content: output });
		try {
			return JSON.stringify(output ?? "", null, 2);
		} catch {
			return String(output ?? "");
		}
	}

	private parseArguments(value: unknown) {
		if (typeof value !== "string") return value ?? {};
		try {
			return JSON.parse(value);
		} catch {
			return { input: value };
		}
	}

	private parseTimestamp(value: unknown) {
		if (typeof value === "number" && Number.isFinite(value)) return value;
		if (typeof value !== "string") return undefined;
		const parsed = Date.parse(value);
		return Number.isFinite(parsed) ? parsed : undefined;
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

	private joinText(a: string, b: string) {
		if (!a) return b;
		if (!b) return a;
		return `${a}\n\n${b}`;
	}

	private normalize(path?: string) {
		return String(path ?? "")
			.replace(/\\/g, "/")
			.replace(/\/+$/, "")
			.toLowerCase();
	}
}
