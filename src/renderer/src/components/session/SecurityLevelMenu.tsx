/**
 * 会话安全等级选择器（输入框底栏）
 *
 * 每个会话可独立选择安全等级：会话级覆盖（sessionId → levelId）保存在
 * SecurityStore，选择后主进程写策略快照，安全门扩展热更新（≤2s）即时生效。
 *
 * 交互样式与「思考级别」选择器（ThinkingPicker）同款：CommandPickerDialog
 * 居中面板 + CommandItem 列表，不自行手搓浮层菜单；自包含组件，按 sessionId
 * 隔离订阅，不依赖全局 atom。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, RotateCcw, Shield, ShieldAlert, ShieldCheck, ShieldOff } from "lucide-react";
import type { SecurityConfig, SecurityLevelConfig } from "../../../../shared/types";
import { desktopApi } from "../../desktopApi";
import { Button } from "../ui-shadcn/button";
import { Dialog, DialogContent } from "../ui-shadcn/dialog";
import { CommandItem, CommandSeparator } from "../ui-shadcn/command";
import { CommandPickerPanel } from "../ui-shadcn/command-picker";
import { t } from "../../i18n";

// Native 在 React 挂载前异步完成 transport bootstrap；用 getter 避免模块加载时捕获 preview API。
const api = {
	get security() {
		return desktopApi.security;
	},
};

/** 等级图标：内置三档各用专属盾牌语义，自定义等级用通用盾牌 */
function levelIcon(level: SecurityLevelConfig) {
	if (level.id === "off") return ShieldOff;
	if (level.id === "strict") return ShieldAlert;
	if (level.id === "standard") return ShieldCheck;
	return Shield;
}

export function SecurityLevelMenu(props: { sessionId: string; disabled?: boolean }) {
	const [config, setConfig] = useState<SecurityConfig | null>(null);
	const [open, setOpen] = useState(false);
	const [saving, setSaving] = useState(false);
	const mountedRef = useRef(true);

	useEffect(() => {
		mountedRef.current = true;
		api.security.getConfig().then((loaded) => {
			if (mountedRef.current) setConfig(loaded);
		}).catch(() => {
			// 配置拉取失败：菜单置灰即可，不打扰输入
		});
		return () => {
			mountedRef.current = false;
		};
	}, [props.sessionId]);

	// 当前生效等级 id：会话覆盖优先，其次全局默认
	const effectiveLevelId = useMemo(() => {
		if (!config) return null;
		return config.sessionOverrides[props.sessionId] ?? config.defaultLevelId;
	}, [config, props.sessionId]);

	const effectiveLevel = useMemo(() => {
		if (!config || !effectiveLevelId) return null;
		return config.levels.find((level) => level.id === effectiveLevelId) ?? null;
	}, [config, effectiveLevelId]);

	const handlePick = useCallback(
		async (levelId: string | null) => {
			setSaving(true);
			try {
				const result = await api.security.setSessionLevel(props.sessionId, levelId);
				if (result.ok && mountedRef.current) {
					setConfig(result.config);
					setOpen(false);
				}
			} catch {
				// 保存失败保持原状
			} finally {
				if (mountedRef.current) setSaving(false);
			}
		},
		[props.sessionId],
	);

	if (!config) {
		// 配置未加载完成时不渲染按钮（避免闪烁）
		return null;
	}

	const enabled = config.enabled;
	const levelName = effectiveLevel?.name ?? t("security.levelUnknown");
	const hasSessionOverride =
		effectiveLevelId != null && effectiveLevelId !== config.defaultLevelId;

	const Icon = !enabled ? ShieldOff : levelIcon(effectiveLevel ?? config.levels[0]);

	return (
		<>
			<Button
				variant="ghost"
				size="icon"
				className={`composer-bar-btn security size-7 rounded-md text-foreground hover:bg-muted/60 ${enabled ? "security-active" : "opacity-60"}`}
				disabled={props.disabled || saving}
				aria-label={t("security.menuTitle")}
				title={`${t("security.menuTitle")}: ${levelName}`}
				onClick={() => setOpen(true)}
			>
				<Icon size={15} strokeWidth={2} aria-hidden="true" />
			</Button>
			<Dialog open={open} onOpenChange={(next) => { if (!next) setOpen(false); }}>
				<DialogContent
					showCloseButton={false}
					className="flex max-h-[min(680px,calc(100vh-48px))] flex-col overflow-hidden p-0 sm:max-w-[min(560px,calc(100vw-48px))]"
				>
					<CommandPickerPanel
						title={t("security.menuTitle")}
						hint={enabled ? t("security.menuHint") : t("security.menuDisabledHint")}
						searchPlaceholder={t("app.commandPickerSearch")}
						emptyLabel={t("security.pickerEmpty")}
						value={effectiveLevelId ?? undefined}
						onClose={() => setOpen(false)}
					>
						{config.levels.map((level) => {
								const selected = effectiveLevelId === level.id;
								const ItemIcon = levelIcon(level);
								return (
									<CommandItem
										key={level.id}
										value={level.id}
										data-picker-value={level.id}
										onSelect={() => void handlePick(level.id)}
										disabled={!enabled || saving}
										className="min-h-9 items-center gap-2 rounded-md px-2.5 py-1"
									>
										<span className={`grid size-6 shrink-0 place-items-center rounded-md ${selected ? "bg-primary/12 text-primary" : "bg-muted text-muted-foreground"}`}>
											<ItemIcon size={14} aria-hidden="true" />
										</span>
										<span className="min-w-0 flex-1 truncate text-control font-semibold text-foreground" title={level.description}>
											{level.name}
										</span>
										{selected ? <Check size={15} className="ml-auto shrink-0 text-primary" aria-hidden="true" /> : null}
									</CommandItem>
								);
							})}
							{enabled && hasSessionOverride && (
								<>
									<CommandSeparator />
									{/* 清除会话覆盖：跟随全局默认同样渲染为可选项（与等级项同宽同行），
										避免被误读为说明文字 */}
									<CommandItem
										value="__global_default__"
										data-picker-value="__global_default__"
										onSelect={() => void handlePick(null)}
										disabled={saving}
										className="min-h-9 items-center gap-2 rounded-md px-2.5 py-1"
									>
										<span className="grid size-6 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
											<RotateCcw size={14} aria-hidden="true" />
										</span>
										<span className="min-w-0 flex-1 truncate text-control font-semibold text-foreground">
											{t("security.followDefault")}
										</span>
									</CommandItem>
								</>
							)}
						</CommandPickerPanel>
				</DialogContent>
			</Dialog>
		</>
	);
}
