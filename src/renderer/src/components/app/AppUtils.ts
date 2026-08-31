/**
 * 非组件工具函数，与 AppParts.tsx 分离以避免 Vite Fast Refresh 报错。
 * Fast Refresh 只支持组件和 hook（useXxx）导出，普通函数导出会导致整页刷新。
 */

import type { ReactNode } from "react";
import type {
	ChatMessage,
	FileTreeNode,
	PiCommand,
	SessionSummary,
} from "../../../../shared/types";
import { t } from "../../i18n";
import type { CompletionSession } from "../session/composer/completion";
import {
	formatFilePathRef,
	getAbsolutePathCompletionQuery,
	getCompletionSearchQuery,
} from "../session/composer/chips";

/* ── 文件树拖拽负载 ── */

/**
 * 文件树行拖拽时写入 dataTransfer 的两个 MIME：
 * - PI_FILE_PATH_DRAG_MIME：纯绝对路径，供「移动到目录」落点使用（历史约定，勿改名）。
 * - PI_FILE_NODE_DRAG_MIME：完整节点 JSON，composer 落点据此生成 @ 引用（区分文件/目录）。
 */
export const PI_FILE_PATH_DRAG_MIME = "text/pi-file-path";
export const PI_FILE_NODE_DRAG_MIME = "application/x-pi-file-node";

export interface FileNodeDragPayload {
	path: string;
	relativePath: string;
	type: "file" | "directory";
}

/** 拖拽开始侧：把节点信息写入 dataTransfer（路径 + JSON 双写，兼容只读路径的旧落点） */
export function writeFileNodeDragPayload(dataTransfer: DataTransfer, node: FileTreeNode): void {
	dataTransfer.setData(PI_FILE_PATH_DRAG_MIME, node.path);
	const payload: FileNodeDragPayload = {
		path: node.path,
		relativePath: node.relativePath,
		type: node.type,
	};
	dataTransfer.setData(PI_FILE_NODE_DRAG_MIME, JSON.stringify(payload));
}

/**
 * 落点侧：读取文件树拖拽负载。
 * 优先解析 JSON；只有纯路径时按「文件 + 绝对路径」兜底（兼容未带 JSON 的拖拽源）。
 * 非文件树拖拽（如 OS 文件拖入）返回 null。
 */
export function readFileNodeDragPayload(dataTransfer: DataTransfer): FileNodeDragPayload | null {
	const raw = dataTransfer.getData(PI_FILE_NODE_DRAG_MIME);
	if (raw) {
		try {
			const parsed = JSON.parse(raw) as Partial<FileNodeDragPayload>;
			if (typeof parsed.path === "string" && parsed.path) {
				return {
					path: parsed.path,
					relativePath: typeof parsed.relativePath === "string" ? parsed.relativePath : "",
					type: parsed.type === "directory" ? "directory" : "file",
				};
			}
		} catch {
			// JSON 损坏时继续走纯路径兜底
		}
	}
	const plainPath = dataTransfer.getData(PI_FILE_PATH_DRAG_MIME);
	return plainPath ? { path: plainPath, relativePath: "", type: "file" } : null;
}

/**
 * 文件树节点 → composer @ 引用文本。
 * 项目内节点优先 relativePath（与 @ 建议一致，可过 chip 白名单校验）；
 * relativePath 缺失时退回绝对路径（chip 规则对绝对路径直接放行）。
 * 目录由 formatFilePathRef 追加尾斜杠，含空格路径自动加引号。
 */
export function fileNodeDragPayloadToRef(payload: FileNodeDragPayload): string {
	return formatFilePathRef(payload.relativePath || payload.path, {
		isDirectory: payload.type === "directory",
	});
}

/* ── ANSI 清理 ── */

const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]/g;

export function stripAnsi(text: string): string {
	return text.replace(ANSI_RE, "");
}

export function stripThinkingTags(text: string): string {
	return text.replace(/<thinking>[\s\S]*?<\/thinking>/gi, "").trim();
}

/* ── 时间和摘要 ── */

export function formatTime(timestamp: number) {
	return new Date(timestamp).toLocaleString(undefined, {
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
	});
}

export function summarizeMessage(text: string) {
	const cleaned = text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
	const firstLine =
		cleaned
			.replace(/```[\s\S]*?```/g, " ")
			.split(/\r?\n/)
			.map((line) => line.trim())
			.find(Boolean) ?? "";
	return firstLine.length > 48 ? `${firstLine.slice(0, 48)}...` : firstLine;
}

/* ── 路径与匹配 ── */

export function matches(value: string, keyword: string) {
	return (
		!keyword.trim() ||
		value.toLowerCase().includes(keyword.trim().toLowerCase())
	);
}

function getHomePathPrefix() {
	const match = location.href.match(/file:\/\/\/([A-Za-z]:\/Users\/[^/]+)/i);
	return match?.[1] ?? "C:/Users/14012";
}

export function displayPath(path?: string) {
	if (!path) return "";
	const home = getHomePathPrefix();
	const normalized = path.replace(/\\/g, "/");
	const friendly =
		home && normalized.toLowerCase().startsWith(home.toLowerCase())
			? `~${normalized.slice(home.length)}`
			: normalized;
	return friendly.length > 36 ? `...${friendly.slice(-35)}` : friendly;
}

/**
 * 将文件树展平为文件 + 目录列表。
 * 目录节点一并保留，供 @ 引用搜索与 chip 白名单使用（空目录也能被引用）。
 */
export function flattenFiles(nodes: FileTreeNode[]): FileTreeNode[] {
	return nodes.flatMap((node) =>
		node.type === "file"
			? [node]
			: [node, ...flattenFiles(node.children ?? [])],
	);
}

/* ── 消息分组类型 ── */

export type ToolGroupItem = {
	kind: "tool-group";
	id: string;
	messages: ChatMessage[];
};

export type MessageItem = { kind: "message"; message: ChatMessage };

export type ThinkingGroupItem = {
	kind: "thinking-group";
	id: string;
	messages: ChatMessage[];
	text: string;
	startedAt: number;
	endedAt: number;
};

export type AgentRunItem = {
	kind: "agent-run";
	id: string;
	items: Array<MessageItem | ToolGroupItem | ThinkingGroupItem>;
	startedAt: number;
	endedAt: number;
};

export type RenderMessage = MessageItem | ToolGroupItem | ThinkingGroupItem | AgentRunItem;

export function sameChatMessageForRender(previous: ChatMessage, next: ChatMessage): boolean {
	if (
		previous.id !== next.id ||
		previous.role !== next.role ||
		previous.text !== next.text ||
		previous.thinking !== next.thinking ||
		previous.timestamp !== next.timestamp ||
		// 空文本消息（纯工具回合骨架）的 stopReason 可能是唯一变化（pending→stop/toolUse），
		// 漏比较会导致 reconcileRuns 复用旧引用、最终/中间分类不更新。
		previous.stopReason !== next.stopReason ||
		(previous.meta?.slidingOut === true) !== (next.meta?.slidingOut === true)
	) {
		return false;
	}
	const previousImages = previous.images ?? [];
	const nextImages = next.images ?? [];
	return (
		previousImages.length === nextImages.length &&
		previousImages.every(
			(image, index) =>
				image.mimeType === nextImages[index]?.mimeType &&
				image.data === nextImages[index]?.data,
		)
	);
}

export function sameAgentRunForRender(previous: AgentRunItem, next: AgentRunItem): boolean {
	// 引用相同即内容相同（阶段0补强：历史 run 复用旧对象引用后，此处 O(1) 快速路径）
	if (previous === next) return true;
	if (
		previous.id !== next.id ||
		previous.startedAt !== next.startedAt ||
		previous.endedAt !== next.endedAt ||
		previous.items.length !== next.items.length
	) {
		return false;
	}
	return previous.items.every((item, index) => {
		const other = next.items[index];
		if (!other || item.kind !== other.kind) return false;
		if (item.kind === "message" && other.kind === "message") {
			return sameChatMessageForRender(item.message, other.message);
		}
		if (item.kind === "thinking-group" && other.kind === "thinking-group") {
			return (
				item.id === other.id &&
				item.text === other.text &&
				item.startedAt === other.startedAt &&
				item.endedAt === other.endedAt &&
				item.messages.length === other.messages.length &&
				item.messages.every((message, messageIndex) =>
					sameChatMessageForRender(message, other.messages[messageIndex]),
				)
			);
		}
		if (item.kind === "tool-group" && other.kind === "tool-group") {
			return (
				item.id === other.id &&
				item.messages.length === other.messages.length &&
				item.messages.every((message, messageIndex) =>
					sameChatMessageForRender(message, other.messages[messageIndex]),
				)
			);
		}
		return false;
	});
}

export function getMultiSelectImageCaptureIds(
	items: RenderMessage[],
	selectedIds: Set<string>,
): Set<string> {
	const ids = new Set<string>();
	for (const item of items) {
		if (item.kind === "message") {
			if (selectedIds.has(item.message.id)) ids.add(item.message.id);
			continue;
		}
		if (item.kind === "agent-run") {
			const hasSelectedAssistant = item.items.some(
				(sub) =>
					sub.kind === "message" &&
					sub.message.role === "assistant" &&
					selectedIds.has(sub.message.id),
			);
			if (hasSelectedAssistant) ids.add(item.id);
		}
	}
	return ids;
}

/* ── 消息分组 ── */

export function groupToolMessages(messages: ChatMessage[]): RenderMessage[] {
	const result: RenderMessage[] = [];
	let currentTools: ChatMessage[] = [];
	let currentThinking: ChatMessage[] = [];
	let currentRun: Array<MessageItem | ToolGroupItem | ThinkingGroupItem> = [];
	let runStartedAt = 0;
	let runEndedAt = 0;
	/** 当前回合的触发用户消息时间戳，用于替代 assistant/tool 时间戳作为回合起点 */
	let lastUserTimestamp = 0;

	function isThinkingOnly(message: ChatMessage) {
		return (
			message.role === "assistant" &&
			Boolean(message.thinking?.trim()) &&
			!stripThinkingTags(stripAnsi(message.text)).trim()
		);
	}

	function flushThinking() {
		if (currentThinking.length === 0) return;
		// 每条 thinking-only 各自成组：id 与主进程 msg-thinking-* 一一对应，禁止 join 合并。
		for (const message of currentThinking) {
			const rawId = message.id ?? "";
			const group: ThinkingGroupItem = {
				kind: "thinking-group",
				id: rawId.startsWith("msg-thinking-") ? rawId : `msg-thinking-${rawId}`,
				messages: [message],
				text: stripAnsi(message.thinking ?? ""),
				startedAt: message.thinkingStartedAt ?? message.timestamp ?? runStartedAt,
				endedAt: message.thinkingEndedAt ?? message.timestamp ?? runEndedAt,
			};
			currentRun.push(group);
			runEndedAt = group.endedAt;
		}
		currentThinking = [];
	}

	function flushTools() {
		if (currentTools.length === 0) return;
		flushThinking();
		// 使用首个工具消息 ID 作为稳定 key，与 flushThinking 同理。
		const stableId = currentTools[0]?.id ?? "";
		const group: ToolGroupItem = {
			kind: "tool-group",
			id: stableId,
			messages: currentTools,
		};
		currentRun.push(group);
		runEndedAt = currentTools[currentTools.length - 1]?.timestamp ?? runEndedAt;
		currentTools = [];
	}

	function flushRun() {
		flushTools();
		flushThinking();
		if (currentRun.length === 0) return;

		// 不再合并连续 assistant 消息：issue #130 要求多段回答原位平铺，
		// 合并会把后段的 thinking 串接到前段消息上，导致思考被上移到两段文本之前。
		const runStableId = currentRun[0]
			? (currentRun[0].kind === "message" ? currentRun[0].message.id : currentRun[0].id)
			: "";
		result.push({
			kind: "agent-run",
			id: runStableId,
			items: currentRun,
			// 回合起点优先用触发它的用户消息时间戳，无用户消息时回退到 run 内首条消息时间戳
			startedAt: lastUserTimestamp || runStartedAt,
			endedAt: runEndedAt || runStartedAt,
		});
		currentRun = [];
		runStartedAt = 0;
		runEndedAt = 0;
		lastUserTimestamp = 0;
	}

	function appendRunMessage(message: ChatMessage) {
		flushThinking();
		flushTools();
		if (currentRun.length === 0) runStartedAt = message.timestamp;
		runEndedAt = message.timestamp;
		currentRun.push({ kind: "message", message });
	}

	// 暂存区：仅用于 ask_question 续答——system 卡片后用户回复时，把卡片前的工具/思考
	// 暂存起来，等下一条 assistant 到来后合并为同一 agent-run。
	// 普通「上一轮只有工具/思考、用户又发新问题」场景不得使用此暂存，否则会串轮。
	let pendingRun: (MessageItem | ToolGroupItem | ThinkingGroupItem)[] | null = null;

	for (const message of messages) {
		if (isThinkingOnly(message)) {
			flushTools();
			if (currentRun.length === 0 && currentThinking.length === 0) {
				runStartedAt = message.timestamp;
			}
			currentThinking.push(message);
			runEndedAt = message.timestamp;
			// 立即成组：禁止多条 thinking-only 积压后 join 成一张卡。
			flushThinking();
		} else if (message.role === "assistant") {
			// 有暂存 run 时先合并到当前 run
			if (pendingRun) {
				currentRun.push(...pendingRun);
				pendingRun = null;
			}
			appendRunMessage(message);
		} else if (message.role === "tool") {
			flushThinking();
			if (currentRun.length === 0) runStartedAt = message.timestamp;
			currentTools.push(message);
		} else if (message.role === "system") {
			const isCompactionCard =
				message.meta?.type === "compaction" || message.meta?.type === "branchSummary";
			if (isCompactionCard) {
				// 压缩/分支摘要是时间线中的真实边界：先收口前一个 run，
				// 否则摘要会被 result 提前放到当前 assistant 回答之前。
				flushRun();
				result.push({ kind: "message", message });
				continue;
			}
			// System 消息（如 askQuestion 卡片）不应中断当前 agent run。
			// 工具、thinking 和后续 assistant 消息应合并为同一轮回答，
			// 否则会被拆成两个独立的折叠区域。
			// 若已有暂存 run（前一次 ask_question 未合并），先 flush 掉。
			if (pendingRun) {
				currentRun.push(...pendingRun);
				pendingRun = null;
				flushRun();
			}
			result.push({ kind: "message", message });
		} else {
			// 若已有暂存 run（前一次 ask_question 未合并），先 flush 掉
			if (pendingRun) {
				currentRun.push(...pendingRun);
				pendingRun = null;
				flushRun();
			}
			// 用户消息到来时，当前 run 可能只有工具/思考、没有最终回答文本。
			// 仅在「回答 ask_question」场景下暂存合并：上一条 result 是 system 消息。
			// 普通新提问（上一轮未完成回答就发下一条）必须 flush 成独立 agent-run，
			// 否则上一轮的工具/思考会混进下一轮回答块。
			const hasToolsWithoutAssistant =
				currentRun.length > 0 &&
				currentRun.every((i) => i.kind !== "message" || i.message.role !== "assistant");
			const lastResult = result[result.length - 1];
			const isAnsweringAskQuestion =
				lastResult?.kind === "message" && lastResult.message.role === "system";
			if (hasToolsWithoutAssistant && isAnsweringAskQuestion) {
				flushTools();
				flushThinking();
				pendingRun = [...currentRun];
				currentRun = [];
				runStartedAt = 0;
				runEndedAt = 0;
			} else {
				flushRun();
			}
			result.push({ kind: "message", message });
			// 记录触发回合的用户消息时间戳，作为回合的真实起点
			lastUserTimestamp = message.timestamp;
		}
	}
	// 最后 flush 当前 run（含合并后的暂存 run）
	if (pendingRun) {
		currentRun.push(...pendingRun);
		pendingRun = null;
	}
	flushRun();

	return result;
}

/**
 * 对比新旧渲染列表，对「内容未变化的 run」复用旧对象引用。
 *
 * 背景（阶段0补强）：groupToolMessages 每次全量重建所有 run，即使只有最后一条消息变化。
 * 若每次都返回新对象，TurnRow 的 memo 比较（sameAgentRunForRender）会对每个历史 run
 * 做深度遍历，长会话时成本不小。复用旧引用后，sameAgentRunForRender 的
 * `previous === next` 快速路径直接命中，历史 run 比较退化为 O(1)。
 *
 * 规则：按 run.id 配对，内容相同（sameAgentRunForRender）则取旧引用；
 * 新增/删除/内容变化的 run 用新对象。列表结构（顺序、条目数）以 next 为准。
 */
export function reconcileRuns(
	previous: RenderMessage[] | undefined,
	next: RenderMessage[],
): RenderMessage[] {
	if (!previous) return next;
	// 只对 agent-run 做引用复用；message/tool-group/thinking-group 顶层条目按需更新
	const prevRuns = new Map<string, AgentRunItem>();
	for (const item of previous) {
		if (item.kind === "agent-run") prevRuns.set(item.id, item);
	}
	let changed = false;
	const reconciled = next.map((item) => {
		if (item.kind !== "agent-run") return item;
		const prev = prevRuns.get(item.id);
		if (prev && sameAgentRunForRender(prev, item)) return prev;
		changed = true;
		return item;
	});
	// 只有「长度相同且全部未变化」才能整体复用 previous 数组本身；
	// 否则（新增/删除/变化）必须返回 reconciled（其中未变化 run 已复用旧引用）。
	if (!changed && previous.length === next.length) return previous;
	return reconciled;
}

/* ── 会话大纲 ── */

export function buildOutline(messages: ChatMessage[]) {
	return messages
		.filter((message) => message.role === "user")
		.map((message) => ({
			id: message.id,
			role: message.role,
			title: summarizeMessage(message.text),
			time: formatTime(message.timestamp),
		}))
		.filter((item) => item.title);
}

/* ── 输入框建议 ── */

export type SuggestionItem = {
	key: string;
	label: string;
	description: string;
	value: string;
	/** 不可选中的分组头；目录本身可选，不再使用 disabled 表示目录 */
	disabled?: boolean;
	/** 树形缩进层级（0=根目录），仅在 @ 无关键词时使用 */
	treeDepth?: number;
	/** 目录引用：UI 显示文件夹图标，插入路径与文件相同 */
	isDirectory?: boolean;
	sessionMeta?: { sessionId: string; filePath: string; projectPath?: string };
};

/* ── 命令管理 ── */

const PINNED_COMMAND_NAMES = new Set<string>();
const HIDDEN_DESKTOP_BUILTIN_COMMAND_NAMES = new Set([
	"new",
	"model",
	"resume",
	"fork",
	"name",
	"logout",
	"goal",
	"tree",
	"reload",
]);

function isBuiltinDesktopCommand(command: PiCommand) {
	return command.source == null || command.source === "builtin";
}

function isVisibleDesktopCommand(command: PiCommand) {
	return !(
		isBuiltinDesktopCommand(command) &&
		HIDDEN_DESKTOP_BUILTIN_COMMAND_NAMES.has(command.name.toLowerCase())
	);
}

function getBuiltinCommands(): PiCommand[] {
	return [
		{ name: "session", description: "", source: "builtin" },
		{ name: "tree", description: "", source: "builtin" },
		{ name: "clone", description: "", source: "builtin" },
		{ name: "compact", description: "", source: "builtin" },
		{ name: "copy", description: "", source: "builtin" },
		{ name: "export", description: "", source: "builtin" },
		{ name: "share", description: "", source: "builtin" },
		{ name: "settings", description: "", source: "builtin" },
		{ name: "reload", description: "", source: "builtin" },
		{ name: "hotkeys", description: "", source: "builtin" },
		{ name: "login", description: "", source: "builtin" },
		{ name: "logout", description: "", source: "builtin" },
	];
}

export function mergeCommands(commands: PiCommand[]) {
	const visibleCommands = commands.filter(isVisibleDesktopCommand);
	const names = new Set(visibleCommands.map((command) => command.name));
	const extras = getBuiltinCommands().filter(
		(command) => !names.has(command.name) && isVisibleDesktopCommand(command),
	);
	return [...visibleCommands, ...extras];
}

function fuzzyScore(value: string, keyword: string) {
	if (!keyword) return 1;
	const text = value.toLowerCase();
	const query = keyword.toLowerCase();
	if (text.includes(query)) return 100 + query.length;
	let score = 0;
	let pos = 0;
	for (const ch of query) {
		const found = text.indexOf(ch, pos);
		if (found === -1) return 0;
		score += found === pos ? 8 : 2;
		pos = found + 1;
	}
	return score;
}

/** 目录引用在建议列表与插入文本中都用尾斜杠标记，避免 @src 被模型当成智能体。 */
function formatPathSuggestionLabel(node: FileTreeNode): string {
	return node.type === "directory" ? `@${node.name}/` : `@${node.name}`;
}

function formatPathSuggestionValue(node: FileTreeNode): string {
	return formatFilePathRef(node.relativePath, {
		isDirectory: node.type === "directory",
	});
}

/**
 * 从扁平路径列表（文件 + 目录）重建一级树视图。
 * 目录与文件均可选，便于直接 @src 这类目录引用。
 */
function buildFileTreeItems(entries: FileTreeNode[]): SuggestionItem[] {
	interface PathNode {
		name: string;
		relativePath: string;
		children: Map<string, PathNode>;
		files: FileTreeNode[];
		dirNode?: FileTreeNode;
	}
	// 用 / 分隔符构建路径树；目录节点单独挂 dirNode，空目录也能出现。
	const root: PathNode = { name: "", relativePath: "", children: new Map(), files: [] };
	const ensureDir = (parent: PathNode, part: string): PathNode => {
		let child = parent.children.get(part);
		if (!child) {
			const relativePath = parent.relativePath ? `${parent.relativePath}/${part}` : part;
			child = { name: part, relativePath, children: new Map(), files: [] };
			parent.children.set(part, child);
		}
		return child;
	};
	for (const entry of entries) {
		const parts = entry.relativePath.replace(/\\/g, "/").split("/").filter(Boolean);
		if (parts.length === 0) continue;
		if (entry.type === "directory") {
			let node = root;
			for (const part of parts) node = ensureDir(node, part);
			node.dirNode = entry;
			continue;
		}
		let node = root;
		for (const part of parts.slice(0, -1)) node = ensureDir(node, part);
		node.files.push(entry);
	}
	// 仅展平第一层（根目录文件 + 一级目录），避免大项目卡顿
	const result: SuggestionItem[] = [];
	function flatten(node: PathNode, depth: number, maxDepth: number) {
		const sortedDirs = [...node.children.values()].sort((a, b) => a.name.localeCompare(b.name));
		const sortedFiles = [...node.files].sort((a, b) => a.name.localeCompare(b.name));
		for (const dir of sortedDirs) {
			const dirPath = dir.dirNode?.relativePath ?? dir.relativePath;
			result.push({
				key: dir.dirNode?.path ?? `dir:${dirPath}`,
				label: `@${dir.name}/`,
				description: dirPath,
				// 必须插入 @dir/：裸 @dir 无法过 chip 路径规则，也易被模型当成 mention
				value: formatFilePathRef(dirPath, { isDirectory: true }),
				treeDepth: depth,
				isDirectory: true,
			});
			if (depth < maxDepth) flatten(dir, depth + 1, maxDepth);
		}
		for (const file of sortedFiles) {
			result.push({
				key: file.path,
				label: formatPathSuggestionLabel(file),
				description: file.relativePath,
				value: formatPathSuggestionValue(file),
				treeDepth: depth,
				isDirectory: file.type === "directory",
			});
		}
	}
	flatten(root, 0, 0); // 只展开第一层
	return result;
}

export function buildCompletionSuggestionItems(
	completion: CompletionSession,
	commands: PiCommand[],
	files: FileTreeNode[],
	sessions?: SessionSummary[],
): SuggestionItem[] {
	const allCommands = mergeCommands(commands);
	const absolutePath = completion.char === "@"
		? getAbsolutePathCompletionQuery(completion.query)
		: null;
	const keyword = (absolutePath?.path ?? getCompletionSearchQuery(completion.query)).toLowerCase();
	if (completion.char === "/") {
		return allCommands
			.map((command, index) => ({ command, index }))
			.filter(({ command }) => command.name.toLowerCase().includes(keyword))
			.sort((a, b) => {
				const aPinned = PINNED_COMMAND_NAMES.has(a.command.name);
				const bPinned = PINNED_COMMAND_NAMES.has(b.command.name);
				if (aPinned !== bPinned) return aPinned ? -1 : 1;
				return a.index - b.index;
			})
			.map(({ command }) => ({
				key: command.name,
				label: `/${command.name}`,
				description: command.description ?? "",
				value: `/${command.name}`,
			}));
	}
	if (completion.char === "@") {
		const rawPath = absolutePath?.path;
		const rawPathItem: SuggestionItem[] = rawPath
			? [{
					key: `raw-path:${rawPath}`,
					label: formatFilePathRef(rawPath, {
						isDirectory: /[\\/]$/.test(rawPath),
					}),
					description: t("prompt.referencePath"),
					value: formatFilePathRef(rawPath, {
						isDirectory: /[\\/]$/.test(rawPath),
					}),
				}]
			: [];
		if (!keyword) {
			// 无关键词展示一级目录/文件；绝对路径始终保留一个“引用此路径”候选，
			// 让用户可以在文件树之外继续补全未扫描到的本地路径。
			return buildFileTreeItems(files);
		}
		// 有关键词：文件与目录一起模糊搜索；同名时目录略优先，方便找文件夹
		const fileItems = files
			.map((file) => ({
				file,
				score:
					fuzzyScore(file.relativePath, keyword) +
					fuzzyScore(file.name, keyword) * 2 +
					(file.type === "directory" ? 4 : 0),
			}))
			.filter((item) => item.score > 0)
			.sort((a, b) => b.score - a.score)
			.slice(0, 15)
			.map((item) => ({
				key: item.file.path,
				label: formatPathSuggestionLabel(item.file),
				description: item.file.relativePath,
				// 相对路径含空格时同样加引号；目录追加 / 以通过 chip 规则并语义化为路径。
				value: formatPathSuggestionValue(item.file),
				isDirectory: item.file.type === "directory",
			}));
		return [...rawPathItem, ...fileItems];
	}
	if (completion.char === "&") {
		const list = sessions ?? [];
		return list
			.map((s) => ({ session: s, score: fuzzyScore(s.name ?? s.filePath, keyword) + fuzzyScore(s.preview ?? "", keyword) }))
			.filter((item) => item.score > 0 || !keyword)
			.sort((a, b) => b.score - a.score)
			.slice(0, 8)
			.map((item) => ({
				key: item.session.filePath,
				label: item.session.name ?? item.session.filePath,
				description: item.session.preview,
				value: `&${item.session.name ?? item.session.filePath}`,
				sessionMeta: { sessionId: item.session.id, filePath: item.session.filePath, projectPath: item.session.projectPath },
			}));
	}
	return [];
}

/* ── 工具参数解析 ── */

export function parseToolArgs(value: unknown): Record<string, unknown> | undefined {
	if (!value) return undefined;
	if (typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
	if (typeof value !== "string" || !value.trim()) return undefined;
	try {
		let parsed = JSON.parse(value) as unknown;
		if (typeof parsed === "string" && parsed.trim()) {
			try { parsed = JSON.parse(parsed); } catch { return undefined; }
		}
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}

export function getToolFilePath(args: any): string | undefined {
	if (!args) return undefined;
	if (typeof args === "string" && args.trim()) {
		try { args = JSON.parse(args); } catch { return undefined; }
	}
	if (typeof args !== "object") return undefined;
	const a = args as Record<string, unknown>;
	return typeof a.filePath === "string" && a.filePath ? a.filePath
		: typeof a.file_path === "string" && a.file_path ? a.file_path
		: typeof a.path === "string" && a.path ? a.path
		: typeof a.targetPath === "string" && a.targetPath ? a.targetPath
		: typeof a.target_path === "string" && a.target_path ? a.target_path
		: typeof a.outputPath === "string" && a.outputPath ? a.outputPath
		: typeof a.output_path === "string" && a.output_path ? a.output_path
		: typeof a.file === "string" && a.file ? a.file
		: typeof a.fileName === "string" && a.fileName ? a.fileName
		: typeof a.filename === "string" && a.filename ? a.filename
		: undefined;
}

export function countTextLines(value: string): number {
	return value ? value.split(/\r\n|\r|\n/).length : 0;
}

export function getToolEditDiff(args: Record<string, unknown>): { oldText: string; newText: string } | undefined {
	const edits = Array.isArray(args.edits) ? args.edits : undefined;
	if (edits) {
		const parts = edits.map((edit: unknown) => {
			if (!edit || typeof edit !== "object") return null;
			const e = edit as Record<string, unknown>;
			const oldText = String(e.oldText ?? e.old_text ?? e.old_string ?? "");
			const newText = String(e.newText ?? e.new_text ?? e.new_string ?? "");
			return { oldText, newText };
		}).filter((p): p is { oldText: string; newText: string } => p !== null);
		if (parts.length === 0) return undefined;
		return {
			oldText: parts.map(p => p.oldText).join("\n"),
			newText: parts.map(p => p.newText).join("\n"),
		};
	}
	const oldText = typeof args.oldText === "string" ? args.oldText : typeof args.old_text === "string" ? args.old_text : typeof args.old_string === "string" ? args.old_string : undefined;
	const newText = typeof args.newText === "string" ? args.newText : typeof args.new_text === "string" ? args.new_text : typeof args.new_string === "string" ? args.new_string : undefined;
	if (oldText === undefined || newText === undefined) return undefined;
	return { oldText, newText };
}

export function getToolNewContent(toolName: string, args: any): string | undefined {
	if (!args) return undefined;
	if (typeof args === "string" && args.trim()) {
		try { args = JSON.parse(args); } catch { return undefined; }
	}
	if (!toolName) return undefined;
	if (/write|create/i.test(toolName)) {
		const a = args as Record<string, unknown>;
		return typeof a.content === "string" ? a.content : typeof a.text === "string" ? a.text : typeof a.data === "string" ? a.data : typeof a.body === "string" ? a.body : undefined;
	}
	if (/edit|patch/i.test(toolName)) {
		const diff = getToolEditDiff(args);
		return diff?.newText;
	}
	return undefined;
}

export function getToolChangedLineCount(toolName: string, args: any): number {
	if (typeof args === "string" && args.trim()) {
		try { args = JSON.parse(args); } catch { return 0; }
	}
	if (!toolName) return 0;
	if (/edit|patch/i.test(toolName)) {
		const edits = Array.isArray(args?.edits) ? args.edits : undefined;
		if (edits) {
			return edits.reduce((total: number, edit: any) => {
				const oldLines = countTextLines(String(edit?.oldText ?? edit?.old_text ?? ""));
				const newLines = countTextLines(String(edit?.newText ?? edit?.new_text ?? ""));
				return total + Math.max(oldLines, newLines);
			}, 0);
		}
		return Math.max(countTextLines(String(args?.oldText ?? args?.old_text ?? "")), countTextLines(String(args?.newText ?? args?.new_text ?? "")));
	}
	if (/write|create/i.test(toolName)) {
		return countTextLines(String(args?.content ?? args?.text ?? args?.data ?? args?.body ?? ""));
	}
	return 0;
}
