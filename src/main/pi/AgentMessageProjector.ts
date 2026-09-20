import type { ChatMessage, ImageContent } from "../../shared/types";
import type { MainProcessTranslationKey } from "../../shared/i18n/mainProcessCopy";
import { extractMessageText } from "./messageContent";
import { takeActiveEntryId } from "./sessionEntryIds";
import { buildAskQuestionResultSummary } from "./askQuestionResult";
import { extractImageContent } from "../../shared/imageContent";
import { applyImageDisplayBudget } from "../../shared/imageLimits";

export type AgentMessageProjectorDeps = {
	translate: (
		key: MainProcessTranslationKey,
		params?: Record<string, string | number>,
	) => string;
	isAskAborted: (agentId: string) => boolean;
};

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}

export function buildActiveBranchEntryIds(
		entries: Array<{ id: string; parentId: string | null; type?: string; message?: { role?: string } }>,
		leafId: string,
	): string[] {
		const entryById = new Map<string, { id: string; parentId: string | null; type?: string; message?: { role?: string } }>();
		for (const entry of entries) {
			entryById.set(entry.id, entry);
		}

		// 从 leafId 回溯到 root，只保留 type=message 的条目
		const allBranchIds: string[] = [];
		let currentId: string | null = leafId;
		while (currentId) {
			allBranchIds.unshift(currentId);
			const entry = entryById.get(currentId);
			currentId = entry?.parentId ?? null;
		}
		return allBranchIds.filter((id) => entryById.get(id)?.type === "message");
	}


/**
 * Converts persisted Pi/RPC history into renderer ChatMessage records. It has no
 * process, window, or Session ownership; AgentManager supplies the live state
 * query needed to preserve cancelled ask_question cards.
 */
export class AgentMessageProjector {
	private static readonly MAX_TOOL_RESULT_CHARS = 8000;

	constructor(private readonly deps: AgentMessageProjectorDeps) {}

	convert(
		agentId: string,
		rawMessages: unknown[],
		activeEntryIds?: string[],
	): ChatMessage[] {
		const historicalToolCalls = this.collectHistoricalToolCalls(rawMessages);
		const historicalOriginalContentByPath = this.collectHistoricalOriginalContentByPath(
			rawMessages,
			historicalToolCalls,
		);
		// 用于生成元消息 id（compaction/branchSummary）的计数器
		let metaSeq = 0;
		// entryId 按 active branch 顺序与 rawMessages 一一对应。
		// 注意：entryIndex 只在 user/assistant/toolResult 时递增，
		// 因为 compactionSummary/branchSummary 在 get_entries 中无对应 entry，
		// 同时 activeEntryIds 还包含 model_change/thinking_level_change/custom 等非角色条目。
		// 因此 currentEntryId 的读取必须放在各个角色块内部，不能在所有条目前统一读取，
		// 否则非 user/assistant/toolResult 条目会提前消费 entryIndex 槽位。
		let entryIndex = 0;
		let turnImageBytes = 0;
		return rawMessages
			.flatMap<ChatMessage>((message, index) => {
				if (!message || typeof message !== "object") return [];
				const typed = message as any;

				if (typed.role === "user") {
					turnImageBytes = 0;
					// 先消费 activeEntryIds 槽位，再决定是否渲染。
					// 边界：空文本 user 不展示，但 get_entries 仍有对应 entry，
					// 若不推进 index，后续消息 entryId 会整体前移错位。
					const taken = takeActiveEntryId(activeEntryIds, entryIndex);
					entryIndex = taken.nextIndex;
					const currentEntryId = taken.entryId;
					const rawImages = extractImageContent(typed.content).images;
					const text = this.extractText(typed.content) ||
						(rawImages.length > 0 ? this.deps.translate("session.imagePlaceholder") : "");
					if (!text.trim()) return [];
					return [{
						id: `${agentId}-history-${currentEntryId ?? index}`,
						agentId,
						role: "user" as const,
						text,
						timestamp: typed.timestamp ?? Date.now(),
						meta: {
							...(currentEntryId ? { entryId: currentEntryId } : {}),
							// 保留 _piDeckMsgSeq 作为旧版本回退兼容
							_piDeckMsgSeq: index,
						},
						...(rawImages.length > 0 ? { images: rawImages } : {}),
					}];
				}
				if (typed.role === "assistant") {
					// 工具调用回合常见「assistant 仅含 toolCall、无可见文本」：
					// 这时不能直接跳过，因为可能包含 thinking 内容。如果 thinking 也被丢掉，
					// 渲染时多步思考会混入下一个回答块，用户在历史会话中看到的信息不完整。
					// 提取 thinking，即使 text 为空也保留消息，由 renderer 端 groupToolMessages
					// 的 isThinkingOnly 判断逻辑统一处理。
					const taken = takeActiveEntryId(activeEntryIds, entryIndex);
					entryIndex = taken.nextIndex;
					const currentEntryId = taken.entryId;
					const rawImages = extractImageContent(typed.content).images;
					const budget = applyImageDisplayBudget(rawImages, { currentTurnUsedBytes: turnImageBytes });
					for (const img of budget.images) turnImageBytes += img.data.length;

					const text = this.extractText(typed.content);
					const thinking = this.extractThinking(typed.content);
					// 无文本、无 thinking、无图片且无展示提示时才是真正的空消息，跳过。
					if (!text.trim() && !thinking?.trim() && budget.images.length === 0 && !budget.notice) return [];
					// stopReason（provider 归一化）：历史 JSONL 已持久化，
					// 渲染层据此精确区分中间/最终回复（与 live 路径同源）。
					const stopReason =
						typeof typed.stopReason === "string" && typed.stopReason
							? typed.stopReason
							: undefined;
					return [{
						id: `${agentId}-history-${currentEntryId ?? index}`,
						agentId,
						role: "assistant" as const,
						text,
						timestamp: typed.timestamp ?? Date.now(),
						meta: {
							...(currentEntryId ? { entryId: currentEntryId } : {}),
							_piDeckMsgSeq: index,
						},
						...(thinking ? { thinking } : {}),
						...(stopReason ? { stopReason } : {}),
						...(budget.images.length > 0 ? { images: budget.images } : {}),
						...(budget.notice ? { imageDisplayNotice: budget.notice } : {}),
					}];
				}
				if (typed.role === "toolResult") {
					const taken = takeActiveEntryId(activeEntryIds, entryIndex);
					entryIndex = taken.nextIndex;
					const currentEntryId = taken.entryId;
					const toolCallId = String(typed.toolCallId ?? `history-tool-${index}`);
					const historicalCall = historicalToolCalls.get(toolCallId);
					const toolName = String(typed.toolName ?? historicalCall?.name ?? "tool");
					const isError = Boolean(typed.isError);
					const startedAt =
						typeof typed.startedAt === "number" ? typed.startedAt : historicalCall?.timestamp;
					const durationMs =
						typeof typed.durationMs === "number"
							? typed.durationMs
							: typeof startedAt === "number" && typeof typed.timestamp === "number"
								? Math.max(0, typed.timestamp - startedAt)
								: undefined;
					const result = {
						content: typed.content,
						details: typed.details,
					};
					const filePath = this.getToolPathFromArgs(historicalCall?.args);
					const piDeckOriginalContent = typed.details?._piDeckOriginalContent as
						| string
						| undefined;
					const originalContent =
						piDeckOriginalContent ??
						(filePath
							? historicalOriginalContentByPath.get(filePath)
							: undefined);
					const toolImagesResult = extractImageContent(typed.content);
					const budget = applyImageDisplayBudget(toolImagesResult.images, { currentTurnUsedBytes: turnImageBytes });
					for (const img of budget.images) turnImageBytes += img.data.length;
					const detailText = this.formatToolDetail(
						toolName,
						historicalCall?.args,
						result,
						isError,
					);
					// detailText 整体截断（拼接后可能超单段上限）并标记 truncated/fullLength，
					// 渲染层据此提供「查看完整输出」按需加载（sessionsCatalogReadMessageFullText）。
					const detailDelivery = this.truncateDetailWithMeta(detailText);
				// 从历史工具结果中提取 ask_question 详情，用于渲染「常驻问答卡」：
				// 与实时（AgentManager）共用 buildAskQuestionResultSummary，保证批量问答
				// 在历史回放时同样恢复全部问题（而非只取第一题）。
				// abort 时 isAskAborted 覆写 answer=null / answered=false，显示"已取消"。
				const askCard = buildAskQuestionResultSummary({
					toolName,
					args: historicalCall?.args,
					result,
					aborted: this.deps.isAskAborted(agentId),
					// 与实时路径（AgentManager）对齐：历史里 ✗ ask_question 的
					// result 同样是错误文案，不升格成「已回答」问答卡。
					isError,
				});
					// entryIndex 已在上方 takeActiveEntryId 推进
					return [{
						id: `${agentId}-history-${currentEntryId ?? index}`,
						agentId,
						role: "tool" as const,
						text: `${isError ? "✗" : "✓"} ${toolName}`,
						timestamp: typed.timestamp ?? Date.now(),
						...(budget.images.length > 0 ? { images: budget.images } : {}),
						...(budget.notice ? { imageDisplayNotice: budget.notice } : {}),
						meta: {
							...(currentEntryId ? { entryId: currentEntryId } : {}),
							_piDeckMsgSeq: index,
							status: isError ? "error" : "done",
							toolName,
							toolCallId,
							...(startedAt !== undefined ? { startedAt } : {}),
							...(durationMs !== undefined ? { durationMs } : {}),
							args: this.truncateForDetail(this.safeJson(historicalCall?.args)),
							result: this.truncateForDetail(this.extractToolResultText(result) || this.safeJson(result)),
							isError,
							detailText: detailDelivery.text,
							...(detailDelivery.truncated
								? { truncated: true, fullLength: detailDelivery.fullLength }
								: {}),
							// 历史会话不保存 originalContent（full file），diff 使用工具参数
							//（oldText/newText）展示变动区域，避免会话文件体积膨胀。
							...(askCard ? { _askCard: askCard } : {}),
						},
					}];
				}
				// 压缩/分支摘要等元消息：显示在时间线上，不参与 _piDeckMsgSeq 计数
				if (typed.role === "compactionSummary" || typed.role === "branchSummary") {
					const isCompaction = typed.role === "compactionSummary";
					metaSeq++;
					return [{
						id: `${agentId}-meta-${metaSeq}`,
						agentId,
						role: "system" as const,
						text: typed.summary ?? (isCompaction ? "Session compacted" : "Branch summarized"),
						timestamp: typeof typed.timestamp === "number"
							? typed.timestamp
							: Date.now(),
						meta: {
							type: isCompaction ? "compaction" : "branchSummary",
							tokensBefore: typed.tokensBefore,
						// 保留压缩次数（桌面端从会话文件解析得到），供前端展示“已压缩 N 次”
						...(isCompaction && typed.meta?.compactionCount != null
							? { compactionCount: typed.meta.compactionCount }
							: {})
						},
					}];
				}
				return [];
			})
			// thinking-only 或 image/notice-bearing assistant turns 保留，供渲染层正常呈现。
			.filter((message: ChatMessage) => Boolean(message.text.trim() || message.thinking?.trim() || message.images?.length || message.imageDisplayNotice));
	}

	private collectHistoricalToolCalls(rawMessages: unknown[]) {
		const calls = new Map<string, { name: string; args: unknown; timestamp?: number }>();
		for (const message of rawMessages) {
			if (!message || typeof message !== "object") continue;
			const typed = message as any;
			if (typed.role !== "assistant" || !Array.isArray(typed.content)) continue;
			for (const block of typed.content) {
				if (!block || typeof block !== "object") continue;
				const toolCall = block as any;
				if (toolCall.type !== "toolCall" || !toolCall.id) continue;
				// pi 的历史文件把工具参数保存在 assistant.content 的 toolCall 块中，
				// toolResult 只带结果；恢复历史详情时必须先建立 toolCallId → 参数映射。
				calls.set(String(toolCall.id), {
					name: String(toolCall.name ?? "tool"),
					args: toolCall.arguments,
					// 旧会话没有 durationMs，只能用发起 toolCall 的 assistant 时间戳作为兜底起点；
					// 同一条 assistant 内并发多个工具时精度有限，但比完全不显示耗时更接近历史行为。
					timestamp: typeof typed.timestamp === "number" ? typed.timestamp : undefined,
				});
			}
		}
		return calls;
	}

	private collectHistoricalOriginalContentByPath(
		rawMessages: unknown[],
		historicalToolCalls: Map<string, { name: string; args: unknown }>,
	) {
		const originals = new Map<string, string>();
		for (const message of rawMessages) {
			if (!message || typeof message !== "object") continue;
			const typed = message as any;
			if (typed.role !== "toolResult") continue;
			const toolCallId = String(typed.toolCallId ?? "");
			const historicalCall = historicalToolCalls.get(toolCallId);
			if (!historicalCall || historicalCall.name !== "read") continue;
			const filePath = this.getToolPathFromArgs(historicalCall.args);
			if (!filePath) continue;
			// 旧历史会话没有保存 originalContent；同一轮写入前通常会先 read 目标文件，
			// 用最近一次 read 结果作为后续 write/edit/patch 的 diff 基准。
			const content = this.extractText(typed.content);
			if (content) originals.set(filePath, content);
		}
		return originals;
	}

	private getToolPathFromArgs(args: unknown) {
		if (!args || typeof args !== "object") return "";
		const typed = args as any;
		return String(
			typed.path ??
				typed.filePath ??
				typed.file ??
				typed.target_file ??
				typed.targetFile ??
				"",
		);
	}

	formatToolDetail(
		toolName: string,
		args: unknown,
		result: unknown,
		isError: boolean,
	) {
		const details = this.extractToolDetails(result);
		// args/结果/details 都先序列化再截断，避免单条工具详情撑大 ChatMessage.meta。
		// 注意：args 在 end/update 事件里可能已是序列化字符串（从 existing.meta.args 回退），
		// 此时 safeJson(string) 会二次编码导致显示异常，先反解回对象再序列化。
		let argsObj = args;
		if (typeof args === "string" && args.trim()) {
			try {
				argsObj = JSON.parse(args) as unknown;
			} catch {
				// truncated/不可解析时保持原样
			}
		}
		const argsText = argsObj ? this.truncateForDetail(this.safeJson(argsObj)) : "";
		const resultText = result
			? this.truncateForDetail(this.extractToolResultText(result) || this.safeJson(result))
			: "";
		const detailsText = details ? this.truncateForDetail(this.safeJson(details)) : "";
		const status = this.deps.translate(isError ? "mainTool.failed" : "mainTool.done");
		const sections = [
			this.deps.translate("mainTool.name", { name: toolName ?? "tool" }),
			this.deps.translate("mainTool.status", { status }),
			args ? this.deps.translate("mainTool.arguments", { value: argsText }) : "",
			result ? this.deps.translate("mainTool.result", { value: resultText }) : "",
			details ? this.deps.translate("mainTool.details", { value: detailsText }) : "",
		].filter(Boolean);
		return sections.join("\n\n");
	}

	private extractToolDetails(result: unknown) {
		if (!result || typeof result !== "object") return undefined;
		return (result as any).details;
	}

	/** 对超长工具文本做首尾截断，保留头部和尾部以兼顾开头信息和错误堆栈。 */
	truncateForDetail(text: unknown): string {
		// safeJson/extractToolResultText 在某些输入下可能返回 undefined（如 JSON.stringify(undefined)），
		// 必须在此归一化为字符串，否则后续 .length 访问会抛 TypeError 导致主进程未捕获异常弹窗。
		const str = typeof text === "string" ? text : text == null ? "" : String(text);
		if (str.length <= AgentMessageProjector.MAX_TOOL_RESULT_CHARS) return str;
		const keep = Math.floor(AgentMessageProjector.MAX_TOOL_RESULT_CHARS / 2);
		const omitted = str.length - keep * 2;
		return (
			`${str.slice(0, keep)}\n` +
			`${this.deps.translate("mainTool.truncated", { omitted, total: str.length })}\n` +
			str.slice(-keep)
		);
	}

	/**
	 * 与 truncateForDetail 同规则的整体截断，但额外返回是否截断与原始长度，
	 * 供下发 meta 标记 truncated/fullLength（渲染层据此提供「查看完整输出」按需加载入口）。
	 * 用于 detailText 的整体上限：formatToolDetail 拼接 args/result/details 三段后可能超过单段上限。
	 */
	truncateDetailWithMeta(text: string): { text: string; truncated: boolean; fullLength: number } {
		if (text.length <= AgentMessageProjector.MAX_TOOL_RESULT_CHARS) {
			return { text, truncated: false, fullLength: text.length };
		}
		const keep = Math.floor(AgentMessageProjector.MAX_TOOL_RESULT_CHARS / 2);
		const omitted = text.length - keep * 2;
		return {
			text:
				`${text.slice(0, keep)}\n` +
				`${this.deps.translate("mainTool.truncated", { omitted, total: text.length })}\n` +
				text.slice(-keep),
			truncated: true,
			fullLength: text.length,
		};
	}


	extractToolResultText(result: unknown) {
		if (!result || typeof result !== "object") return "";
		const content = (result as any).content ?? (Array.isArray(result) ? result : undefined);
		if (!Array.isArray(content)) return "";
		return content
			.map((item) => {
				if (typeof item?.text === "string") return item.text;
				if (item?.type === "image") return `[${this.deps.translate("session.imagePlaceholder") || "图片"}]`;
				return "";
			})
			.filter(Boolean)
			.join("\n");
	}

	private sanitizeForJson(value: unknown): unknown {
		if (!value || typeof value !== "object") return value;
		if (Array.isArray(value)) return value.map((item) => this.sanitizeForJson(item));
		const obj = value as Record<string, unknown>;

		// 识别 flat image: { type: "image", data: string, ... }
		if (obj.type === "image" && typeof obj.data === "string") {
			const sanitized: Record<string, unknown> = {};
			for (const [k, v] of Object.entries(obj)) {
				sanitized[k] = k === "data" ? `[base64 image (${obj.data.length} chars)]` : this.sanitizeForJson(v);
			}
			return sanitized;
		}

		// 识别 nested image: { type: "image", source: { type: "base64", data: string, ... } }
		if (obj.type === "image" && obj.source && typeof obj.source === "object") {
			const source = obj.source as Record<string, unknown>;
			if (source.type === "base64" && typeof source.data === "string") {
				const sanitizedSource: Record<string, unknown> = {};
				for (const [k, v] of Object.entries(source)) {
					sanitizedSource[k] = k === "data" ? `[base64 image (${source.data.length} chars)]` : this.sanitizeForJson(v);
				}
				const sanitized: Record<string, unknown> = {};
				for (const [k, v] of Object.entries(obj)) {
					sanitized[k] = k === "source" ? sanitizedSource : this.sanitizeForJson(v);
				}
				return sanitized;
			}
		}

		// 兼容单独 source 块: { type: "base64", data: string }
		if (obj.type === "base64" && typeof obj.data === "string") {
			const sanitized: Record<string, unknown> = {};
			for (const [k, v] of Object.entries(obj)) {
				sanitized[k] = k === "data" ? `[base64 image (${obj.data.length} chars)]` : this.sanitizeForJson(v);
			}
			return sanitized;
		}

		const copy: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(obj)) {
			copy[k] = this.sanitizeForJson(v);
		}
		return copy;
	}

	safeJson(value: unknown) {
		try {
			return JSON.stringify(this.sanitizeForJson(value), null, 2);
		} catch {
			return String(value);
		}
	}

	extractText(content: unknown): string {
		return extractMessageText(content);
	}

	/** 从历史消息 content 数组中提取 thinking 内容块的文本，清理 ANSI 转义码 */
	extractThinking(content: unknown): string {
		if (!Array.isArray(content)) return "";
		const raw = content
			.map((item) => {
				if (!item || typeof item !== "object") return "";
				const typed = item as any;
				if (typed.type !== "thinking") return "";
				return String(typed.thinking ?? typed.text ?? "");
			})
			.filter(Boolean)
			.join("\n");
		return stripAnsi(raw);
	}

}
