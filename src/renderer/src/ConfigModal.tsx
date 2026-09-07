import { Button, buttonVariants } from "./components/ui-shadcn/button";
import {
	Tabs,
	TabsContent,
	TabsList,
	TabsTrigger,
} from "./components/ui-shadcn/tabs";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogHeader,
	DialogTitle,
} from "./components/ui-shadcn/dialog";
import { ConfirmDialog } from "./components/ui-shadcn/ConfirmDialog";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "./components/ui-shadcn/alert-dialog";
import {
	X,
	Cpu,
	FileCode2,
	FileText,
	KeyRound,
	Puzzle,
	Settings2,
	Shield,
	ShieldCheck,
	Sparkles,
} from "lucide-react";
import { cn } from "./lib/utils";
import { showNotice } from "./utils/notice";
import { desktopApi } from "./desktopApi";
import { collectModelSpecPatches } from "./utils/modelSpecAutoFill";
import { Component, useRef, useState, useEffect, useCallback, type ReactNode } from "react";
import { AuthTab } from "./config/AuthTab";
import { ModelsTab } from "./config/ModelsTab";
import { openDocsInSystemBrowser } from "./config/ConfigShared";
import { RawTab } from "./config/RawTab";
import { TrustTab } from "./config/TrustTab";
import { SettingsTab } from "./config/SettingsTab";
import { PromptsTab } from "./config/PromptsTab";
import { SkillsTab } from "./config/SkillsTab";
import { ExtensionsTab } from "./config/ExtensionsTab";
import { SecuritySection, type SecuritySectionHandle } from "./components/config/SecuritySection";
import { t } from "./i18n";
import { CodeMirrorEditor } from "./components/app/CodeMirrorEditor";
import { translateBuiltinPromptDescription } from "./composerBehavior";
import type {
	AuthFile,
	ConfigTab,
	ModelItem,
	ModelsFile,
	SettingsFile,
} from "./config/configTypes";
import type { ConfigFileDiagnostic, CreatePiPromptTemplateInput, PiExtensionListResult, PiExtensionSummary, PiPromptTemplateListResult, PiPromptTemplateSummary, PiSkillListResult, PiSkillLocation, PiSkillSummary } from "../../shared/types";
import { getProviderHeaders, KNOWN_PROVIDER_ENDPOINTS } from "./config/providerHeaders";
import { ALL_CONFIG_DIRTY_KEYS, dirtyKeysClearedByReload } from "./config/configDirtyMarks";

// Native 在 React 挂载前异步完成 transport bootstrap；用 getter 避免模块加载时捕获 preview API。
const api = {
	get app() {
		return desktopApi.app;
	},
	get config() {
		return desktopApi.config;
	},
	get extensions() {
		return desktopApi.extensions;
	},
	get projects() {
		return desktopApi.projects;
	},
	get prompts() {
		return desktopApi.prompts;
	},
	get skills() {
		return desktopApi.skills;
	},
};
const DEFAULT_MODEL_CONFIG: Pick<
	ModelItem,
	"contextWindow" | "maxTokens" | "reasoning" | "input"
> = {
	contextWindow: 1000000,
	maxTokens: 128000,
	reasoning: true,
	input: ["text", "image"],
};

// ── 配置弹窗左侧导航 = shadcn Vertical Tabs ──
// config 组 5 个子页（模型/认证/设置/信任/原始文件）用 "config:<tab>" 复合值，
// 其余组直接以 section 名作 value；Tabs 受控 value 由此编码，业务仍走 section/tab 双 state，
// loadConfig 等既有依赖零改动。
type ConfigSection =
	| "config"
	| "security"
	| "skills"
	| "prompts"
	| "extensions";

// 注意：修改 ConfigSection/ConfigTab 枚举时需同步更新 CONFIG_SECTIONS/CONFIG_TABS 校验数组

/** section+tab → Tabs value（config 组子页编码为 "config:<tab>"）。 */
function sectionTabValue(section: ConfigSection, tab: ConfigTab): string {
	return section === "config" ? `config:${tab}` : section;
}

/** localStorage 键：Pi 管理页上次打开的 tab（重开弹窗时恢复位置，跨应用重启保留）。 */
const CONFIG_LAST_TAB_KEY = "pideck-config-last-tab";

/** 全部合法 section / config 组子 tab，用于校验持久化值（避免版本更新后残留旧值导致无高亮）。 */
const CONFIG_SECTIONS: readonly ConfigSection[] = ["config", "security", "skills", "prompts", "extensions"];
const CONFIG_TABS: readonly ConfigTab[] = ["models", "auth", "settings", "trust", "raw"];

/**
 * 读取上次打开的 tab；localStorage 不可用、无记录或值已失效时返回 null（由调用方回退默认值）。
 * Radix Dialog 关闭会卸载内容，state 在每次打开时重建，因此需要从外部存储恢复。
 */
function loadLastConfigTab(): { section: ConfigSection; tab?: ConfigTab } | null {
	try {
		const raw = localStorage.getItem(CONFIG_LAST_TAB_KEY);
		if (!raw) return null;
		const parsed = parseSectionTabValue(raw);
		if (!CONFIG_SECTIONS.includes(parsed.section)) return null;
		if (parsed.section === "config" && (!parsed.tab || !CONFIG_TABS.includes(parsed.tab))) return null;
		return parsed;
	} catch {
		return null;
	}
}

/** Tabs value → section/tab；非 config 组无子 tab。 */
function parseSectionTabValue(value: string): {
	section: ConfigSection;
	tab?: ConfigTab;
} {
	const idx = value.indexOf(":");
	if (idx > 0) {
		return {
			section: value.slice(0, idx) as ConfigSection,
			tab: value.slice(idx + 1) as ConfigTab,
		};
	}
	return { section: value as ConfigSection };
}

/**
 * 配置页必须能打开用户手写/旧版本生成的非标准 models.json。
 * pi 自身对配置较宽松，但 UI 会访问 provider.models.length / map；这里先把缺失或异常字段归一化，
 * 避免单个 provider 配置错误导致整个 renderer 白屏。
 */
function normalizeModelsFile(value: unknown): ModelsFile {
	const rawProviders =
		value && typeof value === "object" && !Array.isArray(value)
			? (value as { providers?: unknown }).providers
			: undefined;
	const providers: ModelsFile["providers"] = {};
	if (!rawProviders || typeof rawProviders !== "object" || Array.isArray(rawProviders)) {
		return { providers };
	}
	for (const [name, rawProvider] of Object.entries(rawProviders)) {
		const provider =
			rawProvider && typeof rawProvider === "object" && !Array.isArray(rawProvider)
				? (rawProvider as Record<string, unknown>)
				: {};
		const rawModels = provider.models;
		providers[name] = {
			...provider,
			models: Array.isArray(rawModels)
				? rawModels
					.filter((model): model is ModelItem | string =>
						Boolean(model) &&
						(typeof model === "object" && !Array.isArray(model) || typeof model === "string"),
					)
					.map((model) =>
						typeof model === "string" ? { id: model } : model,
					)
				: [],
		};
	}
	return { providers };
}

function ConfigDiagnosticCard(props: {
	diagnostic: ConfigFileDiagnostic;
	onOpenDocs: () => void;
	onOpenRaw: () => void;
}) {
	const { diagnostic } = props;
	return (
		<div className="config-diagnostic-card">
			<div>
				<strong>{t("config.diagnosticLoadFailed", { fileName: diagnostic.fileName })}</strong>
				<span>
					{diagnostic.line && diagnostic.column
						? t("config.diagnosticLocation", {
								line: diagnostic.line,
								column: diagnostic.column,
								message: diagnostic.message,
							})
						: diagnostic.message}
				</span>
				<small>
					{t("config.diagnosticHelp")}{" "}
					<a href={diagnostic.docsUrl} onClick={openDocsInSystemBrowser(diagnostic.docsUrl)}>
						{t("config.openOfficialDocs")}
					</a>
				</small>
			</div>
			{diagnostic.snippet && <pre>{diagnostic.snippet}</pre>}
			<div className="config-diagnostic-actions">
				<Button size="sm"  variant="default" onClick={props.onOpenRaw}>{t("config.openRawFile")}</Button>
				<Button size="sm"  variant="outline" onClick={props.onOpenDocs}>{t("config.openOfficialDocs")}</Button>
			</div>
		</div>
	);
}

type ConfigModalProps = {
	open: boolean;
	onClose: () => void;
	onSaved: () => void;
};

// 小窗口保留外边距，避免 Pi 管理页完全压住工作区；821px 以上恢复桌面弹框尺寸。
// DialogContent 默认带 sm:max-w-lg，必须显式覆盖它，否则小窗口会变成窄高条。
const configModalSizeClass = "w-[80vw] max-w-[80vw] h-[80vh] max-h-[80vh] sm:max-w-[min(1300px,80vw)]";

class ConfigModalErrorBoundary extends Component<
	{ open: boolean; onClose: () => void; children: ReactNode },
	{ error: Error | null }
> {
	override state = { error: null as Error | null };

	static getDerivedStateFromError(error: Error) {
		return { error };
	}

	override componentDidUpdate(prevProps: { open: boolean }) {
		if (prevProps.open !== this.props.open && this.state.error) {
			this.setState({ error: null });
		}
	}

	override render() {
		if (!this.state.error) return this.props.children;
		if (!this.props.open) return null;
		// #115：错误兜底直接走 shadcn Dialog（components/ui/Modal 薄包装已退役）
		return (
			<Dialog open={this.props.open} onOpenChange={(next) => !next && this.props.onClose()}>
			<DialogContent showCloseButton={false} className={cn("flex flex-col gap-0 overflow-hidden p-0", configModalSizeClass, "config-modal", "[--wallpaper-dialog-alpha:var(--wallpaper-panel-alpha,30%)]")}>
				<DialogHeader className="flex-row items-center justify-between px-4 py-3">
					<DialogTitle>{t("config.loadFailed")}</DialogTitle>
					<DialogClose asChild>
						<Button variant="ghost" size="icon" aria-label={t("common.close")} title={t("common.close")}>
							<X size={18} strokeWidth={2.2} aria-hidden="true" />
						</Button>
					</DialogClose>
				</DialogHeader>
				<div className="config-content">
						<div className="config-diagnostic-card">
							<div>
								<strong>{t("config.renderCrashed")}</strong>
								<span>{this.state.error.message}</span>
								<small>
									{t("config.renderCrashedHelpPrefix")}
									<a
										href="https://pi.dev/docs/latest/models"
										onClick={openDocsInSystemBrowser("https://pi.dev/docs/latest/models")}
									>{t("config.docsModels")}</a>
									{" / "}
									<a
										href="https://pi.dev/docs/latest/settings"
										onClick={openDocsInSystemBrowser("https://pi.dev/docs/latest/settings")}
									>{t("config.docsSettings")}</a>
									{t("config.renderCrashedHelpSuffix")}
								</small>
							</div>
							<pre>{this.state.error.stack ?? this.state.error.message}</pre>
						</div>
					</div>
			</DialogContent>
			</Dialog>
		);
	}
}

/** 配置管理弹窗：支持 models/auth/settings 三个 tab 的可视化编辑和源文件编辑 */
export function ConfigModal(props: ConfigModalProps) {
	return (
		<ConfigModalErrorBoundary open={props.open} onClose={props.onClose}>
			<ConfigModalContent {...props} />
		</ConfigModalErrorBoundary>
	);
}

function ConfigModalContent(props: ConfigModalProps) {
	const { open, onClose, onSaved } = props;
	// 弹窗每次打开都会重新挂载（Radix Dialog 关闭即卸载内容），
	// 用 lazy initializer 在挂载时读一次 localStorage，恢复到上次所在 tab。
	const [lastTab] = useState(loadLastConfigTab);
	const [section, setSection] = useState<ConfigSection>(lastTab?.section ?? "config");
	const [tab, setTab] = useState<ConfigTab>(lastTab?.tab ?? "models");
	const [loading, setLoading] = useState(false);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	/** 各 tab 未保存修改集合：key 用 sectionTabValue 编码（如 "config:models"/"skills"），顶部保存按钮与关闭确认依赖它 */
	const [dirtyTabs, setDirtyTabs] = useState<Set<string>>(new Set());
	/** 关闭弹框时存在未保存修改 → 弹出保存确认（借鉴设置页关闭逻辑） */
	const [closeConfirmOpen, setCloseConfirmOpen] = useState(false);
	const hasDirty = dirtyTabs.size > 0;

	/** 标记某 tab 存在未保存修改（幂等；只用 setDirtyTabs 函数式更新，引用稳定） */
	const markDirty = useCallback((tabKey: string) => {
		setDirtyTabs((prev) => (prev.has(tabKey) ? prev : new Set(prev).add(tabKey)));
	}, []);

	/** 清除某 tab 的未保存修改标记（保存成功或主动放弃编辑时调用） */
	const clearDirty = useCallback((tabKey: string) => {
		setDirtyTabs((prev) =>
			prev.has(tabKey)
				? new Set([...prev].filter((k) => k !== tabKey))
				: prev,
		);
	}, []);
	const [configDiagnostic, setConfigDiagnostic] = useState<ConfigFileDiagnostic | null>(null);
	/* toast 已改用 sonner 实现 */

	// 各 tab 的数据
	const [modelsData, setModelsData] = useState<ModelsFile>({ providers: {} });
	const [authData, setAuthData] = useState<AuthFile>({});
	const [settingsData, setSettingsData] = useState<SettingsFile>({});
	/** 自动发现的模型：auth-only 供应商通过已知端点获取的模型列表 */
	const [discoveredModels, setDiscoveredModels] = useState<
		Record<string, Array<{ id: string; name?: string }>>
	>({});
	const [trustData, setTrustData] = useState<Record<string, boolean>>({});
	const [skillsData, setSkillsData] = useState<PiSkillListResult>({
		locations: [],
		skills: [],
	});
	const [extensionsData, setExtensionsData] = useState<PiExtensionListResult>({
		extensions: [],
		raw: "",
	});
	const [extensionsLoading, setExtensionsLoading] = useState(false);
	const [creatingSkill, setCreatingSkill] = useState(false);
	const [uninstallingExtensionSource, setUninstallingExtensionSource] = useState<string | null>(null);
	const [newSkillName, setNewSkillName] = useState("");
	const [newSkillDescription, setNewSkillDescription] = useState("");
	const [newSkillLocationId, setNewSkillLocationId] = useState<PiSkillLocation["id"]>("pi-global");
	const [deleteSkillConfirm, setDeleteSkillConfirm] = useState<PiSkillSummary | null>(null);
	const [editingGlobalSkill, setEditingGlobalSkill] = useState<PiSkillSummary | null>(null);
	const [editGlobalContent, setEditGlobalContent] = useState("");
	const [editGlobalLoading, setEditGlobalLoading] = useState(false);
	const [editGlobalSaving, setEditGlobalSaving] = useState(false);
	const [editGlobalSaved, setEditGlobalSaved] = useState(false);
	const [promptsData, setPromptsData] = useState<PiPromptTemplateListResult>({
		templates: [],
		globalDir: "",
		hasHiddenBuiltins: false,
	});
	const [creatingPrompt, setCreatingPrompt] = useState(false);
	const [newPromptName, setNewPromptName] = useState("");
	const [newPromptDescription, setNewPromptDescription] = useState("");
	const [editingPrompt, setEditingPrompt] = useState<PiPromptTemplateSummary | null>(null);
	const [editPromptContent, setEditPromptContent] = useState("");
	const [editPromptLoading, setEditPromptLoading] = useState(false);
	const [editPromptSaving, setEditPromptSaving] = useState(false);
	/** 待确认删除的 Prompt 模板（删除前弹确认框） */
	const [deletePromptConfirm, setDeletePromptConfirm] = useState<PiPromptTemplateSummary | null>(null);
	/** 是否确认找回全部默认内置模板 */
	const [restoreBuiltinPromptsConfirm, setRestoreBuiltinPromptsConfirm] = useState(false);
	const [restoringBuiltinPrompts, setRestoringBuiltinPrompts] = useState(false);
	const [uninstallExtensionConfirm, setUninstallExtensionConfirm] = useState<PiExtensionSummary | null>(null);
	const [rawContent, setRawContent] = useState("");
	const [rawFileName, setRawFileName] = useState("models.json");

	// 展开的 provider / auth 项
	const [expandedProvider, setExpandedProvider] = useState<string | null>(null);
	const [expandedAuth, setExpandedAuth] = useState<string | null>(null);
	// 新增 provider
	const [addingProvider, setAddingProvider] = useState(false);
	const [newProviderName, setNewProviderName] = useState("");
	// 重命名 provider
	const [renamingProvider, setRenamingProvider] = useState<string | null>(null);
	const [renameValue, setRenameValue] = useState("");
	// 新增 auth
	const [addingAuth, setAddingAuth] = useState(false);
	const [newAuthName, setNewAuthName] = useState("");
	// 远程拉取模型列表
	const [fetchingProvider, setFetchingProvider] = useState<string | null>(null);
	const [fetchedModels, setFetchedModels] = useState<
		Record<string, Array<{ id: string; name?: string }>>
	>({});

	/**
	 * 根据 API 类型返回对应的获取模型提示。
	 * 不同服务对 /models 端点的支持不同，提供针对性的指导。
	 */
	function getFetchModelsHintByApi(api: string | undefined, baseUrl: string): string {
		switch (api) {
			case "openai-completions":
				return t("config.fetchModelsHintOpenaiCompletions", { baseUrl });
			case "openai-responses":
				return t("config.fetchModelsHintOpenai", { baseUrl });
			case "openai-codex-responses":
				return t("config.fetchModelsHintOpenaiCodex");
			case "anthropic-messages":
				return t("config.fetchModelsHintAnthropic");
			case "google-generative-ai":
				return t("config.fetchModelsHintGoogle");
			case "mistral-conversations":
				return t("config.fetchModelsHintMistral");
			default:
				// 未知 API 类型时使用通用提示
				return t("config.fetchModelsHint");
		}
	}

	// 每个 provider 独立的模型拉取错误状态，避免全局 setError 相互覆盖
	const [fetchModelsErrorByProvider, setFetchModelsErrorByProvider] = useState<
		Record<string, string | undefined>
	>({});
	// 快速测试连接
	const [testingProvider, setTestingProvider] = useState<string | null>(null);
	const [testResult, setTestResult] = useState<{
		providerName: string;
		success: boolean;
		model?: string;
		snippet?: string;
		tokens?: { input?: number; output?: number };
		latencyMs?: number;
		error?: string;
		requestUrl?: string;
		requestBody?: string;
	} | null>(null);
	const [testModelIdByProvider, setTestModelIdByProvider] = useState<
		Record<string, string>
	>({});
	// 删除确认对话框
	const [deleteConfirm, setDeleteConfirm] = useState<{
		type: "provider" | "model" | "auth" | "batch";
		title: string;
		message: string;
		onConfirm: () => void;
	} | null>(null);

	const loadConfig = useCallback(
		async (target: ConfigTab) => {
			setLoading(true);
			setError(null);
			setConfigDiagnostic(null);
			try {
				if (target === "models") {
					const res = await api.config.getModels();
					setModelsData(normalizeModelsFile(res.parsed));
					setRawContent(res.raw);
					setRawFileName("models.json");
					setConfigDiagnostic(res.diagnostic ?? null);
				} else if (target === "auth") {
					const res = await api.config.getAuth();
					setAuthData(res.parsed as AuthFile);
					setRawContent(res.raw);
					setRawFileName("auth.json");
					setConfigDiagnostic(res.diagnostic ?? null);
				} else if (target === "settings") {
					// 同时加载 settings、auth 和 models 数据，确保 defaultProvider / defaultModel 下拉能聚合所有可用信息
					const [settingsRes, authRes, modelsRes] = await Promise.all([
						api.config.getSettings(),
						api.config.getAuth(),
						api.config.getModels(),
					]);
					setSettingsData(settingsRes.parsed as SettingsFile);
					setAuthData(authRes.parsed as AuthFile);
					setModelsData(normalizeModelsFile(modelsRes.parsed));
					setRawContent(settingsRes.raw);
					setRawFileName("settings.json");
					setConfigDiagnostic(settingsRes.diagnostic ?? null);

					// 对于 auth 中有但 models 中没有模型的供应商，自动尝试获取模型列表
					const authProviders = authRes.parsed as AuthFile;
					const modelsProviders = normalizeModelsFile(modelsRes.parsed).providers;
					const discovered: Record<string, Array<{ id: string; name?: string }>> = {};
					const fetchPromises: Array<Promise<void>> = [];

					for (const [providerName, authEntry] of Object.entries(authProviders)) {
						// 跳过已有模型的供应商
						if (modelsProviders[providerName]?.models?.length) continue;
						const apiKey =
							typeof authEntry.key === "string" ? authEntry.key : "";
						if (!apiKey) continue;

						// 情况1：从 KNOWN_PROVIDER_ENDPOINTS 获知该供应商的 API 端点
						const knownEndpoint = KNOWN_PROVIDER_ENDPOINTS[providerName];
						// 情况2：从 models.json 中该供应商的配置获知 baseUrl
						const modelsProvider = modelsProviders[providerName];
						const modelsBaseUrl =
							modelsProvider && typeof modelsProvider.baseUrl === "string"
								? modelsProvider.baseUrl
								: undefined;
						const baseUrl = knownEndpoint?.baseUrl ?? modelsBaseUrl;
						if (!baseUrl) continue;

						const apiType =
							knownEndpoint?.apiType ??
							(typeof modelsProvider?.api === "string"
								? modelsProvider.api
								: undefined);

						fetchPromises.push(
							api.config
								.fetchModels(baseUrl, apiKey, apiType)
								.then((result) => {
									if (result.success && result.models) {
										discovered[providerName] = result.models;
									}
								})
								.catch(() => {
									// 静默失败，不阻塞 UI
								}),
						);
					}

					if (fetchPromises.length > 0) {
						// 不 await，在后台获取后更新状态即可
						void Promise.allSettled(fetchPromises).then(() => {
							if (Object.keys(discovered).length > 0) {
								setDiscoveredModels(discovered);
							}
						});
					}
				} else if (target === "trust") {
					const res = await api.config.getTrust();
					setTrustData(res.parsed as Record<string, boolean>);
					setRawContent(res.raw);
					setRawFileName("trust.json");
					setConfigDiagnostic(res.diagnostic ?? null);
				} else if (target === "raw") {
					// 源文件 tab 复用当前 tab 对应的文件
					const fileName =
						tab === "models"
							? "models.json"
							: tab === "auth"
								? "auth.json"
								: tab === "trust"
									? "trust.json"
									: "settings.json";
					setRawFileName(fileName);
					const res =
						fileName === "models.json"
							? await api.config.getModels()
							: fileName === "auth.json"
								? await api.config.getAuth()
								: fileName === "trust.json"
									? await api.config.getTrust()
									: await api.config.getSettings();
					setRawContent(res.raw);
					setConfigDiagnostic(res.diagnostic ?? null);
				}
				// 加载完成后本地数据与磁盘一致，清除被本次加载覆盖的数据对应的脏标记（含 settings 聚合页顺带重载的 models/auth，以及所有分支都会重写的 rawContent）。
				// 不清理会残留“假脏”标记：保存后黄点不消失、关闭时误弹未保存确认。
				for (const key of dirtyKeysClearedByReload(target)) clearDirty(key);
			} catch (e) {
				setError(e instanceof Error ? e.message : String(e));
			} finally {
				setLoading(false);
			}
		},
		[tab, clearDirty],
	);

	useEffect(() => {
		if (!open) return;
		if (section === "skills") {
			void refreshSkills();
			return;
		}
		if (section === "prompts") {
			void refreshPrompts();
			return;
		}
		if (section === "extensions") {
			// 首次进入只做轻量扫描（或读取主进程缓存），避免为每个 npm 扩展联网查版本。
			// 最新版本只在用户显式点击刷新时查询。
			void refreshExtensions(false);
			return;
		}
		void loadConfig(tab);
	}, [open, section, tab, loadConfig]);

	const showToast = (msg: string) => {
		showNotice(msg, 2500);
	};

	/** 去掉 Electron IPC 包装前缀，只保留真正业务错误，方便 toast 阅读。 */
	const formatIpcError = (error: unknown): string => {
		const raw = error instanceof Error ? error.message : String(error);
		const matched = raw.match(
			/Error invoking remote method '[^']+':\s*(?:Error:\s*)?([\s\S]+)$/i,
		);
		return (matched?.[1] ?? raw).trim();
	};

	/** 统一保存流程：写盘 → 校验 → toast；成功时清除对应 tab 的未保存标记，返回是否成功。 */
	const saveAndReload = async (
		saveFn: () => Promise<{ valid: boolean; error?: string }>,
		successMessage?: string,
		dirtyKey?: string,
	): Promise<boolean> => {
		setSaving(true);
		setError(null);
		try {
			const result = await saveFn();
			if (!result.valid) {
				setError(result.error ?? t("config.saveFailed"));
				return false;
			}
			onSaved();
			showToast(successMessage ?? t("config.saved"));
			if (dirtyKey) clearDirty(dirtyKey);
			return true;
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
			return false;
		} finally {
			setSaving(false);
		}
	};

	// ── Models 操作 ──────────────────────────────────────

	const handleAddProvider = () => {
		const providerName = newProviderName.trim();
		if (!providerName) return;
		const updated = {
			...modelsData,
			providers: {
				...modelsData.providers,
				// 默认不写入 headers，保持和手写 models.json 一致；需要兼容特定代理时再由用户显式选择 User-Agent。
				[providerName]: { models: [] },
			},
		};
		setModelsData(updated);
		markDirty("config:models");
		setExpandedProvider(providerName);
		setAddingProvider(false);
		setNewProviderName("");
	};

	// 重命名 provider：保留所有配置和模型，仅修改 key 名称
	const handleStartRename = (name: string) => {
		setRenamingProvider(name);
		setRenameValue(name);
	};

	const handleConfirmRename = (oldName: string) => {
		const newName = renameValue.trim();
		if (!newName || newName === oldName || modelsData.providers[newName]) {
			// 名称未变、为空或已存在则不操作
			setRenamingProvider(null);
			setRenameValue("");
			return;
		}
		const providers = { ...modelsData.providers };
		providers[newName] = providers[oldName];
		delete providers[oldName];
		setModelsData({ ...modelsData, providers });
		markDirty("config:models");
		if (expandedProvider === oldName) setExpandedProvider(newName);
		setRenamingProvider(null);
		setRenameValue("");
	};

	const handleCancelRename = () => {
		setRenamingProvider(null);
		setRenameValue("");
	};

	const handleDeleteProvider = (name: string) => {
		setDeleteConfirm({
			type: "provider",
			title: t("common.deleteConfirm"),
			message: t("common.deleteConfirmMsg", { name }),
			onConfirm: () => {
				const providers = { ...modelsData.providers };
				delete providers[name];
				setModelsData({ ...modelsData, providers });
				markDirty("config:models");
				if (expandedProvider === name) setExpandedProvider(null);
				setDeleteConfirm(null);
			},
		});
	};

	const handleDuplicateProvider = (name: string) => {
		const sourceProvider = modelsData.providers[name];
		if (!sourceProvider) return;
		
		// 生成新名称：原名称 + " copy" 或 " copy 2" 依此类推
		let newName = `${name} copy`;
		let counter = 2;
		while (modelsData.providers[newName]) {
			newName = `${name} copy ${counter}`;
			counter++;
		}
		
		// 深拷贝 provider 配置，包括 models 数组
		const duplicatedProvider = JSON.parse(JSON.stringify(sourceProvider));
		
		setModelsData({
			...modelsData,
			providers: {
				...modelsData.providers,
				[newName]: duplicatedProvider,
			},
		});
		markDirty("config:models");
		
		// 展开新复制的 provider
		setExpandedProvider(newName);
	};

	/**
	 * 检测成功且实际走通 /v1（或 /v1beta）时，把表单里的 baseUrl 自动改成带版本路径。
	 * 原因：检测侧会兼容补路径，但 pi 会话会原样读 models.json；不改写则「测试正常、会话 404」。
	 * 仅改内存表单，需用户点保存后才写入磁盘。
	 * 后端仅在确实需要改写时返回 suggestedBaseUrl，前端直接应用即可。
	 */
	const applySuggestedBaseUrl = useCallback(
		(providerName: string, suggestedBaseUrl?: string) => {
			if (!suggestedBaseUrl) return false;
			const next = suggestedBaseUrl.replace(/\/+$/, "");
			if (!next) return false;
			// 函数式更新，避免 async 返回时闭包拿到旧 modelsData。
			setModelsData((prev) => {
				const provider = prev.providers[providerName];
				if (!provider) return prev;
				const current = (provider.baseUrl ?? "").replace(/\/+$/, "");
				if (current === next) return prev;
				return {
					...prev,
					providers: {
						...prev.providers,
						[providerName]: { ...provider, baseUrl: next },
					},
				};
			});
			// 检测/测试自动改写 baseUrl 同样属于表单修改，标记未保存
			markDirty("config:models");
			return true;
		},
		[markDirty],
	);

	// 从 provider 的 baseUrl + apiKey 拉取可用模型列表
	const handleFetchModels = async (providerName: string) => {
		const provider = modelsData.providers[providerName];
		if (!provider?.baseUrl || !provider?.apiKey) {
			setFetchModelsErrorByProvider((prev) => ({
				...prev,
				[providerName]: t("config.missingBaseUrlApiKey"),
			}));
			return;
		}
		setFetchingProvider(providerName);
		setFetchModelsErrorByProvider((prev) => ({
			...prev,
			[providerName]: undefined,
		}));
		try {
			const result = await api.config.fetchModels(
				provider.baseUrl,
				provider.apiKey,
				provider.api as string | undefined,
			);
			if (result.success && result.models) {
				setFetchedModels((prev) => ({
					...prev,
					[providerName]: result.models!,
				}));
				setFetchModelsErrorByProvider((prev) => ({
					...prev,
					[providerName]: undefined,
				}));
				const normalized = applySuggestedBaseUrl(
					providerName,
					result.suggestedBaseUrl,
				);
				if (normalized && result.suggestedBaseUrl) {
					showToast(
						t("config.baseUrlAutoNormalized", {
							url: result.suggestedBaseUrl,
						}),
					);
				} else {
					showToast(t("config.fetchedModels", { count: result.models.length }));
				}
			} else {
				// 根据 API 类型提供不同的错误提示
				const apiTypeHint = getFetchModelsHintByApi(provider.api as string | undefined, provider.baseUrl);
				setFetchModelsErrorByProvider((prev) => ({
					...prev,
					[providerName]: (result.error ?? t("config.fetchModelsFailed")) + "\n" + apiTypeHint,
				}));
			}
		} catch (e) {
			setFetchModelsErrorByProvider((prev) => ({
				...prev,
				[providerName]: e instanceof Error ? e.message : String(e),
			}));
		} finally {
			setFetchingProvider(null);
		}
	};

	// 快速测试 provider 连接
	const handleTestProvider = async (providerName: string) => {
		const provider = modelsData.providers[providerName];
		if (!provider?.baseUrl || !provider?.apiKey) {
			setError(t("config.missingBaseUrlApiKey"));
			return;
		}
		// 确定测试用的模型：优先用户指定的 testModelId，否则取第一个模型 id
		const modelId =
			(testModelIdByProvider[providerName] ?? "").trim() ||
			provider.models[0]?.id ||
			"";
		if (!modelId) {
			setError(t("config.missingTestModel"));
			return;
		}
		setTestingProvider(providerName);
		setTestResult(null);
		setError(null);
		try {
			const result = await api.config.testProvider(
				provider.baseUrl,
				provider.apiKey,
				modelId,
				provider.api as string | undefined,
				getProviderHeaders(provider.headers),
			);
			setTestResult({ providerName, ...result });
			// 测试成功且走通版本路径时，自动把根路径 baseUrl 改成 /v1 等，避免会话侧失败。
			if (result.success && result.suggestedBaseUrl) {
				const normalized = applySuggestedBaseUrl(
					providerName,
					result.suggestedBaseUrl,
				);
				if (normalized) {
					showToast(
						t("config.baseUrlAutoNormalized", {
							url: result.suggestedBaseUrl,
						}),
					);
				}
			}
		} catch (e) {
			setTestResult({
				providerName,
				success: false,
				error: e instanceof Error ? e.message : String(e),
			});
		} finally {
			setTestingProvider(null);
		}
	};

	const handleAddModel = (providerName: string) => {
		const provider = modelsData.providers[providerName];
		if (!provider) return;
		const newModel: ModelItem = {
			id: "",
			name: "",
			...DEFAULT_MODEL_CONFIG,
		};
		const updated = {
			...modelsData,
			providers: {
				...modelsData.providers,
				[providerName]: { ...provider, models: [...provider.models, newModel] },
			},
		};
		setModelsData(updated);
		markDirty("config:models");
	};

	const handleUpdateModel = (
		providerName: string,
		index: number,
		field: string,
		value: unknown,
	) => {
		const provider = modelsData.providers[providerName];
		if (!provider) return;
		const models = [...provider.models];
		models[index] = { ...models[index], [field]: value };
		setModelsData({
			...modelsData,
			providers: {
				...modelsData.providers,
				[providerName]: { ...provider, models },
			},
		});
		markDirty("config:models");
	};

	const handleUpdateModelThinkingLevel = (
		providerName: string,
		index: number,
		key: "xhigh" | "max",
		value: "" | "xhigh" | "max",
	) => {
		const provider = modelsData.providers[providerName];
		const currentModel = provider?.models[index];
		if (!provider || !currentModel) return;
		const models = [...provider.models];
		const nextThinkingLevelMap = {
			...(currentModel.thinkingLevelMap ?? {}),
		};
		if (value) nextThinkingLevelMap[key] = value;
		else delete nextThinkingLevelMap[key];
		const nextModel = {
			...currentModel,
			// xhigh/max 只有 reasoning 模型才有意义；打开映射时同步开启。
			reasoning: value ? true : currentModel.reasoning,
		};
		if (Object.keys(nextThinkingLevelMap).length > 0) {
			nextModel.thinkingLevelMap = nextThinkingLevelMap;
		} else {
			delete nextModel.thinkingLevelMap;
		}
		models[index] = nextModel;

		const nextProvider = value
			? {
				...provider,
				compat: {
					supportsDeveloperRole: false,
					...(provider.compat ?? {}),
					supportsReasoningEffort: true,
				},
			}
			: { ...provider };
		setModelsData({
			...modelsData,
			providers: {
				...modelsData.providers,
				[providerName]: { ...nextProvider, models },
			},
		});
		markDirty("config:models");
	};

	const handleDeleteModel = (providerName: string, index: number) => {
		const provider = modelsData.providers[providerName];
		if (!provider) return;
		const model = provider.models[index];
		if (!model) return;
		setDeleteConfirm({
			type: "model",
			title: t("common.deleteConfirm"),
			message: t("common.deleteConfirmMsg", { name: `${providerName}/${model.id}` }),
			onConfirm: () => {
				const models = provider.models.filter((_, i) => i !== index);
				setModelsData({
					...modelsData,
					providers: {
						...modelsData.providers,
						[providerName]: { ...provider, models },
					},
				});
				markDirty("config:models");
				setDeleteConfirm(null);
			},
		});
	};

	const handleSaveModels = async (): Promise<boolean> => {
		// 保存前按内置规格表批量补全空字段（用户无需逐个失焦）：
		// 查询只读、补全只填空字段；结果写回 state 与落盘数据，保证保存的就是补全后的值
		// （onSave 闭包读的是旧 modelsData，不能在 setState 之后再取）。
		const { providers: filledProviders, filledCount } = await collectModelSpecPatches(
			modelsData,
			(providerName, modelId) => api.projects.getModelSpec(providerName, modelId),
		);
		const base = filledCount > 0 ? { ...modelsData, providers: filledProviders } : modelsData;
		// 保存前规范化所有供应商的 compat 字段，确保布尔值显式写入而不依赖后端默认值
		const normalizedData = {
			...base,
			providers: Object.fromEntries(
				Object.entries(base.providers).map(([name, provider]) => [
					name,
					{
						...provider,
						compat: {
							supportsDeveloperRole: false,
							supportsReasoningEffort: false,
							...(provider.compat as Record<string, unknown> | undefined),
						},
					},
				]),
			),
		};
		const ok = await saveAndReload(
			() => api.config.saveModels(normalizedData),
			filledCount > 0
				? t("config.modelsSavedWithSpecs", { count: filledCount })
				: t("config.modelsSaved"),
			"config:models",
		);
		// 保存成功后才把补全值写回 UI：失败时保留原值，下次保存会重新补全（幂等）
		if (ok && filledCount > 0) {
			setModelsData(base);
		}
		await loadConfig("models");
		return ok;
	};

	// ── Auth 操作 ────────────────────────────────────────

	const handleUpdateAuth = (provider: string, field: string, value: string) => {
		setAuthData({
			...authData,
			[provider]: { ...authData[provider], [field]: value },
		});
		markDirty("config:auth");
	};

	/**
	 * 添加认证条目。
	 * name 和 key 从 AuthTab 供应商选择弹窗直接传入，
	 * 避免 React 闭包中状态尚未刷新的问题，且支持弹窗内直接填写 API Key。
	 */
	const handleAddAuth = (name?: string, key?: string) => {
		const finalName = name ?? newAuthName.trim();
		if (!finalName) return;
		setAuthData({
			...authData,
			[finalName]: { type: "api_key", key: key ?? "" },
		});
		markDirty("config:auth");
		setExpandedAuth(finalName);
		setAddingAuth(false);
		setNewAuthName("");
	};

	const handleDeleteAuth = (provider: string) => {
		setDeleteConfirm({
			type: "auth",
			title: t("common.deleteConfirm"),
			message: t("common.deleteConfirmMsg", { name: provider }),
			onConfirm: () => {
				const updated = { ...authData };
				delete updated[provider];
				setAuthData(updated);
				markDirty("config:auth");
				if (expandedAuth === provider) setExpandedAuth(null);
				setDeleteConfirm(null);
			},
		});
	};

	const handleDuplicateAuth = (provider: string) => {
		const sourceAuth = authData[provider];
		if (!sourceAuth) return;
		const duplicatedAuth = JSON.parse(JSON.stringify(sourceAuth));
		let newName = `${provider} copy`;
		let counter = 2;
		while (authData[newName]) {
			newName = `${provider} copy ${counter}`;
			counter++;
		}
		setAuthData({
			...authData,
			[newName]: duplicatedAuth,
		});
		markDirty("config:auth");
		setExpandedAuth(newName);
	};

	const handleDeleteProviders = (names: string[]) => {
		setDeleteConfirm({
			type: "batch",
			title: t("common.deleteConfirm"),
			message: t("common.deleteBatchConfirm", { count: names.length }),
			onConfirm: () => {
				const providers = { ...modelsData.providers };
				for (const name of names) delete providers[name];
				setModelsData({ ...modelsData, providers });
				markDirty("config:models");
				if (names.includes(expandedProvider ?? "")) setExpandedProvider(null);
				setDeleteConfirm(null);
			},
		});
	};

	const handleDeleteAuths = (providers: string[]) => {
		setDeleteConfirm({
			type: "batch",
			title: t("common.deleteConfirm"),
			message: t("common.deleteBatchConfirm", { count: providers.length }),
			onConfirm: () => {
				const updated = { ...authData };
				for (const provider of providers) delete updated[provider];
				setAuthData(updated);
				markDirty("config:auth");
				if (providers.includes(expandedAuth ?? "")) setExpandedAuth(null);
				setDeleteConfirm(null);
			},
		});
	};

	const handleSaveAuth = async (): Promise<boolean> => {
		const ok = await saveAndReload(
			() => api.config.saveAuth(authData),
			undefined,
			"config:auth",
		);
		await loadConfig("auth");
		return ok;
	};

	// ── Settings 操作 ────────────────────────────────────

	const handleSaveSettings = async (): Promise<boolean> => {
		const ok = await saveAndReload(
			() => api.config.saveSettings(settingsData),
			undefined,
			"config:settings",
		);
		await loadConfig("settings");
		return ok;
	};

	// ── Trust 操作 ────────────────────────────────────────

	const handleSaveTrust = async (): Promise<boolean> => {
		const ok = await saveAndReload(
			() => api.config.saveRaw("trust.json", JSON.stringify(trustData, null, 2)),
			undefined,
			"config:trust",
		);
		await loadConfig("trust");
		return ok;
	};

	// ── Raw 操作 ─────────────────────────────────────────

	const handleSaveRaw = async (): Promise<boolean> => {
		const isModelsFile = rawFileName === "models.json";
		const ok = await saveAndReload(
			() => api.config.saveRaw(rawFileName, rawContent),
			isModelsFile ? t("config.modelsSaved") : undefined,
			"config:raw",
		);
		if (isModelsFile) {
			await loadConfig("models");
		} else if (rawFileName === "auth.json") await loadConfig("auth");
		else if (rawFileName === "trust.json") await loadConfig("trust");
		else await loadConfig("settings");
		return ok;
	};

	// 切换源文件时重新加载对应文件内容
	const handleRawFileChange = async (fileName: string) => {
		setRawFileName(fileName);
		setLoading(true);
		try {
			const res =
				fileName === "models.json"
					? await api.config.getModels()
					: fileName === "auth.json"
						? await api.config.getAuth()
						: fileName === "trust.json"
							? await api.config.getTrust()
							: await api.config.getSettings();
			setRawContent(res.raw);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setLoading(false);
		}
	};

	// ── 导出 / 导入 ─────────────────────────────────────

	/** 将三个配置文件打包为 JSON 并触发浏览器下载。 */
	const handleExport = async () => {
		try {
			const json = await api.config.export();
			const blob = new Blob([json], { type: "application/json" });
			const url = URL.createObjectURL(blob);
			const a = document.createElement("a");
			a.href = url;
			// 文件名含时间戳，便于用户区分多次备份
			a.download = `pideck-config-${new Date().toISOString().slice(0, 10)}.json`;
			a.click();
			URL.revokeObjectURL(url);
			showToast(t("config.exported"));
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	};

	/** 刷新 prompt templates 列表 */
	const refreshPrompts = async () => {
		const res = await api.prompts.list();
		// 主进程已按删除标记过滤内置项；这里只翻译内置模板的 description
		res.templates = res.templates.map((tpl) => ({
			...tpl,
			description: translateBuiltinPromptDescription(tpl),
		}));
		setPromptsData(res);
	};

	/** 创建新 prompt template */
	const handleCreatePrompt = async () => {
		setCreatingPrompt(true);
		setError(null);
		try {
			await api.prompts.create({
				name: newPromptName,
				description: newPromptDescription,
			});
			setNewPromptName("");
			setNewPromptDescription("");
			await refreshPrompts();
			showToast(t("config.promptCreatedToast"));
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setCreatingPrompt(false);
		}
	};

	/** 确认删除 prompt template */
	const confirmDeletePrompt = async (target: PiPromptTemplateSummary) => {
		setError(null);
		try {
			await api.prompts.delete(target.path);
			await refreshPrompts();
			showToast(t("config.promptDeletedToast"));
			setDeletePromptConfirm(null);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	};

	/** 清空内置模板删除标记，使默认模板重新出现。 */
	const confirmRestoreBuiltinPrompts = async () => {
		setError(null);
		setRestoringBuiltinPrompts(true);
		try {
			await api.prompts.restoreBuiltins();
			await refreshPrompts();
			showToast(t("config.promptRestoredToast"));
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setRestoringBuiltinPrompts(false);
			setRestoreBuiltinPromptsConfirm(false);
		}
	};

	/** 打开 prompt template 编辑器 */
	const handleEditPrompt = async (template: PiPromptTemplateSummary) => {
		// 内置模板直接使用预加载的 content，无需从文件读取
		if (!template.userCreated) {
			setEditingPrompt(template);
			setEditPromptContent(template.content);
			setEditPromptLoading(false);
			setError(null);
			return;
		}
		setEditingPrompt(template);
		setEditPromptContent("");
		setEditPromptLoading(true);
		setError(null);
		try {
			const content = await api.prompts.edit(template.path);
			setEditPromptContent(content as string);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			setEditingPrompt(null);
		} finally {
			setEditPromptLoading(false);
		}
	};

	/** 取消编辑 prompt template（放弃未保存修改，清除标记） */
	const handleCancelEditPrompt = () => {
		setEditingPrompt(null);
		setEditPromptContent("");
		clearDirty("prompts");
	};

	/** 保存 prompt template 编辑器内容；返回是否成功（关闭确认框等待其结果再决定是否关闭） */
	const handleSaveEditPrompt = async (): Promise<boolean> => {
		if (!editingPrompt || editPromptSaving) return false;
		setEditPromptSaving(true);
		setError(null);
		try {
			if (!editingPrompt.userCreated) {
				// 内置模板：先创建用户副本，再写入编辑内容
				const created = await api.prompts.create({
					name: editingPrompt.name,
					description: editingPrompt.description,
				});
				await api.prompts.edit(created.path, editPromptContent);
			} else {
				await api.prompts.edit(editingPrompt.path, editPromptContent);
			}
			clearDirty("prompts");
			showToast(t("config.promptSavedToast"));
			setEditingPrompt(null);
			await refreshPrompts();
			return true;
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			return false;
		} finally {
			setEditPromptSaving(false);
		}
	};

	/** Ctrl+S 快速保存：保存但不关闭弹框、不弹提示 */
	const handleRenamePrompt = async (template: { name: string; path: string }, newName: string) => {
		setError(null);
		try {
			await api.prompts.rename(template.name, newName);
			await refreshPrompts();
			showToast(t("config.promptRenamedToast"));
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	};

	const handleQuickSavePrompt = async (): Promise<boolean> => {
		if (!editingPrompt || editPromptSaving) return false;
		setEditPromptSaving(true);
		setError(null);
		try {
			if (!editingPrompt.userCreated) {
				const created = await api.prompts.create({
					name: editingPrompt.name,
					description: editingPrompt.description,
				});
				await api.prompts.edit(created.path, editPromptContent);
			} else {
				await api.prompts.edit(editingPrompt.path, editPromptContent);
			}
			clearDirty("prompts");
			await refreshPrompts();
			return true;
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			return false;
		} finally {
			setEditPromptSaving(false);
		}
	};

	/** 从用户选择的 JSON 文件导入配置，成功后刷新当前 tab。 */
	const refreshSkills = async () => {
		const res = await api.skills.list();
		setSkillsData(res);
		if (res.locations[0] && !res.locations.some((item) => item.id === newSkillLocationId)) {
			setNewSkillLocationId(res.locations[0].id);
		}
	};

	const handleCreateSkill = async () => {
		setCreatingSkill(true);
		setError(null);
		try {
			await api.skills.create({
				name: newSkillName,
				description: newSkillDescription,
				locationId: newSkillLocationId,
			});
			setNewSkillName("");
			setNewSkillDescription("");
			await refreshSkills();
			showToast(t("config.skillCreatedToast"));
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setCreatingSkill(false);
		}
	};

	const handleToggleSkill = async (path: string, enabled: boolean) => {
		setError(null);
		try {
			await api.skills.toggle(path, enabled);
			await refreshSkills();
			showToast(enabled ? t("config.skillEnabledToast") : t("config.skillDisabledToast"));
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	};

	const confirmDeleteSkill = async () => {
		if (!deleteSkillConfirm) return;
		const target = deleteSkillConfirm;
		setDeleteSkillConfirm(null);
		setError(null);
		try {
			await api.skills.delete(target.path);
			await refreshSkills();
			showToast(t("config.skillDeletedToast"));
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	};

	const handleRenameGlobalSkill = async (skill: PiSkillSummary, newName: string) => {
		setError(null);
		try {
			await api.skills.rename(skill.path, newName);
			await refreshSkills();
			showToast(t("config.skillRenamedToast"));
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	};

	const handleEditGlobalSkill = async (skill: PiSkillSummary) => {
		setEditingGlobalSkill(skill);
		setEditGlobalContent("");
		setEditGlobalLoading(true);
		setError(null);
		try {
			const content = await window.piDesktop.files.readContent(skill.path);
			setEditGlobalContent(content);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			setEditingGlobalSkill(null);
		} finally {
			setEditGlobalLoading(false);
		}
	};

	// Ctrl+S / Cmd+S 快捷键保存 skill 编辑器
	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			if ((e.ctrlKey || e.metaKey) && e.key === "s" && editingGlobalSkill && !editGlobalSaving) {
				e.preventDefault();
				void saveGlobalSkillEditor();
			}
		};
		if (editingGlobalSkill) {
			window.addEventListener("keydown", handleKeyDown);
			return () => window.removeEventListener("keydown", handleKeyDown);
		}
	}, [editingGlobalSkill, editGlobalSaving]);

	const saveGlobalSkillEditor = async (): Promise<boolean> => {
		if (!editingGlobalSkill || editGlobalSaving) return false;
		setEditGlobalSaving(true);
		setError(null);
		try {
			await window.piDesktop.files.writeContent(editingGlobalSkill.path, editGlobalContent);
			clearDirty("skills");
			setEditGlobalSaved(true);
			window.setTimeout(() => setEditGlobalSaved(false), 2000);
			await refreshSkills();
			return true;
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			return false;
		} finally {
			setEditGlobalSaving(false);
		}
	};

	/**
	 * 加载扩展列表。
	 * - forceRefresh=false：优先用主进程缓存（启动预热后通常秒开）
	 * - forceRefresh=true：手动刷新时强制重扫，并查询 npm 更新信息
	 */
	const refreshExtensions = async (forceRefresh = false) => {
		setExtensionsLoading(true);
		setError(null);
		try {
			const res = await api.extensions.list(forceRefresh);
			setExtensionsData(res);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setExtensionsLoading(false);
		}
	};

	const confirmUninstallExtension = async () => {
		if (!uninstallExtensionConfirm) return;
		const target = uninstallExtensionConfirm;
		// 防御性检查：内置扩展不应出现在确认弹窗中
		if (target.builtIn) {
			setUninstallExtensionConfirm(null);
			return;
		}
		setUninstallExtensionConfirm(null);
		// 立刻进入卸载态以触发卡片退场动画，同时发起真实卸载；两者并行，避免"删完才闪一下"。
		setUninstallingExtensionSource(target.source);
		const exitAnimation = new Promise<void>((resolve) => {
			window.setTimeout(resolve, 280);
		});
		try {
			await Promise.all([
				api.extensions.uninstall(target.source, target.scope),
				exitAnimation,
			]);
			// 卸载已使主进程缓存失效；轻量重扫即可，不额外逐个查询 npm 最新版本。
			await refreshExtensions(false);
			showToast(t("config.extensionUninstalledToast"));
		} catch (e) {
			// 配置页顶部红字容易被滚出视口；卸载失败用 error toast，用户能立刻看到。
			showNotice(
				t("config.extensionUninstallFailed", { error: formatIpcError(e) }),
				4500,
				"error",
			);
		} finally {
			setUninstallingExtensionSource(null);
		}
	};

	const handleImport = async () => {
		const input = document.createElement("input");
		input.type = "file";
		input.accept = ".json";
		input.onchange = async () => {
			const file = input.files?.[0];
			if (!file) return;
			try {
				const text = await file.text();
				const result = await api.config.import(text);
				if (!result.valid) {
					setError(result.error ?? t("config.importFailed"));
					return;
				}
				onSaved();
				// 导入会整体替换四个配置文件：当前 tab 由 loadConfig 重载并清标记，其余 tab 的数据在磁盘上已全部变化，
				// 统一清除它们的脏标记，避免残留黄点/关闭误弹确认（skills/prompts 编辑不涉及配置文件，保留）。
				for (const key of ALL_CONFIG_DIRTY_KEYS) clearDirty(key);
				await loadConfig(tab);
				showToast(t("config.imported"));
			} catch (e) {
				setError(e instanceof Error ? e.message : String(e));
			}
		};
		input.click();
	};

	/** 安全管理面板句柄（顶部统一保存按钮经 saveByKey 调用其 save） */
	const securitySectionRef = useRef<SecuritySectionHandle>(null);

	/** 安全管理草稿脏状态上报：有修改 markDirty("security")，保存成功/卸载清标记。 */
	const handleSecurityDirtyChange = useCallback(
		(dirty: boolean) => {
			if (dirty) markDirty("security");
			else clearDirty("security");
		},
		[markDirty, clearDirty],
	);

	/** 按 tab 编码分发到对应保存 handler；返回是否保存成功（false = 保存失败，由错误提示区展示原因）。 */
	const saveByKey = async (tabKey: string): Promise<boolean> => {
		switch (tabKey) {
			case "config:models":
				return handleSaveModels();
			case "config:auth":
				return handleSaveAuth();
			case "config:settings":
				return handleSaveSettings();
			case "config:trust":
				return handleSaveTrust();
			case "config:raw":
				return handleSaveRaw();
			case "skills":
				return saveGlobalSkillEditor();
			case "prompts":
				return handleSaveEditPrompt();
			case "security":
				return securitySectionRef.current?.save() ?? false;
			default:
				// extensions 即时生效页无保存语义，无 dirty 时按钮不可点
				return false;
		}
	};

	/** 顶部统一保存按钮：保存当前 tab 的未保存修改（不关闭弹框）。 */
	const handleSaveCurrent = async () => {
		const tabKey = sectionTabValue(section, tab);
		if (saving || !dirtyTabs.has(tabKey)) {
			// 当前 tab 无修改但其他 tab 有：提示而不是静默，避免用户以为保存成功了
			if (dirtyTabs.size > 0) showToast(t("config.noUnsavedChangesCurrentTab"));
			return;
		}
		await saveByKey(tabKey);
	};

	/** 关闭弹框：有未保存修改时先弹保存确认（借鉴设置页），无修改直接关闭。 */
	const handleClose = () => {
		if (dirtyTabs.size > 0) {
			setCloseConfirmOpen(true);
		} else {
			props.onClose();
		}
	};

	/** 关闭确认框选择保存并关闭：保存当前 tab 成功才关；失败留在弹框（错误已展示在内容区）。 */
	const handleSaveAndClose = async () => {
		const tabKey = sectionTabValue(section, tab);
		if (dirtyTabs.has(tabKey)) {
			const ok = await saveByKey(tabKey);
			if (!ok) return;
		}
		setCloseConfirmOpen(false);
		props.onClose();
	};

	/** 关闭确认框选择放弃更改：丢弃所有未保存修改直接关闭。 */
	const handleDiscardAndClose = () => {
		setCloseConfirmOpen(false);
		props.onClose();
	};

	const configNavItems: Array<{ id: ConfigTab; label: string; icon: ReactNode }> = [
		{ id: "models", label: t("config.nav.models"), icon: <Cpu size={14} aria-hidden="true" /> },
		{ id: "auth", label: t("config.nav.auth"), icon: <KeyRound size={14} aria-hidden="true" /> },
		{ id: "settings", label: t("config.nav.settings"), icon: <Settings2 size={14} aria-hidden="true" /> },
		{ id: "trust", label: t("config.nav.trust"), icon: <ShieldCheck size={14} aria-hidden="true" /> },
		{ id: "raw", label: t("config.nav.raw"), icon: <FileCode2 size={14} aria-hidden="true" /> },
	];

	// 加载态/错误提示：每个 TabsContent 顶部共用（Tabs 会卸载非激活内容，不能只挂一处）。
	// 同一 JSX element 可在多处渲染，不会造成重复副作用。
	const statusBlock = (
		<>
			{loading && <div className="py-12 text-center text-control text-muted-foreground">{t("common.loading")}</div>}
			{error && <div className="mb-3.5 rounded-sm border border-danger/20 bg-danger-soft px-3.5 py-2.5 text-control leading-relaxed text-danger whitespace-pre-line">{error}</div>}
		</>
	);

	// 配置诊断卡：config 组 5 个子页顶部共用（任意子页打开时都显示）。
	const configDiagnosticBlock = configDiagnostic ? (
		<ConfigDiagnosticCard
			diagnostic={configDiagnostic}
			onOpenDocs={() => api.app.openExternal(configDiagnostic.docsUrl, true)}
			onOpenRaw={() => setTab("raw")}
		/>
	) : null;

	if (!open) return null;

	return (
		<Dialog open={open} onOpenChange={(next) => !next && handleClose()}>
			<DialogContent showCloseButton={false} className={cn("flex flex-col gap-0 overflow-hidden p-0", configModalSizeClass, "config-modal", "[--wallpaper-dialog-alpha:var(--wallpaper-panel-alpha,30%)]")}>
				{/* 顶栏/侧栏控件与设置弹窗、会话顶栏统一到 sm / text-sm 密度 */}
				<DialogHeader className="flex-row items-center justify-between px-4 py-2.5">
					<DialogTitle className="text-sm font-semibold tracking-tight">{t("config.title")}</DialogTitle>
					<div className="flex items-center gap-1.5">
						{/* 顶部统一保存：各 tab 内部保存按钮可能被滚动藏住，这里常驻可见；
						    有未保存修改时按钮带黄点标记，无修改时禁用 */}
						<Button
							variant="default"
							size="sm"
							onClick={() => void handleSaveCurrent()}
							disabled={!hasDirty || saving}
							title={hasDirty ? t("config.dirtyTooltip") : undefined}
						>
							{hasDirty && (
								<span className="size-2 rounded-full bg-amber-400" aria-hidden="true" />
							)}
							{saving ? t("common.saving") : t("common.save")}
						</Button>
						{section === "config" ? (
							<>
								<Button variant="outline" size="sm" onClick={handleExport}>
									{t("common.export")}
								</Button>
								<Button variant="secondary" size="sm" onClick={handleImport}>
									{t("common.import")}
								</Button>
							</>
						) : undefined}
						<DialogClose asChild>
							<Button variant="ghost" size="icon-sm" className="size-7" aria-label={t("common.close")} title={t("common.close")}>
								<X size={16} strokeWidth={2.2} aria-hidden="true" />
							</Button>
						</DialogClose>
					</div>
				</DialogHeader>
			{/* 默认浅色主题整页同底（bg-background），避免顶栏白 / 下方多层灰的割裂感。
			  左侧导航 = shadcn Vertical Tabs：TabsList 竖排（orientation=vertical），
			  组标题是非 trigger 的普通 div；窄屏（<820px）回退为横向导航。 */}
			<Tabs
				orientation="vertical"
				value={sectionTabValue(section, tab)}
				onValueChange={(value) => {
					const parsed = parseSectionTabValue(value);
					setSection(parsed.section);
					if (parsed.tab) setTab(parsed.tab);
					// 记住位置：下次打开 Pi 管理页时回到同一 tab
					try {
						localStorage.setItem(CONFIG_LAST_TAB_KEY, value);
					} catch {
						/* localStorage 不可用（隐私模式等）时静默失败，仅本次会话内不记忆 */
					}
				}}
				className="config-layout flex min-h-0 flex-1 flex-row gap-0 bg-transparent max-[820px]:flex-col"
			>
				<TabsList
					className="config-sidebar flex min-h-0 shrink-0 flex-col items-stretch gap-2.5 overflow-auto border-0 border-r border-border rounded-none bg-transparent p-2.5 data-[orientation=vertical]:w-[160px] max-[820px]:flex-row max-[820px]:gap-3 max-[820px]:overflow-x-auto max-[820px]:overflow-y-hidden max-[820px]:border-r-0 max-[820px]:border-b"
					aria-label={t("config.title")}
				>
					<div className="config-sidebar-group grid gap-0.5">
						<span className="px-2 pb-1 text-micro font-semibold text-muted-foreground">{t("config.group.config")}</span>
						{configNavItems.map((item) => (
							<TabsTrigger
								key={item.id}
								value={`config:${item.id}`}
								className="config-nav-btn h-8 justify-start gap-1.5 px-2.5 text-control font-medium"
							>
								<span className="config-nav-icon">{item.icon}</span>
								{item.label}
							</TabsTrigger>
						))}
					</div>
					<div className="config-sidebar-group grid gap-0.5">
						<span className="px-2 pb-1 text-micro font-semibold text-muted-foreground">{t("config.group.agent")}</span>
						<TabsTrigger value="security" className="config-nav-btn h-8 justify-start gap-1.5 px-2.5 text-control font-medium">
							<span className="config-nav-icon"><Shield size={14} aria-hidden="true" /></span>
							{t("config.nav.security")}
						</TabsTrigger>
						<TabsTrigger value="extensions" className="config-nav-btn h-8 justify-start gap-1.5 px-2.5 text-control font-medium">
							<span className="config-nav-icon"><Puzzle size={14} aria-hidden="true" /></span>
							{t("config.nav.extensions")}
						</TabsTrigger>
						<TabsTrigger value="skills" className="config-nav-btn h-8 justify-start gap-1.5 px-2.5 text-control font-medium">
							<span className="config-nav-icon"><Sparkles size={14} aria-hidden="true" /></span>
							{t("config.nav.skills")}
						</TabsTrigger>
						<TabsTrigger value="prompts" className="config-nav-btn h-8 justify-start gap-1.5 px-2.5 text-control font-medium">
							<span className="config-nav-icon"><FileText size={14} aria-hidden="true" /></span>
							{t("config.nav.prompts")}
						</TabsTrigger>
					</div>
				</TabsList>

					<TabsContent value="config:models" className="config-main min-w-0">
						<div className="config-content">
					{statusBlock}
					{configDiagnosticBlock}
					{!loading && (
						<ModelsTab
							data={modelsData}
							expandedProvider={expandedProvider}
							addingProvider={addingProvider}
							newProviderName={newProviderName}
							renamingProvider={renamingProvider}
							renameValue={renameValue}
							fetchingProvider={fetchingProvider}
							fetchedModels={fetchedModels}
							fetchModelsErrorByProvider={fetchModelsErrorByProvider}
							testingProvider={testingProvider}
							testResult={testResult}
							testModelIdByProvider={testModelIdByProvider}
							saving={saving}
							onToggleProvider={(name) =>
								setExpandedProvider(expandedProvider === name ? null : name)
							}
							onStartAddProvider={() => {
								setAddingProvider(true);
								setNewProviderName("");
							}}
							onCancelAddProvider={() => setAddingProvider(false)}
							onChangeNewProviderName={setNewProviderName}
							onConfirmAddProvider={handleAddProvider}
							onStartRename={handleStartRename}
							onChangeRenameValue={setRenameValue}
							onConfirmRename={handleConfirmRename}
							onCancelRename={handleCancelRename}
							onDeleteProvider={handleDeleteProvider}
							onDuplicateProvider={handleDuplicateProvider}
							onDeleteProviders={handleDeleteProviders}
							onAddModel={handleAddModel}
							onUpdateModel={handleUpdateModel}
							onUpdateModelThinkingLevel={handleUpdateModelThinkingLevel}
							onDeleteModel={handleDeleteModel}
							onFetchModels={handleFetchModels}
							onTestProvider={handleTestProvider}
							onChangeTestModelId={(providerName, modelId) =>
								setTestModelIdByProvider((current) => ({
									...current,
									[providerName]: modelId,
								}))
							}
							onClearTestResult={() => setTestResult(null)}
							onSave={handleSaveModels}
							onChangeProvider={(name, field, value) => {
								const provider = modelsData.providers[name];
								if (!provider) return;
								setModelsData({
									...modelsData,
									providers: {
										...modelsData.providers,
										[name]: { ...provider, [field]: value },
									},
								});
								markDirty("config:models");
							}}
						/>
					)}
						</div>
					</TabsContent>

					<TabsContent value="config:auth" className="config-main min-w-0">
						<div className="config-content">
					{statusBlock}
					{configDiagnosticBlock}
					{!loading && (
						<AuthTab
							data={authData}
							expandedAuth={expandedAuth}
							addingAuth={addingAuth}
							newAuthName={newAuthName}
							saving={saving}
							modelsData={modelsData}
							onToggleAuth={(name) =>
								setExpandedAuth(expandedAuth === name ? null : name)
							}
							onStartAddAuth={() => {
								setAddingAuth(true);
								setNewAuthName("");
							}}
							onCancelAddAuth={() => setAddingAuth(false)}
							onChangeNewAuthName={setNewAuthName}
							onConfirmAddAuth={(name, key) => handleAddAuth(name, key)}
							onDuplicateAuth={handleDuplicateAuth}
						onDeleteAuths={handleDeleteAuths}
						onDeleteAuth={handleDeleteAuth}
							onUpdate={handleUpdateAuth}
							onSave={handleSaveAuth}
						/>
					)}
						</div>
					</TabsContent>

					<TabsContent value="config:settings" className="config-main min-w-0">
						<div className="config-content">
					{statusBlock}
					{configDiagnosticBlock}
					{!loading && (
						<SettingsTab
							data={settingsData}
							saving={saving}
							modelsData={modelsData}
							authData={authData}
							discoveredModels={discoveredModels}
							onChange={(data) => {
								setSettingsData(data);
								markDirty("config:settings");
							}}
							onSave={handleSaveSettings}
						/>
					)}
						</div>
					</TabsContent>

					<TabsContent value="skills" className="config-main min-w-0">
						<div className="config-content">
					{statusBlock}
					{!loading && (
						editingGlobalSkill ? (
							<div className="prompts-editor-backdrop" onClick={() => setEditingGlobalSkill(null)}>
								<div className="prompts-editor-modal" onClick={(e) => e.stopPropagation()}>
									<div className="file-diff-header">
										<span className="file-diff-header-file">{editingGlobalSkill.name} · SKILL.md</span>
										<div className="file-diff-header-actions">
											<Button variant="ghost" size="icon" aria-label={t("common.close")} title={t("common.close")} onClick={() => { clearDirty("skills"); setEditingGlobalSkill(null); }}>
												<X size={18} strokeWidth={2.2} aria-hidden="true" />
											</Button>
										</div>
									</div>
									{editGlobalLoading ? (
										<div className="py-12 text-center text-control text-text-tertiary">{t("common.loading")}</div>
									) : (
										<div className="prompts-monaco-wrap">
											<CodeMirrorEditor
												value={editGlobalContent}
												onChange={(value) => {
													setEditGlobalContent(value);
													markDirty("skills");
												}}
											/>
									</div>
								)}
								{editGlobalSaved && <span className="file-diff-hint saved">{t("config.promptSavedHint")}</span>}
							</div>
						</div>
					) : (
							<SkillsTab
							data={skillsData}
							loading={loading}
							creating={creatingSkill}
							newName={newSkillName}
							newDescription={newSkillDescription}
							newLocationId={newSkillLocationId}
							onRefresh={refreshSkills}
							onOpenRoot={() => api.skills.openFolder()}
							onChangeNewName={setNewSkillName}
							onChangeNewDescription={setNewSkillDescription}
							onChangeNewLocation={setNewSkillLocationId}
							onCreate={handleCreateSkill}
							onToggle={(skill, enabled) => handleToggleSkill(skill.path, enabled)}
							onDelete={setDeleteSkillConfirm}
							onEdit={handleEditGlobalSkill}
							onRename={handleRenameGlobalSkill}
						/>
						)
					)}
						</div>
					</TabsContent>

					<TabsContent value="prompts" className="config-main min-w-0">
						<div className="config-content">
					{statusBlock}
					{!loading && (
						<PromptsTab
							data={promptsData}
							loading={loading}
							creating={creatingPrompt}
							newName={newPromptName}
							newDescription={newPromptDescription}
							editingTemplate={editingPrompt}
							editContent={editPromptContent}
							editLoading={editPromptLoading}
							editSaving={editPromptSaving}
							onRefresh={refreshPrompts}
							onOpenRoot={() => api.prompts.openFolder()}
							canRestoreBuiltins={promptsData.hasHiddenBuiltins}
							restoringBuiltins={restoringBuiltinPrompts}
							onRestoreBuiltins={() => setRestoreBuiltinPromptsConfirm(true)}
							onChangeNewName={setNewPromptName}
							onChangeNewDescription={setNewPromptDescription}
							onCreate={handleCreatePrompt}
							onDelete={setDeletePromptConfirm}
							onEdit={handleEditPrompt}
							onRename={handleRenamePrompt}
							onQuickSave={handleQuickSavePrompt}
							onCancelEdit={handleCancelEditPrompt}
							onChangeEditContent={(value) => {
								setEditPromptContent(value);
								markDirty("prompts");
							}}
							onSaveEdit={handleSaveEditPrompt}
						/>
					)}
						</div>
					</TabsContent>

					<TabsContent value="extensions" className="config-main min-w-0">
						<div className="config-content">
					{statusBlock}
					<ExtensionsTab
							data={extensionsData}
							loading={extensionsLoading}
							uninstallingSource={uninstallingExtensionSource}
							onReload={() => void refreshExtensions(false)}
							onRefresh={() => void refreshExtensions(true)}
							onUninstall={setUninstallExtensionConfirm}
						/>
						</div>
					</TabsContent>

					<TabsContent value="security" className="config-main min-w-0">
						<div className="config-content">
						<SecuritySection
							ref={securitySectionRef}
							onDirtyChange={handleSecurityDirtyChange}
						/>
						</div>
					</TabsContent>

					<TabsContent value="config:trust" className="config-main min-w-0">
						<div className="config-content">
					{statusBlock}
					{configDiagnosticBlock}
					{!loading && (
						<TrustTab
							data={trustData}
							saving={saving}
							onChange={(data) => {
								setTrustData(data);
								markDirty("config:trust");
							}}
							onSave={handleSaveTrust}
						/>
					)}
						</div>
					</TabsContent>

					<TabsContent value="config:raw" className="config-main min-w-0">
						<div className="config-content">
					{statusBlock}
					{configDiagnosticBlock}
					{!loading && (
						<RawTab
							fileName={rawFileName}
							content={rawContent}
							saving={saving}
							onChangeFileName={handleRawFileChange}
							onChangeContent={(value) => {
								setRawContent(value);
								markDirty("config:raw");
							}}
							onSave={handleSaveRaw}
						/>
					)}
						</div>
					</TabsContent>
				</Tabs>

				{deleteSkillConfirm && (
					<ConfirmDialog
						title={t("config.deleteSkillConfirmTitle")}
						message={t("config.deleteSkillConfirmBody", { name: deleteSkillConfirm.name }) + "\n" + deleteSkillConfirm.path}
						confirmLabel={t("common.delete")}
						danger
						onConfirm={() => void confirmDeleteSkill()}
						onCancel={() => setDeleteSkillConfirm(null)}
					/>
				)}

				{uninstallExtensionConfirm && (
					<ConfirmDialog
						title={t("config.uninstallExtensionTitle")}
						message={t("config.uninstallExtensionBody", { source: uninstallExtensionConfirm.source }) + (uninstallExtensionConfirm.path ? "\n" + uninstallExtensionConfirm.path : "")}
						confirmLabel={t("config.uninstall")}
						danger
						onConfirm={confirmUninstallExtension}
						onCancel={() => setUninstallExtensionConfirm(null)}
					/>
				)}

				{deletePromptConfirm && (
					<ConfirmDialog
						title={t("config.deletePromptConfirmTitle")}
						message={t("config.deletePromptConfirmBody", { name: deletePromptConfirm.name })}
						confirmLabel={t("common.delete")}
						danger
						onConfirm={() => void confirmDeletePrompt(deletePromptConfirm)}
						onCancel={() => setDeletePromptConfirm(null)}
					/>
				)}

				{restoreBuiltinPromptsConfirm && (
					<ConfirmDialog
						title={t("config.restoreBuiltinPromptsTitle")}
						message={t("config.restoreBuiltinPromptsBody")}
						confirmLabel={t("common.confirm")}
						onConfirm={() => void confirmRestoreBuiltinPrompts()}
						onCancel={() => setRestoreBuiltinPromptsConfirm(false)}
					/>
				)}

				{/* 关闭确认：有未保存修改时弹出，保存并关闭 / 放弃更改 / 取消（借鉴设置页） */}
				{closeConfirmOpen && (
					<AlertDialog open onOpenChange={(open) => { if (!open) setCloseConfirmOpen(false); }}>
						<AlertDialogContent>
							<AlertDialogHeader>
								<AlertDialogTitle>{t("config.unsavedTitle")}</AlertDialogTitle>
								<AlertDialogDescription>{t("config.unsavedMessage")}</AlertDialogDescription>
							</AlertDialogHeader>
							<AlertDialogFooter>
								<AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
								<AlertDialogAction className={buttonVariants({ variant: "destructive" })} onClick={handleDiscardAndClose}>
									{t("config.discardChanges")}
								</AlertDialogAction>
								<AlertDialogAction onClick={() => void handleSaveAndClose()}>
									{t("config.saveAndClose")}
								</AlertDialogAction>
							</AlertDialogFooter>
						</AlertDialogContent>
					</AlertDialog>
				)}

				{/* toast 已改用 sonner */}
				{deleteConfirm && (
					<ConfirmDialog
						title={deleteConfirm.title}
						message={deleteConfirm.message}
						confirmLabel={t("common.delete")}
						danger
						onConfirm={deleteConfirm.onConfirm}
						onCancel={() => setDeleteConfirm(null)}
					/>
				)}
				</DialogContent>
		</Dialog>
	);
}
