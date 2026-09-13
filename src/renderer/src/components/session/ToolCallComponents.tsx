import { memo, useState, type ReactNode } from "react";
import {
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  CircleX,
  FileText,
  Folder,
  Globe2,
  Loader2,
  MessageCircle,
  Network,
  Search,
  Square,
  SquarePen,
  Terminal,
  Wrench,
} from "lucide-react";
import {
  countTextLines,
  getToolEditDiff,
  getToolFilePath,
  parseToolArgs,
  type ToolGroupItem,
} from "../app/AppUtils";
import { t } from "../../i18n";
import { Badge } from "../ui-shadcn/badge";
import { Button } from "../ui-shadcn/button";
import type { ChatMessage } from "../../../../shared/types";
import { TimelineMarker } from "./TimelineMarker";
import { LiveDuration } from "./LiveDuration";
import { getToolPhraseFromArgs } from "./timeline/toolPhrase";
import { ToolResult } from "../agents/tool-result";
import { desktopApi } from "../../desktopApi";
import {
  formatDuration,
  getToolDetailText,
  getToolExitCode,
  getToolName,
  getToolStatus,
} from "./TimelineFormat";

export type DiffFileHandler = (
  path: string,
  originalContent?: string,
  content?: string,
) => void;

type AskCardSummary = {
  question?: string;
  type?: string;
  answered?: boolean;
  answer?: unknown;
  answerLabel?: string;
  options?: Array<string | { label?: string; value?: unknown; description?: string }>;
  questions?: AskCardSummary[];
};

function toolIcon(toolName: string): ReactNode {
	const key = toolName.toLowerCase();
	if (key.includes("read") || key.includes("view")) return <FileText size={16} />;
	if (key.includes("write") || key.includes("edit") || key.includes("apply_patch") || key.includes("patch"))
		return <SquarePen size={16} />;
	if (key.includes("bash") || key.includes("shell") || key.includes("terminal")) return <Terminal size={16} />;
	if (key.includes("grep") || key.includes("search")) return <Search size={16} />;
	if (key.includes("glob") || key.includes("list") || key.includes("ls")) return <Folder size={16} />;
	if (key.includes("task") || key.includes("subagent") || key.includes("agent")) return <Network size={16} />;
	if (key.includes("web") || key.includes("fetch")) return <Globe2 size={16} />;
	if (key.includes("todo")) return <Check size={16} />;
	return <Wrench size={16} />;
}



/** 从工具消息 meta 中提取副标题（文件路径或命令），让 trigger 行能体现工具作用对象。
 *  pi 的工具参数可能是对象，也可能已被主进程截断/序列化为 JSON 字符串；两种格式都要兼容，否则 bash 命令摘要会丢失。 */
function getToolSubtitle(message: ChatMessage): string {
	const meta = message.meta;
	if (!meta) return "";
	// 优先从 args 取参数（pi 工具事件的标准结构）
	const args = parseToolArgs(meta.args);
	if (args) {
		for (const key of [
			// 文件操作类
			"filePath", "file_path", "path", "file",
			// bash/shell 命令
			"command",
			// 搜索/查询类（grep、web_search 等）
			"pattern", "query", "queries",
			// 网络获取类（fetch_content 等）
			"url", "urls",
			// 待办事项类（todo 等）
			"action", "text",
		]) {
			const v = args[key];
			if (typeof v === "string" && v) return v;
			// queries 和 urls 是数组，取第一条
			if (Array.isArray(v) && v.length > 0 && typeof v[0] === "string") return v[0];
		}
	}
	// 兼容历史平铺写法
	const path = meta.path;
	if (typeof path === "string" && path) return path;
	const command = meta.command;
	if (typeof command === "string" && command) return command;
	const file = meta.file;
	if (typeof file === "string" && file) return file;
	// 兜底：取 args 中第一个非空字符串值
	if (args && typeof args === "object") {
		for (const val of Object.values(args as Record<string, unknown>)) {
			if (typeof val === "string" && val) return val;
		}
	}
	return "";
}

/**
 * 识别模型主动触发的 skill：pi 系统提示会指示 LLM 用 read 工具读取 SKILL.md 来加载 skill，
 * 所以 toolName==="read" 且 path 以 SKILL.md 结尾时，视为 skill 调用，返回 skill 名（父目录名）。
 * 这是模型侧的 skill 触发，与用户侧 /skill:name 展开成 <skill> 块不同。
 */
function getReadSkillName(message: ChatMessage): string | undefined {
	const meta = message.meta;
	if (!meta) return;
	const toolName = typeof meta.toolName === "string" ? meta.toolName : "";
	if (toolName.toLowerCase() !== "read") return;
	const args = meta.args as Record<string, unknown> | undefined;
	if (!args || typeof args !== "object") return;
	const rawPath = String(args.path ?? args.filePath ?? args.file_path ?? "");
	if (!rawPath) return;
	// 取最后一段文件名与父目录名，跨平台分隔符兼容
	const segs = rawPath.split(/[\\/]/).filter(Boolean);
	const fileName = segs[segs.length - 1] ?? "";
	if (fileName.toUpperCase() !== "SKILL.MD") return;
	return segs[segs.length - 2] ?? fileName;
}

/** 计算工具的语气色：running 黄、error 红、其余 ok。
 * 工具内部命令失败（exitCode != 0）不影响工具调用本身的成功状态，
 * 因此不根据 exitCode 变色，只有工具调用层面出错才标红。 */
function getToolTone(message: ChatMessage): "running" | "error" | "ok" {
	const status = getToolStatus(message);
	if (status === "running") return "running";
	if (status === "error" || message.meta?.isError === true) return "error";
	return "ok";
}

/** pi 内置工具名集合，用于与 MCP / 扩展工具区分。 */
const BUILT_IN_TOOLS = new Set(["bash", "edit", "find", "grep", "ls", "read", "write"]);

/**
 * 扩展工具中带下划线的名称，会被 MCP-direct 正则误匹配为形如 {server}_{tool}。
 * 在此登记后 getToolKind 将其归为 "extension" 而非 "mcp-direct"。
 */
const NON_MCP_TOOLS = new Set(["ask_question", "web_search"]);

/**
 * 识别工具来源类型：
 * - mcp-proxy：toolName 为 mcp（pi-mcp-adapter 代理模式，LLM 通过单一 mcp 工具调用具体 server/tool）
 * - mcp-direct：toolName 形如 {server}_{tool} 且非内置/非扩展工具（directTools 模式，server 名去掉 -mcp 后缀）
 * - builtin：pi 内置工具（bash/edit/find/grep/ls/read/write）
 * - extension：扩展工具或自定义命名的其他工具
 */
function getToolKind(toolName: string): "mcp-proxy" | "mcp-direct" | "builtin" | "extension" {
	const key = toolName.toLowerCase();
	if (key === "mcp") return "mcp-proxy";
	if (BUILT_IN_TOOLS.has(key)) return "builtin";
	// directTools 模式：server_tool，server 名通常含字母/连字符，tool 名也是标识符
	if (/^[a-z][a-z0-9-]*_[a-z][a-z0-9_-]*$/i.test(toolName)) {
		// 已知扩展工具名含下划线但不是 MCP 直连 → 归为 extension
		if (NON_MCP_TOOLS.has(key)) return "extension";
		return "mcp-direct";
	}
	return "extension";
}

/** 从 MCP direct 工具名中拆出 server 名（chrome_devtools_navigate → chrome）。 */
function getMcpServerName(toolName: string): string {
	const idx = toolName.indexOf("_");
	return idx > 0 ? toolName.slice(0, idx) : toolName;
}

/** 给工具返回展示标签：MCP 代理/直连/内置/扩展，用于 ToolCard trigger 的 kind 徽标。 */
function getToolKindLabel(toolName: string): string {
	const kind = getToolKind(toolName);
	if (kind === "mcp-proxy") return "MCP";
	if (kind === "mcp-direct") return `MCP-${getMcpServerName(toolName).toUpperCase()}`;
	return "";
}

/**
 * AI Elements Tool 风格的实时工具活动卡片：运行阶段使用轻量 shimmer 和状态轨道，
 * 不依赖工具结果消息，避免 streaming 期间出现空白或跳变。
 */
export const ToolActivityCard = memo(function ToolActivityCard(props: { name: string }) {
	return (
		<section className="tool-activity-card" data-status="running" aria-live="polite">
			<span className="tool-activity-icon">{toolIcon(props.name)}</span>
			<div className="tool-activity-copy">
				<span className="tool-activity-name">{props.name}</span>
				<span>{t("tool.statusRunning")}</span>
			</div>
			<span className="tool-activity-pulse" aria-hidden="true"><i /><i /><i /></span>
		</section>
	);
});

/** 单个工具调用卡片：trigger 行（图标+工具名+副标题+状态+耗时）+ 展开后详情。 */
export const ToolCard = memo(function ToolCard(props: {
	message: ChatMessage;
	defaultOpen?: boolean;
	/** 停止时 tool end 可能永远不会到达，避免遗留 running 状态继续播放动画。 */
	stopped?: boolean;
	/** 所属会话 id：运行期绑定不可用时（历史会话 _viewer 投影）回退会话文件定位 */
	sessionId?: string;
}) {
	const [expanded, setExpanded] = useState(props.defaultOpen ?? false);
	const messageStatus = getToolStatus(props.message);
	const status = props.stopped && messageStatus === "running" ? "stopped" : messageStatus;
	const toolName = getToolName(props.message);
	const detailText = getToolDetailText(props.message);
	// 工具结果截断标记（主进程 truncateDetailWithMeta 写入）：展开区可「查看完整输出」
	// 按需读取（运行期走主进程内存缓存，历史会话定位读会话文件）。
	const isTruncated = props.message.meta?.truncated === true;
	const [fullText, setFullText] = useState<string | null>(null);
	const [fullLoading, setFullLoading] = useState(false);
	const [fullError, setFullError] = useState(false);
	const displayText = fullText ?? detailText;
	const loadFullText = async () => {
		if (fullLoading) return;
		setFullLoading(true);
		setFullError(false);
		try {
			const result = await desktopApi.sessions.readMessageFullText(
				props.sessionId,
				props.message.agentId,
				props.message.id,
				typeof props.message.meta?.entryId === "string" ? props.message.meta.entryId : undefined,
			);
			setFullText(result.text);
		} catch {
			setFullError(true);
		} finally {
			setFullLoading(false);
		}
	};
	const tone = status === "stopped" ? "ok" : getToolTone(props.message);
	const subtitle = getToolSubtitle(props.message);
	const kindLabel = getToolKindLabel(toolName);
	// 学 Proma：折叠态显示语义短语（如「读取 foo.ts」）而非完整命令行
	const phrase = getToolPhraseFromArgs(toolName, props.message.meta?.args);
	const displayLabel = status === "running" ? phrase.loadingLabel : phrase.label;
	const durationMs =
		typeof props.message.meta?.durationMs === "number"
			? props.message.meta.durationMs
			: undefined;
	const showDuration = durationMs !== undefined || status === "running";
	// 模型用 read 工具读取 SKILL.md 来加载 skill：识别后以 skill 徽标样式渲染
	const skillName = getReadSkillName(props.message);
	const isSkillRead = Boolean(skillName);
	// 历史会话中从 ask_question 工具结果反推的提问卡片数据
	const askCard = props.message.meta?._askCard as AskCardSummary | undefined;
	const isAskCard = Boolean(askCard?.question);
	// 状态徽章（借鉴 AI Elements Tool 的 getStatusBadge）：三态图标+文案 pill 一眼可辨。
	// running 保留琥珀色警示位；error 用 destructive 红；done 用 secondary。
	// 低强调确认（ask_question 已回答时文案替换为「已回答」）。
	// 随 trigger 行紧凑化（24px）同步收紧：图标 11→9px、Badge 内边距 py-0.5→py-0、px-1.5→px-1。
	// 2026-11：移除 running 的转圈动画（用户反馈动画具干扰性），只保留「进行中」文字；
	// 状态仍由 tool_execution_start/end 事件驱动，语义不变。
	const statusBadge = (() => {
		if (status === "running") {
			return (
				<Badge variant="outline" className="gap-1 border-warning/40 px-1 py-0 text-micro text-warning">
					{t("tool.statusRunning")}
				</Badge>
			);
		}
		if (status === "stopped") {
			return (
				<Badge variant="outline" className="gap-1 border-border-subtle px-1 py-0 text-micro text-text-tertiary">
					<Square size={8} aria-hidden="true" />
					{t("tool.statusStopped")}
				</Badge>
			);
		}
		if (status === "error") {
			// 失败用 soft 红（danger-soft 淡红底 + danger 红字 + 淡红描边），
			// 不采用实心 destructive 红底白字——单条工具失败不需要最高警告级的视觉冲击，
			// 与 running 的 outline 琥珀徽章同构，三态保持可扫读但整体克制。
			return (
				<Badge variant="outline" className="gap-1 border-danger/40 bg-danger-soft px-1 py-0 text-micro text-danger">
					<CircleX size={9} aria-hidden="true" />
					{t("tool.statusError")}
				</Badge>
			);
		}
		return (
			<Badge variant="secondary" className="gap-1 px-1 py-0 text-micro">
				<CircleCheck size={9} aria-hidden="true" />
				{/* 已完成 ask 的「已回答」文案由常驻 AskQuestionResultCard 承载，
				    ToolCard 的 done 统一用 statusDone（running/损坏 ask 同走此 badge）。 */}
				{t("tool.statusDone")}
			</Badge>
		);
	})();
	return (
		<TimelineMarker
			kind="tool"
			tone={tone === "error" ? "error" : tone === "running" ? "active" : "success"}
		>
		<section
			// 圆角不走 Tailwind rounded-md（6px 会压过 .tool-card 的 token 圆角，
			// 且与系统卡片弧度不一致）；由 timeline.css 的 .tool-card 统一用 --radius-lg 决定
			className={`tool-card w-full min-w-0 overflow-hidden border border-border-subtle bg-bg-panel transition-[border-color,background-color,box-shadow] duration-200 tone-${tone}${isSkillRead ? " tool-card--skill" : ""}${isAskCard ? " tool-card--ask" : ""}${status === "running" ? " tool-card--running" : ""}`}
			data-status={status}
			data-tool-kind={isSkillRead ? "skill" : getToolKind(toolName)}
			data-message-id={props.message.id}
		>
			<div className="relative flex min-h-6 items-center transition-colors duration-150 hover:bg-[color:color-mix(in_srgb,var(--color-bg-hover)_55%,var(--color-bg-panel))]">
				{/* 工具运行中整行扫光（dsh-web command-row-sweep 同款，与思考扫光同 keyframes）。
				    status === "running" 才挂载：stopped/error/done 立即消失（stopped 由 props.stopped 短路）；
				    pointer-events-none 不挡 trigger 点击展开 */}
				{status === "running" && (
					<span
						aria-hidden
						className="pointer-events-none absolute inset-y-0 left-[-300px] w-[300px] animate-tool-sweep motion-reduce:animate-none bg-[linear-gradient(90deg,transparent,color-mix(in_srgb,var(--color-bg-app)_55%,transparent),transparent)]"
					/>
				)}
				<button
					type="button"
					className="flex min-h-6 min-w-0 flex-[1_1_auto] cursor-pointer items-center gap-2 border-0 bg-transparent py-0 pr-0.5 pl-1 text-left text-control leading-5 text-text-secondary focus-visible:-outline-offset-2 focus-visible:outline-2"
					onClick={() => setExpanded((v) => !v)}
					aria-expanded={expanded}
				>
					<span className="tool-card-icon inline-flex shrink-0 items-center justify-center text-text-tertiary">
						{isSkillRead ? <Brain size={16} /> : isAskCard ? <MessageCircle size={16} /> : toolIcon(toolName)}
					</span>
					<span className="shrink-0 text-caption font-medium lowercase text-text-secondary">
						{isSkillRead ? `skill:${skillName}` : isAskCard ? t("ask.toolName") : toolName}
					</span>
					{expanded ? (
						<ChevronDown size={14} className="shrink-0 text-text-tertiary" aria-hidden="true" />
					) : (
						<ChevronRight size={14} className="shrink-0 text-text-tertiary" aria-hidden="true" />
					)}
					{!isSkillRead && kindLabel && (
						<span className="tool-card-kind">{kindLabel}</span>
					)}
					{statusBadge}
					{showDuration && (
						<span className="shrink-0 font-mono text-micro tabular-nums text-text-tertiary" title={t("tool.durationTitle")}>
							{status === "running" ? (
								// 工具执行中：从消息时间戳起实时计时（LiveDuration 每秒刷新）
								<LiveDuration startedAt={props.message.timestamp} isStreaming />
							) : (
								formatDuration(durationMs ?? 0)
							)}
						</span>
					)}
					{isAskCard && askCard?.question ? (
						<span className="min-w-0 flex-[1_1_auto] truncate font-mono text-micro text-text-tertiary" title={askCard.question}>
							| {askCard.question}
						</span>
					) : displayLabel ? (
						<span className="min-w-0 flex-[1_1_auto] truncate font-mono text-micro text-text-secondary" title={subtitle || displayLabel}>
							{displayLabel}
						</span>
					) : subtitle ? (
						<span className="min-w-0 flex-[1_1_auto] truncate font-mono text-micro text-text-tertiary" title={subtitle}>
							| {subtitle}
						</span>
					) : null}
				</button>
			</div>
			{expanded && (
				<div className="relative ml-5 mt-0.5 mb-1 rounded-b-sm border-l-2 border-border-subtle bg-transparent pl-2 animate-in fade-in slide-in-from-top-1 duration-150">
				{/* 已完成 ask_question 已拆成常驻 AskQuestionResultCard（buildTurnDisplay），
				    ToolCard 这里只保留 running / 损坏 ask 的普通工具详情。 */}
					<ToolResult
						showHeader={false}
						tool={toolIcon(toolName)}
						title={toolName}
						status={status === "running" ? "running" : status === "error" ? "error" : "success"}
						kind={toolName.toLowerCase().includes("bash") || toolName.toLowerCase().includes("shell") ? "terminal" : "custom"}
						maxHeight={320}
						copyText={displayText}
						copyClassName="tool-card-copy"
						contentClassName="text-text-tertiary"
					>
						{displayText}
					</ToolResult>
					{isTruncated && !fullText && (
						// 截断提示后的按需加载入口：内容完整与否由主进程决定（内存缓存/会话文件），
						// 失败时保留重试，不让用户卡死在加载态。
						<div className="flex items-center gap-2 pl-1 pb-1">
							{fullError ? (
								<>
									<span className="text-micro text-text-tertiary">{t("tool.fullOutputLoadFailed")}</span>
									<Button
										type="button"
										variant="ghost"
										size="sm"
										className="h-auto px-1 py-0 text-micro text-text-tertiary hover:text-text-secondary"
										onClick={() => void loadFullText()}
									>
										{t("tool.retry")}
									</Button>
								</>
							) : (
								<Button
									type="button"
									variant="ghost"
									size="sm"
									className="h-auto gap-1 px-1 py-0 text-micro text-text-tertiary hover:text-text-secondary"
									disabled={fullLoading}
									onClick={() => void loadFullText()}
								>
									{fullLoading ? (
										<Loader2 size={12} className="animate-spin" aria-hidden="true" />
									) : null}
									{fullLoading ? t("tool.loadingFullOutput") : t("tool.viewFullOutput")}
								</Button>
							)}
						</div>
					)}
				</div>
			)}
		</section>
		</TimelineMarker>
	);
});
/** 工具组直接平铺为工具列表；每个 ToolCard 自己默认折叠，避免外层再占一行。 */
export const ToolGroupCard = memo(function ToolGroupCard(props: {
	group: ToolGroupItem;
	stopped?: boolean;
	/** 所属会话 id（转交 ToolCard「查看完整输出」的历史会话文件回退） */
	sessionId?: string;
}) {
	return (
		<section className="tool-group-card w-full min-w-0 overflow-hidden rounded-none border-0 bg-transparent" data-message-id={props.group.id}>
			<div className="flex flex-col gap-0 p-0">
				{props.group.messages.map((message) => (
					<ToolCard key={message.id} message={message} stopped={props.stopped} sessionId={props.sessionId} />
				))}
			</div>
		</section>
	);
});
