import type { ExternalEditorSettings } from "./project";
import type { SecurityConfig } from "./security";
import type { PiRuntimePreference } from "../piCompatibility";

export type SendShortcutMode =
	| "enter-send"
	| "ctrl-enter-send"
	| "shift-enter-send";

export type AppThemeMode = "system" | "light" | "dark";
/** 主题色预设：data-accent 属性驱动 foundation.css 的 accent/logo 变量 */
export type AppAccentMode = "default" | "green" | "blue" | "purple" | "amber" | "rose";
/**
 * 皮肤（换肤）：覆盖背景/border 色板，与 accent（主题色）正交。
 * 内置皮肤在 themePresets.ts SKIN_PRESETS 定义；custom 由 customThemeOverrides 驱动。
 */
export type AppSkinId =
	| "classic-green"
	| "graphite"
	| "sea-blue"
	| "warm-beige"
	| "custom";
export type AppLanguageMode = "system" | "zh-CN" | "en-US" | "pseudo";

/** 主进程枚举出的可用于手机访问 Web 服务的局域网入口。 */
export type WebNetworkAddress = {
	address: string;
	interfaceName: string;
	cidr: string | null;
	isPrivate: boolean;
};
/** 文件/Git Diff 在中间栏的默认打开方式：分屏与会话并排，或占满中间栏 */
export type WorkspaceContentOpenMode = "split" | "maximize";
/** 会话 Tab 打开模式：preview=单击为临时预览（发消息后自动晋升常驻），permanent=单击即常驻共存 */
export type SessionTabOpenMode = "preview" | "permanent";
export type AppFontSizeMode = "compact" | "default" | "medium" | "large" | "xlarge";
export type AppFontBaseMode = "system" | "sans" | "serif" | "custom";
export type AppFontMonoMode = "system-mono" | "custom";
/** 会话排版档位：通用三档（内容块间距/列表密度/代码密度） */
export type ChatTypographyDensity = "compact" | "default" | "relaxed";
/** 会话正文行距档位：四档（含宽松一档） */
export type ChatBodyLineHeightMode = "compact" | "default" | "relaxed" | "loose";
/** 主窗口启动尺寸预设：last=上次关闭时的窗口大小（读不到时顺延默认）；fullscreen 占满屏幕，maximized 最大化，其余为固定窗口 */
export type StartupWindowMode =
	| "last"
	| "fullscreen"
	| "maximized"
	| "normal-large"
	| "normal-medium"
	| "normal-compact";

	export type AppSettings = {
	useNativeTitleBar: boolean;
	showNativeMenu: boolean;
	sendShortcut: SendShortcutMode;
	/** 界面主题，system 跟随系统浅色/暗色偏好 */
	theme: AppThemeMode;
	/** 主题色（accent）预设，data-accent 驱动；新增预设只需扩充 AppAccentMode 与色板 */
	accent: AppAccentMode;
	/** 皮肤（换肤）：内置预设见 themePresets.ts SKIN_PRESETS；custom 走 customThemeOverrides */
	themeSkin: AppSkinId;
	/** 自定义主题：CSS 变量名 → 值（键不含 -- 前缀），叠加在内置皮肤之上 */
	customThemeOverrides: Record<string, string>;
	/** 背景图文件名（userData/backgrounds/ 目录下），空串=不启用 */
	backgroundImage: string;
	/** 背景图可见度 0-1：0=背景色完全遮住图片，1=图片全显；面板/弹层会按语义分档透出 */
	backgroundImageOpacity: number;
	/** 界面语言，system 跟随系统语言；pseudo 用于长文案布局压力测试 */
	language: AppLanguageMode;
	/** 启动时主窗口尺寸预设，默认 last（上次窗口大小，读不到时顺延 maximized） */
	startupWindowMode: StartupWindowMode;
	piEnvironmentChecked: boolean;
	/** 最近一次 pi 环境检测成功的结果缓存（命令路径 + 版本），打开设置直接显示，不重复检测 */
	piInstall?: { command: string; version: string; runtimeKind?: "typescript" | "rust" | "unknown" };
	/** Pi 实现选择：自动检测、原版 TypeScript 或 pi_agent_rust。 */
	piRuntimePreference: PiRuntimePreference;
	/** 可选的原版 TypeScript Pi 路径；选择对应实现时优先使用。 */
	piTypescriptPath: string;
	/** 可选的 pi_agent_rust 路径；选择对应实现时优先使用。 */
	piRustPath: string;
	/** 会话 Tab 打开模式：preview=单击为临时预览（发消息后自动晋升常驻），permanent=单击即常驻共存 */
	sessionTabOpenMode: SessionTabOpenMode;
	/** 是否启用会话右侧的 Git 源代码管理入口与面板，默认开启以保持升级前行为。 */
	enableGitManagement: boolean;
	/** Git 提交摘要生成提示词模板，{diff} 会被替换为实际 diff 内容 */
	gitCommitMessagePrompt: string;
	/** Git 提交摘要使用的 pi provider；为空时生成前提示用户配置 */
	gitCommitMessageProvider: string;
	/** Git 提交摘要使用的模型 ID；为空时生成前提示用户配置 */
	gitCommitMessageModel: string;
	/** 关闭窗口时隐藏到系统托盘而不是退出 */
	closeToTray: boolean;
	/**
	 * 单实例模式：再次打开应用时复用已有窗口（托盘隐藏也会唤起）。
	 * 默认 true；关闭后允许同时跑多个 PiDeck 进程。
	 */
	singleInstance: boolean;
	/** 会话结束时发送系统通知 */
	enableNotifications: boolean;
	/** 激活 Agent 数量提醒（人文关怀）：激活数达到阈值时，启动时提示关闭空闲会话释放内存。默认开启。 */
	agentCountReminderEnabled: boolean;
	/** 是否在会话中显示模型思考过程，默认开启 */
	showThinking: boolean;
	/**
	 * 流式对话时是否自动展开中间过程（思考/工具详情）。
	 * false（默认）：对话过程中保持折叠（历史轮与最新轮都不自动撑开），手动展开的仍可查看；
	 * true：最新轮流式输出时自动展开。手动开合状态始终优先于本设置。
	 */
	expandInterimDuringStream: boolean;
	/**
	 * 新一轮（用户发送新消息）开始时自动收起上一轮展开的中间过程，节省渲染资源。
	 * true（默认）：发送新消息后收起所有非最新轮（含手动展开的）；false：保持现状。
	 */
	collapsePrevRunsOnNewTurn: boolean;
	/** 是否开启开发者控制台（DevTools） */
	showDevTools: boolean;
	/** 是否给 pi agent 子进程注入代理环境变量，不影响 desktop 自身网络请求 */
	piProxyEnabled: boolean;
	/** pi agent 使用的代理地址，例如 http://127.0.0.1:7890 */
	piProxyUrl: string;
	/** pi agent 代理绕过列表，对应 NO_PROXY 环境变量 */
	piProxyBypass: string;
	/** 是否给桌面端自身网络请求启用代理，不影响已启动的 pi agent 子进程 */
	desktopProxyEnabled: boolean;
	/** 桌面端自身网络请求使用的代理地址，例如 http://127.0.0.1:7890 */
	desktopProxyUrl: string;
	/** 桌面端代理绕过列表，对应 Electron proxyBypassRules */
	desktopProxyBypass: string;
	/** 用户手动指定的 pi CLI 命令路径，自动检测不到时用于兜底 */
	customPiPath: string;

	/** 是否开启局域网 Web 服务 */
	webServiceEnabled: boolean;
	/** Web 服务监听地址，默认 0.0.0.0 允许局域网访问 */
	webServiceHost: string;
	/** Web 服务监听端口 */
	webServicePort: number;
	/** 应用安装类型：portable（便携版）或 installed（安装版），启动时自动检测并持久化 */
	installationType?: "portable" | "installed";
	/** RPC 调用超时时间（毫秒），默认 600000（10 分钟），用于长时间运行的命令 */
	rpcTimeout: number;
	/**
	 * 从文件树 / Git 打开文件或 Diff 时，中间栏默认布局。
	 * split=与会话分屏；maximize=占满中间栏（会话暂时收起，不进侧栏）。
	 */
	workspaceContentOpenMode: WorkspaceContentOpenMode;
	/**
	 * 内容区最大宽度（px），0 表示不限制（填满 chat-pane）。用于限制消息行宽，左右留白。
	 * @deprecated 由 chatContentWidthPct 取代：保留字段以兼容旧 settings.json，新代码不再读取。
	 */
	contentMaxWidth: number;
	/**
	 * 聊天内容区宽度占聊天面板的百分比（60–100，100=无留白全宽）。
	 * 消息与输入框共享同一留白（--chat-content-pct），分屏窄栏时由容器查询自动收敛到 100%。
	 */
	chatContentWidthPct: number;
	/** 编辑器最大文件大小（MB），超过此大小的文件不加载编辑器。默认 5MB。 */
	maxEditorFileSizeMB: number;
	/** 外部编辑器配置：首次异步检测后保存，用户可在设置中手动覆盖路径。 */
	externalEditors: ExternalEditorSettings;
	/** 是否启用 WSL fallback：在 Windows 自动检测不到 pi 时，尝试从 WSL 启动 pi */
	wslEnabled: boolean;
	/** WSL 发行版名称，如 Debian、Ubuntu */
	wslDistro: string;
	/** WSL 用户名，如 piuser */
	wslUser: string;

	// ── 模型收藏：ModelPicker 中用 ☆ 标记，收藏的模型在列表中置顶 ──
	/** 收藏的模型 ID 列表 */
	favoriteModels: string[];

	// ── 字体配置：沿用主题机制实时生效，写入 documentElement token ──
	/** 全局字号基准档位；未单独设置各区域时，所有字号 token 均由此推导 */
	fontSize: AppFontSizeMode;
	/** UI 字号覆盖；null 表示跟随 fontSize。控制 sidebar、按钮、列表、弹窗等 */
	uiFontSize: AppFontSizeMode | null;
	/** 会话正文字号覆盖；null 表示跟随 fontSize。控制用户消息与助手回复 */
	chatFontSize: AppFontSizeMode | null;
	/** 输入框字号覆盖；null 表示跟随 fontSize。控制 composer 输入区 */
	inputFontSize: AppFontSizeMode | null;
	/** 会话正文行距档位：控制自动换行、普通行与单个回车的行高 */
	chatBodyLineHeight: ChatBodyLineHeightMode;
	/** Markdown 段落与相邻内容块的间距档位 */
	chatBlockGap: ChatTypographyDensity;
	/** 列表整体与列表项之间的疏密档位 */
	chatListDensity: ChatTypographyDensity;
	/** 代码块/表格内部的疏密档位 */
	chatCodeDensity: ChatTypographyDensity;
	/** 全局窗口缩放比例，1 为 100%；通过 webContents.setZoomFactor 生效 */
	zoomFactor: number;
	/** UI 基础字体预设，默认使用系统字体；system 跟随系统字体栈；custom 时使用 fontFamilyBaseCustom */
	fontFamilyBase: AppFontBaseMode;
	/** fontFamilyBase=custom 时的自定义字体族栈，原样写入 CSS font-family */
	fontFamilyBaseCustom: string;
	/** 等宽字体预设，system-mono 跟随系统等宽字体；custom 时使用 fontFamilyMonoCustom */
	fontFamilyMono: AppFontMonoMode;
	/** fontFamilyMono=custom 时的自定义字体族栈，原样写入 CSS font-family */
	fontFamilyMonoCustom: string;

	// ── 更新检测 ──
	/** 是否禁用版本更新检测（PiDeck + Pi CLI），默认 false 表示正常检测；
	 *  开启后自动跳过启动和定时检测，设置页中检测按钮也禁用。 */
	disableUpdateCheck: boolean;

	// ── Agent 启动诊断/加速（开发设置） ──
	/**
	 * 启动 pi RPC 时附加 --offline，跳过 pi 启动期模型目录网络刷新。
	 * 桌面端模型列表来自本地 models.json，默认开启以加快冷启动。
	 */
	piRpcOffline: boolean;
	/**
	 * 启动 pi RPC 时附加 --no-extensions，跳过扩展发现与加载。
	 * 用于排查「坏扩展导致 RPC 起不来」；开启后 todo/plan/ask 等扩展不可用。
	 */
	piRpcNoExtensions: boolean;
	/**
	 * 启动 pi RPC 时附加 --no-skills，跳过 skills 发现与加载。
	 * 用于排查/加速；开启后技能命令与 skill 相关能力不可用。
	 */
	piRpcNoSkills: boolean;

	// ── 侧栏 UI 状态 ──
	/**
	 * 左侧边栏处于展开状态的项目 id 列表（含 builtin-chat）。
	 * 写入 settings.json，避免 dev 模式强杀进程时 localStorage 来不及落盘而丢失。
	 * 缺省时由渲染层按「仅展开 chat」处理。
	 */
	sidebarExpandedProjectIds?: string[];

	// ── 扩展管理 ──
	/**
	 * 用户手动移除（或因三方冲突自动让位）的内置扩展列表（如 pi-deck-todo.ts）。
	 * 下次启动跳过自动部署，并清理用户目录残留文件，避免 pi 仍加载导致工具冲突。
	 */
	removedBuiltInExtensions: string[];
	/** 内置扩展默认值迁移版本；仅用于保证新增的默认关闭扩展不影响老配置。 */
	builtInExtensionDefaultsVersion?: number;

	/**
	 * 用户从设置页删除的内置 Prompt 模板名称（如 commit、review）。
	 * 仅隐藏内置推荐项，不删除磁盘文件；找回默认模板时清空此列表。
	 */
	hiddenBuiltinPromptNames: string[];

	// ── 安全管理 ──
	/**
	 * 安全管理配置（等级/工具动作/目录边界/会话覆盖）。
	 * 缺省 undefined：由 SecurityStore.normalizeConfig 并入默认值（enabled=false 零干预）。
	 * 变更后主进程会把策略快照写入 userData/security-policy.json 供 pi-deck-security-gate 扩展消费。
	 */
	securityConfig?: SecurityConfig;

};
