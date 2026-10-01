import type { ChatMessage } from "../../../../shared/types";
import type {
	AgentRunItem,
} from "../app/AppUtils";

/* ── 工具参数解析（与 AppUtils 同逻辑的内联副本：此文件被 node 单测直接加载，
   不能带 AppUtils 的运行时依赖链；改动时需与 AppUtils 同步） ── */

function parseToolArgs(value: unknown): Record<string, unknown> | undefined {
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

function getToolFilePath(args: unknown): string | undefined {
	if (!args) return undefined;
	let a: unknown = args;
	if (typeof a === "string" && a.trim()) {
		try { a = JSON.parse(a); } catch { return undefined; }
	}
	if (typeof a !== "object" || a === null) return undefined;
	const r = a as Record<string, unknown>;
	return typeof r.filePath === "string" && r.filePath ? r.filePath
		: typeof r.file_path === "string" && r.file_path ? r.file_path
		: typeof r.path === "string" && r.path ? r.path
		: typeof r.targetPath === "string" && r.targetPath ? r.targetPath
		: typeof r.target_path === "string" && r.target_path ? r.target_path
		: typeof r.outputPath === "string" && r.outputPath ? r.outputPath
		: typeof r.output_path === "string" && r.output_path ? r.output_path
		: typeof r.file === "string" && r.file ? r.file
		: typeof r.fileName === "string" && r.fileName ? r.fileName
		: typeof r.filename === "string" && r.filename ? r.filename
		: undefined;
}

function countTextLines(value: string): number {
	return value ? value.split(/\r\n|\r|\n/).length : 0;
}

function getToolEditDiff(args: Record<string, unknown>): { oldText: string; newText: string } | undefined {
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
			oldText: parts.map((p) => p.oldText).join("\n"),
			newText: parts.map((p) => p.newText).join("\n"),
		};
	}
	const oldText = typeof args.oldText === "string" ? args.oldText : typeof args.old_text === "string" ? args.old_text : typeof args.old_string === "string" ? args.old_string : undefined;
	const newText = typeof args.newText === "string" ? args.newText : typeof args.new_text === "string" ? args.new_text : typeof args.new_string === "string" ? args.new_string : undefined;
	if (oldText === undefined || newText === undefined) return undefined;
	return { oldText, newText };
}

const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

/* stripThinkingTags 与 AppUtils 同逻辑的内联副本（此文件被 node 单测直接加载，改动需同步） */
export function stripThinkingTags(text: string): string {
	return text.replace(/<thinking>[\s\S]*?<\/thinking>/gi, "").trim();
}

export function getToolStatus(
  message: ChatMessage,
): "running" | "done" | "error" {
  const status = String(message.meta?.status ?? "");
  if (status === "running") return "running";
  if (status === "error" || message.role === "error") return "error";
  return "done";
}

/** 从工具参数中提取文件路径（write/edit/create/patch 等文件工具） */
export function getToolArgFilePath(args: Record<string, unknown> | undefined): string | undefined {
	return getToolFilePath(args);
}

/**
 * 提取单条工具消息的 diff 目标（write/edit/create/patch）：
 * write/create 提供完整新内容；edit/patch 提供变动区域（oldText/newText）。
 * 与单条工具卡片的 diff 按钮共用，会话文件汇总也复用此逻辑。
 */
export function getToolDiffTarget(message: ChatMessage): { path: string; originalContent: string; content: string; changedLines: number } | undefined {
	const toolName = getToolName(message);
	if (!/write|edit|create|patch/i.test(toolName)) return undefined;
	const args = parseToolArgs(message.meta?.args);
	const path = getToolArgFilePath(args);
	if (!args || !path) return undefined;
	if (/write|create/i.test(toolName)) {
		const content = typeof args.content === "string"
			? args.content
			: typeof args.text === "string"
				? args.text
				: undefined;
		if (content === undefined) return undefined;
		return { path, originalContent: "", content, changedLines: countTextLines(content) };
	}
	// edit/patch：不存储 full file originalContent，只展示变动区域
	const diff = getToolEditDiff(args);
	if (!diff) return undefined;
	return {
		path,
		originalContent: diff.oldText,
		content: diff.newText,
		changedLines: Math.max(countTextLines(diff.oldText), countTextLines(diff.newText)),
	};
}

/**
 * 遍历会话消息收集 write/edit/create/patch 修改的文件（复用 getToolDiffTarget）。
 * 同文件多次修改取最后一次 diff 并累计次数。供会话文件汇总组件与单测共用。
 */
export function collectSessionFileChanges(
	messages: readonly ChatMessage[],
): Array<{ path: string; count: number; originalContent: string; content: string }> {
	const map = new Map<string, { path: string; count: number; originalContent: string; content: string }>();
	for (const message of messages) {
		const target = getToolDiffTarget(message);
		if (!target) continue;
		const prev = map.get(target.path);
		map.set(target.path, {
			path: target.path,
			count: (prev?.count ?? 0) + 1,
			originalContent: target.originalContent,
			content: target.content,
		});
	}
	return [...map.values()];
}

/**
 * 一轮 agent-run 内文件修改行的展示结构：
 * 与 beUI FileDiffLine 结构兼容（oldLine/newLine 可选，缺省即可直接传入 FileDiff）。
 */
export type TurnFileDiffLine = {
	id: string;
	type: "added" | "removed" | "context";
	content: string;
};

/**
 * 收集一轮 agent-run 内修改的文件：展开 run.items 的全部消息后复用
 * collectSessionFileChanges。run 完成后其内容不再变化，因此每轮底部展示天然固定，
 * 不会被后续消息清掉。
 */
export function collectRunFileChanges(
	run: AgentRunItem,
): Array<{ path: string; count: number; originalContent: string; content: string }> {
	const msgs: ChatMessage[] = [];
	for (const item of run.items) {
		if (item.kind === "message") {
			msgs.push(item.message);
		} else if (item.kind === "tool-group" || item.kind === "thinking-group") {
			msgs.push(...item.messages);
		}
	}
	return collectSessionFileChanges(msgs);
}

/**
 * 文件修改条目 → beUI FileDiff 行序列：
 * edit/patch 展示变动区域（removed 旧行 + added 新行）；
 * write/create 无旧内容，整文件视为新增（全 added）。
 */
export function fileChangeToDiffLines(entry: {
	originalContent: string;
	content: string;
}): TurnFileDiffLine[] {
	const hasOld = entry.originalContent.length > 0;
	const lines: TurnFileDiffLine[] = [];
	entry.originalContent.split("\n").forEach((content, index) => {
		if (hasOld) lines.push({ id: `removed-${index}`, type: "removed", content });
	});
	entry.content.split("\n").forEach((content, index) => {
		lines.push({ id: `added-${index}`, type: "added", content });
	});
	return lines;
}

export function getToolName(message: ChatMessage): string {
  const fromMeta = message.meta?.toolName;
  if (typeof fromMeta === "string" && fromMeta.trim()) return fromMeta;
  const text = stripAnsi(message.text).replace(/^[\u25b6\u2713\u2717]\s*/u, "").trim();
  return text.split(/\s+/)[0] || "tool";
}

export function getToolDetailText(message: ChatMessage): string {
  if (typeof message.meta?.detailText === "string") {
    return stripAnsi(message.meta.detailText);
  }
  return stripAnsi(JSON.stringify(message.meta ?? {}, null, 2));
}

export function getToolExitCode(message: ChatMessage): number | undefined {
  const result = message.meta?.result;
  if (!result || typeof result !== "object") return undefined;
  const value = (result as { exitCode?: unknown }).exitCode;
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}.${Math.floor((ms % 1000) / 100)}s`;
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  return remaining > 0 ? `${minutes}m${remaining}s` : `${minutes}m`;
}

export function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString(undefined, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/* ── 一轮回答的展示分段已迁移至 timeline/buildTurnDisplay.ts ──
 *
 * 旧 buildTurnSegments（多个 process 折叠段）已被新 buildTurnDisplay（扁平展示序列 +
 * 单一 run 级折叠控制）取代，见 turn/TurnRow.tsx。领域类型见 timeline/types.ts。
 */
