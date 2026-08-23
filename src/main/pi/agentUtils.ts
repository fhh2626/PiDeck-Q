/**
 * AgentManager 纯工具函数。
 * Phase 1.3: 从 AgentManager.ts 中提取，无副作用，不依赖实例状态。
 */

import type { AvailableModel, ChatMessage, Project } from "../../shared/types";

/** 校验 get_available_models RPC，避免把协议失败伪装成成功的空列表。 */
export function parseAvailableModelsResponse(response: {
	success: boolean;
	data?: unknown;
	error?: string;
}): AvailableModel[] {
	if (!response.success) {
		throw new Error(response.error?.trim() || "get_available_models failed");
	}
	if (!response.data || typeof response.data !== "object" || Array.isArray(response.data)) return [];
	const models = Reflect.get(response.data, "models");
	if (!Array.isArray(models)) return [];

	return models.flatMap((value): AvailableModel[] => {
		if (!value || typeof value !== "object" || Array.isArray(value)) return [];
		const id = Reflect.get(value, "id");
		const provider = Reflect.get(value, "provider");
		if (typeof id !== "string" || !id || typeof provider !== "string" || !provider) return [];

		const name = Reflect.get(value, "name");
		const contextWindow = Reflect.get(value, "contextWindow");
		const maxTokens = Reflect.get(value, "maxTokens");
		const reasoning = Reflect.get(value, "reasoning");
		const images = Reflect.get(value, "images");
		return [{
			id,
			provider,
			...(typeof name === "string" ? { name } : {}),
			...(typeof contextWindow === "number" && Number.isFinite(contextWindow) ? { contextWindow } : {}),
			...(typeof maxTokens === "number" && Number.isFinite(maxTokens) ? { maxTokens } : {}),
			...(typeof reasoning === "boolean" ? { reasoning } : {}),
			...(typeof images === "boolean" ? { images } : {}),
		}];
	});
}

/** 去除 ANSI 转义码，用于清洗 thinking 中的终端颜色控制序列。 */
export function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}

/** 从参数列表中取首个有效数字。 */
export function pickNumber(...values: unknown[]): number | undefined {
	for (const value of values) {
		if (typeof value === "number" && Number.isFinite(value)) return value;
		if (typeof value === "string" && value.trim()) {
			const parsed = Number(value);
			if (Number.isFinite(parsed)) return parsed;
		}
	}
	return undefined;
}

/** 钳制百分比到 0-100 范围。 */
export function clampPercent(value: number | undefined): number | undefined {
	if (value == null || !Number.isFinite(value)) return undefined;
	return Math.max(0, Math.min(100, value));
}

/**
 * 解析系统通知点击的会话跳转目标。
 * renderer 的 sessionRecordByIdAtomFamily 只按稳定的 SessionRecord.id 索引；
 * pi sessionId 属于另一套身份体系，缺少 record.id 时必须回到应用根页。
 */
export function resolveNotificationSessionId(
	resolveRecordId: (() => string | undefined) | undefined,
): string | undefined {
	return resolveRecordId?.();
}

/**
 * 按对话轮次截断历史消息：找到最后 maxTurns 个 user 提问，
 * 保留对应轮次及之后的全部消息，避免大会话加载时一次性解析过多内容。
 * 返回保留段的起始下标（无 user 消息时与 slice(-50) 语义一致）。
 */
export function turnTrimStartIndex<T>(rawMessages: T[], maxTurns = 12): number {
	if (rawMessages.length === 0) return 0;
	const userIndices: number[] = [];
	for (let i = rawMessages.length - 1; i >= 0; i--) {
		const msg = rawMessages[i] as { role?: unknown } | undefined;
		if (msg?.role === "user") {
			userIndices.unshift(i);
			if (userIndices.length >= maxTurns) break;
		}
	}
	if (userIndices.length === 0) return Math.max(0, rawMessages.length - 50);
	return userIndices[0];
}

export function trimHistoryMessages<T>(rawMessages: T[], maxTurns = 12): T[] {
	if (rawMessages.length === 0) return rawMessages;
	return rawMessages.slice(turnTrimStartIndex(rawMessages, maxTurns));
}

/**
 * 统计 [0, endIndex) 内会消费 entryId 槽位的角色消息数（user/assistant/toolResult）。
 * 与 AgentMessageProjector 的槽位消费规则一致：compactionSummary/branchSummary/非角色条目
 * 不消费槽位。用于 trim 后把 activeEntryIds 与保留消息重新对齐。
 */
export function countRoleMessagesBefore<T>(rawMessages: T[], endIndex: number): number {
	const bound = Math.min(Math.max(0, endIndex), rawMessages.length);
	let count = 0;
	for (let i = 0; i < bound; i++) {
		const role = (rawMessages[i] as { role?: unknown } | undefined)?.role;
		if (role === "user" || role === "assistant" || role === "toolResult") count++;
	}
	return count;
}

/**
 * 取窗口前的系统摘要卡片（compaction/branchSummary），用于 prepend 到显示窗口最前。
 * 压缩卡片插在消息数组最前（index 0），激活分页窗口从尾部数轮次——若窗口起点 > 0，
 * 卡片会被 slice 切出窗口导致用户看不到；这里把窗口前仍存在的系统卡片找回，
 * 保证压缩标记在时间线可见区顶部（"压缩展示在正确的时间位"）。
 */
export function leadingSummaryCards(
	all: ChatMessage[],
	windowStart: number,
): ChatMessage[] {
	if (windowStart <= 0) return [];
	const cards: ChatMessage[] = [];
	const bound = Math.min(windowStart, all.length);
	for (let i = 0; i < bound; i++) {
		const message = all[i];
		if (
			message.role === "system" &&
			(message.meta?.type === "compaction" || message.meta?.type === "branchSummary")
		) {
			cards.push(message);
		}
	}
	return cards;
}

/**
 * 构造 agents:message 事件的 payload（增量 flush 协议，2026-08 渲染卡顿优化）。
 *
 * 背景：流式期间主进程每 50ms flush 一次，此前每次都发送全量消息数组——
 * 几百条消息的结构化克隆每 50ms 在渲染主线程反序列化一次，是流式卡顿主因。
 *
 * 协议：调用方显式标记 dirtyFrom（自上次 flush 以来最早的变化下标）时，
 * 只发送尾部切片 + upsertFrom + totalLength；渲染层按「从 upsertFrom 起替换尾部」合并，
 * 长度不连续则丢弃并等待下一次全量校准（终态 flush 永远全量，见 flushMessageEmit）。
 * dirtyFrom 缺失或越界（编辑/删除/截断/重载等未标记路径）一律回退全量。
 */
export function buildMessageFlushPayload(
	agentId: string,
	all: ChatMessage[],
	dirtyFrom: number | undefined,
	windowStart = 0,
	fileVersion?: string,
	windowStartFilePos?: number,
	preserveHistory = false,
	stickyHistory = false,
): {
	agentId: string;
	messages: ChatMessage[];
	upsertFrom?: number;
	totalLength?: number;
	windowStart?: number;
	fileVersion?: string;
	windowStartFilePos?: number;
	/** 压缩重载时保留 renderer 已加载的历史前缀；编辑/删除等改写默认不保留。 */
	preserveHistory?: boolean;
	/** 压缩刚完成时暂缓回底清理，避免用户刚看到的旧回复立即被收走。 */
	stickyHistory?: boolean;
	/** trim 窗口右移滑出显示区的旧窗口头部轮次（仅全量 flush 携带，渲染层并入历史前缀） */
	slideOut?: ChatMessage[];
} {
	// 激活显示窗口（2026-08 激活分页）：full 快照也只发窗口段 [windowStart..]，
	// 窗口前历史由 disk 轮次分页按需 prepend；totalLength 恒为数组全长，
	// 供渲染层做窗口偏移校验。fileVersion（会话文件 mtime:size）用于检测压缩改写；
	// 普通改写时渲染层会丢弃 disk 前缀，手动/自动压缩则由 preserveHistory 保留已加载内容。
	const boundedWindow = Math.min(Math.max(0, windowStart), all.length);
	if (dirtyFrom !== undefined && dirtyFrom >= boundedWindow && dirtyFrom < all.length) {
		return {
			agentId,
			messages: stripToolResultForDelivery(all.slice(dirtyFrom)),
			upsertFrom: dirtyFrom,
			totalLength: all.length,
			...(boundedWindow > 0 ? { windowStart: boundedWindow } : {}),
			...(fileVersion ? { fileVersion } : {}),
			...(preserveHistory ? { preserveHistory: true } : {}),
			...(stickyHistory ? { stickyHistory: true } : {}),
		};
	}
	// dirtyFrom 缺失或落到窗口之前（重载后窗口右移）：升级为窗口化全量
	// 窗口前若存在系统摘要卡片（压缩/分支），一并 prepend——压缩卡片插在数组最前，
	// 不 prepend 会被窗口 slice 切掉（增量分支不 prepend：卡片不在增量区，渲染层已有）。
	// windowStartFilePos：窗口首条消息在会话文件消息下标空间中的位置，
	// 供渲染层在窗口消息缺 entryId 时作为首次补历史的数值游标（主进程缓存/文件路径都能消费）。
	const summaryCards = leadingSummaryCards(all, boundedWindow);
	return {
		agentId,
		messages: [...summaryCards, ...stripToolResultForDelivery(all.slice(boundedWindow))],
		totalLength: all.length,
		...(boundedWindow > 0 ? { windowStart: boundedWindow } : {}),
		...(fileVersion ? { fileVersion } : {}),
		...(preserveHistory ? { preserveHistory: true } : {}),
		...(stickyHistory ? { stickyHistory: true } : {}),
		...(typeof windowStartFilePos === "number" && windowStartFilePos >= 0
			? { windowStartFilePos }
			: {}),
	};
}

/**
 * 下发瘦身：工具消息的 meta.result 与 meta.detailText 内容重复（detailText 已含截断后的
 * result 段），渲染层从不读取 result（getToolExitCode 期望对象而主进程存的是截断字符串，
 * 已确认是死代码）。剥离 result 只影响下发载荷——主进程内存仍保留（tool_execution_update
 * 无 result 时回退 existing.meta.result）。渲染层需要完整输出时走 sessionsCatalogReadMessageFullText。
 */
export function stripToolResultForDelivery(messages: ChatMessage[]): ChatMessage[] {
	let stripped = false;
	const out = messages.map((message) => {
		if (message.role !== "tool" || !message.meta || typeof message.meta.result === "undefined") {
			return message;
		}
		stripped = true;
		const meta = { ...message.meta };
		delete meta.result;
		return { ...message, meta };
	});
	return stripped ? out : messages;
}

/** 清洗会话标题文本。 */
export function cleanTitle(value?: string): string | undefined {
	const text = value?.replace(/\s+/g, " ").trim();
	if (!text || /^untitled$/i.test(text)) return undefined;
	return text.length > 32 ? `${text.slice(0, 32)}…` : text;
}

/** 从消息列表推断会话标题（取首条 user 或 assistant 消息的清洗后文本）。 */
export function inferTitleFromMessages(messages: ChatMessage[]): string | undefined {
	const firstUserText = messages.find((message) => message.role === "user")?.text;
	const firstAssistantText = messages.find(
		(message) => message.role === "assistant",
	)?.text;
	return cleanTitle(firstUserText) || cleanTitle(firstAssistantText);
}

/** 判断 Agent 标题是否为默认标题（项目名 + "agent" / "历史会话" 等变体）。 */
export function isDefaultAgentTitle(
	title: string,
	project: Project,
	translate: (key: string, params?: Record<string, string | number>) => string,
): boolean {
	return (
		title === `${project.name} agent` ||
		title === translate("session.historyTitle", { project: project.name }) ||
		title === translate("session.historyFallbackTitle") ||
		title === `${project.name} 历史会话` ||
		title === "历史会话"
	);
}
