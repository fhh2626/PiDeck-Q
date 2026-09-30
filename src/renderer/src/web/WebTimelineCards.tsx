/**
 * Web 时间线的思考卡 / 工具卡 / 工具组卡（从 WebTimeline.tsx 原样搬出，供整轮折叠组件复用）。
 * 拆出独立模块是为了避免 WebAssistantTurn 与 WebTimeline 互相 import（循环依赖）。
 */
import { memo, useState } from "react";
import { Brain, ChevronDown, ChevronRight, ChevronUp, Wrench } from "lucide-react";
import { Badge } from "@/components/ui-shadcn/badge";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";
import { CARD_BODY_PADDING, CARD_PREVIEW_PADDING, DASHED_SURFACE, THINKING_HEADER } from "@/lib/density";
import { MarkdownStream } from "@/components/session/MarkdownStream";
import { SingleLinePreview } from "@/components/session/SingleLinePreview";
import { TimelineMarker } from "../components/session/TimelineMarker";
import type { WebToolPart } from "./webToolGroups";

/** 思考折叠卡片（复用桌面 ThinkingBlock 视觉：Brain 图标 + 可折叠正文）。
 * 默认折叠成单行预览（deepseek-harness ReasoningRow 模式：流式中 tail -f 显示最新行 + 扫光，
 * 结束后显示第一行），标题行整行可点击展开/收起。 */
export const WebThinkingBlock = memo(function WebThinkingBlock(props: {
	text: string;
	/** 思考是否仍在流式：控制 SingleLinePreview 的尾部跟随 + 扫光（Web 端 part 无独立完成标志，用整条消息 isStreaming 近似） */
	running?: boolean;
}) {
	const [expanded, setExpanded] = useState(false);
	if (!props.text.trim()) return null;
	return (
		<TimelineMarker kind="thinking" tone="neutral">
		<section className="w-full min-w-0 overflow-hidden rounded-md border-0">
			<div className="relative min-h-6" data-web-thinking-header-slot="" data-web-thinking-expanded={expanded}>
				<button
					className={`${THINKING_HEADER} border-0 bg-transparent [&]:py-0 text-control leading-5 text-text-secondary hover:bg-[color:color-mix(in_srgb,var(--color-bg-hover)_50%,var(--color-bg))] [&_svg]:shrink-0 [&_svg]:text-[var(--color-info)]`}
					data-web-compact-hit-area=""
					onClick={() => setExpanded((value) => !value)}
					aria-expanded={expanded}
					title={expanded ? t("thinking.collapse") : t("thinking.expand")}
				>
					<Brain size={15} />
					<span className="shrink-0 text-body leading-5 font-[650] text-text-primary">{t("thinking.title")}</span>
					{/* 整行可点：chevron 旋转过渡表达展开/收起，不依赖文字按钮 */}
					<ChevronDown
						size={15}
						className={`shrink-0 text-text-tertiary transition-transform duration-200 motion-reduce:transition-none${expanded ? " rotate-180" : ""}`}
						aria-hidden="true"
					/>
				</button>
			</div>
			{/* 虚线框内容区（折叠/展开共用容器，与桌面端 ThinkingBlock 一致）：
			    折叠态单行预览在标题行下方独立一行，不与标题挤在一起 */}
			<div className={DASHED_SURFACE}>
				{expanded ? (
					<>
					<div className={`markdown-body ${CARD_BODY_PADDING} text-text-tertiary`}>
						<MarkdownStream
							text={props.text}
							onOpenExternal={(url: string) => {
								// Web 端无系统浏览器通道，直接新窗口打开
								window.open(url, "_blank", "noopener");
							}}
						/>
					</div>
					{/* 长思考展开后，内容尾部提供收起入口（与桌面端 ThinkingBlock 一致）：
					    滚动到内容末尾即可收起，不必滚回顶部标题行 */}
					<div className="flex px-1.5 pb-1">
						<button
							type="button"
							className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-micro text-text-tertiary transition-colors duration-150 hover:bg-[color:color-mix(in_srgb,var(--color-bg-hover)_45%,transparent)] hover:text-text-secondary focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)]"
							onClick={() => setExpanded(false)}
						>
							<ChevronUp size={12} aria-hidden="true" />
							{t("thinking.collapse")}
						</button>
					</div>
					</>
				) : (
					<SingleLinePreview
						text={props.text}
						running={props.running}
						className={CARD_PREVIEW_PADDING}
					/>
				)}
			</div>
		</section>
		</TimelineMarker>
	);
});

/** 工具卡片（复用桌面 tool-card 视觉：图标 + 工具名 + 状态）。 */
function formatToolPreview(value: unknown): string { if (value === undefined || value === null) return ''; const text = typeof value === 'string' ? value : (() => { try { return JSON.stringify(value); } catch { return ''; } })(); if (!text) return ''; const compact = text.replace(/\s+/gu, ' ').trim(); return compact.length > 120 ? compact.slice(0, 117) + '…' : compact; }

export const WebToolCard = memo(function WebToolCard(props: { part: WebToolPart; withoutMarker?: boolean }) {
	const { part, withoutMarker } = props;
	// 静态工具 part 不携带 toolName，名称嵌在 type 里（`tool-${name}`）；动态工具带 toolName
	const toolName =
		part.toolName ||
		(typeof part.type === "string" && part.type.startsWith("tool-")
			? part.type.slice("tool-".length)
			: "tool");
	const state = part.state ?? "input-streaming";
	const running = state === "input-streaming" || state === "input-available";
	const error = state === "output-error" || state === "error" || Boolean(part.errorText);
	const preview = formatToolPreview(error ? part.errorText : running ? (part as any).input : part.output);
	const cardSection = (
		<section
			className={cn(
				"tool-card inline-flex w-fit max-w-full min-w-0 overflow-hidden rounded-md border border-border-subtle bg-bg-panel transition-[border-color,background-color] duration-150",
				running && "tone-running",
				error && "tone-error",
			)}
			data-status={error ? "error" : running ? "running" : "done"}
			data-tool-name={toolName}
		>
			<div className="flex min-h-6 max-w-full items-center px-2 py-0.5">
				<span className="tool-card-trigger flex min-w-0 max-w-full items-center gap-2 text-control leading-5 text-text-secondary">
					<span className="tool-card-icon">
						<Wrench size={14} aria-hidden="true" />
					</span>
					<span className="tool-card-name truncate font-medium text-text-primary">{toolName}</span>
					<span className={cn("tool-card-status shrink-0", running && "text-warning", error && "text-danger")}>
						{running ? (
							<span className="inline-flex items-center gap-1.5">
								<span className="tool-card-spinner" aria-hidden="true" />
								{t("tool.statusRunning")}
							</span>
						) : error ? (
							<span className="inline-flex items-center gap-1.5">{t("tool.statusError")}</span>
						) : (
							<span className="inline-flex items-center gap-1.5">{t("tool.statusDone")}</span>
						)}
					</span>
					{preview ? (
						<span className="min-w-0 max-w-[min(60vw,42ch)] truncate font-mono text-micro text-text-tertiary" title={preview}>{preview}</span>
					) : null}
				</span>
			</div>
		</section>
	);

	if (withoutMarker) {
		return cardSection;
	}

	return (
		<TimelineMarker kind="tool" tone={error ? "error" : running ? "active" : "success"}>
			{cardSection}
		</TimelineMarker>
	);
});

/** Web 端连续工具调用合并卡片：默认折叠，展开可查看每个工具。 */
export const WebToolGroupCard = memo(function WebToolGroupCard(props: {
	parts: WebToolPart[];
	groupId: string;
}) {
	const { parts, groupId } = props;
	const [expanded, setExpanded] = useState(false);

	if (parts.length < 2) {
		return parts[0] ? <WebToolCard part={parts[0]} /> : null;
	}

	const hasRunning = parts.some((p) => {
		const s = p.state ?? "input-streaming";
		return s === "input-streaming" || s === "input-available";
	});
	const hasError = parts.some((p) => {
		const s = p.state ?? "input-streaming";
		return s === "output-error" || s === "error" || Boolean(p.errorText);
	});
	const status = hasRunning ? "running" : hasError ? "error" : "done";

	return (
		<TimelineMarker kind="tool" tone={hasError ? "error" : hasRunning ? "active" : "success"}>
			<section
				className="tool-group-card w-full min-w-0 overflow-hidden rounded-md border border-border-subtle bg-bg-panel"
				data-group-id={groupId}
			>
				<button
					type="button"
					className="flex min-h-6 w-full items-center gap-2 border-0 bg-transparent px-2 py-1 text-left text-control text-text-secondary cursor-pointer"
					onClick={() => setExpanded((v) => !v)}
					aria-expanded={expanded}
				>
					<Wrench size={14} className="shrink-0 text-text-tertiary" aria-hidden="true" />
					<span className="font-medium text-text-primary">
						{t("tool.group.title", { count: parts.length })}
					</span>
					{expanded ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
					<Badge
						variant={status === "error" ? "outline" : status === "running" ? "outline" : "secondary"}
						className="px-1 py-0 text-micro"
					>
						{t(
							status === "running"
								? "tool.statusRunning"
								: status === "error"
									? "tool.statusError"
									: "tool.statusDone"
						)}
					</Badge>
				</button>
				{expanded && (
					<div className="flex flex-col gap-1 border-t border-border-subtle p-1.5">
						{parts.map((part, index) => (
							<WebToolCard key={part.toolCallId || index} part={part} withoutMarker />
						))}
					</div>
				)}
			</section>
		</TimelineMarker>
	);
});
