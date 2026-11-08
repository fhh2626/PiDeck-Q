/**
 * WebHeader — Web 端会话头部（与桌面 SessionHeader 同布局）。
 *
 * 左侧：会话标题（截断）；右侧：运行态指示和模型/思考控制。
 * 运行态来自 useChat status（submitted/streaming）与轮询的 runtime.status 兜底。
 */
import { useState } from "react";
import { Check, ChevronsUpDown, Menu } from "lucide-react";
import type { AvailableModel } from "../../../shared/types";
import { Button } from "@/components/ui-shadcn/button";
import {
	Command,
	CommandEmpty,
	CommandInput,
	CommandItem,
	CommandList,
} from "@/components/ui-shadcn/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui-shadcn/popover";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui-shadcn/select";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";

export type WebHeaderStatus = "idle" | "starting" | "running" | "error";

export function WebHeader(props: {
	title: string;
	status: WebHeaderStatus;
	onOpenSidebar: () => void;
	model?: { provider: string; modelId: string };
	thinkingLevel?: string;
	models: AvailableModel[];
	onModelChange: (model: AvailableModel) => void;
	onThinkingChange: (level: string) => void;
}) {
	const {
		title,
		status,
		onOpenSidebar,
		model,
		thinkingLevel,
		models,
		onModelChange,
		onThinkingChange,
	} = props;
	// 允许窄屏换行：标题保留可用宽度，控制项在下一行展开，避免手机上相互挤压。
	return (
		<header className="chat-header flex min-w-0 flex-wrap items-center gap-2 border-b border-border bg-background px-3 py-2">
			<Button
				type="button"
				variant="ghost"
				size="icon"
				className="mobile-sidebar-toggle size-8 shrink-0"
				onClick={onOpenSidebar}
				aria-label={t("web.openProjects")}
				title={t("web.openProjects")}
			>
				<Menu className="size-4" aria-hidden="true" />
			</Button>
			<div className="chat-title-block min-w-0 flex-1">
				<strong
					className="block min-w-0 truncate text-sm font-semibold tracking-tight text-foreground"
					title={title}
				>
					{title}
				</strong>
			</div>
			<div className="chat-header-actions flex min-w-0 max-w-full flex-wrap items-center justify-end gap-1.5">
				{/* 模型/思考/状态成组：窄屏时整组换到下一行，避免控制项被挤成竖排。 */}
				<div className="chat-header-runtime flex min-w-0 items-center gap-1.5">
					<ModelPicker model={model} models={models} onChange={onModelChange} />
					<Select value={thinkingLevel ?? "off"} onValueChange={onThinkingChange}>
						<SelectTrigger
							size="sm"
							className="w-24 shrink-0 border-transparent bg-transparent px-2 text-caption text-muted-foreground hover:bg-muted/60"
							aria-label={t("web.thinking")}
							title={t("web.thinking")}
						>
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{thinkingLevels.map((level) => (
								<SelectItem key={level} value={level}>{thinkingLabel(level)}</SelectItem>
							))}
						</SelectContent>
					</Select>
					{/* 运行态指示：复用桌面 agent-status-indicator 视觉 */}
					<span className="flex shrink-0 items-center gap-2">
						<span
							className={cn(
								"agent-status-indicator",
								status === "running" && "status-running",
								status === "starting" && "status-starting",
								status === "error" && "status-error",
								status === "idle" && "status-idle",
							)}
						>
							{t(statusLabelKey(status))}
						</span>
					</span>
				</div>
			</div>
		</header>
	);
}

function ModelPicker(props: {
	model?: { provider: string; modelId: string };
	models: AvailableModel[];
	onChange: (model: AvailableModel) => void;
}) {
	const [open, setOpen] = useState(false);
	const { model, models, onChange } = props;
	const currentValue = model ? `${model.provider}::${model.modelId}` : "";

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>
				<Button
					type="button"
					variant="ghost"
					size="sm"
					className="h-8 min-w-0 max-w-52 shrink justify-between gap-1 px-2 text-caption text-muted-foreground hover:bg-muted/60 hover:text-foreground"
					aria-label={t("web.model")}
					title={model ? `${model.provider}/${model.modelId}` : t("web.model")}
				>
					<span className="min-w-0 truncate">{model ? `${model.provider}/${model.modelId}` : t("web.model")}</span>
					<ChevronsUpDown className="size-3.5 shrink-0" aria-hidden="true" />
				</Button>
			</PopoverTrigger>
			<PopoverContent align="end" className="w-[min(360px,calc(100vw-24px))] p-0">
				<Command>
					<CommandInput placeholder={t("web.modelSearch")} />
					<CommandList className="max-h-[min(360px,55vh)]">
						<CommandEmpty>{t("web.modelEmpty")}</CommandEmpty>
						{models.map((item) => {
							const value = `${item.provider}::${item.id}`;
							return (
								<CommandItem
									key={value}
									value={`${item.provider} ${item.name || item.id} ${item.id}`}
									onSelect={() => {
										onChange(item);
										setOpen(false);
									}}
								>
									<Check className={cn("mr-2 size-4", currentValue === value ? "opacity-100" : "opacity-0")} aria-hidden="true" />
									<span className="min-w-0 flex-1 truncate">{item.name || item.id}</span>
									<span className="shrink-0 text-caption text-muted-foreground">{item.provider}</span>
								</CommandItem>
							);
						})}
					</CommandList>
				</Command>
			</PopoverContent>
		</Popover>
	);
}

const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

function thinkingLabel(level: string) {
	switch (level) {
		case "minimal": return t("thinking.levelLabel.minimal");
		case "low": return t("thinking.levelLabel.low");
		case "medium": return t("thinking.levelLabel.medium");
		case "high": return t("thinking.levelLabel.high");
		case "xhigh": return t("thinking.levelLabel.xhigh");
		case "max": return t("thinking.levelLabel.max");
		default: return t("thinking.levelLabel.off");
	}
}

function statusLabelKey(status: WebHeaderStatus) {
	switch (status) {
		case "running":
			return "app.statusRunning" as const;
		case "starting":
			return "app.statusStarting" as const;
		case "error":
			return "app.statusError" as const;
		default:
			return "app.statusIdle" as const;
	}
}
