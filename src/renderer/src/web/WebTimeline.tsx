/**
 * WebTimeline — Web 端消息时间线（与桌面 SessionMessageTimeline 同风格）。
 *
 * 数据源为 useChat 的 messages（流式实时）+ 历史分页注入：
 * - 用户消息 → 右对齐气泡（复用桌面 user-turn 布局类）
 * - 助手侧整轮 → WebAssistantTurn（思考/工具/插入语折叠进执行过程，最终回答常驻）
 * - 流式期间底部显示响应指示器；出错显示诊断卡
 */
import { memo, useMemo, useRef } from "react";
import { ArrowDown } from "lucide-react";
import type { UIMessage } from "ai";
import { Button } from "@/components/ui-shadcn/button";
import { t } from "@/i18n";
import { USER_TURN_BUBBLE } from "@/lib/density";
import type { WebPendingUiRequest } from "./webTypes";
import type { AgentUiRequest, AgentUiResponse, SessionUiResponseInput } from "../../../shared/types";
import { useWebTimelineWindow } from "./useWebTimelineWindow";
import { WEB_TIMELINE_TURN_EXPAND_STEP } from "./webTurnWindow";
import {
	createSessionRuntimeUiResponder,
	SessionRuntimeUiOverlay,
} from "../components/overlays/SessionRuntimeUiOverlay";
import type {
	SessionRuntimeUiState,
	SessionRuntimeViewState,
} from "../atoms/session-atoms";
import { groupWebTimelineTurns } from "./webToolGroups";
import { WebAssistantTurn } from "./WebAssistantTurn";

// 兼容再导出：浏览器夹具等仍从 WebTimeline 引用卡片组件。
export { WebThinkingBlock, WebToolCard, WebToolGroupCard } from "./WebTimelineCards";

/** 用户消息右对齐气泡（结构与桌面 UserBubble 一致，去掉操作栏/附件能力）。 */
export const WebUserBubble = memo(function WebUserBubble(props: { message: UIMessage }) {
	const text = props.message.parts
		.filter((part) => part.type === "text")
		.map((part) => (part.type === "text" ? part.text : ""))
		.join("");
	if (!text.trim()) return null;
	return (
		<article className="user-turn group/user flex w-full min-w-0 max-w-full flex-col items-end">
			<div className={USER_TURN_BUBBLE}>
				<div className="text-chat leading-[1.6] text-text-primary whitespace-pre-wrap break-words">
					{text}
				</div>
			</div>
		</article>
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
		<div className="mt-2 w-full">
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
	/** 磁盘仍可向前翻页（缓存内隐藏的更早轮次不计入） */
	hasMoreHistory: boolean;
	loadingMore: boolean;
	streaming: boolean;
	error: string | null;
	/** 会话稳定身份：窗口/锚点状态随会话切换复位 */
	sessionId?: string;
	pendingUiRequest?: WebPendingUiRequest;
	/** Web 端 pending 卡提交：带回快照本身（responder 用它取 4-tuple 身份），成功返回 true */
	onRespondUi?: (
		request: WebPendingUiRequest,
		response: AgentUiResponse,
	) => Promise<boolean>;
	/** 成功返回本次页的新消息头 ID；失败或空页返回 null。 */
	onLoadMore: () => Promise<string | null>;
}) {
	const {
		messages,
		hasActiveSession,
		hasMoreHistory,
		loadingMore,
		streaming,
		error,
		onLoadMore,
	} = props;
	// 显示窗口（2026-12 统一 50 轮）：只渲染最近 50 轮 + 用户主动展开的更早内容。
	// 完整消息仍在 useChat/会话缓存中，这里只做展示切片，不写回底层数据。
	const timelineWindow = useWebTimelineWindow({
		sessionId: props.sessionId,
		messages,
		hasMoreHistory,
		loadingMore,
		onLoadMore,
	});
	const timelineRef = timelineWindow.timelineRef;
	const updateScrollState = timelineWindow.handleScroll;
	const scrollToBottom = timelineWindow.scrollToBottom;
	const showScrollToBottom = timelineWindow.showScrollToBottom;
	const visibleMessages = timelineWindow.visibleMessages;

	// 窗口已切片：在可见集合上按「轮」分组（整轮折叠由 WebAssistantTurn 负责）
	const groupedMessages = useMemo(
		() => groupWebTimelineTurns(visibleMessages),
		[visibleMessages],
	);
	const lastMessage = messages[messages.length - 1];
	const lastTurnId = useMemo(() => {
		for (let index = groupedMessages.length - 1; index >= 0; index -= 1) {
			const item = groupedMessages[index];
			if (item && item.kind === "assistant-turn") return item.id;
		}
		return undefined;
	}, [groupedMessages]);

	return (
		<section
			className="message-timeline relative h-full min-h-0 flex-1 overflow-y-auto"
			ref={timelineRef}
			onScroll={updateScrollState}
		>
			<div className="message-list flex flex-col gap-1.5 px-3 py-2.5">
				{timelineWindow.canRevealOlder && (
					<div className="flex justify-center py-1">
						<Button
							variant="outline"
							size="sm"
							disabled={loadingMore}
							onClick={timelineWindow.revealOlder}
							className="h-8 px-4 text-caption"
						>
							{loadingMore
								? t("timeline.loadingMore")
								: timelineWindow.hiddenTurnCount > 0
									? t("timeline.loadEarlierTurns", { count: Math.min(timelineWindow.hiddenTurnCount, WEB_TIMELINE_TURN_EXPAND_STEP) })
									: t("timeline.loadMoreTurns")}
						</Button>
					</div>
				)}
				{!hasActiveSession && visibleMessages.length === 0 ? (
					<div className="empty-state">
						<div className="empty-logo">
							<svg viewBox="140 140 520 520" width="66" height="66" aria-hidden="true">
								<path fill="#fff" fillRule="evenodd" d="M165.29 165.29H517.36V400H400V517.36H282.65V634.72H165.29ZM282.65 282.65V400H400V282.65Z" />
								<path fill="#fff" d="M517.36 400H634.72V634.72H517.36Z" />
							</svg>
						</div>
						<p className="empty-hint">{t("web.emptySelection")}</p>
					</div>
				) : visibleMessages.length === 0 ? (
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
						{groupedMessages.map((item) => {
							if (item.kind === "assistant-turn") {
								return (
									<div key={item.id} className="mt-0" data-web-message-id={item.id}>
										<WebAssistantTurn
											messages={item.messages}
											streaming={streaming && lastMessage !== undefined && item.messages.includes(lastMessage)}
											isLatest={item.id === lastTurnId}
										/>
									</div>
								);
							}
							const message = item.message;
							return (
								<div key={message.id} className="mt-0" data-web-message-id={message.id}>
									<WebUserBubble message={message} />
								</div>
							);
						})}
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
					<div className="diagnostic-card tone-error p-2 text-control text-danger">
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
