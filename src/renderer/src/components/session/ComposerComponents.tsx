import { useState, useRef, useEffect, useCallback, type ReactNode } from "react";
import {
	Brain,
	Check,
	ChevronDown,
	ChevronLeft,
	Eye,
	FileText,
	FoldVertical,
	GitBranch,
	ListChecks,
	Paperclip,
	Star,
	Wrench,
	X,
} from "lucide-react";
import { t, type TranslationKey } from "../../i18n";
import { Button } from "../ui-shadcn/button";
import {
	Command,
	CommandEmpty,
	CommandInput,
	CommandItem,
	CommandList,
} from "../ui-shadcn/command";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogHeader,
	DialogTitle,
} from "../ui-shadcn/dialog";
import { cn } from "../../lib/utils";
import { computeModelDisplay, formatModelRef, type ModelPending } from "../../utils/modelPendingDisplay";
import { computeThinkingDisplay, type ThinkingLevelPending } from "../../utils/thinkingDisplay";
import { CommandPickerGroup, CommandPickerPanel } from "../ui-shadcn/command-picker";
import { THINKING_LEVELS, groupModelsByProvider } from "./sessionPickerOptions";
import type {
	AgentRuntimeState,
	AvailableModel,
	ComposerAgentMode,
	GitBranchInfo,
	SessionRecord,
} from "../../../../shared/types";


/** 单个 extension widget 卡片：可折叠标题栏 + 内容行，支持手动关闭 */
// widgetKey 由扩展定义且跨重启稳定,可按 widgetKey 持久化折叠状态。
const EXTENSION_WIDGET_COLLAPSED_KEY_PREFIX =
	"pid:extension-widget-collapsed:";

/** 渲染 widget 单行内容，将 ✓/☑ 完成标记高亮为绿色，让 todo/plan 扩展的完成态更醒目。 */
export function renderWidgetLine(line: string): ReactNode {
	const parts = line.split(/(✓|☑)/g);
	if (parts.length <= 1) return line;
	return parts.map((part, i) =>
		part === "✓" || part === "☑" ? (
			<span key={i} className="widget-check-done">
				{part}
			</span>
		) : (
			part
		),
	);
}

/** 内置扩展 widget 的展示标题：widgetKey 是扩展内部标识（如 pi-deck-todo），直接展示不友好，映射为固定短名。 */
export function widgetDisplayTitle(widgetKey: string): string {
	if (widgetKey === "pi-deck-todo") return t("app.widgetTitleTodo");
	if (widgetKey === "pi-deck-plan-todos") return t("app.widgetTitlePlan");
	if (widgetKey === "pi-deck-context-controller") return t("app.widgetTitleContext");
	return widgetKey;
}

export function ExtensionWidgetCard(props: {
	widgetKey: string;
	lines: string[];
	onClose: () => void;
	/** 会话唯一标识，用于避免 Todo 等同名 widget 在不同 agent 间共享折叠状态。 */
	sessionIdOrPath?: string;
}) {
	const storageKey = props.sessionIdOrPath
		? `${EXTENSION_WIDGET_COLLAPSED_KEY_PREFIX}${props.sessionIdOrPath}:${props.widgetKey}`
		: `${EXTENSION_WIDGET_COLLAPSED_KEY_PREFIX}${props.widgetKey}`;
	const [expanded, setExpanded] = useState(() => {
		if (typeof window === "undefined") return true;
		const stored = localStorage.getItem(storageKey);
		return stored !== null ? stored === "true" : true;
	});
	const prevStorageKeyRef = useRef(storageKey);

	// 切换 agent/session 时只读取对应 key，不把上一 agent 的状态写到新 key。
	useEffect(() => {
		if (prevStorageKeyRef.current === storageKey) return;
		prevStorageKeyRef.current = storageKey;
		const stored = localStorage.getItem(storageKey);
		setExpanded(stored !== null ? stored === "true" : true);
	}, [storageKey]);

	const handleToggleExpanded = useCallback(() => {
		setExpanded((prev) => {
			const next = !prev;
			localStorage.setItem(storageKey, String(next));
			return next;
		});
	}, [storageKey]);

	return (
		<div className="extension-widget-card">
			<div className="extension-widget-card-header">
				<button
					className="extension-widget-card-trigger"
					onClick={handleToggleExpanded}
					aria-expanded={expanded}
				>
					<ChevronDown
						size={14}
						className={`extension-widget-card-chevron${expanded ? " open" : ""}`}
					/>
					<span className="extension-widget-card-title">{widgetDisplayTitle(props.widgetKey)}</span>
				</button>
				<button
					className="extension-widget-card-close"
					onClick={(e) => {
						e.stopPropagation();
						props.onClose();
					}}
					title={t("common.close")}
					aria-label={t("common.close")}
				>
					<X size={12} strokeWidth={2} />
				</button>
			</div>
			{expanded && (
				<div className="extension-widget-card-content">
					{props.lines.map((line, index) => (
						<div key={index} className="extension-widget-card-line">
							{renderWidgetLine(line)}
						</div>
					))}
				</div>
			)}
		</div>
	);
}

export function ComposerBottomBar(props: {
	state?: AgentRuntimeState;
	compacting: boolean;
	disabled?: boolean;
	/** thinking 按钮专用禁用：与 disabled 不同，busy（生成进行中）时仍可切换思考强度
	 *  （issue #146：pi 的 set_thinking_level 支持下一轮生成生效）。 */
	thinkingDisabled?: boolean;
	/** 模型按钮专用禁用：生成进行中仍可选（pi 不支持运行中切模型，只记下下一轮）。 */
	modelDisabled?: boolean;
	/** 流式生成中已请求、下一轮才生效的思考档位切换（显示为 from→to）。 */
	thinkingPending?: ThinkingLevelPending;
	/** 生成进行中已选定、本轮结束后才套到 Agent 的模型（显示为 from→to）。 */
	modelPending?: ModelPending;
	composerAgentMode: ComposerAgentMode;
	gitInfo?: GitBranchInfo;
	/** Draft sessions do not have a runtime yet, so retain their persisted settings in the bar. */
	record?: Pick<SessionRecord, "model" | "thinkingLevel">;
	/** 安全等级选择器（自包含组件，注入到左下角工具组） */
	securityControl?: ReactNode;
	sendControls: ReactNode;
	onPickModel: () => void;
	onPickPromptTemplate: () => void;
	onPickThinking: () => void;
	onCompact: () => void;
	onOpenComposerModePicker: () => void;
	onCancelPlan: () => void;
	onAttachFile: () => void;
}) {
	const ctxPercent = props.state?.contextPercent;
	const showCompact = ctxPercent != null && ctxPercent > 30;
	const contextPercent = ctxPercent ?? 0;
	// 默认模型/思考级别来自主进程按 pi 配置自动填充进会话记录的默认值（props.record），
	// 不读取渲染层 welcome localStorage 偏好，避免用户偏好覆盖 pi 配置。
	const currentThinkingLevel = props.state?.thinkingLevel ?? props.record?.thinkingLevel;
	// 有待生效切换时展示 from→to（新档位尚未被任何生成使用），否则展示当前档位
	const thinkingDisplay = computeThinkingDisplay(currentThinkingLevel, props.thinkingPending);
	const thinkingLevelLabel = (level: string) => {
		const labelKey = THINKING_LEVELS.find((item) => item.value === level)?.labelKey;
		return labelKey ? t(labelKey) : level;
	};
	const thinkingText = thinkingDisplay.levels.length > 0
		? thinkingDisplay.levels.map(thinkingLevelLabel).join(" → ")
		: t("app.think");
	const thinkingPendingTitle = props.thinkingPending
		? t("app.thinkingPendingTitle", {
			from: thinkingLevelLabel(props.thinkingPending.from),
			to: thinkingLevelLabel(props.thinkingPending.to),
		})
		: undefined;
	const isPlanMode = props.composerAgentMode === "plan";
	const modeLabel = isPlanMode
		? t("app.composerModePlan")
		: t("app.composerModeNormal");
	const liveModel = {
		provider: props.state?.provider ?? props.record?.model?.provider ?? "",
		modelId: props.state?.modelId ?? props.record?.model?.modelId ?? "",
		modelName: props.state?.modelName ?? props.record?.model?.modelId,
	};
	const modelDisplay = computeModelDisplay(
		liveModel.modelId ? liveModel : undefined,
		props.modelPending,
	);
	const modelFrom = modelDisplay.from;
	const modelTo = modelDisplay.to;
	const modelProvider = modelFrom?.provider;
	const modelName = modelFrom?.modelName || modelFrom?.modelId;
	const modelLabel = modelName
		? formatModelRef(modelFrom ?? { provider: "", modelId: "" })
		: `${t("app.model")}: -`;
	const modelPendingTitle = props.modelPending
		? t("app.modelPendingTitle", {
			from: formatModelRef(props.modelPending.from),
			to: formatModelRef(props.modelPending.to),
		})
		: undefined;
	// 底栏只承载当前状态和直接操作，快捷键说明留给设置页，避免再次挤压编辑器。
	// shrink-0：面板缩到最小时底栏不被输入区挤扁/挤出滚动条
	return (
		<div className="composer-bottom-bar min-h-10 shrink-0 border-t border-border/40 px-2 py-1.5">
			<div className="composer-bottom-layout flex min-w-0 items-center gap-2">
				<div className="composer-bottom-left flex min-w-0 flex-wrap items-center gap-0.5">
					<Button
						variant="ghost"
						size="sm"
						className={`composer-bar-btn h-7 gap-1 rounded-md px-1.5 text-control font-semibold text-foreground hover:bg-muted/60${isPlanMode ? " active" : ""}`}
						disabled={props.disabled}
						onClick={props.onOpenComposerModePicker}
						aria-haspopup="dialog"
						title={t("app.composerModeTitle")}
					>
						{isPlanMode ? (
							<ListChecks size={15} strokeWidth={2} aria-hidden="true" />
						) : (
							<Wrench size={15} strokeWidth={2} aria-hidden="true" />
						)}
						{/* 模式按钮文案：普通/计划模式均不加粗（font-normal 覆盖父按钮继承的 font-semibold）；
						    普通模式另用小一号字号 + 斜体做弱化艺术字。 */}
						<span
							className={cn(
								isPlanMode
									? "text-control font-normal"
									: "text-micro italic font-normal text-muted-foreground",
							)}
						>
							{modeLabel}
						</span>
					</Button>
					{isPlanMode && (
						<Button variant="ghost" size="icon"
							className="composer-bar-btn icon mode-cancel size-7 rounded-md"
							aria-label={t("app.composerModeCancelPlan")} title={t("app.composerModeCancelPlan")}
							disabled={props.disabled}
							onClick={props.onCancelPlan}
						>
							<X size={14} strokeWidth={2.2} aria-hidden="true" />
						</Button>
					)}
					<Button variant="ghost" size="icon"
						className="composer-bar-btn icon size-7 rounded-md text-foreground hover:bg-muted/60"
						aria-label={t("app.promptTemplatePickerTitle")} title={t("app.promptTemplatePickerTitle")}
						disabled={props.disabled}
						onClick={props.onPickPromptTemplate}
					>
						<FileText size={15} strokeWidth={2} aria-hidden="true" />
					</Button>
					<Button variant="ghost" size="icon"
						className="composer-bar-btn icon size-7 rounded-md text-foreground hover:bg-muted/60"
						aria-label={t("menu.attachFile")} title={t("menu.attachFile")}
						disabled={props.disabled}
						onClick={props.onAttachFile}
					>
						<Paperclip size={15} strokeWidth={2} aria-hidden="true" />
					</Button>
					{props.securityControl}
				</div>
				<div className="composer-bottom-center flex min-w-0 flex-1 items-center justify-center gap-4 overflow-hidden">
					<Button
						variant="ghost"
						size="sm"
						className="composer-bar-btn model flex h-7 min-w-0 max-w-[42ch] truncate rounded-md px-2 font-brand text-caption font-medium italic text-muted-foreground hover:bg-muted/60 hover:text-foreground"
						disabled={props.modelDisabled ?? props.disabled}
						onClick={props.onPickModel}
						aria-haspopup="dialog"
						title={modelPendingTitle ?? t("app.modelPickerTitle")}
					>
						{modelName ? (
							<>
								{modelProvider && (
									<span className="max-w-[14ch] truncate text-muted-foreground">{modelProvider}</span>
								)}
								{modelProvider && <span className="text-muted-foreground/50">/</span>}
								<span className="min-w-0 truncate">{modelName}</span>
								{modelDisplay.pending && modelTo && (
									<>
										<span className="text-muted-foreground/50"> → </span>
										<span className="min-w-0 truncate">{modelTo.modelName || modelTo.modelId}</span>
									</>
								)}
							</>
						) : (
							<span className="text-muted-foreground">{modelLabel}</span>
						)}
					</Button>
					<Button
						variant="ghost"
						size="sm"
						className="composer-bar-btn thinking h-7 max-w-[10rem] rounded-md px-2 font-brand text-caption font-semibold italic text-[var(--color-brand-green)] hover:bg-muted/60"
						disabled={props.thinkingDisabled}
						onClick={props.onPickThinking}
						aria-haspopup="dialog"
						title={thinkingPendingTitle ?? t("app.thinkingPickerTitle")}
					>
						{thinkingText}
					</Button>
					{showCompact && (() => {
						const isCompactingNow = Boolean(props.state?.isCompacting || props.compacting);
						const urgency =
							contextPercent >= 90 ? " critical" : contextPercent >= 70 ? " warn" : "";
						return (
							<Button
								variant="ghost"
								size="sm"
								className={`composer-bar-btn compact h-7 gap-1 rounded-md px-1.5 text-control${urgency}${isCompactingNow ? " compacting" : ""}`}
								disabled={
									isCompactingNow ||
									Boolean(props.state?.isStreaming)
								}
								title={t("app.contextCompactTitle", {
									percent: contextPercent.toFixed(1),
								})}
								aria-label={t("app.compact")}
								onClick={props.onCompact}
							>
								<FoldVertical size={13} strokeWidth={1.8} aria-hidden="true" />
								{isCompactingNow
									? t("app.compacting")
									: t("app.compactUsage", { percent: contextPercent.toFixed(0) })}
							</Button>
						);
					})()}
				</div>
				<div className="composer-bottom-right ml-auto flex shrink-0 items-center gap-2">
					{props.gitInfo?.current && (
						<span
							className="composer-bar-branch inline-flex max-w-[12rem] items-center gap-1.5 truncate px-1.5 text-sm font-semibold text-foreground/75"
							title={t("app.branchCurrent", {
								branch: props.gitInfo.current,
								count: props.gitInfo.branches.length,
							})}
						>
							<GitBranch size={14} strokeWidth={1.8} aria-hidden="true" />
							<span className="composer-bar-branch-name truncate">{props.gitInfo.current}</span>
						</span>
					)}
					{props.sendControls}
				</div>
			</div>
		</div>
	);
}

/**
 * 选择器对话框外壳（#115 U5 收尾）：统一 shadcn Dialog + cmdk Command，
 * 旧 Prompt 选择器仍使用统一 shadcn Dialog + cmdk；模型、思考级别和引导页使用 CommandPickerPanel，共享折叠、搜索和选中项定位。
 * 保留此壳是为了支持 Prompt 预览态的特殊头部与返回操作。
 */
function PickerDialog(props: {
	title: string;
	hint?: string;
	onClose: () => void;
	className?: string;
	children: ReactNode;
}) {
	return (
		<Dialog open onOpenChange={(next) => !next && props.onClose()}>
			<DialogContent
				showCloseButton={false}
				className={cn(
					"flex flex-col gap-0 overflow-hidden p-0 sm:max-w-[min(560px,calc(100vw-48px))]",
					props.className,
				)}
			>
				<DialogHeader className="flex-row items-center justify-between px-3 py-2">
					<div className="grid gap-0.5">
						<DialogTitle>{props.title}</DialogTitle>
						{props.hint && (
							<small className="text-muted-foreground text-caption">{props.hint}</small>
						)}
					</div>
					<DialogClose asChild>
						<Button variant="ghost" size="icon" aria-label={t("common.close")} title={t("common.close")}><X size={18} strokeWidth={2.2} aria-hidden="true" /></Button>
					</DialogClose>
				</DialogHeader>
				{props.children}
			</DialogContent>
		</Dialog>
	);
}

/** Dialog wrapper for the shared Command panel; the panel owns header, search, groups, and footer. */
function CommandPickerDialog(props: {
	title: string;
	hint?: string;
	onClose: () => void;
	className?: string;
	searchPlaceholder?: string;
	emptyLabel?: ReactNode;
	value?: string;
	showGroupActions?: boolean;
	children: ReactNode;
}) {
	return (
		<Dialog open onOpenChange={(next) => !next && props.onClose()}>
			<DialogContent
				showCloseButton={false}
				className={cn(
					"flex max-h-[min(680px,calc(100vh-48px))] flex-col overflow-hidden p-0 sm:max-w-[min(560px,calc(100vw-48px))]",
					props.className,
				)}
			>
				<CommandPickerPanel
					title={props.title}
					hint={props.hint}
					searchPlaceholder={props.searchPlaceholder ?? t("app.commandPickerSearch")}
					emptyLabel={props.emptyLabel ?? t("app.commandPickerEmpty")}
					value={props.value}
					showGroupActions={props.showGroupActions}
					onClose={props.onClose}
				>
					{props.children}
				</CommandPickerPanel>
			</DialogContent>
		</Dialog>
	);
}

export function ModelPicker(props: {
	models: AvailableModel[];
	current?: { provider?: string; modelId?: string; modelName?: string };
	onClose: () => void;
	onPick: (model: AvailableModel) => void;
	/** 收藏的模型 ID 列表（格式：provider/modelId），收藏的模型独立置顶显示但仍保留在原供应商分组 */
	favoriteModels?: string[];
	/** 切换收藏状态；引导页不提供收藏操作，因此允许省略。 */
	onToggleFavorite?: (provider: string, modelId: string) => void;
}) {
	const currentModelKey = props.current?.provider && props.current?.modelId
		? `${props.current.provider}/${props.current.modelId}`
		: undefined;
	const favoritesSet = new Set(props.favoriteModels ?? []);

	// 收藏列表（从全部模型中提取，不移除原供应商分组下的显示）
	const favorites: AvailableModel[] = props.models.filter((model) =>
		favoritesSet.has(`${model.provider}/${model.id}`),
	);
	favorites.sort((a, b) => {
		const ap = a.provider ?? '';
		const bp = b.provider ?? '';
		if (ap !== bp) return ap.localeCompare(bp);
		return (a.name ?? a.id).localeCompare(b.name ?? b.id);
	});

	// 全量模型按供应商分组（收藏模型也保留在原分组）；
	// 搜索交给 cmdk（item 的 value/keywords 同时覆盖 name/id/provider）
	const groupedModels = groupModelsByProvider(props.models);
	const providerOrder = ['anthropic', 'openai', 'google', 'deepseek', 'other'];
	const sortedProviders = Object.keys(groupedModels).sort((a, b) => {
		const aIndex = providerOrder.indexOf(a);
		const bIndex = providerOrder.indexOf(b);
		if (aIndex !== -1 && bIndex !== -1) return aIndex - bIndex;
		if (aIndex !== -1) return -1;
		if (bIndex !== -1) return 1;
		return a.localeCompare(b);
	});

	const renderModelRow = (model: AvailableModel) => {
		const modelKey = `${model.provider}/${model.id}`;
		const selected = modelKey === currentModelKey;
		const favorited = favoritesSet.has(modelKey);
		return (
			<CommandItem
				key={modelKey}
				value={modelKey}
				data-picker-value={modelKey}
				keywords={[model.name ?? "", model.id, model.provider, modelKey]}
				onSelect={() => props.onPick(model)}
				className="group min-h-9 items-center gap-2 rounded-md px-2.5 py-1"
			>
				{/* 收藏/取消收藏按钮：填充星为收藏，空心为未收藏 */}
				{props.onToggleFavorite && (
					<button
						type="button"
						className={`grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground${favorited ? " text-amber-500" : ""}`}
						title={favorited ? t("app.modelUnfavorite") : t("app.modelFavorite")}
						aria-label={favorited ? t("app.modelUnfavorite") : t("app.modelFavorite")}
						onClick={(e) => {
							e.stopPropagation();
							props.onToggleFavorite?.(model.provider, model.id);
						}}
					>
						<Star size={14} strokeWidth={1.8} fill={favorited ? "currentColor" : "none"} />
					</button>
				)}
				<span className="min-w-0 flex-1 truncate font-mono text-control font-medium text-foreground" title={model.name ? `${model.name} · ${modelKey}` : modelKey}>
					{modelKey}
				</span>
				{selected ? <Check size={15} className="ml-auto shrink-0 text-primary" aria-hidden="true" /> : null}
			</CommandItem>
		);
	};

	return (
		<CommandPickerDialog
			title={t("app.modelPickerTitle")}
			onClose={props.onClose}
			className="model-picker sm:max-w-[min(720px,calc(100vw-32px))]"
			searchPlaceholder={t("app.modelPickerSearch")}
			emptyLabel={t("app.modelPickerEmpty")}
			value={currentModelKey}
			showGroupActions
		>
			{favorites.length > 0 && (
				<CommandPickerGroup id="favorites" label={t("app.modelFavorites")} count={favorites.length}>
					{favorites.map(renderModelRow)}
				</CommandPickerGroup>
			)}
			{sortedProviders.map((provider) => (
				<CommandPickerGroup id={`provider:${provider}`} key={provider} label={provider} count={groupedModels[provider].length}>
					{groupedModels[provider].map(renderModelRow)}
				</CommandPickerGroup>
			))}
		</CommandPickerDialog>
	);
}

export function ComposerModePicker(props: {
	currentMode: ComposerAgentMode;
	planModeAvailable: boolean;
	onClose: () => void;
	onPick: (mode: ComposerAgentMode) => void;
}) {
	const items = [
		{
			value: "normal" as const,
			labelKey: "app.composerModeNormal" as const,
			descriptionKey: "app.composerModeNormalDesc" as const,
		},
		...(props.planModeAvailable ? [{
			value: "plan" as const,
			labelKey: "app.composerModePlan" as const,
			descriptionKey: "app.composerModePlanDesc" as const,
		}] : []),
	];

	return (
		<CommandPickerDialog
			title={t("app.composerModeTitle")}
			onClose={props.onClose}
			className="composer-mode-picker"
			value={props.currentMode}
		>
			{items.map((item) => {
				const selected = item.value === props.currentMode;
				return (
					<CommandItem
						key={item.value}
						value={item.value}
						data-picker-value={item.value}
						onSelect={() => props.onPick(item.value)}
						className="min-h-9 items-center gap-2 rounded-md px-2.5 py-1"
					>
						<span className={`grid size-6 shrink-0 place-items-center rounded-md ${selected ? "bg-primary/12 text-primary" : "bg-muted text-muted-foreground"}`}>
							{item.value === "plan" ? <ListChecks size={14} aria-hidden="true" /> : <Wrench size={14} aria-hidden="true" />}
						</span>
						{/* 弹窗项文案：普通/计划模式均不加粗，plan 用图标/选中态作为区分。 */}
						<span className="min-w-0 flex-1 truncate text-control font-normal text-foreground" title={t(item.descriptionKey)}>{t(item.labelKey)}</span>
						{selected ? <Check size={15} className="ml-auto shrink-0 text-primary" aria-hidden="true" /> : null}
					</CommandItem>
				);
			})}
		</CommandPickerDialog>
	);
}

export function ThinkingPicker(props: {
	current?: string;
	onClose: () => void;
	onPick: (level: string) => void;
}) {
	return (
		<CommandPickerDialog
			title={t("app.thinkingPickerTitle")}
			hint={t("app.thinkingPickerHint")}
			onClose={props.onClose}
			className="thinking-picker"
			value={props.current}
		>
			{THINKING_LEVELS.map((level) => {
				const selected = level.value === props.current;
				return (
					<CommandItem
						key={level.value}
						value={level.value}
						data-picker-value={level.value}
						onSelect={() => props.onPick(level.value)}
						className="min-h-9 items-center gap-2 rounded-md px-2.5 py-1"
					>
						<span className={`grid size-6 shrink-0 place-items-center rounded-md ${selected ? "bg-primary/12 text-primary" : "bg-muted text-muted-foreground"}`}>
							<Brain size={14} aria-hidden="true" />
						</span>
						<span className="min-w-0 flex-1 truncate text-control font-semibold text-foreground" title={t(level.descriptionKey)}>{t(level.labelKey)}</span>
						{selected ? <Check size={15} className="ml-auto shrink-0 text-primary" aria-hidden="true" /> : null}
					</CommandItem>
				);
			})}
		</CommandPickerDialog>
	);
}

/**
 * Prompt Template 选择器：列出 ~/.pi/agent/prompts/ 下所有 .md 模板，
 * 点击后将模板内容插入到 composer 输入框。
 */
export function PromptTemplatePicker(props: {
	templates: Array<{
		name: string;
		path: string;
		description: string;
		content: string;
		scope?: "global" | "project";
		argumentHint?: string;
	}>;
	onClose: () => void;
	onPick: (template: {
		name: string;
		path: string;
		description: string;
		content: string;
		scope?: "global" | "project";
		argumentHint?: string;
	}) => void;
}) {
	type TemplateItem = typeof props.templates[number];
	const [previewTemplate, setPreviewTemplate] = useState<TemplateItem | null>(null);

	// 预览态：替换标题为返回按钮 + 模板名，正文为模板内容（沿用旧内联预览设计）
	if (previewTemplate) {
		return (
			<PickerDialog
				title={t("app.promptTemplatePreviewTitle", { name: "/" + previewTemplate.name })}
				onClose={props.onClose}
				className="prompt-template-picker"
			>
				<div className="picker-preview-inline">
					<Button
						type="button"
						variant="ghost"
						className="h-auto gap-1 px-1 text-caption"
						onClick={() => setPreviewTemplate(null)}
						title={t("app.promptTemplateBackToPicker")}
					>
						<ChevronLeft size={16} strokeWidth={2.2} />
						{t("app.promptTemplateBackToPicker")}
					</Button>
					<pre className="picker-preview-content">{previewTemplate.content}</pre>
				</div>
			</PickerDialog>
		);
	}

	return (
		<PickerDialog title={t("app.promptTemplatePickerTitle")} onClose={props.onClose} className="prompt-template-picker">
			<Command>
				<CommandInput placeholder={t("app.promptTemplateSearchPlaceholder")} autoFocus />
				<CommandList>
					<CommandEmpty>{t("app.promptTemplateSearchEmpty")}</CommandEmpty>
					{props.templates.length === 0 && (
						<div className="py-6 text-center text-body text-muted-foreground">{t("app.promptTemplateEmpty")}</div>
					)}
					{props.templates.map((template) => (
						<CommandItem
							key={template.path}
							value={`/${template.name}`}
							keywords={[template.name, template.description]}
							onSelect={() => props.onPick(template)}
						>
							<FileText size={14} strokeWidth={1.8} aria-hidden="true" />
							<span className="picker-palette-label">/{template.name}</span>
							{template.argumentHint && (
								<code className="picker-palette-arg-hint">{template.argumentHint}</code>
							)}
							<span className="picker-palette-desc">{template.description}</span>
							<Button
								type="button"
								variant="ghost"
								size="icon-sm"
								title={t("common.preview")}
								onClick={(e) => {
									e.stopPropagation();
									setPreviewTemplate(template);
								}}
							>
								<Eye size={14} strokeWidth={1.8} />
							</Button>
						</CommandItem>
					))}
				</CommandList>
			</Command>
		</PickerDialog>
	);
}
