import { memo, useEffect, useRef, useState } from "react";
import { AlertTriangle, Brain, Check, ChevronDown, ChevronUp, MessageCircle, Minimize, X } from "lucide-react";
import type { ChatMessage } from "../../../../shared/types";
import { t, translateI18nDescriptor } from "../../i18n";
import { formatDuration, formatTime, stripAnsi } from "./TimelineFormat";
import { Textarea } from "../ui-shadcn/textarea";
import { StackTrace } from "../ui-shadcn/stack-trace";
import { ApprovalCard } from "../ui-shadcn/approval-card";
import { TimelineMarker } from "./TimelineMarker";
import { LiveDuration } from "./LiveDuration";
import { MarkdownStream } from "./MarkdownStream";
import { ShimmerText } from "./ShimmerText";
import { ReasoningText } from "../agents/loading-states/reasoning-text";
import { Loader } from "../motion/loader";
import { SingleLinePreview } from "./SingleLinePreview";
import { CARD_BODY_PADDING, CARD_PREVIEW_PADDING, DASHED_SURFACE, THINKING_HEADER } from "@/lib/density";

// Button 收口状态（P0）：本文件按钮全部保留原生——
// compaction-card-header / thinking-card-trigger 是折叠触发器 + 内容排版容器（内部 span/small/em 结构）；
// ask-question-card-option 是选项卡片；ask-question-card-submit/cancel 是品牌视觉按钮
// （30px 圆角 14px + 2px 边框 + 硬编码品牌绿/危险色，非 token 值，换装会丢失品牌感）。
// 迁移路径见 P2 CSS 收口。

function getDiagnosticTone(message: ChatMessage): "error" | "warning" | "success" | "info" {
	if (message.role === "error") return "error";
	const status = String(message.meta?.status ?? "");
	if (status === "error") return "error";
	if (status === "running") return "warning";
	if (status === "success") return "success";
	return "info";
}

/** 压缩事件卡片：对话流中的一条普通消息，标记会话被压缩过。
 * 视觉与思考卡片（ThinkingBlock）对齐：lucide 图标标签行 + 虚线内容框，
 * 折叠态最多 7.56 行轻渲染纯文本预览，展开态挂 Markdown 全文；
 * 展开/收起走左下角按钮（不整体可点，与思考/工具卡一致）。
 * 压缩前的归档消息由翻页像正常对话流一样逐条可见（磁盘分页包含归档历史）。 */
export const CompactionCard = memo(function CompactionCard(props: {
	message: ChatMessage;
	sessionId: string;
	onOpenExternal: (url: string, forceSystem?: boolean) => void;
	onOpenFile?: (path: string) => void;
}) {
	const [expanded, setExpanded] = useState(false);
	// 学 ThinkingBlock 折叠轻渲染：折叠态只挂 200 字符截断预览，
	// 全文（Markdown DOM）仅在展开时挂载、收起即卸载；溢出判断用字符阈值替代 DOM 测量。
	const summaryText = stripAnsi(props.message.text);
	const PREVIEW_CHARS = 200;
	const overflowing = summaryText.length > PREVIEW_CHARS;
	const tokensBefore = (props.message.meta as any)?.tokensBefore;
	const compactionCount = (props.message.meta as any)?.compactionCount;
	const time = formatTime(props.message.timestamp);

	return (
		<TimelineMarker kind="compaction" tone="active">
		<section data-message-id={props.message.id} className="w-full min-w-0 overflow-hidden rounded-md border-0">
			{/* 标签行：纯展示，不可点击；展开/收起走左下角按钮（与思考卡片同构） */}
			<div className="flex min-h-6 flex-wrap items-center gap-1.5 px-1">
				<Minimize size={15} className="shrink-0 text-text-secondary" aria-hidden="true" />
				{typeof compactionCount === "number" && compactionCount > 0 && (
					<span className="inline-flex items-center rounded-full border border-[color:color-mix(in_srgb,var(--color-accent)_16%,transparent)] bg-[color:color-mix(in_srgb,var(--color-accent)_8%,transparent)] px-1.5 font-mono text-micro text-text-tertiary">
						{t("app.compactionCount", { count: compactionCount })}
					</span>
				)}
				{typeof tokensBefore === "number" && (
					<span className="font-mono text-micro text-text-tertiary">
						{t("app.compactionTokensBefore", { count: Math.round(tokensBefore / 1000) })}
					</span>
				)}
				<time className="font-mono text-micro tabular-nums text-text-tertiary">{time}</time>
			</div>
			{/* 虚线框内容区（与思考卡片同款）：折叠态最多 7.56 行（按 --font-size-chat 联动），
			    第 8 行切半提示还有内容；展开态挂 Markdown 全文 */}
			<div className={DASHED_SURFACE}>
				{expanded ? (
					<div className={`markdown-body ${CARD_BODY_PADDING} text-text-tertiary`}>
						<MarkdownStream
							text={summaryText}
							onOpenExternal={props.onOpenExternal}
							onOpenFile={props.onOpenFile}
						/>
					</div>
				) : (
					// 折叠态轻渲染：只显示截断纯文本预览，不跑 streamdown、不建全文 DOM
					<div className="max-h-[calc(var(--font-size-chat)*7.56)] overflow-hidden whitespace-pre-wrap break-words px-2 py-0.5 text-text-tertiary">
						{overflowing ? summaryText.slice(0, PREVIEW_CHARS) + "…" : summaryText}
					</div>
				)}
				<div className="flex px-1 pb-1">
					<button
						type="button"
						className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-micro text-text-tertiary transition-colors duration-150 hover:bg-[color:color-mix(in_srgb,var(--color-bg-hover)_50%,transparent)] hover:text-text-secondary focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)]"
						onClick={() => setExpanded((v) => !v)}
						aria-expanded={expanded}
					>
						{expanded ? <ChevronUp size={12} aria-hidden="true" /> : <ChevronDown size={12} aria-hidden="true" />}
						{expanded ? t("app.compactionCollapse") : t("app.compactionExpand")}
					</button>
				</div>
			</div>
		</section>
		</TimelineMarker>
	);
});

/** 错误/RPC/系统诊断消息使用独立卡片，避免和普通 AI 正文混在一起难以扫读。 */
export const DiagnosticMessageCard = memo(function DiagnosticMessageCard(props: {
	message: ChatMessage;
}) {
	const tone = getDiagnosticTone(props.message);
	const localizedText = translateI18nDescriptor(props.message.meta, props.message.text);
	const debugDetails = typeof props.message.meta?.debugDetails === "string"
		? props.message.meta.debugDetails.trim()
		: "";
	const title = props.message.role === "error"
		? t("diagnostic.errorTitle")
		: t("diagnostic.systemTitle");
	return (
		<TimelineMarker
			kind="diagnostic"
			tone={
				tone === "error"
					? "error"
					: tone === "warning"
						? "warning"
						: tone === "success"
							? "success"
							: "neutral"
			}
			// 系统状态/自动重试/错误提示是独立卡片，不需要轨道归属关系
			hideRail
		>
		<article
			className={`diagnostic-card w-full min-w-0 overflow-hidden rounded-md border border-border-subtle bg-[var(--color-chat-muted-bg)] tone-${tone}`}
			data-message-id={props.message.id}
			data-role={props.message.role}
		>
			<div className="flex items-center gap-2 px-2 py-1.5 font-mono text-caption text-text-secondary">
				<AlertTriangle size={14} aria-hidden="true" />
				<span className="font-semibold">{title}</span>
				<time className="ml-auto text-micro tabular-nums text-text-tertiary">{formatTime(props.message.timestamp)}</time>
			</div>
			<div className="p-2">
				<p className="m-0 whitespace-pre-wrap break-words text-caption leading-relaxed text-text-secondary">{stripAnsi(localizedText)}</p>
				{debugDetails ? <StackTrace trace={stripAnsi(debugDetails)} defaultOpen={tone === "error"} /> : null}
			</div>
		</article>
		</TimelineMarker>
	);
});

/**
 * 内联提问卡片：渲染 Extension UI 请求（select/confirm/input/editor）作为 system 消息。
 * 用于实时会话中模型通过 ask_question 扩展向用户发起交互。
 */
export const AskQuestionCard = memo(function AskQuestionCard(props: {
	message: ChatMessage;
	onRespond?: (response: { value?: string | boolean; cancelled?: boolean; confirmed?: boolean }) => void;
}) {
	const meta = props.message.meta as Record<string, unknown> | undefined;
	const uiRequest = meta?.uiRequest as Record<string, unknown> | undefined;
	const status = String(meta?.status ?? "pending");
	const response = meta?.response as Record<string, unknown> | undefined;
	const answered = status === "answered" && response && !response.cancelled;
	const cancelled = status === "cancelled" || status === "error";

	const [inputValue, setInputValue] = useState("");
	const [cancelling, setCancelling] = useState(false);
	const [expanded, setExpanded] = useState(true);
	const inputRef = useRef<HTMLTextAreaElement>(null);

	// 编辑器输入 ref
	const editorRef = useRef<HTMLTextAreaElement>(null);

	// 当 prefill 变化时同步到 inputValue
	useEffect(() => {
		if (uiRequest?.prefill) setInputValue(String(uiRequest.prefill));
		setExpanded(true);
	}, [uiRequest?.prefill, props.message.id]);

	const handleSelect = (value: string) => {
		props.onRespond?.({ value });
	};

	const handleConfirm = (value: boolean) => {
		props.onRespond?.({ confirmed: value });
	};

	const handleInputSubmit = () => {
		if (inputValue.trim()) {
			props.onRespond?.({ value: inputValue });
		}
	};

	const handleCancel = () => {
		setCancelling(true);
		props.onRespond?.({ cancelled: true });
	};

	// 已回答/取消的卡片：信息已在 ToolCard 的 _askCard 中展示，此处不再重复渲染
	if (answered || cancelled) {
		return null;
	}

	// pending 卡片：显示交互界面
	const cancellingLabel = t("ask.cancelling");
	const method = String(uiRequest?.method ?? "input");
	const title = String(uiRequest?.title ?? "");
	const placeholder = String(uiRequest?.placeholder ?? "");
	const options = uiRequest?.options as string[] | undefined;

	return (
		<TimelineMarker kind="ask" tone="active">
			<ApprovalCard
				open={expanded}
				onOpenChange={setExpanded}
				title={t("ask.toolName")}
				description={title || t("ask.defaultTitle")}
				status={cancelling ? t("ask.cancelling") : t("ask.waiting")}
				onCancel={handleCancel}
				cancelDisabled={cancelling}
				cancelLabel={t("common.cancel")}
				className="ask-question-card pending"
			>
				<div className="ask-question-card-body">
					{method === "select" && options && options.length > 0 && (
						<div className="ask-question-card-options">
							{/* 过滤掉 Pi 自带的 "✎ 自行输入..." 选项，用下方内联输入框替代。 */}
							{options.filter((opt) => !opt.startsWith("✎")).map((opt) => (
								<button
									key={opt}
									className="ask-question-card-option"
									onClick={() => handleSelect(opt)}
									disabled={cancelling}
								>
									{opt}
								</button>
							))}
						</div>
					)}
					{method === "confirm" && (
						<div className="ask-question-card-options ask-question-card-options-confirm">
							<button
								className="ask-question-card-option ask-question-card-option-yes"
								onClick={() => handleConfirm(true)}
								disabled={cancelling}
							>
								{t("common.true")}
							</button>
							<button
								className="ask-question-card-option ask-question-card-option-no"
								onClick={() => handleConfirm(false)}
								disabled={cancelling}
							>
								{t("common.false")}
							</button>
						</div>
					)}
					{method === "input" && (
						<div className="ask-question-card-input-row">
							<Textarea
								ref={inputRef}
								className="ask-question-card-input"
								placeholder={placeholder || t("ask.inputPlaceholder")}
								value={inputValue}
								onChange={(e) => setInputValue(e.target.value)}
								onKeyDown={(e) => {
									if (e.key === "Enter" && !e.shiftKey) {
										e.preventDefault();
										handleInputSubmit();
									}
								}}
								disabled={cancelling}
							/>
							<button
								className="ask-question-card-submit"
								onClick={handleInputSubmit}
								disabled={!inputValue.trim() || cancelling}
								title={t("ask.submit")}
							>
								<Check size={14} />
							</button>
						</div>
					)}
					{method === "editor" && (
						<div className="ask-question-card-editor-area">
							<Textarea
								ref={editorRef}
								className="ask-question-card-editor"
								placeholder={placeholder || t("ask.editorPlaceholder")}
								value={inputValue}
								onChange={(e) => setInputValue(e.target.value)}
								disabled={cancelling}
							/>
							<div className="ask-question-card-editor-actions">
								<button
									className="ask-question-card-submit"
									onClick={handleInputSubmit}
									disabled={!inputValue.trim() || cancelling}
								>
									{t("ask.submit")}
								</button>
							</div>
						</div>
					)}
				</div>
			</ApprovalCard>
		</TimelineMarker>
	);
});

/** 思考过程折叠卡片：标签行（图标+耗时+右侧展开/收起按钮）与虚线框内容区分行；
 * 默认折叠成单行静态预览（溢出尾部渐变淡出，不滚动——横向跑马灯实测太晃且
 * 思考结束后仍在滚动，与状态脱节，已弃用），点击按钮展开后
 * markdown 全文实时渲染（isStreaming 透传 MarkdownStream），按钮变「收起思考」；
 * agent 完成（endedAt 出现）时强制回到折叠态，随执行过程整体收起。
 * defaultExpanded=true 时以「展开」形态呈现（暂无调用方，保留扩展）。 */
export const ThinkingBlock = memo(
	function ThinkingBlock(props: {
		text: string;
		startedAt?: number;
		endedAt?: number;
		showThinking?: boolean;
		/** 初始展开状态（仅初始值）：默认折叠成单行跑马灯，显式传 true 才展开 */
		defaultExpanded?: boolean;
		/** 流式进行中：MarkdownStream 以 isStreaming 实时渲染 */
		isStreaming?: boolean;
		onOpenExternal: (url: string) => void;
		onOpenFile?: (path: string) => void;
	}) {
	const [expanded, setExpanded] = useState(props.defaultExpanded ?? false);
	// agent 完成时强制收起：即使之前手动展开过，思考也随执行过程整体收起（回到折叠单行态）
	useEffect(() => {
		if (props.endedAt) setExpanded(false);
	}, [props.endedAt]);
	// 折叠态只挂载轻量单行预览；展开态由 MarkdownStream 负责唯一的流式渲染，避免双重打字机。

	if (!props.showThinking || !props.text.trim()) return null;
	// 思考耗时：结束固定（endedAt - startedAt）；流式中（isStreaming）由 LiveDuration 实时增长
	const hasEnded =
		props.endedAt && props.startedAt && props.endedAt >= props.startedAt;
	const durationText =
		hasEnded && props.endedAt != null && props.startedAt != null
			? formatDuration(props.endedAt - props.startedAt)
			: null;
	return (
		<TimelineMarker kind="thinking" tone={props.endedAt ? "neutral" : "active"}>
		<section className="w-full min-w-0 overflow-hidden rounded-md border-0">
		{/* 思考栏（整行可点，仿 ToolCard trigger 行交互）：Brain 图标 + 耗时 + 旋转 chevron。
		    不再是行尾小按钮——点击整行展开/收起，触控感：hover 淡背景 + active 轻微按压缩放 +
		    chevron 旋转过渡。预览内容在下方虚线框内独立一行，不与「思考了」挤在同一行。 */}
			<button
				type="button"
				className={`${THINKING_HEADER} group relative min-w-0 hover:bg-[color:color-mix(in_srgb,var(--color-bg-hover)_50%,transparent)]`}
				onClick={() => setExpanded((v) => !v)}
				aria-expanded={expanded}
				title={expanded ? t("thinking.collapse") : t("thinking.expand")}
			>
				{/* 流式思考中整行扫光（dsh-web reasoning-row-sweep 同款：光带从行左滑到行右，
				    2.6s 循环）。isStreaming 才挂载：思考结束立即消失，与状态同步；
				    pointer-events-none 保证不挡整行点击，motion-reduce 尊重系统减弱动效 */}
				{props.isStreaming && (
					<span
						aria-hidden
						className="pointer-events-none absolute inset-y-0 left-[-300px] w-[300px] animate-thinking-sweep motion-reduce:animate-none bg-[linear-gradient(90deg,transparent,color-mix(in_srgb,var(--color-bg-app)_55%,transparent),transparent)]"
					/>
				)}
				<Brain size={15} className="shrink-0 text-text-secondary" aria-hidden="true" />
				{(hasEnded || props.isStreaming) && props.startedAt && (
					<small className="shrink-0 font-mono text-micro tabular-nums text-text-tertiary">
						{hasEnded ? (
							t("thinking.duration", { duration: durationText })
						) : (
							// 流式中：思考未结束，用同一「思考了 Xs」文案 + LiveDuration 实时跳动，
							// 思考结束只是数字冻结，不会出现前缀/文案整体蹦出。
							<>
								{t("thinking.durationPrefix")}
								<LiveDuration startedAt={props.startedAt} isStreaming />
							</>
						)}
					</small>
				)}
				{/* 展开态 chevron 旋转 180° 朝上（收起语义），折叠态朝下（展开语义），
				    旋转过渡本身就是「触控感」的一部分 */}
				<ChevronDown
					size={14}
					aria-hidden="true"
					className={`shrink-0 text-text-tertiary transition-transform duration-200 motion-reduce:transition-none${expanded ? " rotate-180" : ""}`}
				/>
			</button>
			{/* 虚线框内容区（折叠/展开共用容器，内容切换）：
			    折叠态单行静态预览（不跑 streamdown、不建全文 DOM，长思考折叠时只有一行纯文本，
			    是时间线内存最大单项的根治）；展开态 markdown 全文，字号随 --font-size-chat 联动 */}
			<div className={DASHED_SURFACE}>
				{expanded ? (
					<div className={`markdown-body ${CARD_BODY_PADDING} text-text-tertiary`}>
						<MarkdownStream
							text={props.text}
							isStreaming={props.isStreaming}
							onOpenExternal={props.onOpenExternal}
							onOpenFile={props.onOpenFile}
						/>
					</div>
				) : (
					<SingleLinePreview
						text={props.text}
						running={props.isStreaming}
						className={CARD_PREVIEW_PADDING}
					/>
				)}
				{/* 收起入口：长思考展开后滚到底即可收起（不用滚回顶部思考栏）。
				    左下角纯文本按钮，无外框、不抢视觉 */}
				{expanded && (
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
				)}
			</div>
		</section>
		</TimelineMarker>
	);
	},
	// 回调函数（onOpenExternal/onOpenFile）行为稳定（读 ref），不参与比较
	(prev, next) =>
		prev.text === next.text &&
		prev.startedAt === next.startedAt &&
		prev.endedAt === next.endedAt &&
		prev.showThinking === next.showThinking &&
		prev.isStreaming === next.isStreaming,
);



/**
 * 流式响应指示器（三点脉动动画 + 状态文案），在 agent 运行/流式期间显示。
 *
 * 状态优先级：
 *  1. Agent 启动中 → “正在启动 Agent”（琥珀色）
 *  2. 工具执行中 → “正在工具调用”（琥珀色）
 *  3. 有思考文本 / 流式回答中 → “正在回应”
 *  4. 过渡等待 → 单条静态文案
 *
 * 启动状态单独展示，避免用户发消息后 Agent 尚未完成预热时看起来像“没有响应”。
 * 视觉实现：beUI ReasoningText（swap 整句淡入淡出 + ascii-line 终端指示器），
 * 每种状态一组 i18n 短语轮播；状态切换用 key 重建，从第一条短语重新开始。
 */

/** 每种状态对应的轮播短语组（i18n；waiting 单条即不轮播）。 */
type RespondingKind = "starting" | "executing" | "responding" | "waiting";

export function RespondingIndicator(props: {
	thinking?: string;
	showThinking?: boolean;
	isStarting?: boolean;
	isExecutingTool?: boolean;
	isStreaming?: boolean;
}) {
	const { isStarting, isExecutingTool, isStreaming, thinking, showThinking } = props;

	let kind: RespondingKind;

	if (isStarting) {
		kind = "starting";
	} else if (isExecutingTool) {
		kind = "executing";
	} else if ((showThinking && thinking && thinking.length > 0) || isStreaming) {
		// 有思考文本或流式回答中统一显示“正在回应”
		kind = "responding";
	} else {
		// 过渡等待：单条静态文案（不轮播）
		kind = "waiting";
	}

	// 必须在渲染期翻译：模块加载时应用设置尚未完成初始化，顶层调用 t()
	// 会把系统语言固化进数组，导致显式选择的界面语言无法作用于临时状态。
	const phrases: Record<RespondingKind, string[]> = {
		starting: [
			t("agent.loading.starting1"),
			t("agent.loading.starting2"),
			t("agent.loading.starting3"),
		],
		executing: [
			t("agent.loading.executing1"),
			t("agent.loading.executing2"),
			t("agent.loading.executing3"),
		],
		responding: [
			t("agent.loading.responding1"),
			t("agent.loading.responding2"),
			t("agent.loading.responding3"),
		],
		waiting: [t("agent.loading.waiting")],
	};

	return (
		<div className="responding-indicator" data-kind={kind}>
			{/* key=kind：状态切换时从该组短语第一条重新轮播，避免旧组下标错位；
			   指示器用 Loader dots（三点跳动，bg-current 跟随状态色），
			   不用官方默认的 ascii 终端字符；文字放大到 text-base */}
			<ReasoningText
				key={kind}
				phrases={phrases[kind]}
				variant="swap"
				interval={1800}
				indicator={
					<Loader
						variant="dot-matrix"
						size={18}
						speed={1.1}
						label={t("agent.loading.aria")}
					/>
				}
				// 字号用官方默认（text-sm）：实测语义 token 缩放的观感不如官方字阶，保持官方原样
				/>
		</div>
	);
}
