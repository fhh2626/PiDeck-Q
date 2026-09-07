import { Component, lazy, memo, Suspense, useCallback, useRef, useState, type ReactNode } from "react";
import {
	Settings2,
	Network,
	Wrench,
	PawPrint,
	Trash2,
	Brush,
	Eye,
	ChartColumnBig,
	Activity,
	MessageSquare,
	X,
} from "lucide-react";
import { t } from "../../i18n";
import { Button } from "../ui-shadcn/button";
import {
	Tabs,
	TabsContent,
	TabsList,
	TabsTrigger,
} from "../ui-shadcn/tabs";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogHeader,
	DialogTitle,
} from "../ui-shadcn/dialog";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "../ui-shadcn/alert-dialog";
import { cn } from "../../lib/utils";
import { buttonVariants } from "../ui-shadcn/button";
import { useVisionBridgeDraft } from "./settings/visionDraft.ts";
import { useGitModels } from "./settings/gitModels.ts";
import type { AppSettings, AppInfo, AvailableModel, PiInstallStatus, PiUpdateCheckResult, PiCliUpdateResult } from "../../../../shared/types";

// ── 各 tab 内容 lazy 加载：首开只下载壳 + 当前 tab 的 chunk（qrcode/表格/日志查看器等
//    重依赖随各自 tab 拆包），切换到某 tab 时才加载其 chunk（本地文件，秒级以内）。──
const CommonTab = lazy(() => import("./settings/CommonTab").then((m) => ({ default: m.CommonTab })));
const AppearanceTab = lazy(() => import("./settings/AppearanceTab").then((m) => ({ default: m.AppearanceTab })));
const ProxyTab = lazy(() => import("./settings/ProxyTab").then((m) => ({ default: m.ProxyTab })));
const DevTab = lazy(() => import("./settings/DevTab").then((m) => ({ default: m.DevTab })));
const StorageTab = lazy(() => import("./settings/SettingsStorageTab").then((m) => ({ default: m.StorageTab })));
const ProcessMetricsTab = lazy(() => import("./settings/ProcessMetricsTab").then((m) => ({ default: m.ProcessMetricsTab })));
const UsageStatsTab = lazy(() => import("./settings/UsageStatsTab").then((m) => ({ default: m.UsageStatsTab })));
const VisionBridgeSettingsTab = lazy(() => import("./settings/VisionBridgeSettingsTab").then((m) => ({ default: m.VisionBridgeSettingsTab })));

type SettingsTabId = "common" | "appearance" | "proxy" | "dev" | "storage" | "usage" | "process" | "vision";

// 注意：修改 SettingsTabId 枚举时需同步更新 SETTINGS_TAB_IDS 校验数组

/** localStorage 键：设置页上次打开的 tab（重开弹窗时恢复位置，跨应用重启保留）。 */
const SETTINGS_LAST_TAB_KEY = "pideck-settings-last-tab";

/** 全部合法 tab id，用于校验持久化值（避免版本更新后残留旧值导致无高亮）。 */
const SETTINGS_TAB_IDS: readonly SettingsTabId[] = [
	"common", "appearance", "proxy", "dev", "storage", "usage", "process", "vision",
];

/**
 * 读取上次打开的设置 tab；localStorage 不可用、无记录或值已失效时回退默认值 "common"。
 * Radix Dialog 关闭会卸载内容，state 在每次打开时重建，因此需要从外部存储恢复。
 */
function loadLastSettingsTab(): SettingsTabId {
	try {
		const raw = localStorage.getItem(SETTINGS_LAST_TAB_KEY);
		if (raw && (SETTINGS_TAB_IDS as readonly string[]).includes(raw)) return raw as SettingsTabId;
	} catch {
		/* localStorage 不可用（隐私模式等）时静默失败 */
	}
	return "common";
}

type SettingsModalProps = {
	settings: AppSettings;
	piStatus: PiInstallStatus | null;
	piChecking: boolean;
	piProxyChecking: boolean;
	piProxyNotice: string;
	piProxyNoticeTone: "info" | "success" | "error";
	webServiceChanging: boolean;
	onRestartWebService: () => void;
	appInfo: AppInfo;
	customPiPath: string;
	customPathValidating: boolean;
	customPathResult: PiInstallStatus | null;
	updateChecking: boolean;
	piUpdating: boolean;
	piUpdateChecking: boolean;
	piUpdateCheck: PiUpdateCheckResult | null;
	piUpdateResult: PiCliUpdateResult | null;
	onCustomPathChange: (path: string) => void;
	onValidateCustomPath: () => void;
	onClearCustomPath: () => void;
	onCheckPi: () => void;
	onTestPiProxy: () => void;
	onCheckUpdate: () => void;
	onCheckPiUpdate: () => void;
	onUpdatePi: () => void;
	onToggleDevTools: () => void;
	onRestartApp: () => void;
	onClearCheckFlag?: () => void;
	onOpenWebService: (port: string) => void;
	onClose: () => void;
	onChange: (patch: Partial<AppSettings>) => void;
};

/**
 * 设置弹框错误边界：渲染异常时保留可关闭的错误面板，避免整页白屏无法退出。
 */
// 小窗口保留外边距，避免设置页完全压住工作区；821px 以上恢复桌面弹框尺寸。
// DialogContent 默认带 sm:max-w-lg，必须显式覆盖它，否则小窗口会变成窄高条。
const settingsModalSizeClass = "w-[80vw] max-w-[80vw] h-[80vh] max-h-[80vh] sm:max-w-[min(1300px,80vw)]";

class SettingsModalErrorBoundary extends Component<
	{ onClose: () => void; children: ReactNode },
	{ error: Error | null }
> {
	override state = { error: null as Error | null };

	static getDerivedStateFromError(error: Error) {
		return { error };
	}

	override render() {
		if (!this.state.error) return this.props.children;
		// #115：错误兜底直接走 shadcn Dialog 外壳
		return (
			<Dialog open onOpenChange={(next) => !next && this.props.onClose()}>
			<DialogContent showCloseButton={false} className={cn("flex flex-col gap-0 overflow-hidden p-0", settingsModalSizeClass, "settings-modal")}>
				<DialogHeader className="flex-row items-center justify-between px-4 py-3">
					<DialogTitle>{t("settings.loadFailed")}</DialogTitle>
					<DialogClose asChild>
						<Button variant="ghost" size="icon" aria-label={t("common.close")} title={t("common.close")}>
							<X size={18} strokeWidth={2.2} aria-hidden="true" />
						</Button>
					</DialogClose>
				</DialogHeader>
				<div className="settings-layout">
					<div className="settings-content" style={{ padding: "var(--space-5)" }}>
						<div className="config-diagnostic-card">
							<div>
								<strong>{t("settings.renderCrashed")}</strong>
								<span>{this.state.error.message}</span>
								<small>{t("settings.renderCrashedHelp")}</small>
							</div>
							<pre>{this.state.error.stack ?? this.state.error.message}</pre>
						</div>
					</div>
				</div>
			</DialogContent>
			</Dialog>
		);
	}
}

/** tab chunk 加载占位：轻量居中提示，避免首次切到某 tab 时空白闪烁 */
function SettingsTabLoading() {
	return (
		<div className="settings-panel grid min-w-0 min-h-40 place-items-center text-caption text-text-tertiary">
			{t("common.loading")}
		</div>
	);
}

/**
 * 设置弹框。memo + SettingsFeatureRoot 内稳定 props：
 * App 根组件重渲染（如 agent 流式输出）不会连带重渲染整个设置页。
 */
export const SettingsModal = memo(function SettingsModal(props: SettingsModalProps) {
	return (
		<SettingsModalErrorBoundary onClose={props.onClose}>
			<SettingsModalContent {...props} />
		</SettingsModalErrorBoundary>
	);
});

/**
 * 设置弹框壳：只持有跨 tab 共享状态（草稿/脏标记/视觉桥/重置信号）与 Tabs 导航，
 * 各 tab 内容拆为独立 memo 组件（settings/*Tab.tsx），切换 tab 只挂载目标 tab。
 */
function SettingsModalContent(props: SettingsModalProps) {
	// 弹窗每次打开都会重新挂载（Radix Dialog 关闭即卸载内容），
	// 用 lazy initializer 在挂载时读一次 localStorage，恢复到上次所在 tab。
	const [activeTab, setActiveTab] = useState<SettingsTabId>(loadLastSettingsTab);
	// ── 全局设置草稿：进入弹框时快照 props.settings，所有修改在 draft 上操作，保存时统一提交 ──
	const [draftSettings, setDraftSettings] = useState<AppSettings>(() => ({ ...props.settings }));
	const [dirtyFields, setDirtyFields] = useState<Set<string>>(new Set());
	/** 打开弹框时的原始设置快照，用于取消时回退 */
	const baseSnapshotRef = useRef<AppSettings>({ ...props.settings });
	// ── 视觉桥草稿：独立于全局设置（写 pi-deck-vision.json，走独立 IPC），脏标记/保存/取消由弹框统一管理 ──
	const visionDraft = useVisionBridgeDraft();
	/** 各 tab 的局部编辑态（WSL 输入/Web 端口）在取消时通过递增信号重置 */
	const [devTabResetKey, setDevTabResetKey] = useState(0);

	/** 更新草稿并标记对应字段为已修改。调用方传入的 patch 中的每个 key 都会追加到 dirtyFields。 */
	const updateDraft = useCallback((patch: Partial<AppSettings>) => {
		setDraftSettings((prev) => ({ ...prev, ...patch }));
		setDirtyFields((prev) => {
			const next = new Set(prev);
			for (const key of Object.keys(patch)) {
				next.add(key);
			}
			return next;
		});
	}, []);

	/** 检查指定字段在草稿中是否已被修改（与初始快照比较） */
	const isDirty = useCallback((field: keyof AppSettings): boolean => {
		// keyof 含 number/symbol 成员，Set 按 string 存储，统一转字符串比较
		return dirtyFields.has(String(field));
	}, [dirtyFields]);

	/** 保存全部已修改内容：全局设置差异提交 + 视觉桥草稿（若有改动）；返回是否全部成功 */
	const saveAll = async (): Promise<boolean> => {
		let ok = true;
		if (dirtyFields.size > 0) {
			const patch: Partial<AppSettings> = {};
			for (const key of dirtyFields) {
				(patch as Record<string, unknown>)[key] = (draftSettings as Record<string, unknown>)[key];
			}
			props.onChange(patch);
			// 更新快照基准为当前草稿值，并清除修改标记
			baseSnapshotRef.current = { ...baseSnapshotRef.current, ...patch };
			setDirtyFields(new Set());
		}
		if (visionDraft.dirty) {
			// 视觉桥保存失败（如 API Key 缺失/接口不可达）时保留脏标记，头部按钮可重试
			ok = await visionDraft.save();
		}
		return ok;
	};

	/** 取消全部修改：将草稿回退到初始快照，丢弃所有未保存变更（含视觉桥草稿与各 tab 局部编辑态） */
	const cancelAll = () => {
		setDraftSettings({ ...baseSnapshotRef.current });
		setDirtyFields(new Set());
		visionDraft.reset();
		setPerAreaFontSize(
			baseSnapshotRef.current.uiFontSize !== null ||
				baseSnapshotRef.current.chatFontSize !== null ||
				baseSnapshotRef.current.inputFontSize !== null,
		);
		// tab 局部编辑态（WSL 输入、Web 端口）由各自 tab 监听信号重置
		setDevTabResetKey((k) => k + 1);
	};

	/** 关闭弹框：有未保存变更（全局设置或视觉桥草稿）时弹出确认对话框，无变更时直接关闭 */
	const handleClose = () => {
		if (dirtyFields.size > 0 || visionDraft.dirty) {
			setCloseConfirmOpen(true);
		} else {
			props.onClose();
		}
	};

	/** 关闭确认弹框时选择保存并关闭：视觉桥保存失败则留在弹框内（脏标记保留，可重试） */
	const handleSaveAndClose = async () => {
		setCloseConfirmOpen(false);
		const ok = await saveAll();
		if (ok) {
			props.onClose();
		}
	};

	/** 关闭确认弹框时选择放弃更改 */
	const handleDiscardAndClose = () => {
		setCloseConfirmOpen(false);
		props.onClose();
	};

	const [closeConfirmOpen, setCloseConfirmOpen] = useState(false);

	const [perAreaFontSize, setPerAreaFontSize] = useState(
		draftSettings.uiFontSize !== null ||
			draftSettings.chatFontSize !== null ||
			draftSettings.inputFontSize !== null,
	);

	// Git 摘要模型列表与会话 Command 选择器共用 pi --list-models 数据源。
	const { gitModels, gitModelPickerOpen, openPicker: openGitModelPicker, closePicker: closeGitModelPicker } = useGitModels();

	/** 选择提交信息模型：写入草稿并关闭选择器 */
	const handlePickGitModel = useCallback((model: AvailableModel) => {
		updateDraft({
			gitCommitMessageProvider: model.provider,
			gitCommitMessageModel: model.id,
		});
		closeGitModelPicker();
	}, [updateDraft, closeGitModelPicker]);

	/** 收藏/取消收藏提交信息模型 */
	const handleToggleGitModelFavorite = useCallback((provider: string, modelId: string) => {
		const key = `${provider}/${modelId}`;
		const favorites = draftSettings.favoriteModels ?? [];
		updateDraft({
			favoriteModels: favorites.includes(key)
				? favorites.filter((item) => item !== key)
				: [...favorites, key],
		});
	}, [draftSettings.favoriteModels, updateDraft]);

	const tabs: Array<{
		id: SettingsTabId;
		label: string;
		icon: ReactNode;
	}> = [
		{
			id: "common",
			label: t("settings.tabs.common"),
			icon: <Settings2 size={16} />,
		},
		{
			id: "appearance",
			label: t("settings.tabs.appearance"),
			icon: <Brush size={16} />,
		},
		{
			id: "proxy",
			label: t("settings.tabs.proxy"),
			icon: <Network size={16} />,
		},
		{
			id: "dev",
			label: t("settings.tabs.dev"),
			icon: <Wrench size={16} />,
		},
		{
			id: "storage",
			label: t("settings.tabs.storage"),
			icon: <Trash2 size={16} />,
		},
		{
			id: "usage",
			label: t("settings.tabs.usage"),
			icon: <ChartColumnBig size={16} />,
		},
		{
			id: "process",
			label: t("settings.tabs.process"),
			icon: <Activity size={16} />,
		},
		{
			id: "vision",
			label: t("settings.tabs.vision"),
			icon: <Eye size={16} />,
		},
	];

	const hasDirtyChanges = dirtyFields.size > 0;
	// 视觉桥草稿有未保存改动时，头部保存/取消按钮同样点亮（与全局设置脏标记合并判定）
	const hasAnyDirtyChanges = hasDirtyChanges || visionDraft.dirty;

	return (
		<Dialog open onOpenChange={(next) => !next && handleClose()}>
			<DialogContent showCloseButton={false} stagger className={cn("flex flex-col gap-0 overflow-hidden p-0", settingsModalSizeClass, "settings-modal", "[--wallpaper-dialog-alpha:var(--wallpaper-panel-alpha,30%)]")}>
				<DialogHeader className="flex-row items-center justify-between px-4 py-3">
					<DialogTitle>{t("settings.title")}</DialogTitle>
					<div className="flex items-center gap-2">
						{/* 保存按钮常驻：无未保存改动时禁用，避免用户改完直接关窗丢改动；视觉桥保存中禁用防重复提交 */}
						<Button variant="default" size="sm" onClick={saveAll} disabled={!hasAnyDirtyChanges || visionDraft.saving}>
							{t("common.save")}
						</Button>
						{hasAnyDirtyChanges ? (
							/* 放弃更改用 outline（白底描边）而非灰底 secondary：与黑色主按钮形成
							    清晰的主次层级（shadcn dialog 的 confirm/cancel 惯例），避免一对按钮
							    都是灰色填充分不出哪个是提交。 */
							<Button variant="outline" size="sm" onClick={cancelAll}>
								{t("common.cancel")}
							</Button>
						) : undefined}
						<DialogClose asChild>
							<Button variant="ghost" size="icon" aria-label={t("common.close")} title={t("common.close")}>
								<X size={18} strokeWidth={2.2} aria-hidden="true" />
							</Button>
						</DialogClose>
					</div>
				</DialogHeader>
			<Tabs orientation="vertical" value={activeTab} onValueChange={(v) => { const match = tabs.find((t) => t.id === v); if (!match) return; setActiveTab(match.id); try { localStorage.setItem(SETTINGS_LAST_TAB_KEY, match.id); } catch { /* localStorage 不可用时静默失败，仅本次会话内不记忆 */ } }} className="settings-layout flex min-h-0 flex-1 flex-row gap-0 bg-transparent">
					<TabsList className="settings-tabs flex min-h-0 shrink-0 flex-col items-stretch gap-2.5 overflow-auto border-0 border-r border-border rounded-none bg-transparent p-2.5 data-[orientation=vertical]:w-[196px]" aria-label={t("settings.title")}>
						{tabs.map((tab) => (
							<TabsTrigger key={tab.id} value={tab.id} className="config-nav-btn h-8 justify-start gap-1.5 px-2.5 text-control font-medium">
								<span className="settings-tab-icon">{tab.icon}</span>
								<strong>{tab.label}</strong>
							</TabsTrigger>
						))}
					</TabsList>
					{/* ── 常用设置 tab ── */}
					{activeTab === "common" && (
						<TabsContent value="common" className="settings-panel min-w-0">
							<Suspense fallback={<SettingsTabLoading />}>
							<CommonTab
								draft={draftSettings}
								updateDraft={updateDraft}
								isDirty={isDirty}
								gitModels={gitModels}
								gitModelPickerOpen={gitModelPickerOpen}
								onOpenGitModelPicker={openGitModelPicker}
								onCloseGitModelPicker={closeGitModelPicker}
								onPickGitModel={handlePickGitModel}
								onToggleGitModelFavorite={handleToggleGitModelFavorite}
							/>
							</Suspense>
						</TabsContent>
					)}

					{/* ── 外观设置 tab ── */}
					{activeTab === "appearance" && (
						<TabsContent value="appearance" className="settings-panel min-w-0">
							<Suspense fallback={<SettingsTabLoading />}>
							<AppearanceTab
								draft={draftSettings}
								updateDraft={updateDraft}
								isDirty={isDirty}
								perAreaFontSize={perAreaFontSize}
								setPerAreaFontSize={setPerAreaFontSize}
								platform={props.appInfo.platform}
							/>
							</Suspense>
						</TabsContent>
					)}

					{/* ── 代理设置 tab ── */}
					{activeTab === "proxy" && (
						<TabsContent value="proxy" className="settings-panel min-w-0">
							<Suspense fallback={<SettingsTabLoading />}>
							<ProxyTab
								draft={draftSettings}
								updateDraft={updateDraft}
								isDirty={isDirty}
								piProxyChecking={props.piProxyChecking}
								piProxyNotice={props.piProxyNotice}
								piProxyNoticeTone={props.piProxyNoticeTone}
								onTestPiProxy={props.onTestPiProxy}
							/>
							</Suspense>
						</TabsContent>
					)}

					{/* ── 开发设置 tab（含 Web 服务） ── */}
					{activeTab === "dev" && (
						<TabsContent value="dev" className="settings-panel min-w-0">
							<Suspense fallback={<SettingsTabLoading />}>
							<DevTab
								draft={draftSettings}
								updateDraft={updateDraft}
								isDirty={isDirty}
								appInfo={props.appInfo}
								piStatus={props.piStatus}
								piChecking={props.piChecking}
								customPiPath={props.customPiPath}
								customPathValidating={props.customPathValidating}
								customPathResult={props.customPathResult}
								onCustomPathChange={props.onCustomPathChange}
								onValidateCustomPath={props.onValidateCustomPath}
								onClearCustomPath={props.onClearCustomPath}
								onCheckPi={props.onCheckPi}
								onClearCheckFlag={props.onClearCheckFlag}
								piUpdateChecking={props.piUpdateChecking}
								onCheckPiUpdate={props.onCheckPiUpdate}
								piUpdating={props.piUpdating}
								onUpdatePi={props.onUpdatePi}
								piUpdateCheck={props.piUpdateCheck}
								piUpdateResult={props.piUpdateResult}
								updateChecking={props.updateChecking}
								onCheckUpdate={props.onCheckUpdate}
								webServiceChanging={props.webServiceChanging}
								onOpenWebService={props.onOpenWebService}
								onRestartWebService={props.onRestartWebService}
								onToggleDevTools={props.onToggleDevTools}
								onRestartApp={props.onRestartApp}
								resetKey={devTabResetKey}
							/>
							</Suspense>
						</TabsContent>
					)}

					{/* ── 进程监控 tab（由 Pi 管理界面迁入） ── */}
					{activeTab === "process" && (
						<TabsContent value="process" className="settings-panel min-w-0">
							<Suspense fallback={<SettingsTabLoading />}>
							<ProcessMetricsTab />
							</Suspense>
						</TabsContent>
					)}
					{/* ── 存储与日志 tab ── */}
					{activeTab === "storage" && (
						<TabsContent value="storage" className="settings-panel min-w-0">
							<Suspense fallback={<SettingsTabLoading />}>
							<StorageTab
								settings={draftSettings}
								onChange={updateDraft}
							/>
							</Suspense>
						</TabsContent>
					)}
					{/* ── 用量统计 tab ── */}
					{activeTab === "usage" && (
						<TabsContent value="usage" className="settings-panel min-w-0">
							<Suspense fallback={<SettingsTabLoading />}>
							<UsageStatsTab />
							</Suspense>
						</TabsContent>
					)}
					{/* ── 视觉桥 tab：草稿/脏标记/保存由弹框统一管理，本组件只呈现表单 */}
					{activeTab === "vision" && (
						<TabsContent value="vision" className="settings-panel min-w-0">
							<Suspense fallback={<SettingsTabLoading />}>
							<VisionBridgeSettingsTab
								draft={visionDraft.draft}
								saving={visionDraft.saving}
								configDir={visionDraft.configDir}
								notice={visionDraft.notice}
								onChange={visionDraft.updateDraft}
							/>
							</Suspense>
						</TabsContent>
					)}
				</Tabs>
			{/* 未保存变更确认对话框 */}
			{closeConfirmOpen && (
				<AlertDialog open onOpenChange={(open) => { if (!open) setCloseConfirmOpen(false); }}>
					<AlertDialogContent>
						<AlertDialogHeader>
							<AlertDialogTitle>{t("settings.unsavedTitle")}</AlertDialogTitle>
							<AlertDialogDescription>{t("settings.unsavedMessage")}</AlertDialogDescription>
						</AlertDialogHeader>
						<AlertDialogFooter>
							<AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
							<AlertDialogAction className={buttonVariants({ variant: "destructive" })} onClick={handleDiscardAndClose}>
								{t("settings.discardChanges")}
							</AlertDialogAction>
							<AlertDialogAction onClick={handleSaveAndClose}>
								{t("settings.saveAndClose")}
							</AlertDialogAction>
						</AlertDialogFooter>
					</AlertDialogContent>
				</AlertDialog>
			)}
			</DialogContent>
		</Dialog>
	);
}
