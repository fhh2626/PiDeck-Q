import { open, readFile, stat } from "node:fs/promises";
import type { ChatMessage, ImageContent, SessionMessagePage } from "../../shared/types";
import type { MainProcessTranslationKey } from "../../shared/i18n/mainProcessCopy";
import type { RpcResponse } from "./PiRpcClient";
import type { AppLogger } from "../logging/AppLogger";

type SessionDisplayEntry = {
	id: string;
	parentId: string | null;
	type: string;
	offset: number;
	byteLength: number;
	hasMessage: boolean;
	/** 消息角色（user/assistant/…）：轮次分页按 user 消息切轮次边界，建索引时顺手捕获 */
	role?: string;
	/** 消息条目的 message.id：编辑/删除/重发缓存未命中时按 messageId 定位文件条目 */
	messageId?: string;
	summary?: string;
	firstKeptEntryId?: string;
	timestamp?: string;
	tokensBefore?: number;
};

type SessionDisplayIndex = {
	hostPath: string;
	size: number;
	mtimeMs: number;
	hasCompaction: boolean;
	/** 全量条目表（含非活跃分支）：增量追加与 fork/rewind 回溯用 */
	entries: Map<string, SessionDisplayEntry>;
	/** 活动分支（含 compaction 等非消息条目）：从最后 entry 沿 parentId 回溯 */
	activeBranch: SessionDisplayEntry[];
	/** 活动分支中的消息条目（分页/轮次计算用，派生自 activeBranch） */
	activeMessageEntries: SessionDisplayEntry[];
	/** 构建时文件是否以完整行（\n）结尾：false 时禁止增量追加（旧最后一行可能被拼接污染） */
	endsWithNewline: boolean;
};

export type SessionArchiveData = {
	compactions: Array<{
		id: string;
		summary: string;
		timestamp: string;
		firstKeptEntryId?: string;
		tokensBefore?: number;
	}>;
};

export type SessionHistoryReaderDeps = {
	toHostPath: (sessionPath: string) => string;
	convertMessages: (
		agentId: string,
		rawMessages: unknown[],
		activeEntryIds?: string[],
	) => ChatMessage[];
	trimMessages: (rawMessages: unknown[], maxTurns?: number) => unknown[];
	translate: (
		key: MainProcessTranslationKey,
		params?: Record<string, string | number>,
	) => string;
	logger?: Pick<AppLogger, "info" | "warn">;
};

/**
 * 轮次分页起点计算（纯函数，2026-08 激活分页）。
 * 轮次起点 = user 消息——与 trimHistoryMessages、渲染层 agent-run 分组同一约定，
 * 保证页边界永远对齐完整轮次（折叠不会被切成半个回答）。
 *
 * 字节预算是安全阀而非分页维度：超预算时从最旧侧整轮丢弃，
 * 最新一轮无论多大都整轮保留（宁超预算不拆轮）。
 */
export function findTurnPageStart(
	entries: ReadonlyArray<{ role?: string; byteLength: number }>,
	before: number,
	turnCount: number,
	byteBudget: number,
): number {
	if (before <= 0 || turnCount < 1) return 0;
	// 从 before-1 向前数第 turnCount 个轮次起点（user 消息）
	let turnsSeen = 0;
	let start = 0;
	for (let i = before - 1; i >= 0; i -= 1) {
		if (entries[i].role === "user") {
			turnsSeen += 1;
			if (turnsSeen === turnCount) {
				start = i;
				break;
			}
		}
	}
	// 不足 turnCount 轮：从会话头起（开头的 system/碎片消息归入首轮）
	if (turnsSeen < turnCount) start = 0;
	// 起点之前已无 user 消息（落在首个轮次起点）：开头碎片并入本页，避免碎片单独成页
	else {
		let hasEarlierUser = false;
		for (let i = 0; i < start; i += 1) {
			if (entries[i].role === "user") { hasEarlierUser = true; break; }
		}
		if (!hasEarlierUser) start = 0;
	}
	let bytes = 0;
	for (let i = start; i < before; i += 1) bytes += entries[i].byteLength;
	while (bytes > byteBudget) {
		let next = start + 1;
		while (next < before && entries[next].role !== "user") next += 1;
		if (next >= before) break; // 只剩最新一轮：整轮保留，预算让位
		for (let i = start; i < next; i += 1) bytes -= entries[i].byteLength;
		start = next;
	}
	return start;
}

/**
 * 从 pi 消息 content 提取「重发」回填内容：string 或 blocks 数组（text/image）。
 * 图片块格式：{ type: "image", source: { type: "base64", media_type, data } }。
 */
function extractResendContent(content: unknown): { text: string; images?: ImageContent[] } {
	if (typeof content === "string") return { text: content };
	if (Array.isArray(content)) {
		const textParts: string[] = [];
		const images: ImageContent[] = [];
		for (const block of content) {
			const typed = block as {
				type?: string;
				text?: string;
				source?: { type?: string; media_type?: string; data?: string };
			} | null;
			if (!typed || typeof typed !== "object") continue;
			if (typed.type === "text" && typeof typed.text === "string") {
				textParts.push(typed.text);
			} else if (
				typed.type === "image" &&
				typed.source?.type === "base64" &&
				typeof typed.source.data === "string"
			) {
				images.push({
					type: "image",
					mimeType: typeof typed.source.media_type === "string" ? typed.source.media_type : "image/png",
					data: typed.source.data,
				});
			}
		}
		return { text: textParts.join("\n"), ...(images.length > 0 ? { images } : {}) };
	}
	return { text: "" };
}

/**
 * 从渲染层合成消息 ID（`${agentId}-history-${entryId}`）解析出 entryId。
 * 与 SessionFileEditor.legacyEntryId 的格式约定一致：agentId/entryId 是 UUID，
 * 不含 "-history-" 分隔符；非合成格式返回 undefined。
 */
export function syntheticHistoryEntryId(messageId: string): string | undefined {
	const marker = "-history-";
	const index = messageId.lastIndexOf(marker);
	if (index < 0) return undefined;
	const entryId = messageId.slice(index + marker.length);
	return entryId || undefined;
}

/**
 * Reads persisted Session JSONL without starting Pi. Runtime ownership remains in
 * AgentManager; this reader owns bounded display paging and compaction recovery.
 */
export class SessionHistoryReader {
	private readonly sessionDisplayIndexes = new Map<string, SessionDisplayIndex>();
	private static readonly SESSION_DISPLAY_INDEX_LIMIT = 32;
	private static readonly MAX_SESSION_DISPLAY_PAGE_SIZE = 100;
	private static readonly MAX_SESSION_DISPLAY_PAGE_BYTES = 256 * 1024;
	/** 完整消息文本 LRU 缓存（「查看完整输出」按需读取结果）：键 `${sessionPath}#${messageId}`。 */
	private readonly fullTextCache = new Map<string, string>();
	private static readonly FULL_TEXT_CACHE_LIMIT = 200;
	/** 轮次分页默认/上限：默认最近一次激活带 3 轮，单页最多 10 轮（防恶意参数撑爆 IPC） */
	static readonly DEFAULT_TURN_PAGE_SIZE = 3;
	private static readonly MAX_TURN_PAGE_SIZE = 10;

	/** 单页轮次上限（AgentManager 缓存优先路径复用，避免翻页超预算） */
	static maxTurnPageSize(): number {
		return SessionHistoryReader.MAX_TURN_PAGE_SIZE;
	}

	constructor(private readonly deps: SessionHistoryReaderDeps) {}

	/**
	 * 不启动 pi 进程，直接从 JSONL 构造与运行态相同的时间线数据。
	 * Viewer 必须复用 AgentManager 的压缩归档与消息转换规则，避免维护第二套显示模型。
	 */
	async readMessageFullText(
		sessionPath: string,
		messageId: string,
		entryId?: string,
	): Promise<{ text: string }> {
		const cacheKey = `${sessionPath}#${messageId}`;
		const cached = this.fullTextCache.get(cacheKey);
		if (cached !== undefined) {
			// LRU 刷新：先删后插，保持 Map 迭代序 = 最近使用序
			this.fullTextCache.delete(cacheKey);
			this.fullTextCache.set(cacheKey, cached);
			return { text: cached };
		}
		const content = await readFile(this.deps.toHostPath(sessionPath), "utf8");
		// 定位读取：逐行 parse 直到命中目标 entry（entryId 优先，回退 message.id），
		// 不做全文件转换，避免大会话展开单条内容时触发整文件解析冻结。
		for (const line of content.split("\n")) {
			if (!line.trim()) continue;
			let entry: unknown;
			try {
				entry = JSON.parse(line);
			} catch {
				continue; // 跳过单行解析失败
			}
			if (!entry || typeof entry !== "object") continue;
			const e = entry as { id?: unknown; message?: unknown };
			const match = Boolean(
				(entryId && e.id === entryId) ||
				(e.message && typeof e.message === "object" && (e.message as { id?: unknown }).id === messageId),
			);
			if (!match) continue;
			const text = extractEntryResultText(e.message);
			if (!text) {
				throw new Error(`Message ${messageId} has no extractable text content`);
			}
			if (this.fullTextCache.size >= SessionHistoryReader.FULL_TEXT_CACHE_LIMIT) {
				const oldest = this.fullTextCache.keys().next().value;
				if (oldest !== undefined) this.fullTextCache.delete(oldest);
			}
			this.fullTextCache.set(cacheKey, text);
			return { text };
		}
		throw new Error(`Message ${messageId} not found in session file`);
	}

	async readSessionDisplayMessages(
		sessionPath: string,
		agentId = "_viewer",
		sessionContent?: string,
	): Promise<ChatMessage[]> {
		const content = sessionContent ?? await readFile(this.deps.toHostPath(sessionPath), "utf8");
		const entries: Array<{
			id: string;
			parentId: string | null;
			type: string;
			message?: unknown;
			summary?: string;
			firstKeptEntryId?: string;
			tokensBefore?: number;
			timestamp?: string;
		}> = [];

		for (const line of content.split("\n")) {
			if (!line.trim()) continue;
			try {
				const entry = JSON.parse(line);
				if (!entry || typeof entry !== "object" || typeof entry.id !== "string") continue;
				entries.push({
					id: entry.id,
					parentId: typeof entry.parentId === "string" ? entry.parentId : null,
					type: typeof entry.type === "string" ? entry.type : "",
					message: entry.message,
					summary: typeof entry.summary === "string" ? entry.summary : undefined,
					firstKeptEntryId: typeof entry.firstKeptEntryId === "string" ? entry.firstKeptEntryId : undefined,
					tokensBefore: typeof entry.tokensBefore === "number" ? entry.tokensBefore : undefined,
					timestamp: typeof entry.timestamp === "string" ? entry.timestamp : undefined,
				});
			} catch {
				// 单行损坏不应阻断整个 Viewer。
			}
		}
		if (entries.length === 0) return [];

		// JSONL 最后一个 entry 是 pi 当前叶节点；沿 parentId 回溯得到与 get_messages 一致的活动分支。
		const byId = new Map(entries.map((entry) => [entry.id, entry]));
		const activeBranch: typeof entries = [];
		const seen = new Set<string>();
		let current: (typeof entries)[number] | undefined = entries[entries.length - 1];
		while (current && !seen.has(current.id)) {
			seen.add(current.id);
			activeBranch.push(current);
			current = current.parentId ? byId.get(current.parentId) : undefined;
		}
		activeBranch.reverse();

		const lastCompactionIndex = activeBranch.findLastIndex((entry) => entry.type === "compaction");
		const lastCompaction = lastCompactionIndex >= 0 ? activeBranch[lastCompactionIndex] : undefined;
		// 活动分支包含压缩点之前的全部消息（JSONL 保留完整历史）：
		// 压缩前历史直接作为正常对话流的一部分，由渲染层分页（往上翻）逐条可见；
		// 压缩卡片单独 prepend 在最前，翻页补前缀时自然落在归档消息之后（压缩点位置）。
		const currentEntries = activeBranch
			.filter((entry) => entry.type === "message" && entry.message);
		const rawMessages = currentEntries.map((entry) => entry.message);
		// Offline Session viewers must expose the complete active branch. The runtime
		// prompt-history cap belongs to Agent startup, while renderer pagination owns
		// how much of a historical Session is rendered at one time.
		const activeEntryIds = currentEntries.map((entry) => entry.id);

		let finalRaw: unknown[] = rawMessages;
		if (lastCompaction) {
			const compactionEntry = lastCompaction;
			// 压缩卡片只带元信息（摘要/次数/tokens）；归档消息全文由分页翻出，不注入内存
			const archiveData = await this.scanCompactions(sessionPath, content);
			const card = {
				role: "compactionSummary",
				summary: compactionEntry.summary || this.deps.translate("session.summaryPlaceholder"),
				timestamp: compactionEntry.timestamp ? Date.parse(compactionEntry.timestamp) : Date.now(),
				meta: {
					compactionId: compactionEntry.id,
					compactionCount: archiveData.compactions.length,
					firstKeptEntryId: compactionEntry.firstKeptEntryId,
					tokensBefore: compactionEntry.tokensBefore,
				},
			};
			// 卡片插在压缩点：firstKeptEntryId（保留起点）之前，即归档消息之后、保留消息之前；
			// 找不到锚点则插到压缩条目之后（activeBranch 中紧随其后的消息）。
			const firstKeptPos = compactionEntry.firstKeptEntryId
				? currentEntries.findIndex((entry) => entry.id === compactionEntry.firstKeptEntryId)
				: -1;
			const insertAt = firstKeptPos >= 0
				? firstKeptPos
				: lastCompactionIndex >= 0 && lastCompactionIndex < activeBranch.length
					? activeBranch.slice(0, lastCompactionIndex + 1).filter((entry) => entry.type === "message" && entry.message).length
					: rawMessages.length;
			finalRaw = [...rawMessages.slice(0, insertAt), card, ...rawMessages.slice(insertAt)];
		}

		return this.deps.convertMessages(agentId, finalRaw, activeEntryIds);
	}

	async readSessionDisplayMessagePage(
		sessionPath: string,
		agentId = "_viewer",
		before?: number,
		pageSize = SessionHistoryReader.MAX_SESSION_DISPLAY_PAGE_SIZE,
	): Promise<SessionMessagePage> {
		const index = await this.getSessionDisplayIndex(sessionPath);
		const total = index.activeMessageEntries.length;
		const boundedBefore = Number.isSafeInteger(before)
			? Math.min(Math.max(0, before!), total)
			: total;
		const requestedPageSize = Number.isFinite(pageSize)
			? Math.floor(pageSize)
			: SessionHistoryReader.MAX_SESSION_DISPLAY_PAGE_SIZE;
		const limit = Math.min(
			Math.max(1, requestedPageSize),
			SessionHistoryReader.MAX_SESSION_DISPLAY_PAGE_SIZE,
		);
		let start = boundedBefore;
		let selectedBytes = 0;
		let selectedCount = 0;
		while (start > 0 && selectedCount < limit) {
			const candidate = index.activeMessageEntries[start - 1];
			if (
				selectedCount > 0 &&
				selectedBytes + candidate.byteLength > SessionHistoryReader.MAX_SESSION_DISPLAY_PAGE_BYTES
			) {
				break;
			}
			selectedBytes += candidate.byteLength;
			selectedCount += 1;
			start -= 1;
		}

		// Compaction cards contain archived child messages. Preserve their existing
		// semantics until archive data gets its own cursor protocol; normal Sessions,
		// including the 50 MiB fixture, use the bounded offset reader below.
		if (index.hasCompaction) {
			// 分页必须与 normal 分支同空间：按索引 activeMessageEntries 切片后读取原始消息再转换。
			// 旧实现用 readSessionDisplayMessages 的全量数组按索引坐标 slice——转换会跳过空消息
			// （thinking-only/空 user），数组比索引短，slice 越界返回空页（打开大会话起始页误显根因）。
			const entries = index.activeMessageEntries.slice(start, boundedBefore);
			const rawMessages = await this.readIndexedSessionMessages(index.hostPath, entries);
			const messages = await this.convertCompactionPageMessages(
				index, agentId, rawMessages, entries.map((entry) => entry.id), start,
			);
			return {
				messages,
				total,
				nextBefore: start > 0 ? start : null,
			};
		}
		const entries = index.activeMessageEntries.slice(start, boundedBefore);
		const rawMessages = await this.readIndexedSessionMessages(index.hostPath, entries);
		return {
			messages: this.deps.convertMessages(agentId, rawMessages, entries.map((entry) => entry.id)),
			total,
			nextBefore: start > 0 ? start : null,
		};
	}

	/**
	 * 轮次维度的显示分页（2026-08 激活分页）：与 readSessionDisplayMessagePage 同一游标协议
	 * （before/nextBefore 都是绝对消息下标，与运行时 messages 数组同一下标空间），
	 * 但页边界对齐完整轮次——渲染层「加载更多对话」不会切到半个回答。
	 */
	async readSessionDisplayTurnPage(
		sessionPath: string,
		agentId = "_viewer",
		before?: number,
		turnCount = SessionHistoryReader.DEFAULT_TURN_PAGE_SIZE,
		beforeEntryId?: string,
	): Promise<SessionMessagePage> {
		const index = await this.getSessionDisplayIndex(sessionPath);
		const total = index.activeMessageEntries.length;
		// beforeEntryId：渲染层以「运行时窗口首条消息的 entryId」作为首次补历史的游标，
		// 解析为该 entry 在活跃分支的绝对下标（运行时窗口与 JSONL 是两个下标空间，
		// entryId 是唯一的对齐锚点）。解析失败回退为 undefined（= 从尾部起页）。
		let resolvedBefore = before;
		if (beforeEntryId) {
			const position = index.activeMessageEntries.findIndex((entry) => entry.id === beforeEntryId);
			if (position >= 0) resolvedBefore = position;
		}
		const boundedBefore = Number.isSafeInteger(resolvedBefore)
			? Math.min(Math.max(0, resolvedBefore!), total)
			: total;
		const boundedTurnCount = Number.isFinite(turnCount)
			? Math.min(Math.max(1, Math.floor(turnCount)), SessionHistoryReader.MAX_TURN_PAGE_SIZE)
			: SessionHistoryReader.DEFAULT_TURN_PAGE_SIZE;
		const start = findTurnPageStart(
			index.activeMessageEntries,
			boundedBefore,
			boundedTurnCount,
			SessionHistoryReader.MAX_SESSION_DISPLAY_PAGE_BYTES,
		);

		// 与消息分页一致：压缩会话的归档语义未游标化前走全量读取 + 切片
		if (index.hasCompaction) {
			// 同空间分页（见 readSessionDisplayMessagePage 注释）：索引切片 + 转换 + 页内卡片
			const entries = index.activeMessageEntries.slice(start, boundedBefore);
			const rawMessages = await this.readIndexedSessionMessages(index.hostPath, entries);
			const messages = await this.convertCompactionPageMessages(
				index, agentId, rawMessages, entries.map((entry) => entry.id), start,
			);
			return {
				messages,
				total,
				nextBefore: start > 0 ? start : null,
				nextBeforeEntryId: start > 0 ? index.activeMessageEntries[start]?.id : undefined,
				indexVersion: `${index.mtimeMs}:${index.size}`,
			};
		}

		const entries = index.activeMessageEntries.slice(start, boundedBefore);
		const rawMessages = await this.readIndexedSessionMessages(index.hostPath, entries);
		return {
			messages: this.deps.convertMessages(agentId, rawMessages, entries.map((entry) => entry.id)),
			total,
			nextBefore: start > 0 ? start : null,
			nextBeforeEntryId: start > 0 ? index.activeMessageEntries[start]?.id : undefined,
			indexVersion: `${index.mtimeMs}:${index.size}`,
		};
	}

	/** entryId → 活动分支消息条目的绝对下标（文件下标空间）；不存在返回 undefined。 */
	async resolveEntryPosition(sessionPath: string, entryId: string): Promise<number | undefined> {
		if (!entryId) return undefined;
		const index = await this.getSessionDisplayIndex(sessionPath);
		const position = index.activeMessageEntries.findIndex((entry) => entry.id === entryId);
		return position >= 0 ? position : undefined;
	}

	/** 绝对下标（文件下标空间）→ entryId；越界/无条目返回 undefined。 */
	async resolveEntryIdAtPosition(sessionPath: string, position: number): Promise<string | undefined> {
		const index = await this.getSessionDisplayIndex(sessionPath);
		const entry = index.activeMessageEntries[position];
		return entry?.id;
	}

	/** 活动分支消息条目总数（SessionMessagePage.total 的文件口径）。 */
	async getActiveEntryCount(sessionPath: string): Promise<number> {
		const index = await this.getSessionDisplayIndex(sessionPath);
		return index.activeMessageEntries.length;
	}

	/**
	 * 压缩会话分页的消息转换：与 normal 分支同空间（页条目 → 原始消息 → 转换）。
	 * 页内包含压缩插入点时补一张压缩卡片（与 readSessionDisplayMessages 同语义：
	 * 卡片落在 firstKeptEntryId 之前，即归档消息之后、保留消息之前；卡片在页外不插）。
	 * 卡片 id 对齐 projector 的 `${agentId}-meta-N` 输出，保证与运行时窗口卡片去重一致。
	 */
	private async convertCompactionPageMessages(
		index: SessionDisplayIndex,
		agentId: string,
		rawMessages: unknown[],
		entryIds: string[],
		start: number,
	): Promise<ChatMessage[]> {
		const messages = this.deps.convertMessages(agentId, rawMessages, entryIds);
		const compactions = index.activeBranch.filter((entry) => entry.type === "compaction");
		const lastCompaction = compactions[compactions.length - 1];
		if (!lastCompaction) return messages;
		// insertAt（全量 activeMessageEntries 下标空间）：firstKeptEntryId 优先，
		// 缺省回退「压缩条目之后的消息数」（与 readSessionDisplayMessages 一致）。
		let insertAt = lastCompaction.firstKeptEntryId
			? index.activeMessageEntries.findIndex((entry) => entry.id === lastCompaction.firstKeptEntryId)
			: -1;
		if (insertAt < 0) {
			const compIdx = index.activeBranch.findIndex((entry) => entry.id === lastCompaction.id);
			insertAt = compIdx >= 0
				? index.activeBranch.slice(0, compIdx + 1).filter((entry) => entry.type === "message" && entry.hasMessage).length
				: index.activeMessageEntries.length;
		}
		const rel = insertAt - start;
		if (rel < 0 || rel > messages.length) return messages; // 卡片在本页之外
		const card: ChatMessage = {
			id: `${agentId}-meta-1`,
			agentId,
			role: "system",
			text: lastCompaction.summary || this.deps.translate("session.summaryPlaceholder"),
			timestamp: lastCompaction.timestamp ? Date.parse(lastCompaction.timestamp) : Date.now(),
			meta: {
				type: "compaction",
				tokensBefore: lastCompaction.tokensBefore,
				...(compactions.length > 0 ? { compactionCount: compactions.length } : {}),
			},
		};
		return [...messages.slice(0, rel), card, ...messages.slice(rel)];
	}

	/** 会话文件版本（mtime:size），与分页页面 indexVersion 同口径；供缓存命中页透传。 */
	async getSessionIndexVersion(sessionPath: string): Promise<string> {
		const index = await this.getSessionDisplayIndex(sessionPath);
		return `${index.mtimeMs}:${index.size}`;
	}

	/**
	 * 读取会话当前活动分支的 entryId 序列与叶节点 ID（JSONL canonical identity）。
	 * 当 RPC get_entries 不支持或不可用时，供 AgentManager 回退获取。
	 */
	async readActiveEntryIdentity(
		sessionPath: string,
	): Promise<{
		entryIds: string[];
		leafId?: string;
		activeMessageEntries: Array<{ id: string; role?: string; messageId?: string }>;
	}> {
		const index = await this.getSessionDisplayIndex(sessionPath);
		return {
			entryIds: index.activeMessageEntries.map((entry) => entry.id),
			leafId: index.activeBranch.length > 0
				? index.activeBranch[index.activeBranch.length - 1].id
				: undefined,
			activeMessageEntries: index.activeMessageEntries.map((entry) => ({
				id: entry.id,
				role: entry.role,
				messageId: entry.messageId,
			})),
		};
	}

	/**
	 * 按 messageId 在活动分支定位消息条目并读出其正文（编辑/删除/重发缓存未命中时的文件定位）。
	 * 返回 entryId（SessionFileEditor 精确定位锚点）+ 正文文本/图片（重发回填用）。
	 */
	async readMessageByMessageId(
		sessionPath: string,
		messageId: string,
	): Promise<{ entryId: string; role?: string; text: string; images?: ImageContent[] } | undefined> {
		if (!messageId) return undefined;
		const index = await this.getSessionDisplayIndex(sessionPath);
		// 兼容三种命中：JSONL 原生 message.id、渲染层合成 ID（agentId-history-entryId）、
		// 裸 entryId（旧会话无 message.id 时渲染 ID 即 `${agentId}-history-${entryId}`）。
		const syntheticId = syntheticHistoryEntryId(messageId);
		const entry = index.activeMessageEntries.find(
			(candidate) =>
				candidate.messageId === messageId ||
				candidate.id === messageId ||
				(syntheticId !== undefined && candidate.id === syntheticId),
		);
		if (!entry) return undefined;
		const raw = await this.readIndexedSessionMessages(index.hostPath, [entry]);
		const content = (raw[0] as { content?: unknown } | undefined)?.content;
		const extracted = extractResendContent(content);
		return {
			entryId: entry.id,
			role: entry.role,
			text: extracted.text,
			...(extracted.images?.length ? { images: extracted.images } : {}),
		};
	}

	private async getSessionDisplayIndex(sessionPath: string): Promise<SessionDisplayIndex> {
		const hostPath = this.deps.toHostPath(sessionPath);
		const version = await stat(hostPath);
		const cached = this.sessionDisplayIndexes.get(hostPath);
		if (cached && cached.size === version.size && cached.mtimeMs === version.mtimeMs) {
			this.sessionDisplayIndexes.delete(hostPath);
			this.sessionDisplayIndexes.set(hostPath, cached);
			return cached;
		}

		// 增量路径：文件变大且旧索引以完整行结尾 → 只读尾部新增字节并追加条目。
		// pi 运行中持续往 JSONL 追加行，运行中翻历史/看分页会反复触发索引失效；
		// 全量重建需要整文件 readFile + 逐行 parse，大会话（几十 MB）会造成可感知卡顿。
		// 前置条件 endsWithNewline：旧最后一行以 \n 结尾，追加内容与旧内容边界干净。
		if (cached && version.size > cached.size && cached.endsWithNewline) {
			const updated = await this.appendIndexFromTail(cached, hostPath, version);
			if (updated) {
				this.sessionDisplayIndexes.delete(hostPath);
				this.sessionDisplayIndexes.set(hostPath, updated);
				this.trimDisplayIndexCache();
				return updated;
			}
			// 增量失败（IO 异常/无新增完整行）：回退全量重建
		}

		const content = await readFile(hostPath, "utf8");
		const entries = new Map<string, SessionDisplayEntry>();
		let lastEntryId: string | undefined;
		let byteOffset = 0;
		// 文件是否以完整行（\n）结尾：决定后续 append 能否走增量索引
		const endsWithNewline = content.endsWith("\n");
		const lines = content.split("\n");
		for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
			const sourceLine = lines[lineIndex];
			const hasNewline = lineIndex < lines.length - 1;
			const byteLength = Buffer.byteLength(sourceLine, "utf8");
			const parsed = this.parseIndexLine(sourceLine, byteOffset, byteLength);
			if (parsed) {
				entries.set(parsed.id, parsed);
				lastEntryId = parsed.id;
			}
			byteOffset += byteLength + (hasNewline ? 1 : 0);
		}
		const activeBranch = this.traceActiveBranch(entries, lastEntryId);
		const index = this.finishIndex(hostPath, version, entries, activeBranch, endsWithNewline);
		this.sessionDisplayIndexes.delete(hostPath);
		this.sessionDisplayIndexes.set(hostPath, index);
		this.trimDisplayIndexCache();
		return index;
	}

	/** 解析单行 JSONL 为索引条目；损坏行返回 null（不影响其他行）。 */
	private parseIndexLine(
		sourceLine: string,
		offset: number,
		byteLength: number,
	): SessionDisplayEntry | null {
		const jsonLine = sourceLine.endsWith("\r") ? sourceLine.slice(0, -1) : sourceLine;
		try {
			const entry = JSON.parse(jsonLine) as Record<string, unknown>;
			if (typeof entry.id !== "string") return null;
			const message = entry.message as Record<string, unknown> | null | undefined;
			return {
				id: entry.id,
				parentId: typeof entry.parentId === "string" ? entry.parentId : null,
				type: typeof entry.type === "string" ? entry.type : "",
				offset,
				byteLength,
				hasMessage: entry.message !== undefined && entry.message !== null,
				role: typeof message?.role === "string" ? message.role : undefined,
				messageId: typeof message?.id === "string" ? message.id : undefined,
				summary: typeof entry.summary === "string" ? entry.summary : undefined,
				firstKeptEntryId: typeof entry.firstKeptEntryId === "string"
					? entry.firstKeptEntryId
					: undefined,
				timestamp: typeof entry.timestamp === "string" ? entry.timestamp : undefined,
				tokensBefore: typeof entry.tokensBefore === "number" ? entry.tokensBefore : undefined,
			};
		} catch {
			return null;
		}
	}

	/** 从最后 entry 沿 parentId 回溯活动分支（与 JSONL 语义一致：leaf 沿父链到 root）。 */
	private traceActiveBranch(
		entries: Map<string, SessionDisplayEntry>,
		lastEntryId: string | undefined,
	): SessionDisplayEntry[] {
		const activeBranch: SessionDisplayEntry[] = [];
		const seen = new Set<string>();
		let current = lastEntryId ? entries.get(lastEntryId) : undefined;
		while (current && !seen.has(current.id)) {
			seen.add(current.id);
			activeBranch.push(current);
			current = current.parentId ? entries.get(current.parentId) : undefined;
		}
		activeBranch.reverse();
		return activeBranch;
	}

	/** 由分支 + 全量条目表组装最终索引（消息条目派生 + 压缩标记）。 */
	private finishIndex(
		hostPath: string,
		version: { size: number; mtimeMs: number },
		entries: Map<string, SessionDisplayEntry>,
		activeBranch: SessionDisplayEntry[],
		endsWithNewline: boolean,
	): SessionDisplayIndex {
		return {
			hostPath,
			size: version.size,
			mtimeMs: version.mtimeMs,
			// 分页索引包含压缩点之前的全部消息（JSONL 保留完整历史）：
			// 压缩前历史由翻页像正常对话流一样逐条可见（用户需求），不再从 firstKeptEntryId 截断。
			hasCompaction: activeBranch.some((entry) => entry.type === "compaction"),
			entries,
			activeBranch,
			activeMessageEntries: activeBranch.filter((entry) => entry.type === "message" && entry.hasMessage),
			endsWithNewline,
		};
	}

	/**
	 * 增量索引：只读 [oldSize, newSize) 的新增字节，解析完整行后追加到既有索引。
	 * 新条目沿 parentId 回溯至旧分支节点（支持 fork/rewind 场景），旧分支保留。
	 * 返回 null 表示无可追加内容或 IO 失败（调用方回退全量重建）。
	 */
	private async appendIndexFromTail(
		cached: SessionDisplayIndex,
		hostPath: string,
		version: { size: number; mtimeMs: number },
	): Promise<SessionDisplayIndex | null> {
		const length = version.size - cached.size;
		if (length <= 0) return null;
		let tail: Buffer;
		try {
			const handle = await open(hostPath, "r");
			try {
				// 前置校验：SessionFileEditor.atomicReplace 会整文件重写（temp + rename），
				// 若重写使文件变大，仅凭 size 增长会被误判为 append，从旧 offset 读新内容会
				// 解析出半行 JSON（曾复现 SyntaxError: Unexpected token）。
				// 抽查旧索引首/末条目的 offset/byteLength 是否仍能解析出相同 id：
				// 纯 append 保证 [0, oldSize) 字节不变 → 校验通过；整文件重写必然破坏末条目（或首条目）
				// 的旧 offset 内容 → 返回 null，调用方回退全量重建。
				const entriesInOrder = [...cached.entries.values()];
				const probes = [entriesInOrder[0], entriesInOrder[entriesInOrder.length - 1]];
				for (const probe of probes) {
					if (!probe) continue;
					const probeBuffer = Buffer.allocUnsafe(probe.byteLength);
					const probeRead = await handle.read(probeBuffer, 0, probe.byteLength, probe.offset);
					if (probeRead.bytesRead !== probe.byteLength) return null;
					try {
						const parsed = JSON.parse(
							probeBuffer.toString("utf8").replace(/\r$/, ""),
						) as { id?: unknown };
						if (parsed.id !== probe.id) return null;
					} catch {
						return null;
					}
				}
				tail = Buffer.allocUnsafe(length);
				const { bytesRead } = await handle.read(tail, 0, length, cached.size);
				if (bytesRead !== length) return null;
			} finally {
				await handle.close();
			}
		} catch {
			return null;
		}
		const tailText = tail.toString("utf8");
		// 只解析完整行（以 \n 结尾）；尾部残行（pi 正在写）留给下一次 append/重建
		const completeLines = tailText.split("\n").slice(0, -1);
		const entries = new Map(cached.entries);
		const newEntries: SessionDisplayEntry[] = [];
		let byteOffset = cached.size;
		for (const sourceLine of completeLines) {
			const byteLength = Buffer.byteLength(sourceLine, "utf8");
			const parsed = this.parseIndexLine(sourceLine, byteOffset, byteLength);
			if (parsed) {
				entries.set(parsed.id, parsed);
				newEntries.push(parsed);
			}
			byteOffset += byteLength + 1; // 完整行必然带 \n
		}
		// 无新增完整行（文件还在写）：保持旧索引，下次 mtime 变化再试
		if (newEntries.length === 0) return null;

		// 从最后一个新条目沿 parentId 回溯到旧分支内的锚点；新链挂到锚点之后。
		const branchSet = new Set(cached.activeBranch.map((entry) => entry.id));
		const chain: SessionDisplayEntry[] = [];
		let current: SessionDisplayEntry | undefined = newEntries[newEntries.length - 1];
		while (current && !branchSet.has(current.id) && !chain.some((entry) => entry.id === current?.id)) {
			chain.push(current);
			current = current.parentId ? entries.get(current.parentId) : undefined;
		}
		chain.reverse();
		const pivotIndex = current
			? cached.activeBranch.findIndex((entry) => entry.id === current.id)
			: -1;
		const baseBranch = pivotIndex >= 0
			? cached.activeBranch.slice(0, pivotIndex + 1)
			: cached.activeBranch;
		const nextBranch = [...baseBranch, ...chain];
		return this.finishIndex(hostPath, version, entries, nextBranch, tailText.endsWith("\n"));
	}

	/** 索引 LRU 上限裁剪：超出上限丢最旧（Map 迭代序 = 插入序）。 */
	private trimDisplayIndexCache() {
		while (this.sessionDisplayIndexes.size > SessionHistoryReader.SESSION_DISPLAY_INDEX_LIMIT) {
			this.sessionDisplayIndexes.delete(this.sessionDisplayIndexes.keys().next().value!);
		}
	}

	private async readIndexedSessionMessages(
		hostPath: string,
		entries: SessionDisplayEntry[],
	): Promise<unknown[]> {
		const handle = await open(hostPath, "r");
		try {
			return await Promise.all(entries.map(async (entry) => {
				const buffer = Buffer.allocUnsafe(entry.byteLength);
				await handle.read(buffer, 0, buffer.length, entry.offset);
				const line = buffer.toString("utf8").replace(/\r$/, "");
				return (JSON.parse(line) as { message?: unknown }).message;
			}));
		} finally {
			await handle.close();
		}
	}


	/**
	 * 直接从历史会话 JSONL 文件读取最近 N 轮对话的消息条目。
	 * 用于大会话场景：绕过 get_messages RPC 的整文件 JSON 传输瓶颈，
	 * 直接在桌面进程解析 JSONL 并只取尾部消息，避免大会话加载导致界面冻结。
	 * 返回兼容 RpcResponse 格式的对象，可复用 loadMessages 的消息处理管线。
	 */
	async readRecentMessages(
		sessionPath: string,
		maxTurns: number,
	): Promise<RpcResponse> {
		const t0 = Date.now();
		let content: string;
		try {
			content = await readFile(this.deps.toHostPath(sessionPath), "utf8");
		} catch (error) {
			void this.deps.logger?.warn("agent", "Failed to read session file for recent messages", {
				sessionPath,
				error: error instanceof Error ? error.message : String(error),
			});
			throw error;
		}

		const lines = content.split("\n");
		const messageEntries: unknown[] = [];

		for (const line of lines) {
			if (!line.trim()) continue;
			try {
				const entry = JSON.parse(line);
				if (entry.type === "message" && entry.message) {
					messageEntries.push(entry.message);
				}
			} catch {
				// 跳过单行解析失败，不影响后续行
			}
		}

		// 只保留最近 maxTurns 轮对话
		const trimmed = this.deps.trimMessages(messageEntries, maxTurns);
		const t1 = Date.now();

		void this.deps.logger?.info("agent", "Recent messages read from session file", {
			sessionPath,
			totalLines: lines.length,
			messageEntries: messageEntries.length,
			trimmedTurns: maxTurns,
			trimmedMessages: trimmed.length,
			readMs: t1 - t0,
		});

		return {
			type: "response" as const,
			command: "get_messages",
			success: true,
			data: { messages: trimmed },
		};
	}

	/**
	 * 轻量扫描会话文件中的压缩（compaction）记录。
	 * 只返回压缩条目元信息（摘要/时间/保留起点/tokens），不收集归档消息全文——
	 * 压缩前的归档消息由分页按正常对话流逐条翻出（JSONL 保留完整历史），
	 * 卡片展开展示的是压缩摘要本身（产品意图：看摘要，不看归档）。
	 * 用途：1) 时间线补回"压缩摘要"卡片（与 pi 行为一致）；2) 统计压缩次数供"已压缩 N 次"展示。
	 */
	async scanCompactions(
		sessionPath: string,
		sessionContent?: string,
	): Promise<{
		compactions: Array<{ id: string; summary: string; timestamp: string; firstKeptEntryId?: string; tokensBefore?: number }>;
	}> {
		let content: string;
		try {
			content = sessionContent ?? await readFile(this.deps.toHostPath(sessionPath), "utf8");
		} catch (error) {
			void this.deps.logger?.warn("agent", "Failed to read session file for archive parsing", {
				sessionPath,
				error: error instanceof Error ? error.message : String(error),
			});
			return { compactions: [] };
		}

		// 单次遍历只收集 compaction 条目（消息全文不解析、不保留）
		const compactions: Array<{ id: string; summary: string; timestamp: string; firstKeptEntryId?: string; tokensBefore?: number }> = [];
		for (const line of content.split("\n")) {
			if (!line.trim()) continue;
			try {
				const entry = JSON.parse(line);
				if (!entry || typeof entry !== "object" || entry.type !== "compaction") continue;
				compactions.push({
					id: typeof entry.id === "string" ? entry.id : "",
					summary: typeof entry.summary === "string" ? entry.summary : "",
					timestamp: typeof entry.timestamp === "string" ? entry.timestamp : "",
					firstKeptEntryId: typeof entry.firstKeptEntryId === "string" ? entry.firstKeptEntryId : undefined,
					tokensBefore: typeof entry.tokensBefore === "number" ? entry.tokensBefore : undefined,
				});
			} catch {
				// 跳过单行解析失败
			}
		}
		return { compactions };
	}

}

/**
 * 从 JSONL message entry 提取展示文本（「查看完整输出」用）。
 * 与 AgentMessageProjector.extractToolResultText 同格式约定（content 数组的 text 拼接），
 * 额外兼容 content 为字符串的旧格式；改动时两边保持同步。
 */
function extractEntryResultText(message: unknown): string {
	if (!message || typeof message !== "object") return "";
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((item) => (typeof item?.text === "string" ? item.text : ""))
			.filter(Boolean)
			.join("\n");
	}
	return "";
}
