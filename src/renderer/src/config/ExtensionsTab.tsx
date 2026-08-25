import { Button } from "../components/ui-shadcn/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui-shadcn/table";
import { useEffect, useState } from "react";
import { CircleCheck, CircleOff, Copy, Download, RotateCcw, Trash2 } from "lucide-react";
import type { PiCliUpdateResult, PiExtensionListResult, PiExtensionSummary, PiPackageInfo } from "../../../shared/types";
import { t } from "../i18n";
import type { TranslationKey } from "../i18n/rendererCopy.zh-CN";
import { showNotice } from "../utils/notice";
import { writeClipboard } from "../utils/clipboard";

type ExtensionsApi = {
	list: () => Promise<PiExtensionListResult>;
	uninstall: (source: string, scope?: "user" | "project" | "unknown") => Promise<void>;
	install: (source: string) => Promise<string>;
	toggle: (source: string, enabled: boolean) => Promise<void>;
	removeBuiltIn: (source: string) => Promise<void>;
	restoreBuiltIn: (source: string) => Promise<void>;
	update: () => Promise<PiCliUpdateResult>;
	updateOne: (source: string) => Promise<PiCliUpdateResult>;
};

function getExtensionsApi(): ExtensionsApi {
	const api = (window as unknown as { piDesktop?: { extensions?: ExtensionsApi } })
		.piDesktop?.extensions;
	if (!api) throw new Error("PiDeck extensions API is not available");
	return api;
}

/** 把 IPC/主进程异常转成可读文本，避免内置扩展操作退回原生 alert。 */
function formatExtensionError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** PiDeck 内置扩展名 → source 文件名映射 */
const PIDEK_BUILTIN_SOURCE: Record<string, string> = {
	"pi-deck-todo": "pi-deck-todo.ts",
	"pi-deck-plan-mode": "pi-deck-plan-mode.ts",
	"PiDeck-Q-Ask-Question": "pideck-q-ask-question.ts",
	"pi-deck-nul-redirect-fix": "pi-deck-nul-redirect-fix.ts",
	"pi-deck-context-controller": "pideck-q-context-controller.ts",
	"PiDeck-Q-context-controller": "pideck-q-context-controller.ts",
};

/** 推荐扩展包：描述走 i18n（descriptionKey），不在组件里硬编码中英文案。 */
type RecommendedPackage = Omit<PiPackageInfo, "description"> & { descriptionKey: TranslationKey };
const RECOMMENDED_PACKAGES: RecommendedPackage[] = [
	{
		name: "pi-deck-todo",
		descriptionKey: "config.extRecommended.piDeckTodo",
		installCmd: "npm:@earendil-works/pi-deck-todo",
		tags: ["extension"],
		downloads: "",
		updated: "",
		npmUrl: "",
		repoUrl: "https://github.com/fhh2626/PiDeck-Q",
	},
	{
		name: "PiDeck-Q-context-controller",
		descriptionKey: "config.extRecommended.piDeckContextController",
		installCmd: "npm:@earendil-works/pi-deck-context-controller",
		tags: ["extension"],
		downloads: "",
		updated: "",
		npmUrl: "",
		repoUrl: "https://github.com/fhh2626/PiDeck-Q",
	},
	{
		name: "pi-deck-plan-mode",
		descriptionKey: "config.extRecommended.piDeckPlanMode",
		installCmd: "npm:@earendil-works/pi-deck-plan-mode",
		tags: ["extension"],
		downloads: "",
		updated: "",
		npmUrl: "",
		repoUrl: "https://github.com/fhh2626/PiDeck-Q",
	},
	{
		name: "PiDeck-Q-Ask-Question",
		descriptionKey: "config.extRecommended.piDeckAskQuestion",
		installCmd: "npm:@earendil-works/pi-deck-ask-question",
		tags: ["extension"],
		downloads: "",
		updated: "",
		npmUrl: "",
		repoUrl: "https://github.com/fhh2626/PiDeck-Q",
	},
	{
		name: "pi-deck-nul-redirect-fix",
		descriptionKey: "config.extRecommended.piDeckNulRedirectFix",
		installCmd: "npm:@earendil-works/pi-deck-nul-redirect-fix",
		tags: ["extension"],
		downloads: "",
		updated: "",
		npmUrl: "",
		repoUrl: "https://github.com/fhh2626/PiDeck-Q",
	},
	{
		name: "context-mode",
		descriptionKey: "config.extRecommended.contextMode",
		installCmd: "npm:context-mode",
		tags: ["extension"],
		downloads: "107K/mo",
		updated: "",
		npmUrl: "https://www.npmjs.com/package/context-mode",
		repoUrl: "https://github.com/mksglu/context-mode",
	},
	{
		name: "pi-web-access",
		descriptionKey: "config.extRecommended.piWebAccess",
		installCmd: "npm:pi-web-access",
		tags: ["extension"],
		downloads: "99K/mo",
		updated: "",
		npmUrl: "https://www.npmjs.com/package/pi-web-access",
		repoUrl: "https://github.com/nicobailon/pi-web-access",
	},
	{
		name: "pi-mcp-adapter",
		descriptionKey: "config.extRecommended.piMcpAdapter",
		installCmd: "npm:pi-mcp-adapter",
		tags: ["extension"],
		downloads: "99K/mo",
		updated: "",
		npmUrl: "https://www.npmjs.com/package/pi-mcp-adapter",
		repoUrl: "https://github.com/nicobailon/pi-mcp-adapter",
	},
	{
		name: "pi-subagents",
		descriptionKey: "config.extRecommended.piSubagents",
		installCmd: "npm:pi-subagents",
		tags: ["extension"],
		downloads: "92K/mo",
		updated: "",
		npmUrl: "https://www.npmjs.com/package/pi-subagents",
		repoUrl: "https://github.com/nicobailon/pi-subagents",
	},
];

/** 内置扩展的用户可见产品名；source basename 供 -e 注入。 */
const BUILT_IN_DISPLAY_NAME: Record<string, string> = {
	"pideck-q-ask-question.ts": "PiDeck-Q-Ask-Question",
	"pideck-q-ask-question": "PiDeck-Q-Ask-Question",
	"pideck-q-context-controller.ts": "PiDeck-Q-context-controller",
	"pideck-q-context-controller": "PiDeck-Q-context-controller",
	"pideck-q-websearch.ts": "PiDeck-Q-WebSearch",
	"pideck-q-websearch": "PiDeck-Q-WebSearch",
	"pideck-q-better-compaction.ts": "PiDeck-Q-Better-Compaction",
	"pideck-q-better-compaction": "PiDeck-Q-Better-Compaction",
};

/** 从扩展来源提取简短描述名 */
function shortName(source: string): string {
	const trimmed = source.trim();
	if (BUILT_IN_DISPLAY_NAME[trimmed]) return BUILT_IN_DISPLAY_NAME[trimmed];
	const stripped = trimmed
		.replace(/^(?:npm|file|github|git|https?):/i, "")
		.replace(/\.ts$/, "")
		.replace(/@[^/]+\//, "");
	return BUILT_IN_DISPLAY_NAME[stripped] ?? stripped;
}

export function ExtensionsTab(props: {
	data: PiExtensionListResult;
	loading: boolean;
	uninstallingSource: string | null;
	/** 数据变更后的轻量重载：不查询 npm 最新版本。 */
	onReload: () => void;
	/** 用户显式刷新：重新扫描并查询 npm 最新版本。 */
	onRefresh: () => void;
	onUninstall: (extension: PiExtensionSummary) => void;
}) {
	const [installingSources, setInstallingSources] = useState<Set<string>>(() => new Set());
	const [restoringBuiltIn, setRestoringBuiltIn] = useState<string | null>(null);
	const [removingBuiltIn, setRemovingBuiltIn] = useState<string | null>(null);
	const [togglingSource, setTogglingSource] = useState<string | null>(null);

	// 首次加载或列表刷新时展示扩展冲突通知
	useEffect(() => {
		if (!props.data.conflicts || props.data.conflicts.length === 0) return;
		for (const c of props.data.conflicts) {
			showNotice(
				t("config.extensionConflict", {
					builtIn: shortName(c.builtIn),
					thirdParty: shortName(c.thirdParty),
				}),
				8000,
				"warning",
			);
		}
	}, [props.data.conflicts]);

	const handleRemoveBuiltIn = async (extension: PiExtensionSummary) => {
		if (removingBuiltIn) return;
		setRemovingBuiltIn(extension.source);
		try {
			await getExtensionsApi().removeBuiltIn(extension.source);
			props.onReload();
		} catch (e) {
			showNotice(
				t("config.extensionOperationFailed", { error: formatExtensionError(e) }),
				4500,
				"error",
			);
		} finally {
			setRemovingBuiltIn(null);
		}
	};

	const handleRestoreBuiltIn = async (extension: PiExtensionSummary) => {
		if (restoringBuiltIn) return;
		setRestoringBuiltIn(extension.source);
		try {
			await getExtensionsApi().restoreBuiltIn(extension.source);
			props.onReload();
		} catch (e) {
			showNotice(
				t("config.extensionOperationFailed", { error: formatExtensionError(e) }),
				4500,
				"error",
			);
		} finally {
			setRestoringBuiltIn(null);
		}
	};

	/** 普通扩展通过 Pi 原生 disabledExtensions 启停，文件和安装记录保持不变。 */
	const handleToggle = async (extension: PiExtensionSummary, enabled: boolean) => {
		if (togglingSource) return;
		setTogglingSource(extension.source);
		try {
			await getExtensionsApi().toggle(extension.source, enabled);
			props.onReload();
			showNotice(t(enabled ? "config.extensionEnabledToast" : "config.extensionDisabledToast", {
				name: shortName(extension.source),
			}), 3000);
		} catch (e) {
			showNotice(
				t("config.extensionOperationFailed", { error: formatExtensionError(e) }),
				4500,
				"error",
			);
		} finally {
			setTogglingSource(null);
		}
	};
	const [updating, setUpdating] = useState<string | null>(null);
	const [updateResult, setUpdateResult] = useState<PiCliUpdateResult | null>(null);
	const [showUpdateDialog, setShowUpdateDialog] = useState(false);
	// 单扩展更新进行中的 source（与批量更新互斥，同一时间只跑一个 pi update）
	const [updatingOne, setUpdatingOne] = useState<string | null>(null);

	const handleInstall = async (pkg: Pick<PiPackageInfo, "name" | "installCmd">) => {
		setInstallingSources((current) => new Set(current).add(pkg.installCmd));
		try {
			// 对已移除的内置扩展，走恢复流程而非 npm 安装
						const builtInSource = PIDEK_BUILTIN_SOURCE[pkg.name];
			if (builtInSource) {
				await getExtensionsApi().restoreBuiltIn(builtInSource);
			} else {
				await getExtensionsApi().install(pkg.installCmd);
			}
			props.onReload();
		} catch (e) {
			showNotice(
				t("config.extensionOperationFailed", { error: formatExtensionError(e) }),
				4500,
				"error",
			);
		} finally {
			setInstallingSources((current) => {
				const next = new Set(current);
				next.delete(pkg.installCmd);
				return next;
			});
		}
	};

	const handleUpdateExtensions = async () => {
		setUpdating("all");
		setUpdateResult(null);
		setShowUpdateDialog(true);
		try {
			const result = await getExtensionsApi().update();
			setUpdateResult(result);
		} catch (e) {
			showNotice(
				t("config.extensionOperationFailed", { error: formatExtensionError(e) }),
				4500,
				"error",
			);
		} finally {
			setUpdating(null);
		}
	};

	/** 更新单个扩展（`pi update <source>`），完成后强制刷新列表拿新版本。 */
	const handleUpdateOne = async (extension: PiExtensionSummary) => {
		if (updatingOne) return;
		setUpdatingOne(extension.source);
		try {
			await getExtensionsApi().updateOne(extension.source);
			props.onReload();
			showNotice(t("config.extensionUpdatedToast", { name: shortName(extension.source) }), 3000);
		} catch (e) {
			showNotice(
				t("config.extensionOperationFailed", { error: formatExtensionError(e) }),
				4500,
				"error",
			);
		} finally {
			setUpdatingOne(null);
		}
	};

	/** 复制单扩展更新指令到剪贴板，用户可在终端手动执行。 */
	const handleCopyUpdateCommand = (extension: PiExtensionSummary) => {
		const command = `pi update ${extension.source}`;
		void writeClipboard(command);
		showNotice(t("config.extensionUpdateCommandCopied", { command }), 2500);
	};

	return (
		<div className="extensions-tab">
			{showUpdateDialog && (
				<div className="config-update-dialog-backdrop" role="dialog" aria-modal="true">
					<div className="config-update-dialog">
						<div className="config-update-dialog-header">
							<strong>{t("settings.updateExtensionsAll")}</strong>
							<Button variant="ghost" size="icon-sm" className="size-7"
								onClick={() => {
									setShowUpdateDialog(false);
									props.onReload();
								}}
								disabled={Boolean(updating)}
							>
								×
							</Button>
						</div>
						<p className="config-im-form-hint">
							{updating ? t("settings.extensionsUpdatingDesc") : t("settings.extensionsUpdateResultHint")}
						</p>
						<pre className="setting-update-output">
							{updateResult ? `${updateResult.command}\n${updateResult.output}` : t("settings.extensionsUpdating")}
						</pre>
						<div className="config-update-dialog-actions">
							<Button variant="default"
								size="sm"
								onClick={() => {
									setShowUpdateDialog(false);
									props.onReload();
								}}
								disabled={Boolean(updating)}
							>
								{t("common.close")}
							</Button>
						</div>
					</div>
				</div>
			)}
			{false && (
			<div className="config-section mb-5">
				<div className="mb-3 flex items-center justify-between">
					{/* 与设置弹窗分区标题同级：text-sm，避免 title 字号偏大 */}
					<h3 className="extensions-installed-title text-sm font-semibold tracking-tight text-foreground">
						{t("config.recommendedPackages")}
					</h3>
				</div>
				<p className="config-im-form-hint mb-3 text-caption text-muted-foreground">
					{t("config.recommendedPackagesHint")}
				</p>
				<div className="extensions-recommended-list">
					{RECOMMENDED_PACKAGES.map((pkg) => {
						// 内置扩展按 source 文件名匹配，npm 扩展按 installCmd 匹配
			const builtInSource = PIDEK_BUILTIN_SOURCE[pkg.name];
						const builtInExt = builtInSource
							? props.data.extensions.find((ext) => ext.builtIn && ext.source === builtInSource)
							: undefined;
						// 已部署（非移除状态）视为已安装；已移除的内置扩展允许恢复安装
						const alreadyInstalled = builtInExt
							? builtInExt.enabled !== false
							: props.data.extensions.some((ext) => ext.source === pkg.installCmd);
						const installing = installingSources.has(pkg.installCmd);
						return (
						<div
							key={pkg.name}
							className="extensions-recommended-row"
							onClick={() => {
								// pi.dev 的详情路由使用 npm 包名,但查询参数可能是扩展内部展示名。
								const packageName = pkg.piPackageName ?? pkg.name;
								// 外部文档/服务页面通过 desktopApi.app.openExternal 交由系统默认浏览器打开。
								window.piDesktop.app.openExternal(
									`https://pi.dev/packages/${pkg.name}?name=${packageName}`,
									true
								);
							}}
							title={`${t("config.openPackageDetail")}: ${pkg.name}`}
						>
							<div className="extensions-recommended-info">
								<div className="extensions-recommended-name">
									<strong>{pkg.name}</strong>
									{alreadyInstalled && <span className="config-im-connected-badge" style={{ marginLeft: 8 }}>{t("config.installed")}</span>}
								</div>
								<div className="extensions-recommended-desc">
									{t(pkg.descriptionKey)}
								</div>
							</div>
							<div className="extensions-recommended-action" onClick={(e) => e.stopPropagation()}>
								{/* 安装中保持与图标按钮同尺寸，避免 config-btn 文本把操作区撑开错位 */}
								<Button variant="ghost" size="icon-sm" className="size-7"
									title={installing ? t("config.installing") : alreadyInstalled ? t("config.installed") : t("config.install")}
									onClick={() => handleInstall(pkg)}
									disabled={alreadyInstalled || installing}
									aria-busy={installing}
								>
									{installing ? (
										<span className="skillhub-installing-dot" aria-hidden="true" />
									) : (
										<Download size={15} strokeWidth={1.8} aria-hidden="true" />
									)}
								</Button>
								<Button variant="ghost" size="icon-sm" className="size-7"
									title={t("common.copy")}
									onClick={(e) => {
										e.stopPropagation();
										const cmd = `pi install ${pkg.installCmd}`;
										writeClipboard(cmd);
										showNotice(t("app.codeCopied"), 1200);
									}}
								>
									<Copy size={14} strokeWidth={1.8} />
								</Button>
							</div>
						</div>
					);
					})}
				</div>
			</div>
			)}

			{/* 已安装扩展列表 */}
			<div className="config-section">
				<h3 className="extensions-installed-title mb-2 text-sm font-semibold tracking-tight text-foreground">
					{t("config.installedExtensions")}
				</h3>
				<div className="mb-3 mt-2 flex items-center justify-between gap-3">
					<div className="min-w-0">
						<span className="font-mono text-xs tabular-nums text-muted-foreground">
							{t("config.count.extensions", { count: props.data.extensions.length })}
						</span>
						<small className="skills-restart-hint block text-caption text-muted-foreground">
							{t("config.extensionRestartHint")}
						</small>
					</div>
					<div className="skills-toolbar-actions flex shrink-0 items-center gap-1.5">
						{/* 工具栏统一 size=sm，与设置页/会话顶栏控件高度对齐 */}
						<Button variant="outline" size="sm" onClick={handleUpdateExtensions} disabled={props.loading || Boolean(updating)}>
							{updating ? t("settings.updating") : t("settings.updateExtensionsAll")}
						</Button>
						<Button variant="outline" size="sm" onClick={props.onRefresh} disabled={props.loading}>
							{t("common.refresh")}
						</Button>
					</div>
				</div>
				<div className="overflow-hidden rounded-lg border border-border-subtle bg-bg-panel">
					{props.loading ? (
						<div className="py-12 text-center text-control text-muted-foreground">{t("config.loadingExtensions")}</div>
					) : props.data.extensions.length === 0 ? (
						<div className="py-12 text-center text-control text-muted-foreground">{t("config.emptyExtensions")}</div>
					) : (
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>{t("config.extension")}</TableHead>
									<TableHead>{t("config.extensionVersion")}</TableHead>
									<TableHead>{t("config.extensionPath")}</TableHead>
									<TableHead className="w-20 text-right">{t("config.actions")}</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{props.data.extensions.map((extension) => (
									<ExtensionTableRow
										key={extension.id}
										extension={extension}
										uninstalling={props.uninstallingSource === extension.source}
										onUninstall={props.onUninstall}
										onRemoveBuiltIn={handleRemoveBuiltIn}
										onRestoreBuiltIn={handleRestoreBuiltIn}
										removingBuiltIn={removingBuiltIn === extension.source}
										restoringBuiltIn={restoringBuiltIn === extension.source}
										toggling={togglingSource === extension.source}
										onToggle={handleToggle}
										updatingOne={updatingOne === extension.source}
										onUpdateOne={handleUpdateOne}
										onCopyUpdateCommand={handleCopyUpdateCommand}
									/>
								))}
							</TableBody>
						</Table>
					)}
				</div>
			</div>
		</div>
	);
}

function ExtensionTableRow(props: {
	extension: PiExtensionSummary;
	uninstalling: boolean;
	onUninstall: (extension: PiExtensionSummary) => void;
	onRemoveBuiltIn: (extension: PiExtensionSummary) => void;
	onRestoreBuiltIn: (extension: PiExtensionSummary) => void;
	removingBuiltIn?: boolean;
	restoringBuiltIn?: boolean;
	toggling: boolean;
	onToggle: (extension: PiExtensionSummary, enabled: boolean) => void;
	updatingOne: boolean;
	onUpdateOne: (extension: PiExtensionSummary) => void;
	onCopyUpdateCommand: (extension: PiExtensionSummary) => void;
}) {
	const { extension } = props;
	const name = shortName(extension.source);
	return (
		<TableRow aria-busy={props.uninstalling}>
			<TableCell className="min-w-0">
				<div className="flex min-w-0 flex-col gap-0.5">
					<div className="flex min-w-0 items-center gap-2">
						<strong className="truncate text-control font-medium text-foreground">{name}</strong>
						{extension.builtIn && <span className="text-micro text-muted-foreground">{t("common.builtIn")}</span>}
						{/* 过滤式安装徽标：source 已在主进程剥离 "(filtered)" 后缀，
						    版本查询/更新/卸载均用干净 source；此处仅展示标记 */}
						{extension.filtered && <span className="text-micro text-muted-foreground">{t("config.extensionFiltered")}</span>}
					</div>
					<span className="truncate font-mono text-caption text-muted-foreground">{extension.source}</span>
				</div>
			</TableCell>
			<TableCell className="whitespace-nowrap text-caption text-muted-foreground">
				{extension.builtIn ? "-" : t("config.extensionVersions", {
					current: extension.currentVersion ?? "-",
					latest: extension.latestVersion ?? "-",
				})}
				{extension.hasUpdate && <span className="ml-1 text-text-primary">{t("config.extensionUpdateAvailable")}</span>}
				{/* 有更新时提供单扩展更新与复制更新指令（npm 包专属；内置扩展无版本概念） */}
				{extension.hasUpdate && !extension.builtIn && (
					<div className="mt-1.5 flex items-center gap-1.5">
						<Button
							size="xs"
							variant="outline"
							onClick={() => props.onUpdateOne(extension)}
							disabled={props.updatingOne}
							aria-busy={props.updatingOne}
						>
							{props.updatingOne ? t("config.extensionUpdatingOne") : t("config.extensionUpdateOne")}
						</Button>
						<Button size="xs" variant="ghost" onClick={() => props.onCopyUpdateCommand(extension)}>
							<Copy size={13} strokeWidth={1.8} className="mr-1" aria-hidden="true" />
							{t("config.extensionCopyUpdateCommand")}
						</Button>
					</div>
				)}
				{extension.updateError && <div className="text-destructive">{extension.updateError}</div>}
			</TableCell>
			<TableCell className="max-w-64 truncate font-mono text-caption text-muted-foreground" title={extension.path ?? undefined}>
				{extension.path || "-"}
			</TableCell>
			<TableCell className="text-right">
				<div className="flex justify-end gap-1">
					{!extension.builtIn && (
						<Button
							variant="ghost"
							size="icon-sm"
							className="size-7"
							disabled={props.toggling}
							onClick={() => props.onToggle(extension, extension.enabled === false)}
							title={extension.enabled === false ? t("config.enableExtension") : t("config.disableExtension")}
							aria-label={extension.enabled === false ? t("config.enableExtension") : t("config.disableExtension")}
						>
							{extension.enabled === false ? (
								<CircleCheck size={14} strokeWidth={1.8} aria-hidden="true" />
							) : (
								<CircleOff size={14} strokeWidth={1.8} aria-hidden="true" />
							)}
						</Button>
					)}
					{extension.builtIn && extension.enabled !== false && (
						<Button variant="ghost" size="icon-sm" className="size-7" disabled={props.removingBuiltIn} onClick={() => props.onRemoveBuiltIn(extension)} title={props.removingBuiltIn ? t("config.uninstalling") : t("config.uninstall")}>
							<Trash2 size={14} strokeWidth={1.8} />
						</Button>
					)}
					{extension.builtIn && extension.enabled === false && (
						<Button variant="ghost" size="icon-sm" className="size-7" disabled={props.restoringBuiltIn} onClick={() => props.onRestoreBuiltIn(extension)} title={t("config.restoreBuiltIn")}>
							<RotateCcw size={14} strokeWidth={1.8} />
						</Button>
					)}
					{!extension.builtIn && (
						<Button variant="ghost" size="icon-sm" className="size-7 text-destructive hover:bg-destructive/10 hover:text-destructive" disabled={props.uninstalling} onClick={() => props.onUninstall(extension)} title={props.uninstalling ? t("config.uninstalling") : t("config.uninstall")}>
							<Trash2 size={14} strokeWidth={1.8} />
						</Button>
					)}
				</div>
			</TableCell>
		</TableRow>
	);
}
