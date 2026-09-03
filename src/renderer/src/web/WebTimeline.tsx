/**
 * WebTimeline — Web 端消息时间线（与桌面 SessionMessageTimeline 同风格）。
 *
 * 数据源为 useChat 的 messages（流式实时）+ 历史分页注入：
 * - 用户消息 → 右对齐气泡（复用桌面 user-turn 布局类）
 * - 助手消息 → 扁平 Markdown（WebAssistantText）
 * - reasoning part → 可折叠思考卡片（复用桌面 ThinkingBlock 视觉）
 * - tool-invocation part → 工具卡片（复用桌面 tool-card 视觉）
 * - 流式期间底部显示响应指示器；出错显示诊断卡
 */
import { Fragment, memo, useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, Brain, ChevronDown, ChevronUp, Wrench } from "lucide-react";
import type { UIMessage } from "ai";
import { Button } from "@/components/ui-shadcn/button";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";
import { WebAssistantText } from "./WebAssistantText";
import type { WebPendingUiRequest } from "./webTypes";
import type { AgentUiRequest, AgentUiResponse, SessionUiResponseInput } from "../../../shared/types";
import { getWebAskQuestionResult } from "./webApi";
import { AskQuestionResultCard } from "../components/session/AskQuestionResultCard";
import {
	createSessionRuntimeUiResponder,
	SessionRuntimeUiOverlay,
} from "../components/overlays/SessionRuntimeUiOverlay";
import type {
	SessionRuntimeUiState,
	SessionRuntimeViewState,
} from "../atoms/session-atoms";
import { MarkdownStream } from "@/components/session/MarkdownStream";
import { SingleLinePreview } from "@/components/session/SingleLinePreview";
import { TimelineMarker } from "../components/session/TimelineMarker";
import { isWebReasoningPartRunning, mergeAdjacentWebMessageParts } from "./webMessageParts";

/** 用户消息右对齐气泡（结构与桌面 UserBubble 一致，去掉操作栏/附件能力）。 */
export const WebUserBubble = memo(function WebUserBubble(props: { message: UIMessage }) {
	const text = props.message.parts
		.filter((part) => part.type === "text")
		.map((part) => (part.type === "text" ? part.text : ""))
		.join("");
	if (!text.trim()) return null;
	return (
		<article className="user-turn group/user flex w-full min-w-0 max-w-full flex-col items-end">
			<div className="w-fit min-w-0 max-w-[min(82%,64ch)] rounded-[14px] border border-border bg-muted/60 px-3 py-2 text-sm text-foreground [overflow-wrap:anywhere] break-words">
				<div className="text-chat leading-[1.6] text-text-primary whitespace-pre-wrap break-words">
					{text}
				</div>
			</div>
		</article>
	);
});

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
		<TimelineMarker kind="thinking" tone="neutral" contentClassName="pb-0">
		<section className="w-full min-w-0 overflow-hidden rounded-md border-0">
			<button
				className="flex min-h-6 w-full cursor-pointer items-center gap-2 border-0 bg-transparent px-2 py-0.5 text-left text-control leading-5 text-text-secondary transition-[background-color,transform] duration-150 motion-reduce:transition-none hover:bg-[color:color-mix(in_srgb,var(--color-bg-hover)_50%,var(--color-bg))] active:scale-[0.99] focus-visible:-outline-offset-2 focus-visible:outline-2 [&_svg]:shrink-0 [&_svg]:text-[var(--color-info)]"
				onClick={() => setExpanded((value) => !value)}
				aria-expanded={expanded}
				title={expanded ? t("thinking.collapse") : t("thinking.expand")}
			>
				<Brain size={15} />
				<span className="shrink-0 text-body font-[650] text-text-primary">{t("thinking.title")}</span>
				{/* 整行可点：chevron 旋转过渡表达展开/收起，不依赖文字按钮 */}
				<ChevronDown
					size={15}
					className={`shrink-0 text-text-tertiary transition-transform duration-200 motion-reduce:transition-none${expanded ? " rotate-180" : ""}`}
					aria-hidden="true"
				/>
			</button>
			{/* 虚线框内容区（折叠/展开共用容器，与桌面端 ThinkingBlock 一致）：
			    折叠态单行预览在标题行下方独立一行，不与标题挤在一起 */}
			<div className="rounded-md border border-dashed border-border-subtle bg-[color:color-mix(in_srgb,var(--color-bg-muted)_45%,transparent)]">
				{expanded ? (
					<div className="markdown-body px-3 pt-2 pb-1 text-text-tertiary">
						<MarkdownStream
							text={props.text}
							onOpenExternal={(url: string) => {
								// Web 端无系统浏览器通道，直接新窗口打开
								window.open(url, "_blank", "noopener");
							}}
						/>
						{/* 长思考展开后，内容尾部提供收起入口（与桌面端 ThinkingBlock 一致）：
						    滚动到内容末尾即可收起，不必滚回顶部标题行 */}
						<div className="mt-1.5">
							<button
								type="button"
								className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-micro text-text-tertiary transition-colors duration-150 hover:bg-[color:color-mix(in_srgb,var(--color-bg-hover)_45%,transparent)] hover:text-text-secondary focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)]"
								onClick={() => setExpanded(false)}
							>
								<ChevronUp size={12} aria-hidden="true" />
								{t("thinking.collapse")}
							</button>
						</div>
					</div>
				) : (
					<SingleLinePreview
						text={props.text}
						running={props.running}
						className="px-3 pt-2 pb-1 font-mono text-caption text-text-tertiary"
					/>
				)}
			</div>
		</section>
		</TimelineMarker>
	);
});

type WebToolPart = {
	type: string;
	toolName?: string;
	toolCallId?: string;
	state?: string;
	output?: unknown;
	errorText?: string;
};

/** 工具卡片（复用桌面 tool-card 视觉：图标 + 工具名 + 状态）。 */
function formatToolPreview(value: unknown): string { if (value === undefined || value === null) return ''; const text = typeof value === 'string' ? value : (() => { try { return JSON.stringify(value); } catch { return ''; } })(); if (!text) return ''; const compact = text.replace(/\s+/gu, ' ').trim(); return compact.length > 120 ? compact.slice(0, 117) + '…' : compact; }

export const WebToolCard = memo(function WebToolCard(props: { part: WebToolPart }) {
	const { part } = props;
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
	return (
		<TimelineMarker kind="tool" tone={error ? "error" : running ? "active" : "success"} contentClassName="pb-0">
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
		</TimelineMarker>
	);
});

/** 助手消息：思考 + 工具 + 正文 的扁平容器（不套气泡，左对齐全宽）。 */
export const WebAssistantMessage = memo(function WebAssistantMessage(props: {
	message: UIMessage;
	isStreaming: boolean;
}) {
	const { message, isStreaming } = props;
	// 已完成的 ask_question：主进程投影把结果挂在 metadata（经 webApi 规范化）。
	// 有结果时把第一个工具 part 替换成常驻问答卡，其余 part（reasoning/text）
	// 保持原样——与桌面「ask 不再折叠进执行过程」一致。
	const displayParts = useMemo(
		() => mergeAdjacentWebMessageParts(message.parts),
		[message.parts],
	);
	const askResult = getWebAskQuestionResult(message);
	const firstToolIndex = askResult
		? displayParts.findIndex(
				(part) =>
					part.type === "dynamic-tool" ||
					(typeof part.type === "string" && part.type.startsWith("tool-")),
		  )
		: -1;
	return (
		<div className="w-full min-w-0">
			{displayParts.map((part, index) => {
				if (part.type === "reasoning") {
					return (
						<WebThinkingBlock
							key={index}
							text={part.text}
							running={isWebReasoningPartRunning(displayParts, index, isStreaming)}
						/>
					);
				}
				if (
					part.type === "dynamic-tool" ||
					(typeof part.type === "string" && part.type.startsWith("tool-"))
				) {
					// v7：静态工具 part.type 为 `tool-${toolName}`（tool-input-start 无 dynamic 标志），
					// 动态工具为 "dynamic-tool"；toolName/toolCallId/state 都直接挂在 part 上
					if (askResult && index === firstToolIndex) {
						return <AskQuestionResultCard key={index} result={askResult} messageId={message.id} />;
					}
					return (
						<WebToolCard
							key={index}
							part={
								part as unknown as WebToolPart
							}
						/>
					);
				}
				if (part.type === "text") {
					return (
						<Fragment key={index}>
							{part.text ? (
								<div className="timeline-inline-text">
									<WebAssistantText text={part.text} isStreaming={isStreaming} />
								</div>
							) : null}
						</Fragment>
					);
				}
				return null;
			})}
		</div>
	);
});

/**
 * Web 端 pending 提问卡：复用桌面 SessionRuntimeUiOverlay（select/confirm/input/
 * editor/batch_ask 五种形态与桌面完全一致）。Web 没有桌面 atoms，这里把
 * WebPendingUiRequest 快照现场构造成 overlay 需要的 runtime/ui 只读视图。
 */
function WebPendingAsk(props: {
	request: WebPendingUiRequest;
	onRespond: (request: WebPendingUiRequest, response: AgentUiResponse) => Promise<boolean>;
}) {
	return <WebPendingAskInner key={props.request.requestId} request={props.request} onRespond={props.onRespond} />;
}

/**
 * 内层 memo 是尽力而为：外层 key={requestId} 才是真正保证「同一请求只 remount 一次」
 * 的机制（requestId 变了才重建 overlay 状态）。轮询每 2-3s 带来全新引用的
 * request 对象、onRespond 每次渲染也是新函数，memo 比较多半会失败——
 * 但即使重渲染，overlay 的草稿/题号状态依然存活：批量卡的 reset effect 只依赖
 * 稳定的 requestKey（requestId 标量），input 卡的 reset 只依赖 prefill/value 标量，
 * 不依赖对象身份。memo 只是减少无谓重渲染，不承担正确性。
 */
const WebPendingAskInner = memo(function WebPendingAskInner(props: {
	request: WebPendingUiRequest;
	onRespond: (request: WebPendingUiRequest, response: AgentUiResponse) => Promise<boolean>;
}) {
	const { request, onRespond } = props;
	// 稳定引用：responder 的 claim/rollback 闭包不能随每次渲染重建
	const requestRef = useRef(request);
	requestRef.current = request;

	const responder = useMemo(
		() =>
			createSessionRuntimeUiResponder({
				binding: {
					sessionId: request.sessionId,
					agentId: request.agentId,
					runtimeGeneration: request.runtimeGeneration,
				},
				// Web 侧只有轮询快照：send 前再校验一次请求身份，防止
				// 「响应已过期」（轮询到旧快照后用户才点击）。
				readBinding: () => {
					const latest = requestRef.current;
					return {
						sessionId: latest.sessionId,
						agentId: latest.agentId,
						runtimeGeneration: latest.runtimeGeneration,
					};
				},
				claim: () => true,
				rollback: () => true,
				send: async (input: SessionUiResponseInput) => {
					// onRespond 内部走 /api/ui-response，成功后主进程移除 pending 快照
					const accepted = await onRespond(requestRef.current, input.response);
					if (!accepted) throw new Error("web ui request expired");
				},
			}),
		[onRespond],
	);

	// overlay 的激活判定需要 runtime 与 ui 状态同 agentId/runtimeGeneration；
	// 这里用只读视图构造最小状态，requests 只放当前这一条。
	const runtimeView: SessionRuntimeViewState = useMemo(
		() => ({
			agentId: request.agentId,
			runtimeGeneration: request.runtimeGeneration,
			status: "running",
			updatedAt: 0,
		}),
		[request.agentId, request.runtimeGeneration],
	);
	const uiView: SessionRuntimeUiState = useMemo(
		() => ({
			agentId: request.agentId,
			runtimeGeneration: request.runtimeGeneration,
			requests: {
				[request.requestId]: {
					request: {
						agentId: request.agentId,
						requestId: request.requestId,
						method: request.method,
						title: request.title,
						...(request.options ? { options: request.options } : {}),
						...(request.placeholder ? { placeholder: request.placeholder } : {}),
						...(request.prefill ? { prefill: request.prefill } : {}),
						...(request.allowOther ? { allowOther: true } : {}),
						...(request.batchQuestions ? { batchQuestions: request.batchQuestions } : {}),
						...(request.batchReview ? { batchReview: true } : {}),
					} satisfies AgentUiRequest,
					status: "pending",
				},
			},
			widgets: {},
			revision: 1,
		}),
		[request],
	);

	return (
		<div className="mt-3 w-full">
			<SessionRuntimeUiOverlay
				sessionId={request.sessionId}
				runtime={runtimeView}
				ui={uiView}
				responder={responder}
			/>
		</div>
	);
});

export function WebTimeline(props: {
	messages: UIMessage[];
	hasActiveSession: boolean;
	hasMoreHistory: boolean;
	moreCount: number;
	loadingMore: boolean;
	streaming: boolean;
	error: string | null;
	pendingUiRequest?: WebPendingUiRequest;
	/** Web 端 pending 卡提交：带回快照本身（responder 用它取 4-tuple 身份），成功返回 true */
	onRespondUi?: (
		request: WebPendingUiRequest,
		response: AgentUiResponse,
	) => Promise<boolean>;
	onLoadMore: () => void;
}) {
	const {
		messages,
		hasActiveSession,
		hasMoreHistory,
		moreCount,
		loadingMore,
		streaming,
		error,
		onLoadMore,
	} = props;
	const timelineRef = useRef<HTMLDivElement | null>(null);
	const stickToBottomRef = useRef(true);
	const [showScrollToBottom, setShowScrollToBottom] = useState(false);

	const updateScrollState = () => {
		const el = timelineRef.current;
		if (!el) return;
		const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
		const nearBottom = distance < 160;
		stickToBottomRef.current = nearBottom;
		setShowScrollToBottom(!nearBottom && messages.length > 0);
	};

	const scrollToBottom = () => {
		const el = timelineRef.current;
		if (!el) return;
		stickToBottomRef.current = true;
		setShowScrollToBottom(false);
		el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
	};

	// 新消息或流式增量到达时，仅在用户原本接近底部时跟随，避免打断用户阅读历史。
	useEffect(() => {
		const frame = requestAnimationFrame(() => {
			const el = timelineRef.current;
			if (el && stickToBottomRef.current) el.scrollTo({ top: el.scrollHeight });
			updateScrollState();
		});
		return () => cancelAnimationFrame(frame);
		// messages 变化既覆盖新消息，也覆盖同一条 assistant 消息的流式增量。
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [messages, streaming]);

	return (
		<section
			className="message-timeline relative h-full min-h-0 flex-1 overflow-y-auto"
			ref={timelineRef}
			onScroll={updateScrollState}
		>
			<div className="message-list flex flex-col gap-2 p-4">
				{hasMoreHistory && (
					<div className="flex justify-center py-1">
						<Button
							variant="outline"
							size="sm"
							disabled={loadingMore}
							onClick={() => {
								stickToBottomRef.current = false;
								// A short transcript can still count as "at bottom". Suspend live-edge
								// following before prepending history so the new page stays visible.
								setShowScrollToBottom(messages.length > 0);
								onLoadMore();
							}}
							className="h-8 px-4 text-caption"
						>
							{loadingMore ? t("timeline.loadingMore") : t("timeline.loadMoreHistory", { count: moreCount })}
						</Button>
					</div>
				)}
				{!hasActiveSession && messages.length === 0 ? (
					<div className="empty-state">
						<div className="empty-logo">
							<svg viewBox="140 140 520 520" width="66" height="66" aria-hidden="true">
								<path fill="#fff" fillRule="evenodd" d="M165.29 165.29H517.36V400H400V517.36H282.65V634.72H165.29ZM282.65 282.65V400H400V282.65Z" />
								<path fill="#fff" d="M517.36 400H634.72V634.72H517.36Z" />
							</svg>
						</div>
						<p className="empty-hint">{t("web.emptySelection")}</p>
					</div>
				) : messages.length === 0 ? (
					<div className="empty-state">
						<div className="empty-logo">
							<svg viewBox="140 140 520 520" width="66" height="66" aria-hidden="true">
								<path fill="#fff" fillRule="evenodd" d="M165.29 165.29H517.36V400H400V517.36H282.65V634.72H165.29ZM282.65 282.65V400H400V282.65Z" />
								<path fill="#fff" d="M517.36 400H634.72V634.72H517.36Z" />
							</svg>
						</div>
						<p className="empty-hint">{t("web.noMessages")}</p>
					</div>
				) : (
					<>
						{messages.map((message) => (
							<div key={message.id} className="mt-0">
								{message.role === "user" ? (
									<WebUserBubble message={message} />
								) : (
									<WebAssistantMessage
										message={message}
										isStreaming={
											streaming && message === messages[messages.length - 1]
										}
									/>
								)}
							</div>
						))}
					</>
				)}

				{/* 流式响应指示器 */}
				{streaming && (
					<div className="responding-indicator" data-kind="waiting">
						<span className="responding-indicator-dots flex gap-1" aria-hidden="true">
							<span className="size-1.5 rounded-full" />
							<span className="size-1.5 rounded-full" />
							<span className="size-1.5 rounded-full" />
						</span>
						<span className="responding-indicator-label">{t("app.statusRunning")}</span>
					</div>
				)}

				{/* 错误诊断卡 */}
				{error ? (
					<div className="diagnostic-card tone-error p-3 text-control text-danger">
						{error}
					</div>
				) : null}

				{props.pendingUiRequest && props.onRespondUi ? (
					<WebPendingAsk
						request={props.pendingUiRequest}
						onRespond={props.onRespondUi}
					/>
				) : null}
			</div>

			{showScrollToBottom && (
				<Button
					variant="secondary"
					size="icon"
					className="absolute right-4 bottom-4 z-10 size-9 rounded-full border border-border bg-background/95 shadow-md"
					onClick={scrollToBottom}
					aria-label={t("web.scrollToBottom")}
					title={t("web.scrollToBottom")}
				>
					<ArrowDown className="size-4" aria-hidden="true" />
				</Button>
			)}

		</section>
	);
}
