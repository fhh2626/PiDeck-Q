import { readFile, stat } from "node:fs/promises";
import { SessionDisplayIndexStore, type SessionDisplayIndex, type SessionDisplayEntry } from "./SessionDisplayIndexStore";
import { buildActiveBranchEntryIds } from "./sessionEntryIds";
import type { ChatMessage, ImageContent, SessionMessagePage } from "../../shared/types";
import type { MainProcessTranslationKey } from "../../shared/i18n/mainProcessCopy";
import type { RpcResponse } from "./PiRpcClient";
import type { AppLogger } from "../logging/AppLogger";
import { extractImageContent } from "../../shared/imageContent";

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
 * 支持平铺格式 { type: "image", data, mimeType } 与旧嵌套格式 { type: "image", source: { type: "base64", media_type, data } }。
 */
export function extractResendContent(content: unknown): { text: string; images?: ImageContent[] } {
	if (typeof content === "string") return { text: content };
	if (Array.isArray(content)) {
		const textParts: string[] = [];
		for (const block of content) {
			if (!block || typeof block !== "object") continue;
			const typed = block as Record<string, unknown>;
			if (typed.type === "text" && typeof typed.text === "string") {
				textParts.push(typed.text);
			}
		}
		const { images } = extractImageContent(content);
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
	private readonly indexStore = new SessionDisplayIndexStore(32);
	private static readonly MAX_SESSION_DISPLAY_PAGE_SIZE = 100;
	private static readonly MAX_SESSION_DISPLAY_PAGE_BYTES = 256 * 1024;
	/** Full text is reusable only for the same host file version and exact entry anchor. */
	private readonly fullTextCache = new Map<string, { text: string; version: string }>();
	private static readonly FULL_TEXT_CACHE_LIMIT = 200;
	/** 轮次分页默认/上限：默认最近一次激活带 3 轮，单页最多 50 轮（2026-12 10→50：
	 *  初始尾页按「最近 50 轮」窗口读取；上限仍存在，防恶意参数撑爆 IPC） */
	static readonly DEFAULT_TURN_PAGE_SIZE = 3;
	private static readonly MAX_TURN_PAGE_SIZE = 50;

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
		const hostPath = this.deps.toHostPath(sessionPath);
		const fileStat = await stat(hostPath);
		const version = `${fileStat.dev}:${fileStat.ino}:${fileStat.size}:${fileStat.mtimeMs}:${fileStat.ctimeMs}`;
		const cacheKey = JSON.stringify([hostPath, messageId, entryId ?? null]);
		const cached = this.fullTextCache.get(cacheKey);
		if (cached?.version === version) {
			// LRU 刷新：先删后插，保持 Map 迭代序 = 最近使用序
			this.fullTextCache.delete(cacheKey);
			this.fullTextCache.set(cacheKey, cached);
			return { text: cached.text };
		}
		this.fullTextCache.delete(cacheKey);
		const index = await this.getSessionDisplayIndex(sessionPath);
		// Preserve physical-first lookup, including abandoned branches and legacy no-id messages.
		const entry = entryId ? index.firstEntries.get(entryId) : index.firstMessages.get(messageId);
		if (!entry) throw new Error(`Message ${messageId} not found in session file`);
		const raw = await this.readIndexedSessionMessages(index, [entry]);
		const text = extractEntryResultText(raw[0]);
		if (!text) throw new Error(`Message ${messageId} has no extractable text content`);
		if (this.fullTextCache.size >= SessionHistoryReader.FULL_TEXT_CACHE_LIMIT) {
			const oldest = this.fullTextCache.keys().next().value;
			if (oldest !== undefined) this.fullTextCache.delete(oldest);
		}
		const sourceVersion = `${index.dev}:${index.ino}:${index.size}:${index.mtimeMs}:${index.ctimeMs}`;
		this.fullTextCache.set(cacheKey, { text, version: sourceVersion });
		return { text };
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

		// Compacted sessions use the same indexed message space, with the summary card
		// inserted only when this page crosses its retained-entry boundary.
		if (index.hasCompaction) {
			// 分页必须与 normal 分支同空间：按索引 activeMessageEntries 切片后读取原始消息再转换。
			// 旧实现用 readSessionDisplayMessages 的全量数组按索引坐标 slice——转换会跳过空消息
			// （thinking-only/空 user），数组比索引短，slice 越界返回空页（打开大会话起始页误显根因）。
			const entries = index.activeMessageEntries.slice(start, boundedBefore);
			const rawMessages = await this.readIndexedSessionMessages(index, entries);
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
		const rawMessages = await this.readIndexedSessionMessages(index, entries);
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

		// 与消息分页一致：只读取本页条目，并在压缩插入点落入页内时补摘要卡片。
		if (index.hasCompaction) {
			// 同空间分页（见 readSessionDisplayMessagePage 注释）：索引切片 + 转换 + 页内卡片
			const entries = index.activeMessageEntries.slice(start, boundedBefore);
			const rawMessages = await this.readIndexedSessionMessages(index, entries);
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
		const rawMessages = await this.readIndexedSessionMessages(index, entries);
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
	 *
	 * entryIds 与 pi 的 get_messages 对齐（压缩后从最新压缩的 firstKeptEntryId 起），
	 * 供运行时投影按位置配对；activeMessageEntries 仍是全量活动消息——分页与
	 * 按尾对齐的序列映射（mapCachedMessageToEntryCandidates）依赖完整列表。
	 */
	async readActiveEntryIdentity(
		sessionPath: string,
	): Promise<{
		entryIds: string[];
		leafId?: string;
		activeMessageEntries: Array<{ id: string; role?: string; messageId?: string }>;
	}> {
		const index = await this.getSessionDisplayIndex(sessionPath);
		const leafId = index.activeBranch.length > 0
			? index.activeBranch[index.activeBranch.length - 1].id
			: undefined;
		return {
			// 必须传 activeBranch（含 compaction 与 firstKeptEntryId）：若传 activeMessageEntries，
			// 函数看不到压缩点，会以为「没有压缩」而退回全量分支，压缩会话的 entryId 会再次错位。
			entryIds: leafId ? buildActiveBranchEntryIds(index.activeBranch, leafId) : [],
			leafId,
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
		const raw = await this.readIndexedSessionMessages(index, [entry]);
		const content = (raw[0] as { content?: unknown } | undefined)?.content;
		const extracted = extractResendContent(content);
		return {
			entryId: entry.id,
			role: entry.role,
			text: extracted.text,
			...(extracted.images?.length ? { images: extracted.images } : {}),
		};
	}

	/** File/index ownership is isolated from projection and runtime history semantics. */
	private getSessionDisplayIndex(sessionPath: string): Promise<SessionDisplayIndex> {
		return this.indexStore.get(this.deps.toHostPath(sessionPath)).catch((error: unknown) => this.translateSnapshotFailure(error));
	}

	private readIndexedSessionMessages(index: SessionDisplayIndex, entries: SessionDisplayEntry[]): Promise<unknown[]> {
		return this.indexStore.readMessages(index, entries).catch((error: unknown) => this.translateSnapshotFailure(error));
	}

	/** Keep the internal retry marker machine-readable while presenting a localized failure. */
	private translateSnapshotFailure(error: unknown): never {
		if (error !== null && typeof error === "object" && "message" in error && error.message === "SESSION_HISTORY_CHANGED") {
			throw Object.assign(new Error(this.deps.translate("session.historyChanged"), { cause: error }), { code: "SESSION_HISTORY_CHANGED" });
		}
		throw error;
	}

	/**
	 * 直接从历史会话 JSONL 文件读取最近 N 轮对话的消息条目。
	 * 用于大会话场景：绕过 get_messages RPC 的整文件 JSON 传输瓶颈，
	 * 直接在桌面进程解析 JSONL 并只取尾部消息，避免大会话加载导致界面冻结。
	 *
	 * 取的是「当前 leaf 的活动父链」尾部而不是文件物理尾部：fork/rewind 后废弃分支
	 * 仍留在文件里，按物理顺序截取会把这些分支混进最新历史。
	 * 活动链构建失败时保持失败返回（抛错交给调用方提示重试），不静默退回物理顺序。
	 * 返回兼容 RpcResponse 格式的对象，可复用 loadMessages 的消息处理管线。
	 */
	async readRecentMessages(
		sessionPath: string,
		maxTurns: number,
	): Promise<RpcResponse> {
		const t0 = Date.now();
		const index = await this.getSessionDisplayIndex(sessionPath);
		if (index.entries.size === 0) throw new Error("Session file contains no readable entries");
		const activeEntries = index.activeBranch.filter((entry) => entry.type === "message" && entry.hasTruthyMessage);
		// Apply the existing ordered, role-based trimmer before reading message bodies.
		const wanted = new Set(this.deps.trimMessages(activeEntries, maxTurns));
		const selected = activeEntries.filter((entry) => wanted.has(entry));
		const trimmed = await this.readIndexedSessionMessages(index, selected);
		const totalLines = index.rowCount;
		const t1 = Date.now();

		void this.deps.logger?.info("agent", "Recent messages read from session file", {
			sessionPath,
			totalLines,
			messageEntries: activeEntries.length,
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
			if (sessionContent === undefined) {
				const index = await this.getSessionDisplayIndex(sessionPath);
				return { compactions: index.compactions.map((entry) => ({ ...entry })) };
			}
			content = sessionContent;
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
