import {
	Fragment,
	isValidElement,
	memo,
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
	type CSSProperties,
	type PointerEvent as ReactPointerEvent,
	type ReactNode,
} from "react";
import { MarkdownStream } from "./MarkdownStream";
import { useAtomValue } from "jotai";
import "katex/dist/katex.min.css";
import { MessageImage, ImagePreviewModal } from "./MessageImage";
import { CopyMenu } from "./MessageCopyMenu";
import { EmptyState } from "./EmptyState";
export { ImagePreviewModal } from "./MessageImage";
export { CopyMenu } from "./MessageCopyMenu";
export { EmptyState } from "./EmptyState";
import {
	summarizeMessage,
	type RenderMessage,
	type ComposerSuggestionResult,
	type ComposerTrigger,
	groupToolMessages,
	buildOutline,
	detectTrigger,
	applySuggestion,
	clearSuggestionTrigger,
	buildSuggestionItems,
	mergeCommands,
	matches,
	displayPath,
	flattenFiles,
} from "../app/AppUtils";
import { Textarea } from "../ui-shadcn/textarea";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "../ui-shadcn/tooltip";

// Mermaid 库体积数 MB，仅在真正出现 mermaid 代码块时才动态加载，
// 避免随渲染进程常驻、放大内存占用并在流式期间抢占主线程。
import {
	AlertTriangle,
	Check,
	CircleAlert,
	CircleDot,
	ChevronLeft,
	ChevronDown,
	ChevronUp,
	ChevronsUpDown,
	MoveDown,
	MoveUp,
	ChevronsDownUp,
	GitBranch,
	Eye,
	Loader2,
	FileText,
	Folder,
	Globe2,
	MessageCircle,
	Network,
	PawPrint,
	Pin,
	Plus,
	RefreshCw,
	Search,
	Settings2,
	Terminal,
	UploadCloud,
	Wrench,
	Star,
	FolderOpen,
	Trash,
	Share,
	SquarePen,
	Send,
	UserPen,
	GitFork,
	LoaderCircle,
} from "lucide-react";
import { getFileIconSeti, getFileIconColor, getFileTypeLabel } from "../../fileIcons";
import { normalizeSessionPathForCompare } from "../../agentListDisplay";
import { t } from "../../i18n";
import { showNotice } from "../../utils/notice";
import { Button } from "../ui-shadcn/button";
import type {
	AgentRuntimeState,
	AgentTab,
	AppInfo,
	AppSettings,
	ComposerAgentMode,
	AvailableModel,
	ChatMessage,
	CodexImportReport,
	CodexSessionSummary,
	ClaudeImportReport,
	ClaudeSessionSummary,
	OpenCodeImportReport,
	OpenCodeSessionSummary,
	GitBranchInfo,
	ImageContent,
	PiCliUpdateResult,
	PiCommand,
	PiInstallExecResult,
	PiInstallStatus,
	PiUpdateCheckResult,
	Project,
	SessionSummary,
	VisionBridgeEvent,
	VisionEventsInfo,
} from "../../../../shared/types";
import { parseRichInputChips, unwrapFileChipPath } from "./composer/chips";
import { createTrackedEditSubmit } from "../../utils/trackedEditSubmit";
import removeMarkdown from "remove-markdown";

import type { WorkspaceDrawerPanel } from "../../hooks/useWorkspacePanels";
import { formatDuration, formatTime, stripAnsi } from "./TimelineFormat";
import { extractVisionBridgeBlocks, matchVisionBridgeEvent } from "../../utils/visionBridgeBlocks";
import { visionImageHashes } from "../../utils/visionImageHash";
import { ToolCard, ToolGroupCard, type DiffFileHandler } from "./ToolCallComponents";
import {
	AskQuestionCard,
	CompactionCard,
	DiagnosticMessageCard,
	RespondingIndicator,
	ThinkingBlock,
} from "./TimelineEventCards";
import { MultiSelectModal } from "./MessageShareModal";

// ============================================================
// Surface & Workspace domain components
// 从 AppParts.tsx 提取，包含所有会话渲染组件
//
// Button 收口状态（P0 UI 统一）：
// - 已换装 shadcn Button：turn-row-action-btn / user-turn-action-btn / copy-menu-trigger
//   （ghost + size-7 + hover:bg-muted，对齐旧透明小钮；避免 hover:bg-accent 绿底）。
// - 保留原生 button（样式完全由自定义 CSS 驱动，直接换装会被 Tailwind utilities 覆盖默认尺寸
//   导致回归，需先做 CSS→utility 迁移）：code-copy、execution-summary-toggle/collapse、
//   image-preview-close、outline-* 系列、scratch/terminal/files/git/editors/browser-entry、
//   空状态创建按钮。迁移路径见 P2 CSS 收口。
//   （copy-menu-popover 菜单项已于 2026-08 迁移到 shadcn DropdownMenu，保留锚点类仅用于
//   多选导出/截图复制的节点排除。）
// ============================================================

type SessionModifiedFile = {
	path: string;
	toolName: string;
	status: string;
	changedLines?: number;
	/** 工具执行前的文件原始内容，用于历史会话恢复时展示差异对比。 */
	originalContent?: string;
	/** 工具写入/编辑后的新文件内容，优先于从磁盘实时读取（历史会话恢复时磁盘可能已变化或文件已删除）。 */
	content?: string;
};


/**
 * 美元→人民币估算汇率：仅用于费用提示的便捷换算（约合金额），非实时牌价。
 * 如需跟随实时汇率或用户自定义，可升级为设置项（usdToCnyRate）。
 */
export const USD_TO_CNY_RATE = 7.2;

export type SessionDetailRow = { label: string; value: string; emphasis?: boolean };

export type SessionStatusDetail = {
	detailRows: SessionDetailRow[];
	/** 最近一条回复的性能指标（TTFT/总耗时/tps）：与上下文累计量分开展示，避免误读为整段会话均值 */
	replyPerfRows: SessionDetailRow[];
	hasDetail: boolean;
};

/**
 * 由 runtime 状态构建会话状态详情行（SessionStatus tooltip 与圆环面板共用）。
 * 纯函数：label/value 已本地化，调用方只负责布局。
 */
export function buildSessionStatusDetail(
	state:
		| Pick<
				AgentRuntimeState,
				| "contextPercent" | "contextTokens" | "contextWindow"
				| "inputTokens" | "outputTokens"
				| "cacheRead" | "cacheWrite" | "cacheTotal" | "cacheHitPercent"
				| "ttftMs" | "totalMs" | "tps" | "cost"
		  >
		| undefined,
	averageCacheHit: number | undefined,
	averageCacheHitSampleCount: number,
): SessionStatusDetail {
	const detailRows: SessionDetailRow[] = [];
	const replyPerfRows: SessionDetailRow[] = [];
	if (!state) return { detailRows, replyPerfRows, hasDetail: false };
	// 美元→人民币估算汇率（仅用于费用提示的便捷换算，非实时牌价；
	// 如后续需要跟随实时汇率，可升级为设置项 usdToCnyRate）
	const cnyAmount = state.cost != null
		? `¥${(state.cost * USD_TO_CNY_RATE).toFixed(2)}`
		: undefined;

	if (state.contextPercent != null || state.contextTokens != null) {
		detailRows.push({
			label: t("ctx.detail.context"),
			value: `${state.contextPercent != null ? `${state.contextPercent.toFixed(1)}%` : "-"} / ${formatCompact(state.contextTokens)} / ${formatCompact(state.contextWindow)}`,
		});
	}
	if (state.inputTokens != null || state.outputTokens != null) {
		detailRows.push({
			label: t("ctx.detail.tokens"),
			value: `↑ ${formatCompact(state.inputTokens)} / ↓ ${formatCompact(state.outputTokens)}`,
		});
	}
	if (state.cacheRead != null || state.cacheWrite != null) {
		detailRows.push({
			label: t("ctx.detail.cacheIO"),
			value: `${t("ctx.detail.cacheRead")} ${formatCompact(state.cacheRead)} / ${t("ctx.detail.cacheWrite")} ${formatCompact(state.cacheWrite)}`,
		});
	}
	if (state.cacheTotal != null) {
		detailRows.push({
			label: t("ctx.detail.cacheTotal"),
			value: formatCompact(state.cacheTotal),
		});
	}
	if (state.cacheHitPercent != null) {
		detailRows.push({
			label: t("ctx.detail.hitLatest"),
			value: `${state.cacheHitPercent.toFixed(1)}%`,
		});
	}
	if (averageCacheHit != null) {
		detailRows.push({
			label: t("ctx.detail.hitAverage"),
			value: `${averageCacheHit.toFixed(1)}% (${averageCacheHitSampleCount} ${t("ctx.detail.snapshots")})`,
		});
	}
	// 这些值来自 AgentManager 的 lastPerfByAgent，只代表最近一条 assistant 回复，
	// 不能和上下文累计量混在同一组，否则用户会误以为是整段会话的平均性能。
	if (state.ttftMs != null) {
		replyPerfRows.push({ label: t("ctx.detail.ttft"), value: formatDuration(state.ttftMs) });
	}
	if (state.totalMs != null) {
		replyPerfRows.push({ label: t("ctx.detail.total"), value: formatDuration(state.totalMs) });
	}
	if (state.tps != null) {
		replyPerfRows.push({ label: t("ctx.detail.tps"), value: `${state.tps.toFixed(0)} tok/s` });
	}
	if (state.cost != null) {
		detailRows.push({ label: t("ctx.detail.cost"), value: `$${state.cost.toFixed(3)}`, emphasis: true });
		detailRows.push({ label: t("ctx.detail.costCny"), value: cnyAmount ?? "-", emphasis: true });
	}
	return { detailRows, replyPerfRows, hasDetail: detailRows.length > 0 || replyPerfRows.length > 0 };
}

export function SessionStatus(props: {
	state?: AgentRuntimeState;
	duration?: number;
	/** 本会话历史缓存命中率快照，用于展示会话平均命中率 */
	cacheHitHistory?: number[];
}) {
	const state = props.state;
	if (!state) return null;
	// 会话平均缓存命中率：主进程基于会话文件全部 assistant 消息 usage 算出的
	// 真实平均优先；渲染层快照历史均值仅作为无文件样本时的降级回退。
	const history = props.cacheHitHistory ?? [];
	const averageCacheHit = state.cacheHitAveragePercent ?? (
		history.length > 0
			? history.reduce((sum, value) => sum + value, 0) / history.length
			: undefined
	);
	const averageCacheHitSampleCount = state.cacheHitSampleCount ?? history.length;
	const { detailRows, replyPerfRows, hasDetail } = buildSessionStatusDetail(
		state,
		averageCacheHit,
		averageCacheHitSampleCount,
	);
	// cost-chip 悬浮提示里的人民币估算（与明细行共用同一汇率常量）
	const cnyAmount = state.cost != null
		? `¥${(state.cost * USD_TO_CNY_RATE).toFixed(2)}`
		: undefined;

	const statusInner = (
		<div className="session-status">
			{state.contextPercent != null && (
				<span className="ctx-chip">
					{t("app.ctx")}:{" "}
					{state.contextPercent?.toFixed?.(1) ??
						state.contextPercent}
					% / {formatCompact(state.contextWindow)}
				</span>
			)}
			{(state.cacheHitPercent != null) && (
				<span className="cache-chip">
					{t("app.cacheHit")}: {state.cacheHitPercent?.toFixed?.(0) ?? state.cacheHitPercent}%
				</span>
			)}
			{/* 平均命中率只在悬停明细中展示（ctx.detail.hitAverage），头部不再显示单独 chip */}
			{state.cost != null && (
				<span className="cost-chip" title={t("app.totalCostCny", {
					usd: `$${state.cost.toFixed(3)}`,
					cny: cnyAmount ?? "-",
				})}>
					${state.cost.toFixed(3)}
				</span>
			)}
		</div>
	);

	if (!hasDetail) return statusInner;
	// 用有标题的 popover 承载明细：标题解释这组数字，行内用标签/数值对比降低阅读成本。
	return (
		<Tooltip>
			<TooltipTrigger asChild>{statusInner}</TooltipTrigger>
			<TooltipContent
				side="bottom"
				align="end"
				sideOffset={8}
				arrowClassName="!bg-popover !fill-popover"
				className="ctx-detail-tooltip !w-auto min-w-64 max-w-[min(320px,calc(100vw-24px))] !rounded-md !border !border-border !bg-popover !px-3 !py-2.5 !text-popover-foreground !shadow-lg"
			>
				<div className="grid gap-2.5">
					<div className="flex items-center justify-between gap-4 border-b border-border/70 pb-2">
						<span className="text-caption font-semibold text-popover-foreground">{t("ctx.detail.title")}</span>
						<span className="text-micro text-muted-foreground">{t("app.ctx")}</span>
					</div>
					<div className="grid gap-1">
						{detailRows.map((row) => (
							<div
								key={row.label}
								className={`flex items-baseline justify-between gap-4 px-1 py-0.5 text-caption leading-5${row.emphasis ? " mt-1 border-t border-border/70 pt-1.5" : ""}`}
							>
								<span className="shrink-0 text-muted-foreground">{row.label}</span>
								<span className="min-w-0 text-right font-mono font-semibold tabular-nums text-popover-foreground">{row.value}</span>
							</div>
						))}
					</div>
					{replyPerfRows.length > 0 && (
						<div className="mt-2.5 grid gap-1 border-t border-border/70 pt-2">
							<div className="px-1 text-micro font-semibold uppercase tracking-wide text-muted-foreground">
								{t("ctx.detail.lastReply")}
							</div>
							{replyPerfRows.map((row) => (
								<div key={row.label} className="flex items-baseline justify-between gap-4 px-1 py-0.5 text-caption leading-5">
									<span className="shrink-0 text-muted-foreground">{row.label}</span>
									<span className="min-w-0 text-right font-mono font-semibold tabular-nums text-popover-foreground">{row.value}</span>
								</div>
							))}
						</div>
					)}
				</div>
			</TooltipContent>
		</Tooltip>
	);
}

function formatCompact(value?: number | null) {
	if (value == null) return "-";
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
	if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
	return String(value);
}

export function LogoMark({ size = 32 }: { size?: number } = {}) {
	// size 默认 32（错误页/小型场景）；起始页/引导页传 56 放大品牌存在感
	return (
		<div
			className="logo-mark relative grid place-items-center overflow-hidden rounded-md bg-black text-white shadow-sm ring-1 ring-white/15"
			style={{ width: size, height: size }}
			aria-label={t("app.logoLabel")}
		>
			{/* 使用独立渐变而不是 currentColor，让 LogoMark 在浅色/深色主题下都保持黑底白标的品牌对比。 */}
			<svg viewBox="140 140 520 520" width={Math.round(size * 0.5625)} height={Math.round(size * 0.5625)} aria-hidden="true">
				<defs>
					<linearGradient id="logo-mark-silver" x1="0.2" y1="0" x2="0.8" y2="1">
						<stop stopColor="#ffffff" />
						<stop offset="0.5" stopColor="#f4f4f5" />
						<stop offset="1" stopColor="#a7a8ab" />
					</linearGradient>
				</defs>
				<path
					fill="url(#logo-mark-silver)"
					fillRule="evenodd"
					d="M165.29 165.29H517.36V400H400V517.36H282.65V634.72H165.29ZM282.65 282.65V400H400V282.65Z"
				/>
				<path fill="url(#logo-mark-silver)" d="M517.36 400H634.72V634.72H517.36Z" />
			</svg>
		</div>
	);
}


export function AgentAvatar(props: { status: string }) {
	const normalizedStatus = props.status === "running" || props.status === "starting" || props.status === "error" ? props.status : "idle";
	return (
		<div className={`conversation-avatar agent-avatar avatar-status-${normalizedStatus}`} data-avatar-status={normalizedStatus}>
			<span className="agent-avatar-mark" aria-hidden="true">
			<svg viewBox="140 140 520 520" width="28" height="28" aria-hidden="true">
				<path
					fill="#fff"
					fillRule="evenodd"
					d="M165.29 165.29H517.36V400H400V517.36H282.65V634.72H165.29ZM282.65 282.65V400H400V282.65Z"
				/>
				<path fill="#fff" d="M517.36 400H634.72V634.72H517.36Z" />
			</svg>
			</span>
			<span className="avatar-status-indicator" aria-label={normalizedStatus}>
				{normalizedStatus === "error" ? <CircleAlert size={8} strokeWidth={2.5} /> : normalizedStatus === "starting" ? <CircleDot size={8} strokeWidth={2.5} /> : normalizedStatus === "running" ? <LoaderCircle size={8} strokeWidth={2.5} className="animate-spin" /> : <Check size={8} strokeWidth={2.5} />}
			</span>
		</div>
	);
}

// ============================================================
// 会话时间线渲染组件（借鉴 opencode 扁平 timeline 风格重写）
// 设计要点：
// - 助手内容去掉气泡，改为左对齐扁平排版，用左侧竖线聚合一轮对话
// - 工具调用做成独立可折叠卡片，trigger 行 + 展开内容，内联在 timeline 里
// - 用户消息保留右对齐气泡，但收窄并去掉头像，操作栏 hover 显隐
// - 思考过程做成轻量折叠卡片，不再占用大块气泡空间
// ============================================================

/** 助手正文：扁平 markdown 渲染，无气泡包裹，全宽排版，支持内嵌图片。
 *  路径链接化用 remark 插件在 mdast 层处理（见底部 remarkLinkifyPaths），不再前置改写原始字符串。 */
export const AssistantText = memo(
	function AssistantText(props: {
		text: string;
		images?: ImageContent[];
		onPreviewImage: (image: ImageContent) => void;
		onOpenExternal: (url: string) => void;
		onOpenFile?: (path: string) => void;
		/** 当前消息是否正在流式追加。为 true 时走轻量渲染路径，跳过 KaTeX 数学解析与
		 *  mermaid 图渲染，避免每个 token 都对不断增长的全量正文调用重型插件导致主线程卡死。 */
		isStreaming?: boolean;
		/** live→settled 交接时播放一次淡入 */
		settle?: boolean;
	}) {
		// 清理 ANSI 转义码与 <thinking> 标签，thinking 由调用方通过 ThinkingBlock 渲染
		const cleanText = stripThinkingTags(stripAnsi(props.text));
		// 统一 Streamdown 引擎（迁移后唯一 markdown 管线）：流式由引擎按 block memo、
		// 半截 markdown 由 remend 容错补全，不再需要旧管线的流式/静态双路径切换。
		return (
			<div
				className="assistant-text markdown-body"
				data-settle={props.settle ? "1" : undefined}
			>
				{props.images && props.images.length > 0 && (
					<div className="message-images">
						{props.images.map((img, index) => (
							<MessageImage
								key={index}
								src={`data:${img.mimeType};base64,${img.data}`}
								alt={t("app.imageAlt", { index: index + 1 })}
								className="message-image"
								placeholderClass="min-h-24"
								onClick={() => props.onPreviewImage(img)}
							/>
						))}
					</div>
				)}
				<MarkdownStream
					text={cleanText}
					isStreaming={Boolean(props.isStreaming)}
					onOpenExternal={props.onOpenExternal}
					onOpenFile={props.onOpenFile}
				/>
			</div>
		);
	},
	// 自定义比较：文本、流式标记、图片一致时跳过重渲染。回调函数（onPreviewImage/onOpenExternal/
	// onOpenFile）行为稳定（读 ref 或 setState），不参与比较，避免 App 每次渲染新建内联箭头
	// 函数导致 memo 失效——历史消息在流式期间因此不再重复解析 Markdown，从根上消除卡顿。
	(prev, next) =>
		prev.text === next.text &&
		prev.isStreaming === next.isStreaming &&
		prev.settle === next.settle &&
		prev.images === next.images,
);

/** 视觉桥「请求详情」展开面板：展示最近一次 input 转换的模型/耗时/token/提示词与每张图结果。
 * 事件数据来自扩展写的 pi-deck-vision-events.jsonl（经 IPC 拉取），与消息文本里的图片 #N 序号同源。 */
function VisionBridgeDetail(props: { events: VisionEventsInfo | null; loading: boolean }) {
	if (props.loading) {
		return <p className="mt-2 text-[11px] text-muted-foreground">…</p>;
	}
	const batch = props.events?.events.filter((e) => e.kind === "input").at(-1);
	if (!batch) {
		return <p className="mt-2 text-[11px] text-muted-foreground">{t("app.visionNoEvents")}</p>;
	}
	return (
		<div className="mt-2 border-t border-border/60 pt-2 text-[11px] leading-relaxed text-muted-foreground">
			<div className="flex flex-wrap items-center gap-x-3 gap-y-1">
				<span className="font-mono text-foreground/80">{batch.model}</span>
				<span>{formatDuration(batch.totalDurationMs)}</span>
				<span>{t("app.imageAlt", { index: batch.items.length })}</span>
			</div>
			<ul className="mt-1 space-y-0.5">
				{batch.items.map((it) => (
					<li key={it.index} className={it.ok ? "" : "text-danger"}>
						{t("app.visionRequestItem", {
							index: it.index,
							duration: it.cached ? "" : `${formatDuration(it.durationMs)} · `,
							tokens:
								typeof it.outputTokens === "number"
									? `${t("app.visionOutputTokens", { count: it.outputTokens })} · `
									: "",
							status: it.cached
								? t("app.visionCacheHit")
								: it.ok
									? ""
									: t("app.visionRequestFailed", { error: it.error ?? "" }),
						})}
					</li>
				))}
			</ul>
			<p className="mt-1 truncate" title={batch.prompt}>
				{t("app.visionRequestPrompt")}：{batch.prompt}
			</p>
		</div>
	);
}

/**
 * 从用户消息文本中提取 pi 展开后的 <skill name="..." location="...">...</skill> 块。
 * pi 在发送 /skill:name 时会把 skill 内容展开成该 XML 块注入用户消息，
 * 这里在展示层把它们识别出来，渲染成 skill 徽标，并把原始 XML 从正文里剥除。
 * 返回 { skills, text }：skills 为 skill 名列表，text 为移除 skill 块后的正文。
 */
function extractSkillBlocks(text: string): { skills: string[]; text: string } {
	const skills: string[] = [];
	// 非贪婪匹配 skill 块；name/location 属性顺序与引号样式兼容 pi 实际输出
	const re = /<skill\s+name="([^"]+)"[^>]*>[\s\S]*?<\/skill>/gi;
	const cleaned = text.replace(re, (_m, name: string) => {
		if (name) skills.push(name);
		return "";
	});
	return { skills, text: cleaned.trim() };
}

/** 用户消息：右对齐气泡 + 附件 + hover 显隐操作栏（复制/编辑/删除/重发/修改输入框）。
 * 编辑分两种：原地编辑（修改 JSONL + 重载会话）和修改输入框（放回 composer 不自动发送）。 */
export const UserBubble = memo(function UserBubble(props: {
	message: ChatMessage;
	/** 新消息入场动画：发送后乐观上屏的用户消息播放一次 */
	fresh?: boolean;
	onPreviewImage: (image: ImageContent) => void;
	onOpenFile?: (path: string) => void;
	onResendUserMessage?: (message: ChatMessage) => void;
	onEditMessage?: (messageId: string, newText: string) => void;
	onDeleteMessage?: (messageId: string) => void;
	/** 从该用户消息 fork 新会话；忙碌时不展示入口 */
	onForkMessage?: (message: ChatMessage) => void;
	/** 是否为最后一条用户消息，用于控制重发按钮的显隐 */
	isLastUserMessage?: boolean;
	/** 仅当该消息后出现 error/abort 时显示重发（取代无条件 isLastUserMessage） */
	showResendButton?: boolean;
	validCommandNames?: Set<string>;
	validFilePaths?: Set<string>;
	/** Agent 正在处理请求或流式输出中时禁用编辑/删除等操作按钮 */
	agentRunning?: boolean;
	/** fork 进行中：仅当前消息禁用按钮，避免连点重复 fork */
	forking?: boolean;
	/** 打开多选分享弹框 */
	onEnterMultiSelect?: () => void;
}) {
	const { message } = props;
	// 空闲时始终展示 fork 入口；entryId 解析放到点击时做（meta 缺失时走 getForkMessages 回退）。
	const canFork = Boolean(props.onForkMessage) && !props.agentRunning;
	const rowRef = useRef<HTMLElement | null>(null);
	const [editing, setEditing] = useState(false);
	const [editText, setEditText] = useState("");
	const editAreaRef = useRef<HTMLDivElement | null>(null);
	// 编辑是跨渲染周期的长时操作：进入编辑时捕获当次提交回调，保存时用捕获值。
	// 若保存时才读最新 props，Agent 重启后回调已换绑新 generation target，会把旧
	// 编辑重定向到新 runtime、绕过 freshness 校验（见 trackedEditSubmit.ts 注释）。
	const trackedEditSubmit = useRef(createTrackedEditSubmit());
	/** 进入编辑模式：捕获当前 onEditMessage（绑定当时的 runtime target）。 */
	const startEditingWithCurrentTarget = () => {
		trackedEditSubmit.current.begin(props.onEditMessage);
		setEditText(cleanText);
		setEditing(true);
	};
	// 长消息折叠（2026-08）：超过 8 行（line-clamp-8）折叠为预览，避免超长发送全量铺开；
	// 溢出检测用 ResizeObserver 对比 scrollHeight/clientHeight，折叠态下才测量（展开态保持按钮可见）。
	const [messageExpanded, setMessageExpanded] = useState(false);
	const [messageOverflowing, setMessageOverflowing] = useState(false);
	const userTextRef = useRef<HTMLDivElement | null>(null);
	// 视觉桥「请求详情」展开态：事件数据懒加载（用户点击才拉取，避免每条消息都读事件文件）
	const [visionDetailOpen, setVisionDetailOpen] = useState(false);
	const [visionEvents, setVisionEvents] = useState<VisionEventsInfo | null>(null);
	const [visionLoading, setVisionLoading] = useState(false);
	const loadVisionEvents = useCallback(async () => {
		if (visionEvents || visionLoading) return;
		setVisionLoading(true);
		try {
			setVisionEvents(await window.piDesktop.config.visionGetEvents());
		} catch {
			// 读取失败保持空态（卡片仍显示，详情区显示暂无记录）
			setVisionEvents({ exists: false, size: 0, events: [], truncated: false });
		} finally {
			setVisionLoading(false);
		}
	}, [visionEvents, visionLoading]);
	// 实时消息的视觉桥卡片：pi 只把转换结果写会话文件、不推送给实时消息流，
	// 因此对带图片的乐观消息轮询事件文件，按图片哈希匹配本次转换批次。
	const [imageHashes, setImageHashes] = useState<string[] | null>(null);
	const [visionMatch, setVisionMatch] = useState<VisionBridgeEvent | null>(null);
	const [visionPolling, setVisionPolling] = useState(false);
	// 图片哈希与扩展侧 imageHash（sha256 前 24 位）同源，跨进程可匹配
	useEffect(() => {
		const images = message.images ?? [];
		if (images.length === 0) return;
		let cancelled = false;
		void visionImageHashes(images.map((image) => image.data)).then((hashes) => {
			if (!cancelled) setImageHashes(hashes);
		});
		return () => {
			cancelled = true;
		};
	}, [message.images]);
	// 激活编辑时自动滚动到编辑区
	useEffect(() => {
		if (editing && editAreaRef.current) {
			editAreaRef.current.scrollIntoView({ behavior: "smooth", block: "nearest" });
		}
	}, [editing]);
	// 长消息折叠溢出检测：折叠态 clamp 生效后 scrollHeight > clientHeight 即溢出；
	// 窗口缩放/内容变化（chips 换行）都会经 ResizeObserver 重新测量。
	useLayoutEffect(() => {
		const el = userTextRef.current;
		if (!el) return;
		const check = () => {
			if (messageExpanded) return; // 展开态无需测量，保持按钮可见
			setMessageOverflowing(el.scrollHeight > el.clientHeight + 1);
		};
		check();
		const observer = new ResizeObserver(check);
		observer.observe(el);
		return () => observer.disconnect();
	}, [messageExpanded]);
	// 视觉桥块：pi-deck-vision 扩展把用户消息里的图片换成描述文本时，会在消息里
	// 留下「[图片 #N（视觉桥已查看...）]」/失败标记。先剥出块，渲染成可视化卡片，
	// 用户才能直观看到「走了视觉桥」以及转换结果/失败原因，而不是一段方括号文本。
	const vision = extractVisionBridgeBlocks(stripAnsi(message.text));
	const visionBlocks = vision.blocks;
	// 发送后短窗口内轮询事件文件（0/700/1800/3200ms），命中即渲染实时卡片，超时静默放弃。
	// 依赖 visionBlocks.length：历史消息文本里已有标记块时走文本卡片，不再轮询。
	useEffect(() => {
		const images = message.images ?? [];
		if (images.length === 0 || visionBlocks.length > 0 || !imageHashes || imageHashes.length === 0) {
			return;
		}
		let cancelled = false;
		let timer: number | undefined;
		const delays = [0, 700, 1800, 3200];
		let attempt = 0;
		const poll = async () => {
			if (cancelled) return;
			setVisionPolling(true);
			try {
				const info = await window.piDesktop.config.visionGetEvents();
				if (cancelled) return;
				const matched = matchVisionBridgeEvent(info.events, imageHashes, message.timestamp);
				if (matched) {
					setVisionMatch(matched);
					setVisionPolling(false);
					return;
				}
			} catch {
				// 拉取失败静默，等下一轮重试
			}
			attempt++;
			if (attempt < delays.length) timer = window.setTimeout(poll, delays[attempt]);
			else setVisionPolling(false);
		};
		void poll();
		return () => {
			cancelled = true;
			if (timer !== undefined) window.clearTimeout(timer);
		};
	}, [imageHashes, message.images, message.timestamp, visionBlocks.length]);
	// 提取 pi 展开后的 <skill> 块：渲染为 skill 徽标，并从正文里剥除 XML
	const { skills, text: bodyText } = extractSkillBlocks(vision.text);
	const cleanText = bodyText;
	// 投递策略标签：steer(下次调用前插入) / followUp(停止后排队)
	const deliveryBehavior = message.meta?.streamingBehavior as
		| "steer"
		| "followUp"
		| undefined;
	const deliveryLabel =
		deliveryBehavior === "steer"
			? t("app.messageDeliverySteer")
			: deliveryBehavior === "followUp"
				? t("app.messageDeliveryFollowUp")
				: null;
	/** 原地编辑不影响输入框；先提交给确认弹窗。 */
	const handleSaveEdit = () => {
		// 不再依赖当前 props.onEditMessage：runtime 消失时它会被置为 undefined，
		// 若用它拦截保存会让已打开的编辑框静默无效。捕获回调存在即派发，
		// target 已过期/消失由 hook 的 freshness 校验拒绝并提示 runtimeChanged。
		if (editText.trim() && trackedEditSubmit.current.submit(message.id, editText)) {
			setEditing(false);
		}
	};
	/** 编辑后重发：放回 composer 输入框，由用户自行修改后发送。 */
	const handleEditAndResend = () => {
		document.querySelector<HTMLElement>(".composer-box .rich-input, .composer-box textarea")?.focus();
		window.dispatchEvent(
			new CustomEvent("user-message-edit", { detail: { text: message.text } }),
		);
	};
	return (
		<article /* user-turn 为 e2e 选择器锚点 */ ref={rowRef} className={`user-turn group/user mb-4 flex w-full min-w-0 max-w-full flex-col items-end ${props.fresh ? "user-turn--fresh animate-[message-enter_260ms_cubic-bezier(0.22,1,0.36,1)_both]" : ""}`} data-message-id={message.id}>
			{skills.length > 0 && (
				<div className="mb-1.5 flex flex-wrap justify-end gap-1.5">
					{skills.map((name) => (
						<span key={name} className="user-turn-skill-badge inline-flex items-center gap-0.5 rounded-full border border-border bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground" title={`/${name}`}>
							<span className="font-mono text-[11px] font-medium text-muted-foreground">/</span>
							{name}
						</span>
					))}
				</div>
			)}
			{message.images && message.images.length > 0 && (
				<div className="mb-2 flex max-w-[min(82%,64ch)] flex-wrap justify-end gap-2">
					{message.images.map((img, index) => (
						<MessageImage
							key={index}
							src={`data:${img.mimeType};base64,${img.data}`}
							alt={t("app.imageAlt", { index: index + 1 })}
							className="size-16 max-h-40 cursor-pointer rounded-md border border-border object-cover transition-colors duration-150 hover:border-border-strong"
							onClick={() => props.onPreviewImage(img)}
						/>
					))}
				</div>
			)}
			{visionBlocks.length > 0 && (
				<div className="mb-2 flex w-full max-w-[min(82%,64ch)] flex-col items-end gap-1.5">
					{visionBlocks.map((block, bi) =>
						block.kind === "success" ? (
							// 成功：徽章行（图标 + 视觉桥已查看 + 图片序号）+ 描述正文
							<div
								key={bi}
								className="vision-bridge-card w-full min-w-0 rounded-lg border border-border bg-background/70 p-2.5"
								title={t("app.visionBridgeSeenDesc")}
							>
								<div className="flex items-center justify-between gap-2">
									<div className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
										<Eye size={12} className="shrink-0 text-[var(--color-accent)]" />
										<span>{t("app.visionBridgeSeen")}</span>
										<span className="text-muted-foreground/60">·</span>
										<span>{t("app.visionBridgeImageLabel", { index: block.index })}</span>
									</div>
									<button
										type="button"
										className="inline-flex shrink-0 items-center gap-0.5 rounded-sm px-1 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
										onClick={() => {
											setVisionDetailOpen((open) => !open);
											if (!visionDetailOpen) void loadVisionEvents();
										}}
									>
										{visionDetailOpen ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
										{t("app.visionDetail")}
									</button>
								</div>
								{block.description && (
									<p className="mt-1.5 text-[13px] leading-[1.6] break-words whitespace-pre-wrap text-text-primary">
										{block.description}
									</p>
								)}
								{visionDetailOpen && (
									<VisionBridgeDetail events={visionEvents} loading={visionLoading} />
								)}
							</div>
						) : (
							// 失败：红色卡片，原因直出，用户不用去设置页翻日志
							<div
								key={bi}
								className="w-full min-w-0 rounded-lg border border-danger/40 bg-danger-soft/40 p-2.5"
								title={t("app.visionBridgeFailedDesc")}
							>
								<div className="flex items-center gap-1.5 text-[11px] font-medium text-danger">
									<AlertTriangle size={12} className="shrink-0" />
									<span>{t("app.visionBridgeFailed")}</span>
									<span className="text-danger/60">·</span>
									<span>{t("app.visionBridgeImageLabel", { index: block.index })}</span>
								</div>
								{block.reason && (
									<p className="mt-1.5 text-[13px] leading-[1.6] break-words text-danger/90">
										{block.reason}
									</p>
								)}
							</div>
						),
					)}
				</div>
			)}
			{/* 实时消息：文本里没有标记块（转换结果只写会话文件），用事件文件匹配渲染卡片 */}
			{visionBlocks.length === 0 && visionPolling && !visionMatch && (
				<div className="mb-2 flex w-full max-w-[min(82%,64ch)] flex-col items-end">
					<div className="flex items-center gap-1.5 rounded-lg border border-border bg-background/70 px-2.5 py-1.5 text-[11px] text-muted-foreground">
						<Loader2 size={11} className="animate-spin" />
						<span>{t("app.visionConverting")}</span>
					</div>
				</div>
			)}
			{visionBlocks.length === 0 && visionMatch && (
				<div className="mb-2 flex w-full max-w-[min(82%,64ch)] flex-col items-end gap-1.5">
					{visionMatch.items.map((item) =>
						item.ok ? (
							// 成功：徽章行（图标 + 视觉桥已查看 + 图片序号）+ 描述正文（与历史标记卡片同款）
							<div
								key={item.index}
								className="vision-bridge-card w-full min-w-0 rounded-lg border border-border bg-background/70 p-2.5"
								title={t("app.visionBridgeSeenDesc")}
							>
								<div className="flex items-center justify-between gap-2">
									<div className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
										<Eye size={12} className="shrink-0 text-[var(--color-accent)]" />
										<span>{t("app.visionBridgeSeen")}</span>
										<span className="text-muted-foreground/60">·</span>
										<span>{t("app.visionBridgeImageLabel", { index: item.index })}</span>
									</div>
									<button
										type="button"
										className="inline-flex shrink-0 items-center gap-0.5 rounded-sm px-1 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
										onClick={() => {
											setVisionDetailOpen((open) => !open);
											if (!visionDetailOpen) void loadVisionEvents();
										}}
									>
										{visionDetailOpen ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
										{t("app.visionDetail")}
									</button>
								</div>
								{item.description && (
									<p className="mt-1.5 text-[13px] leading-[1.6] break-words whitespace-pre-wrap text-text-primary">
										{item.description}
									</p>
								)}
								{visionDetailOpen && (
									<VisionBridgeDetail events={visionEvents} loading={visionLoading} />
								)}
							</div>
						) : (
							// 失败：红色卡片，原因直出（与历史标记卡片同款）
							<div
								key={item.index}
								className="w-full min-w-0 rounded-lg border border-danger/40 bg-danger-soft/40 p-2.5"
								title={t("app.visionBridgeFailedDesc")}
							>
								<div className="flex items-center gap-1.5 text-[11px] font-medium text-danger">
									<AlertTriangle size={12} className="shrink-0" />
									<span>{t("app.visionBridgeFailed")}</span>
									<span className="text-danger/60">·</span>
									<span>{t("app.visionBridgeImageLabel", { index: item.index })}</span>
								</div>
								{item.error && (
									<p className="mt-1.5 text-[13px] leading-[1.6] break-words text-danger/90">
										{item.error}
									</p>
								)}
							</div>
						),
					)}
				</div>
			)}
			{cleanText && !editing && (
				<div className="user-turn-bubble w-fit min-w-0 max-w-[min(82%,64ch)] rounded-[14px] border border-border bg-muted/60 px-3 py-2 text-sm text-foreground [overflow-wrap:anywhere] break-words">
					<div
						ref={userTextRef}
						className={`text-chat leading-[1.6] text-text-primary whitespace-pre-wrap break-words ${messageExpanded ? "" : "line-clamp-8"}`}
					>
						{renderChipText(cleanText, props.onOpenFile, props.validCommandNames, props.validFilePaths)}
					</div>
					{messageOverflowing && (
						<div className="relative mt-1 flex justify-end">
							{/* 折叠态底部渐变提示还有内容；展开态不需要 */}
							{!messageExpanded && (
								<div className="pointer-events-none absolute inset-x-0 -top-6 h-6 bg-gradient-to-t from-muted/70 to-transparent" aria-hidden="true" />
							)}
							<button
								type="button"
								className="inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-micro text-text-tertiary transition-colors duration-150 hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)]"
								onClick={() => setMessageExpanded((v) => !v)}
								aria-expanded={messageExpanded}
							>
								{messageExpanded ? <ChevronUp size={11} aria-hidden="true" /> : <ChevronDown size={11} aria-hidden="true" />}
								{messageExpanded ? t("app.messageCollapse") : t("app.messageExpand")}
							</button>
						</div>
					)}
				</div>
			)}
			{editing && (
				<div className="flex w-full min-w-0 flex-col gap-2 rounded-md border border-border-subtle bg-[color:color-mix(in_srgb,var(--color-accent)_3%,var(--color-bg-panel))] pl-2" ref={editAreaRef}>
					<div className="flex items-center gap-1 text-xs font-medium text-[var(--color-accent)] before:content-['✎'] before:text-sm">{t("common.edit")}</div>
					<Textarea
						className="min-h-[100px] max-h-[400px] w-full resize-y rounded-sm border border-[var(--color-accent)] bg-bg-panel p-2 font-mono text-sm leading-relaxed text-text-primary outline-none focus:border-[var(--color-accent)] focus:shadow-[0_0_0_2px_var(--focus-ring)]"
						value={editText}
						onChange={(e) => setEditText(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
								e.preventDefault();
								handleSaveEdit();
							}
							if (e.key === "Escape") setEditing(false);
						}}
						autoFocus
					/>
					<div className="flex justify-end gap-2">
						<Button variant="outline" size="sm" className="h-auto border-[var(--color-accent)] px-3 py-1 text-xs text-[var(--color-accent)] shadow-none hover:text-[var(--color-accent)]" onClick={handleSaveEdit}>
							{t("common.save")}
						</Button>
						<Button variant="outline" size="sm" className="h-auto px-3 py-1 text-xs shadow-none" onClick={() => setEditing(false)}>
							{t("common.cancel")}
						</Button>
					</div>
				</div>
			)}
			<div className="mt-1 inline-flex items-center gap-2 text-[11px] tabular-nums text-text-tertiary">
				{deliveryLabel && (
					<span
						className={`inline-flex h-[18px] items-center rounded-full border border-[color-mix(in_srgb,var(--color-accent)_24%,var(--color-border-subtle))] bg-[var(--color-accent-soft)] px-[7px] font-mono text-[11px] font-semibold leading-none text-[var(--color-accent)]${
							deliveryBehavior === "followUp" ? " border-[color-mix(in_srgb,var(--color-info)_20%,var(--color-border-subtle))] bg-[color:color-mix(in_srgb,var(--color-info)_10%,var(--color-bg-panel))] text-[var(--color-info)]" : ""
						}`}
						title={
							deliveryBehavior === "followUp"
								? t("app.messageDeliveryFollowUpTitle")
								: t("app.messageDeliverySteerTitle")
						}
					>
						{deliveryLabel}
					</span>
				)}
				<time className="font-mono">{formatTime(message.timestamp)}</time>
			</div>
			<div className="user-turn-actions flex min-h-6 items-center gap-0.5 opacity-0 transition-opacity group-hover/user:opacity-100 focus-within:opacity-100">
				<CopyMenu text={stripMarkdown(cleanText)} markdown={message.text} targetRef={rowRef} />
				<Button
					type="button"
					variant="ghost"
					size="icon-sm"
					className="user-turn-action-btn size-7 rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground"
					onClick={props.onEnterMultiSelect}
					title={t("app.multiSelectEnter")}
				>
					<Share size={14} />
				</Button>
				{!editing && !props.agentRunning && (
					<>
						{canFork && (
							<Button
								type="button"
								variant="ghost"
								size="icon-sm"
								className="user-turn-action-btn size-7 rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground"
								disabled={props.forking}
								onClick={() => props.onForkMessage?.(message)}
								title={t("app.forkFromMessageTitle")}
								aria-label={t("app.forkFromMessage")}
							>
								<GitFork size={14} strokeWidth={1.8} aria-hidden="true" />
							</Button>
						)}
						{props.onEditMessage && (
							<Button
								type="button"
								variant="ghost"
								size="icon-sm"
								className="user-turn-action-btn size-7 rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground"
								onClick={startEditingWithCurrentTarget}
								title={t("common.edit")}
							>
								<SquarePen size={14} />
							</Button>
						)}
						<Button
							type="button"
							variant="ghost"
							size="icon-sm"
							className="user-turn-action-btn size-7 rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground"
							onClick={handleEditAndResend}
							title={t("app.editAndResendTitle")}
						>
							<UserPen size={14} />
						</Button>
						{props.onDeleteMessage && (
							<Button
								type="button"
								variant="ghost"
								size="icon-sm"
								className="user-turn-action-btn size-7 rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground"
								onClick={() => props.onDeleteMessage?.(message.id)}
								title={t("common.delete")}
							>
								<Trash size={14} />
							</Button>
						)}
						{((props.isLastUserMessage || props.showResendButton) && props.onResendUserMessage) && (
							<Button
								type="button"
								variant="ghost"
								size="icon-sm"
								className="user-turn-action-btn size-7 rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground"
								onClick={() => props.onResendUserMessage?.(message)}
								title={t("app.resendTitle")}
							>
								<Send size={14} />
							</Button>
						)}
					</>
				)}
			</div>
		</article>
	);
});

// ANSI 转义码正则:匹配 \x1b[...m 等终端颜色/样式序列
function stripThinkingTags(text: string): string {
	return text.replace(/<thinking>[\s\S]*?<\/thinking>/gi, "").trim();
}

/** 将 Markdown 语法转换为纯文本，保留可读的文字内容 */
export function stripMarkdown(text: string): string {
	return removeMarkdown(text, {
		// 保留列表项文本，移除列表标记符号
		stripListLeaders: true,
		// 使用 Unicode 字符替换列表标记
		listUnicodeChar: "",
		// 启用 GFM 表格/任务列表等处理
		gfm: true,
		// 图片保留 alt 文本
		useImgAltText: true,
	});
}

/** 将消息文本中的 @path / /command 渲染为行内 chip（聊天区展示用，与输入框 chip 视觉一致）。
 * 可通过 onOpenFile 回调使 chip 可点击跳转。 */
function renderChipText(text: string, onOpenFile?: (path: string) => void, validCommandNames?: Set<string>, validFilePaths?: Set<string>): ReactNode[] {
	const chips = parseRichInputChips(text, validCommandNames, validFilePaths);
	if (chips.length === 0) return [text];
	const nodes: ReactNode[] = [];
	let cursor = 0;
	for (const chip of chips) {
		if (chip.start > cursor) {
			nodes.push(text.slice(cursor, chip.start));
		}
		const clickable = onOpenFile && chip.kind === "file";
		nodes.push(
			<span
				key={`chip-${chip.start}`}
				className={`input-chip input-chip--${chip.kind}${clickable ? " clickable" : ""}`}
				data-type={chip.kind}
				data-raw={chip.raw}
				title={chip.raw}
				onClick={clickable ? () => onOpenFile(unwrapFileChipPath(chip.raw)) : undefined}
			>
				<span className="input-chip__icon">
					{chip.kind === "file" ? "@" : "/"}
				</span>
				<span className="input-chip__label">{chip.label}</span>
			</span>,
		);
		cursor = chip.end;
	}
	if (cursor < text.length) {
		nodes.push(text.slice(cursor));
	}
	return nodes;
}

export { ToolCard, ToolGroupCard };
export {
	AskQuestionCard,
	CompactionCard,
	DiagnosticMessageCard,
	RespondingIndicator,
	ThinkingBlock,
};
export { MultiSelectModal };

/** 将毫秒数格式化为短可读形式,如 "3.2s" "1m23s" */
type EntryAction = {
	active?: boolean;
	label: string;
	onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
	icon: ReactNode;
	/** 真 HTML disabled（鼠标/键盘均不可触发）；用于全局安全门控，如 Skills 快捷入口。 */
	disabled?: boolean;
};

export function ConversationOutline(props: {
	items: Array<{ id: string; role: string; title: string; time: string }>;
	onJump: (id: string) => void;
	extraAction?: EntryAction;
	terminalAction?: EntryAction;
	filesAction?: EntryAction;
	gitAction?: EntryAction;
	editorsAction?: EntryAction & { anchorRef?: React.RefObject<HTMLButtonElement | null> };
	browserAction?: EntryAction;
	skillsAction?: EntryAction;
}) {
	const [expanded, setExpanded] = useState(false);
	const [dragging, setDragging] = useState(false);
	const [top, setTop] = useState(() => getInitialOutlineTop());
	const dragRef = useRef<{ startY: number; startTop: number } | null>(null);
	const topRef = useRef(top);
	const visibleItems = expanded ? props.items : props.items.slice(-15);
	const hasMore = props.items.length > 15;

	useEffect(() => {
		topRef.current = top;
	}, [top]);

	useEffect(() => {
		if (!dragging) return;
		function onMove(event: PointerEvent) {
			const drag = dragRef.current;
			if (!drag) return;
			setTop(clampOutlineTop(drag.startTop + event.clientY - drag.startY));
		}
		function onUp() {
			setDragging(false);
			dragRef.current = null;
			localStorage.setItem(OUTLINE_TOP_STORAGE_KEY, String(topRef.current));
		}
		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onUp);
		return () => {
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onUp);
		};
	}, [dragging]);

	useEffect(() => {
		const onResize = () => setTop((value) => clampOutlineTop(value));
		window.addEventListener("resize", onResize);
		return () => window.removeEventListener("resize", onResize);
	}, []);

	function startDrag(event: ReactPointerEvent<HTMLElement>) {
		event.preventDefault();
		event.stopPropagation();
		dragRef.current = { startY: event.clientY, startTop: topRef.current };
		setDragging(true);
	}

	return (
		<div
			className={`outline-hover${dragging ? " dragging" : ""}`}
			style={{ "--outline-top": `${top}px` } as React.CSSProperties}
		>
			<div className="outline-zone">
				<button
					className={`outline-trigger${props.items.length > 0 ? "" : " is-disabled"}`}
					disabled={props.items.length === 0}
					title={t("outline.trigger", { count: props.items.length })}
					onPointerDown={props.items.length > 0 ? startDrag : undefined}
				>
					☰
				</button>
				{props.items.length > 0 && (
				<nav className="conversation-outline">
				<div className="outline-title">
					<span
						className="outline-drag-handle"
						title={t("outline.drag")}
						onPointerDown={startDrag}
					>
						⋮⋮
					</span>
					<span>{t("outline.title")}</span>
					<span className="outline-count">{props.items.length}</span>
				</div>
				<div className="outline-list">
					{hasMore && !expanded && (
						<button
							className="outline-expand"
							onClick={() => setExpanded(true)}
						>
							{t("outline.showAll", { count: props.items.length })}
						</button>
					)}
					{visibleItems.map((item) => (
						<button
							key={item.id}
							className={
								item.role === "user" ? "outline-user" : "outline-assistant"
							}
							onClick={() => props.onJump(item.id)}
						>
							<strong>{item.title}</strong>
							<span>{item.time}</span>
						</button>
					))}
				</div>
				</nav>
				)}
			</div>
			{props.extraAction && (
				<button
					type="button"
					className={`scratch-pad-entry${props.extraAction.active ? " active" : ""}`}
					title={props.extraAction.label}
					aria-label={props.extraAction.label}
					onClick={props.extraAction.onClick}
				>
					{props.extraAction.icon}
				</button>
			)}
			{props.terminalAction && (
				<button
					type="button"
					className={`terminal-entry${props.terminalAction.active ? " active" : ""}`}
					title={props.terminalAction.label}
					aria-label={props.terminalAction.label}
					onClick={props.terminalAction.onClick}
				>
					{props.terminalAction.icon}
				</button>
			)}
			{props.filesAction && (
				<button
					type="button"
					className={`files-entry${props.filesAction.active ? " active" : ""}`}
					title={props.filesAction.label}
					aria-label={props.filesAction.label}
					onClick={props.filesAction.onClick}
				>
					{props.filesAction.icon}
				</button>
			)}
			{props.gitAction && (
				<button
					type="button"
					className={`git-entry${props.gitAction.active ? " active" : ""}`}
					title={props.gitAction.label}
					aria-label={props.gitAction.label}
					onClick={props.gitAction.onClick}
				>
					{props.gitAction.icon}
				</button>
			)}
			{props.editorsAction && (
				<button
					type="button"
					className={`editors-entry${props.editorsAction.active ? " active" : ""}`}
					title={props.editorsAction.label}
					aria-label={props.editorsAction.label}
					onClick={props.editorsAction.onClick}
				>
					{props.editorsAction.icon}
				</button>
			)}
			{props.skillsAction && (
				<button
					type="button"
					className={`skills-entry${props.skillsAction.active ? " active" : ""}`}
					title={props.skillsAction.label}
					aria-label={props.skillsAction.label}
					disabled={props.skillsAction.disabled}
					onClick={props.skillsAction.onClick}
				>
					{props.skillsAction.icon}
				</button>
			)}
			{props.browserAction && (
				<button
					type="button"
					className={`browser-entry${props.browserAction.active ? " active" : ""}`}
					title={props.browserAction.label}
					aria-label={props.browserAction.label}
					onClick={props.browserAction.onClick}
				>
					{props.browserAction.icon}
				</button>
			)}
		</div>
	);
}

const OUTLINE_TOP_STORAGE_KEY = "pi-desktop:outline-top";
function getInitialOutlineTop() {
	if (typeof window === "undefined") return 180;
	const saved = Number(localStorage.getItem(OUTLINE_TOP_STORAGE_KEY));
	if (Number.isFinite(saved) && saved > 0) return clampOutlineTop(saved);
	return clampOutlineTop(Math.round(window.innerHeight * 0.32));
}

function clampOutlineTop(value: number) {
	if (typeof window === "undefined") return value;
	return Math.min(window.innerHeight - 92, Math.max(76, value));
}

export { SessionFileSummary, SessionHistoryModal } from "./WorkspaceSurface";

export { FileContextMenu, PromptSuggestions } from "./ComposerOverlayComponents";

/** 会话管理弹框：展示项目所有会话，支持多选删除、导出、重命名 */
