/**
 * 安全管理配置面板（Pi 管理弹框 → 安全管理）
 *
 * 功能：
 * - 总开关（enabled）：关闭时安全门扩展完全放行（零干预默认）；
 * - 全局默认等级：未设置会话级覆盖的会话使用；
 * - 等级管理：内置 off/standard/strict 三档 + 用户自定义；每档可配置
 *   工具动作（allow/ask/deny）、Bash 与 PowerShell 危险命令正则、目录边界、敏感文件保护、兜底动作；
 * - 会话级覆盖在会话输入框切换（见 SecurityLevelMenu），不在此处管理。
 *
 * 数据流：本组件只做「草稿编辑 + 保存」；保存走 api.security.updateConfig
 * → SecurityStore 校验/持久化 → 写策略快照 → 安全门在下一次工具调用前读取更新。
 */

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { RegExpValidator } from "@eslint-community/regexpp";
import {
	createDefaultSecurityConfig,
	DEFAULT_DENY_POWERSHELL_PATTERNS,
	type SecurityConfig,
	type SecurityLevelConfig,
} from "../../../../shared/types";
import { Button } from "../ui-shadcn/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui-shadcn/select";
import { Switch } from "../ui-shadcn/switch";
import { t } from "../../i18n";
import { desktopApi } from "../../desktopApi";
import { SecurityLevelCard } from "./SecurityLevelCard";

// Native 在 React 挂载前异步完成 transport bootstrap；用 getter 避免模块加载时捕获 preview API。
const api = {
	get security() {
		return desktopApi.security;
	},
};

/** 安全管理面板暴露给父级（ConfigModal 顶部统一保存按钮）的能力。 */
export type SecuritySectionHandle = {
	/** 保存当前草稿；返回是否成功（失败详情已写入错误区）。 */
	save: () => Promise<boolean>;
};

type SecuritySectionProps = {
	/** 草稿脏状态变化上报（true=有未保存修改）；卸载时上报 false 供父级清标记。 */
	onDirtyChange?: (dirty: boolean) => void;
};

/** 复制一份等级草稿（深拷贝，避免直接改共享引用） */
function cloneLevel(level: SecurityLevelConfig): SecurityLevelConfig {
	return {
		...level,
		toolActions: { ...level.toolActions },
		denyBashPatterns: [...level.denyBashPatterns],
		denyPowerShellPatterns: [...(level.denyPowerShellPatterns ?? (level.id === "off" ? [] : DEFAULT_DENY_POWERSHELL_PATTERNS))],
		customAllowDirs: [...level.customAllowDirs],
		denyDirs: [...level.denyDirs],
	};
}

/** Keep input newlines in the draft, but never publish empty regexes that match every command. */
function prepareLevel(level: SecurityLevelConfig): SecurityLevelConfig {
	const draft = cloneLevel(level);
	return {
		...draft,
		denyBashPatterns: draft.denyBashPatterns.map((line) => line.trim()).filter(Boolean),
		denyPowerShellPatterns: draft.denyPowerShellPatterns?.map((line) => line.trim()).filter(Boolean),
	};
}

export const SecuritySection = forwardRef<SecuritySectionHandle, SecuritySectionProps>(
	function SecuritySection({ onDirtyChange }, ref) {
		const [config, setConfig] = useState<SecurityConfig>(() => createDefaultSecurityConfig());
		const [loading, setLoading] = useState(true);
		const [loaded, setLoaded] = useState(false);
		const [loadAttempt, setLoadAttempt] = useState(0);
		const [saving, setSaving] = useState(false);
		const [dirty, setDirty] = useState(false);
		const [expandedLevelId, setExpandedLevelId] = useState<string | null>(null);
		const [error, setError] = useState<string | null>(null);
		const revision = useRef(0);
		const saveInFlight = useRef<Promise<boolean> | null>(null);
		const markDirty = useCallback(() => {
			revision.current += 1;
			setDirty(true);
		}, []);

		useEffect(() => {
			let cancelled = false;
			setLoading(true);
			setLoaded(false);
			setError(null);
			api.security
				.getConfig()
				.then((loaded) => {
					if (cancelled) return;
					setConfig({ ...loaded, levels: loaded.levels.map(cloneLevel) });
					setLoaded(true);
				})
				.catch(() => {
					if (!cancelled) setError(t("security.error.loadFailed"));
				})
				.finally(() => {
					if (!cancelled) setLoading(false);
				});
			return () => {
				cancelled = true;
			};
		}, [loadAttempt]);

		// dirty 变化上报父级（ConfigModal 顶部统一保存按钮的黄点/可用态依赖它）
		useEffect(() => {
			onDirtyChange?.(dirty);
		}, [dirty, onDirtyChange]);

		// 关闭弹框卸载组件时上报 false，避免父级残留“假脏”标记
		useEffect(() => {
			return () => onDirtyChange?.(false);
		}, [onDirtyChange]);

		const updateLevel = useCallback((levelId: string, patch: Partial<SecurityLevelConfig>) => {
			setConfig((current) => ({
				...current,
				levels: current.levels.map((level) =>
					level.id === levelId ? { ...cloneLevel(level), ...patch } : level,
				),
			}));
			markDirty();
		}, [markDirty]);

		const handleSave = useCallback((): Promise<boolean> => {
			// A ref also catches two save calls made before React renders the saving state.
			if (saveInFlight.current) return saveInFlight.current;
			if (loading || !loaded) return Promise.resolve(false);
			const levels = config.levels.map(prepareLevel);
			try {
				// A newer browser can accept syntax missing from supported Pi runtimes.
				// Match the backend's ECMAScript 2024 baseline, then check this browser too.
				const validator = new RegExpValidator({ ecmaVersion: 2024 });
				for (const level of levels) {
					for (const pattern of level.denyBashPatterns) {
						validator.validatePattern(pattern);
						new RegExp(pattern);
					}
					for (const pattern of level.denyPowerShellPatterns ?? []) {
						validator.validatePattern(pattern);
						new RegExp(pattern, "i");
					}
				}
			} catch {
				setError(t("security.error.regexUnsupported"));
				return Promise.resolve(false);
			}
			const savedRevision = revision.current;
			setSaving(true);
			setError(null);
			const pending = (async () => {
				try {
					const result = await api.security.updateConfig({
						enabled: config.enabled,
						defaultLevelId: config.defaultLevelId,
						levels,
					});
					if (!result.ok) {
						const localizedKey = result.code === "VALIDATION_FAILED"
							? "security.error.validationFailed"
							: result.code === "SNAPSHOT_WRITE_FAILED"
								? "security.error.snapshotWriteFailed"
								: "security.error.unknown";
						setError(t(localizedKey));
						return false;
					}
					// A completed request must not overwrite edits made while it was pending.
					// Returning false keeps save-and-close open until the newer draft is saved.
					if (revision.current !== savedRevision) return false;
					setConfig(result.config);
					setDirty(false);
					return true;
				} catch {
					setError(t("security.error.unknown"));
					return false;
				} finally {
					setSaving(false);
				}
			})();
			saveInFlight.current = pending;
			void pending.finally(() => { saveInFlight.current = null; });
			return pending;
		}, [config, loaded, loading]);

		// 供父级顶部统一保存按钮调用（saveByKey → security）
		useImperativeHandle(ref, () => ({ save: () => handleSave() }), [handleSave]);

		const handleReset = useCallback(() => {
			setConfig(createDefaultSecurityConfig());
			markDirty();
		}, [markDirty]);

		const handleAddCustom = useCallback(() => {
			const base = config.levels.find((level) => level.id === "standard") ?? config.levels[0];
			const id = crypto.randomUUID();
			const stamp = id.slice(0, 4);
			const next: SecurityLevelConfig = {
				...cloneLevel(base),
				id: `custom-${id}`,
				name: `${t("security.customLevelName")} ${stamp}`,
				description: "",
				builtin: false,
			};
			setConfig((current) => ({ ...current, levels: [...current.levels, next] }));
			setExpandedLevelId(next.id);
			markDirty();
		}, [config.levels, markDirty]);

		const handleDeleteLevel = useCallback((levelId: string) => {
			setConfig((current) => {
				const levels = current.levels.filter((level) => level.id !== levelId);
				// 删除的等级若为默认等级，回退 standard（保证 defaultLevelId 始终有效）
				const defaultLevelId =
					current.defaultLevelId === levelId ? "standard" : current.defaultLevelId;
				return { ...current, levels, defaultLevelId };
			});
			markDirty();
		}, [markDirty]);

		if (loading) {
			return <div className="py-12 text-center text-control text-muted-foreground">{t("common.loading")}</div>;
		}
		// Failed reads must never turn the initial disabled defaults into a writable draft.
		if (!loaded) {
			return (
				<div className="flex flex-col items-start gap-3" role="alert">
					<p className="text-control text-danger">{error}</p>
					<Button variant="outline" onClick={() => setLoadAttempt((attempt) => attempt + 1)}>
						{t("security.retryLoad")}
					</Button>
				</div>
			);
		}

		return (
			<div className="security-section flex flex-col gap-4">
				{/* 总开关 */}
				<div className="security-header flex items-start justify-between gap-3 rounded-md border border-border/60 bg-muted/30 p-3.5">
					<div className="min-w-0">
						<div className="flex items-center gap-2 text-control font-semibold">
							{t("security.enabledTitle")}
						</div>
						<p className="mt-1 text-micro leading-relaxed text-muted-foreground">
							{t("security.enabledHint")}
						</p>
					</div>
					<Switch
						checked={config.enabled}
						onCheckedChange={(checked) => {
							setConfig((current) => ({ ...current, enabled: checked }));
							markDirty();
						}}
						aria-label={t("security.enabledTitle")}
					/>
				</div>

				{/* 全局默认等级 */}
				<div className="security-default flex items-center justify-between gap-3">
					<label className="text-control font-medium" htmlFor="security-default-level">
						{t("security.defaultLevelTitle")}
					</label>
					<Select
						value={config.defaultLevelId}
						onValueChange={(value) => {
							setConfig((current) => ({ ...current, defaultLevelId: value }));
							markDirty();
						}}
					>
						<SelectTrigger id="security-default-level" className="w-52">
							<SelectValue placeholder={t("security.selectLevel")} />
						</SelectTrigger>
						<SelectContent>
							{config.levels.map((level) => (
								<SelectItem key={level.id} value={level.id}>
									{level.name}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>

				{/* 等级列表 */}
				<div className="security-levels flex flex-col gap-2">
					<div className="flex items-center justify-between">
						<span className="text-micro font-semibold text-muted-foreground">{t("security.levelsTitle")}</span>
						<div className="flex gap-1.5">
							<Button variant="outline" size="sm" onClick={handleReset} disabled={saving}>
								{t("security.reset")}
							</Button>
							<Button variant="secondary" size="sm" onClick={handleAddCustom} disabled={saving}>
								{t("security.addLevel")}
							</Button>
						</div>
					</div>
					{config.levels.map((level) => (
						<SecurityLevelCard
							key={level.id}
							level={level}
							expanded={expandedLevelId === level.id}
							onToggle={() => setExpandedLevelId(expandedLevelId === level.id ? null : level.id)}
							onChange={(patch) => updateLevel(level.id, patch)}
							onDelete={() => handleDeleteLevel(level.id)}
						/>
					))}
				</div>

				{error && (
					<div className="rounded-sm border border-danger/20 bg-danger-soft px-3.5 py-2.5 text-control leading-relaxed text-danger whitespace-pre-line">
						{error}
					</div>
				)}
			</div>
		);
});
