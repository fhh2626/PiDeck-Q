/**
 * 子代理偏好弹框（右侧悬浮工具条「子代理」入口）。
 *
 * 只做三件事：切换「子代理用独立模型」、选模型/思考强度、切换「优先委派」。
 * 配置落在 pi settings.json 的 `subagents` 块（全局或当前项目），
 * 由 pideck-q-subagents 扩展消费——PiDeck 不另存一份，避免状态漂移。
 */

import { useEffect, useRef, useState } from "react";
import { Check, ChevronsUpDown, Loader2, Users, X } from "lucide-react";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "../ui-shadcn/dialog";
import { Button } from "../ui-shadcn/button";
import { Switch } from "../ui-shadcn/switch";
import { Popover, PopoverContent, PopoverTrigger } from "../ui-shadcn/popover";
import {
	Command,
	CommandEmpty,
	CommandInput,
	CommandItem,
	CommandList,
} from "../ui-shadcn/command";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "../ui-shadcn/select";
import { cn } from "../../lib/utils";
import { t } from "../../i18n";
import { desktopApi } from "../../desktopApi";
import { showNotice } from "../../utils/notice";
import type {
	AvailableModel,
	SubagentSettings,
	SubagentSettingsScope,
	SubagentSettingsSnapshot,
} from "../../../../shared/types";
import { findModelThinkingSupport, isExtendedThinkingLevel } from "../../../../shared/thinkingLevelSupport";
import { THINKING_LEVELS } from "../session/sessionPickerOptions";
import {
	dirtySubagentScopes,
	emptySubagentSettingsDraft as emptyDraft,
} from "../../utils/subagentSettingsDraft";

/** 思考强度「不指定」哨兵：不写 defaultThinking，子代理沿用 pi 默认档位。 */
const THINKING_INHERIT = "inherit";

const THINKING_LABEL_KEYS = new Map(THINKING_LEVELS.map((level) => [level.value, level.labelKey]));

function thinkingLabel(level: string): string {
	const key = THINKING_LABEL_KEYS.get(level);
	return key ? t(key) : level;
}

export function SubagentSettingsDialog(props: {
	open: boolean;
	/** 当前项目 id；无项目时只能配置全局作用域。 */
	projectId?: string;
	projectName?: string;
	onClose: () => void;
}) {
	const [scope, setScope] = useState<SubagentSettingsScope>("global");
	const [snapshot, setSnapshot] = useState<SubagentSettingsSnapshot | null>(null);
	// 每个作用域各留一份草稿：切到另一个作用域再切回来，未保存的改动还在。
	const [drafts, setDrafts] = useState<Record<SubagentSettingsScope, SubagentSettings>>({
		global: emptyDraft(),
		project: emptyDraft(),
	});
	const draft = drafts[scope];
	const setDraft = (updater: (previous: SubagentSettings) => SubagentSettings) => {
		setDrafts((previous) => ({ ...previous, [scope]: updater(previous[scope]) }));
	};
	const [models, setModels] = useState<AvailableModel[]>([]);
	const [loading, setLoading] = useState(false);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [modelPickerOpen, setModelPickerOpen] = useState(false);
	// 读取代数：打开弹框或切换项目都会重读；后发的读取必须丢弃先发的结果，
	// 否则快速切换项目时旧项目的配置会覆盖新项目的草稿。
	const loadGenerationRef = useRef(0);

	const projectAvailable = Boolean(props.projectId);

	// 每次打开都重新读取：配置文件是唯一权威状态，不在渲染层做长期缓存。
	useEffect(() => {
		if (!props.open) return;
		const generation = ++loadGenerationRef.current;
		let cancelled = false;
		setLoading(true);
		setError(null);
		setSnapshot(null);
		setScope("global");
		void desktopApi.subagents
			.getSettings(props.projectId)
			.then((next) => {
				if (cancelled) return;
				setSnapshot(next);
				setDrafts({ global: next.global, project: next.project ?? emptyDraft() });
			})
			.catch((e: unknown) => {
				if (!cancelled) setError(e instanceof Error ? e.message : String(e));
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});
		// 模型列表用于选择器；失败只影响可选模型，不阻塞开关操作。
		void desktopApi.projects
			.listModels(props.projectId)
			.then((next) => {
				if (!cancelled) setModels(next);
			})
			.catch(() => {
				if (!cancelled) setModels([]);
			});
		return () => {
			cancelled = true;
		};
	}, [props.open, props.projectId]);

	/** 切换作用域：两个作用域各自保留草稿，互不覆盖。 */
	const handleScopeChange = (next: SubagentSettingsScope) => {
		if (next === scope) return;
		if (next === "project" && !projectAvailable) return;
		setScope(next);
		// 错误属于刚离开的那个作用域（如「请先选择模型」），切走后不再展示。
		setError(null);
	};

	// 两个作用域各自可能被改过：保存按钮按「有没有任何改动」启用，保存时一起写盘，
	// 避免只保存当前作用域而静默丢掉另一个作用域的编辑。
	const dirtyScopes = dirtySubagentScopes({
		drafts,
		saved: { global: snapshot?.global ?? emptyDraft(), project: snapshot?.project ?? null },
		projectAvailable,
	});
	const dirty = dirtyScopes.length > 0;

	const currentModel = draft.model;
	const thinkingSupport = findModelThinkingSupport(models, currentModel?.provider, currentModel?.modelId);
	// 与主界面选择器同一套门控：模型未声明 xhigh/max 时不展示这两个档位。
	// 已保存的档位例外：模型列表拉取失败或模型已被移除时，Select 找不到对应 item 会渲染成空白触发器。
	const visibleThinkingLevels = THINKING_LEVELS.filter(
		(level) => !isExtendedThinkingLevel(level.value)
			|| thinkingSupport[level.value]
			|| level.value === draft.model?.thinkingLevel,
	);

	const handleToggleOwnModel = (checked: boolean) => {
		setDraft((prev) => {
			if (!checked) {
				// 关闭时保留已选模型作为下次打开的默认值，但不写入配置（保存时按关闭处理）。
				return { ...prev, useOwnModel: false };
			}
			// 首次开启且没有选择：预填当前列表第一个模型，避免「开着但没模型」无法保存。
			if (prev.model?.modelId) return { ...prev, useOwnModel: true };
			const first = models[0];
			return {
				...prev,
				useOwnModel: true,
				...(first ? { model: { provider: first.provider, modelId: first.id } } : {}),
			};
		});
	};

	const handlePickModel = (model: AvailableModel) => {
		setDraft((prev) => {
			const support = findModelThinkingSupport(models, model.provider, model.id);
			const previousLevel = prev.model?.thinkingLevel;
			// 换模型后档位可能不再被支持：按主界面同一规则退回 high。
			const thinkingLevel = previousLevel && isExtendedThinkingLevel(previousLevel) && !support[previousLevel]
				? "high"
				: previousLevel;
			return {
				...prev,
				model: {
					provider: model.provider,
					modelId: model.id,
					...(thinkingLevel ? { thinkingLevel } : {}),
				},
			};
		});
		setModelPickerOpen(false);
	};

	const handleSave = async () => {
		if (!snapshot || saving || dirtyScopes.length === 0) return;
		// 记录本次保存对应的读取代数：保存期间换了项目（重读已发起）就不再写盘，
		// 否则会把上一个项目的草稿写到新项目上。
		const generation = loadGenerationRef.current;
		// 开关打开却没有模型：不写盘，切到出问题的作用域并提示（主进程同样会拒绝）。
		const invalid = dirtyScopes.find(
			(value) => drafts[value].useOwnModel && !drafts[value].model?.modelId,
		);
		if (invalid) {
			setScope(invalid);
			setError(t("subagents.modelRequired"));
			return;
		}
		setSaving(true);
		setError(null);
		try {
			for (const value of dirtyScopes) {
				if (generation !== loadGenerationRef.current) return;
				await desktopApi.subagents.saveSettings(value, props.projectId, drafts[value]);
			}
			if (generation !== loadGenerationRef.current) return;
			const next = await desktopApi.subagents.getSettings(props.projectId);
			setSnapshot(next);
			setDrafts({ global: next.global, project: next.project ?? emptyDraft() });
			showNotice(t("subagents.savedToast"));
			props.onClose();
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setSaving(false);
		}
	};

	const modelLabel = draft.model
		? `${draft.model.provider ? `${draft.model.provider}/` : ""}${draft.model.modelId}`
		: t("subagents.pickModel");

	const scopeButton = (value: SubagentSettingsScope, label: string, disabled = false) => (
		<Button
			type="button"
			variant={scope === value ? "secondary" : "ghost"}
			size="sm"
			className="h-7 px-2.5 text-caption"
			disabled={disabled}
			onClick={() => handleScopeChange(value)}
		>
			{label}
		</Button>
	);

	return (
		<Dialog open={props.open} onOpenChange={(next) => { if (!next && !saving) props.onClose(); }}>
			<DialogContent
				className="max-w-[520px] gap-4 p-5 sm:max-w-[520px]"
				closeLabel={t("common.close")}
				closeDisabled={saving}
			>
				<DialogHeader>
					<DialogTitle className="flex items-center gap-2 text-base">
						<Users size={16} strokeWidth={1.8} className="text-text-tertiary" />
						{t("subagents.title")}
					</DialogTitle>
					{/* text-caption 会被 tailwind-merge 当作颜色类丢弃，显式声明 length/line-height 保证 caption 字号生效。 */}
					<DialogDescription className="text-[length:var(--font-size-caption)] leading-[var(--line-height-caption)] text-muted-foreground">
						{t("subagents.description")}
					</DialogDescription>
				</DialogHeader>

				{loading ? (
					<div className="flex items-center justify-center py-6 text-muted-foreground">
						<Loader2 className="size-4 animate-spin" aria-hidden="true" />
					</div>
				) : (
					<div className="grid gap-4">
						{/* 作用域：全局配置对所有项目生效；项目配置覆盖全局 */}
						<div className="flex items-center justify-between gap-3">
							<span className="text-caption text-muted-foreground">{t("subagents.scope")}</span>
							<div className="flex items-center gap-1 rounded-md border border-border-subtle p-0.5">
								{scopeButton("global", t("subagents.scopeGlobal"))}
								{scopeButton(
									"project",
									props.projectName ? t("subagents.scopeProjectNamed", { name: props.projectName }) : t("subagents.scopeProject"),
									!projectAvailable,
								)}
							</div>
						</div>

						{/* 第一条：子代理使用独立模型 */}
						<div className="grid gap-2 rounded-md border border-border-subtle p-3">
							<label className="flex cursor-pointer items-start justify-between gap-3">
								<span className="grid gap-0.5">
									<span className="text-control font-medium text-foreground">{t("subagents.ownModel")}</span>
									<span className="text-caption text-muted-foreground">{t("subagents.ownModelDesc")}</span>
								</span>
								<Switch
									checked={draft.useOwnModel}
									onCheckedChange={handleToggleOwnModel}
									aria-label={t("subagents.ownModel")}
								/>
							</label>

							{/* 第二条：模型 + 思考强度；未开启独立模型时整块置灰 */}
							<div
								className={cn(
									"grid gap-2 rounded-md border border-border-subtle bg-bg-panel p-2 sm:grid-cols-[minmax(0,1fr)_auto]",
									!draft.useOwnModel && "pointer-events-none opacity-50",
								)}
								aria-disabled={!draft.useOwnModel}
							>
								<Popover open={modelPickerOpen} onOpenChange={setModelPickerOpen}>
									<PopoverTrigger asChild>
										<Button
											type="button"
											variant="ghost"
											size="sm"
											className="h-8 min-w-0 justify-between gap-1 px-2 text-caption"
											disabled={!draft.useOwnModel}
											title={modelLabel}
										>
											<span className="min-w-0 truncate">{modelLabel}</span>
											<ChevronsUpDown className="size-3.5 shrink-0 opacity-60" aria-hidden="true" />
										</Button>
									</PopoverTrigger>
									<PopoverContent align="start" className="w-[min(360px,calc(100vw-24px))] p-0">
										<Command>
											<CommandInput placeholder={t("subagents.modelSearch")} />
											<CommandList className="max-h-[min(320px,50vh)]">
												<CommandEmpty>{t("subagents.modelEmpty")}</CommandEmpty>
												{models.map((item) => {
													const value = `${item.provider}/${item.id}`;
													const selected = draft.model?.provider === item.provider && draft.model?.modelId === item.id;
													return (
														<CommandItem
															key={value}
															value={`${item.provider} ${item.name ?? item.id} ${item.id}`}
															onSelect={() => handlePickModel(item)}
														>
															<Check className={cn("mr-2 size-4", selected ? "opacity-100" : "opacity-0")} aria-hidden="true" />
															<span className="min-w-0 flex-1 truncate">{item.name ?? item.id}</span>
															<span className="shrink-0 text-caption text-muted-foreground">{item.provider}</span>
														</CommandItem>
													);
												})}
											</CommandList>
										</Command>
									</PopoverContent>
								</Popover>

								<Select
									value={draft.model?.thinkingLevel ?? THINKING_INHERIT}
									disabled={!draft.useOwnModel}
									onValueChange={(level) => {
										setDraft((prev) => {
											if (!prev.model) return prev;
											const { thinkingLevel: _previous, ...rest } = prev.model;
											return {
												...prev,
												model: level === THINKING_INHERIT ? rest : { ...rest, thinkingLevel: level },
											};
										});
									}}
								>
									<SelectTrigger size="sm" className="h-8 w-32 text-caption" aria-label={t("subagents.thinking")}>
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										{/* 未选择档位 = 不写 defaultThinking，子代理沿用 pi 的默认档位 */}
										<SelectItem value={THINKING_INHERIT}>{t("subagents.thinkingInherit")}</SelectItem>
										{visibleThinkingLevels.map((level) => (
											<SelectItem key={level.value} value={level.value}>
												{thinkingLabel(level.value)}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</div>
						</div>

						{/* 第三条：优先委派 */}
						<div className="rounded-md border border-border-subtle p-3">
							<label className="flex cursor-pointer items-start justify-between gap-3">
								<span className="grid gap-0.5">
									<span className="text-control font-medium text-foreground">{t("subagents.preferDelegation")}</span>
									<span className="text-caption text-muted-foreground">{t("subagents.preferDelegationDesc")}</span>
								</span>
								<Switch
									checked={draft.preferDelegation}
									onCheckedChange={(checked) => setDraft((prev) => ({ ...prev, preferDelegation: checked }))}
									aria-label={t("subagents.preferDelegation")}
								/>
							</label>
						</div>

						{error && <p className="text-caption text-destructive">{error}</p>}
					</div>
				)}

				<div className="flex items-center justify-end gap-2">
					<Button variant="ghost" size="sm" onClick={props.onClose} disabled={saving}>
						<X size={14} aria-hidden="true" />
						{t("common.cancel")}
					</Button>
					<Button
						size="sm"
						onClick={() => void handleSave()}
						disabled={loading || saving || !dirty}
						loading={saving}
					>
						{t("common.save")}
					</Button>
				</div>
			</DialogContent>
		</Dialog>
	);
}
