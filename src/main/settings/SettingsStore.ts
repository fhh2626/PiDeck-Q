import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import {
	getDefaultGitCommitMessagePrompt,
	isDefaultGitCommitMessagePrompt,
	resolveGitCommitMessagePromptLocale,
} from "../../shared/gitCommitMessagePrompt";
import { createDefaultExternalEditorSettings, type AppSettings } from "../../shared/types";
import { getAppLogger } from "../logging/sharedLogger";
import {
	BUILT_IN_EXTENSION_DEFAULTS_VERSION,
	DEFAULT_DISABLED_BUILT_IN_EXTENSIONS,
	migrateBuiltInExtensionDefaults,
} from "../extensions/builtInExtensions";

export { readSingleInstancePreference } from "./startupPreferences";

/**
 * 读取 pi agent 的 settings.json 并从中提取 showThinking（取 hideThinkingBlock 的反值）。
 * pi CLI 的 hideThinkingBlock 语义：true=隐藏思考，false=显示思考。
 * 桌面端 showThinking 语义：true=显示，false=隐藏。
 * 映射：showThinking = !hideThinkingBlock
 * 若 pi agent 文件不存在或 hideThinkingBlock 未设置，返回 undefined。
 */
export function readPiAgentShowThinking(filePath: string): boolean | undefined {
	try {
		const agentRaw = readFileSync(filePath, "utf8");
		const agentSettings = JSON.parse(agentRaw) as Record<string, unknown>;
		if (typeof agentSettings.hideThinkingBlock === "boolean") {
			return !agentSettings.hideThinkingBlock;
		}
	} catch {
		// 文件不存在或解析失败，静默忽略
	}
	return undefined;
}

const defaultSettings: AppSettings = {
  useNativeTitleBar: false,
  showNativeMenu: false,
  sendShortcut: "enter-send",
  theme: "system",
  accent: "default",
	themeSkin: "classic-green",
	customThemeOverrides: {},
	backgroundImage: "",
	backgroundImageOpacity: 0.8,
  language: "system",
  // 默认最大化：与历史 createWindow 在 ready-to-show 后 maximize() 的行为一致
  // （1480×960 只是最大化前的兜底尺寸，不是最终展示态）
  startupWindowMode: "last",
  piEnvironmentChecked: false,
	piRuntimePreference: "auto",
	piTypescriptPath: "",
	piRustPath: "",
  sessionTabOpenMode: "preview",
  enableGitManagement: true,
  // load() 会按系统/用户语言把内置模板切换为中文或英文。
  gitCommitMessagePrompt: getDefaultGitCommitMessagePrompt("zh-CN"),
  // 默认不指定模型，避免升级后在用户尚未配置 provider 时隐式调用错误模型。
  gitCommitMessageProvider: "",
  gitCommitMessageModel: "",
  closeToTray: true,
  // 默认单实例：托盘隐藏后再次点击快捷方式会唤起原窗口，而不是再开一个进程
  singleInstance: true,
  enableNotifications: true,
  // 人文关怀提醒默认开启：用户可在设置中随时关闭
  agentCountReminderEnabled: true,
  showThinking: true,
  // 流式对话设置：默认不自动展开中间过程（省渲染资源，手动展开不受影响）；
  // 新一轮开始默认收起非最新轮（含手动展开的），用户可在设置中关闭。
  expandInterimDuringStream: false,
  collapsePrevRunsOnNewTurn: true,
  showDevTools: false,
  piProxyEnabled: false,
  piProxyUrl: "http://127.0.0.1:7890",
  piProxyBypass: "localhost,127.0.0.1,::1",
  desktopProxyEnabled: false,
  desktopProxyUrl: "http://127.0.0.1:7890",
  desktopProxyBypass: "localhost,127.0.0.1,::1",
  customPiPath: "",
  wslEnabled: false,
  wslDistro: "Ubuntu",
  wslUser: "root",
  webServiceEnabled: false,
  webServiceHost: "0.0.0.0",
  webServicePort: 8765,
  rpcTimeout: 600_000,
  workspaceContentOpenMode: "split",
  contentMaxWidth: 1800,
  // 内容区宽度默认 80%：轻微留白兼顾阅读舒适（1826px 面板 → 内容 1461px）；
  // 分屏窄栏时由容器查询自动收敛，详见 foundation.css --chat-content-pct。
  chatContentWidthPct: 80,
  maxEditorFileSizeMB: 5,
  externalEditors: createDefaultExternalEditorSettings(),

  favoriteModels: [],

  // ── 扩展管理 ──
  /** 用户手动移除的内置扩展，启动时跳过自动部署 */
  removedBuiltInExtensions: [...DEFAULT_DISABLED_BUILT_IN_EXTENSIONS],
  builtInExtensionDefaultsVersion: BUILT_IN_EXTENSION_DEFAULTS_VERSION,
  /** 用户删除的内置 Prompt 模板名称；找回默认模板时清空 */
  hiddenBuiltinPromptNames: [],

  // ── 更新检测：默认正常检测，用户可手动关闭忽略更新 ──
  disableUpdateCheck: false,

  // ── Agent 启动诊断/加速：offline 默认开；扩展/技能默认加载 ──
  piRpcOffline: true,
  piRpcNoExtensions: false,
  piRpcNoSkills: false,

  // 字体配置：默认使用系统字体；用户可通过自定义字体设置修改。
  // 出厂默认取 "default" 档：与 CSS token 基线（:root 无覆盖时）一致，
  // 避免「默认」档位名与实际出厂外观错位（旧默认 medium 比 default 大一档）。
  fontSize: "default",
  uiFontSize: null,
  chatFontSize: null,
  inputFontSize: null,
  chatBodyLineHeight: "default",
  chatBlockGap: "default",
  chatListDensity: "default",
  chatCodeDensity: "default",
  zoomFactor: 1,
  fontFamilyBase: "system",
  fontFamilyBaseCustom: "",
  fontFamilyMono: "system-mono",
  fontFamilyMonoCustom: "",
};

export interface SettingsStoreDeps {
	desktopSettingsFile?: string;
	piAgentSettingsFile?: string;
	getSystemLocale?: () => string | undefined;
}

export class SettingsStore {
  private readonly filePath: string;
  private readonly piAgentSettingsFile: string;
  private readonly getSystemLocale: () => string | undefined;
  private settings: AppSettings;

  constructor(deps: SettingsStoreDeps = {}) {
    const home = homedir();
    this.filePath = deps.desktopSettingsFile ?? join(home, ".pi-desktop", "settings.json");
    this.piAgentSettingsFile = deps.piAgentSettingsFile ?? join(home, ".pi", "agent", "settings.json");
    this.getSystemLocale = deps.getSystemLocale ?? (() => undefined);
    const showThinking = readPiAgentShowThinking(this.piAgentSettingsFile) ?? true;
    this.settings = {
      ...defaultSettings,
      showThinking,
    };
  }

  async load() {
    let migratedBuiltInExtensionDefaults = false;
    try {
      const raw = await readFile(this.filePath, "utf8");
      // 磁盘 JSON 无类型；旧版匿名统计字段只读兼容，加载时剥离后不再写回。
      const parsedUnknown = JSON.parse(raw) as Record<string, unknown>;
      const hadLegacyTelemetry =
        Object.hasOwn(parsedUnknown, "telemetryEnabled") ||
        Object.hasOwn(parsedUnknown, "telemetryInstallId") ||
        Object.hasOwn(parsedUnknown, "telemetryLastHeartbeatDate");
      const hadLegacyLinkOpenMode = Object.hasOwn(parsedUnknown, "linkOpenMode");
      const hadLegacyElectronChromiumSandbox = Object.hasOwn(parsedUnknown, "electronChromiumSandbox");
      const {
        telemetryEnabled: _ignoredTelemetryEnabled,
        telemetryInstallId: _ignoredTelemetryInstallId,
        telemetryLastHeartbeatDate: _ignoredTelemetryLastHeartbeatDate,
        linkOpenMode: _ignoredLinkOpenMode,
        electronChromiumSandbox: _ignoredElectronChromiumSandbox,
        ...parsedClean
      } = parsedUnknown;
      const parsed = parsedClean as Partial<AppSettings>;
      this.settings = {
        ...defaultSettings,
        ...parsed,
        externalEditors: {
          ...createDefaultExternalEditorSettings(),
          ...(parsed.externalEditors ?? {}),
        },
      };
      const migratedBuiltIns = migrateBuiltInExtensionDefaults(
        this.settings.removedBuiltInExtensions,
        parsed.builtInExtensionDefaultsVersion,
      );
      this.settings.removedBuiltInExtensions = migratedBuiltIns.removedBuiltInExtensions;
      this.settings.builtInExtensionDefaultsVersion = migratedBuiltIns.version;
      migratedBuiltInExtensionDefaults = migratedBuiltIns.migrated;
      const migratedGitCommitMessagePrompt = this.applyLocalizedDefaultGitCommitMessagePrompt(parsed);
      // 兼容迁移：内置 CommitMono 字体已移除（打包瘦身），旧设置里的 "commit-mono"
      // 不再存在于 AppFontMonoMode 枚举，统一回退到系统等宽字体，避免类型漂移。
      // 注意：磁盘 JSON 是无类型的，旧值可能是已删除的枚举项，先拓宽为 string 再比较。
      const persistedMonoFont: string = this.settings.fontFamilyMono;
      if (persistedMonoFont === "commit-mono") {
        this.settings.fontFamilyMono = "system-mono";
      }
      // 兼容迁移：旧版 contentMaxWidth(px) → chatContentWidthPct(%)。
      // 语义从「最大宽度 px」变为「占面板百分比」，无法精确换算（面板宽度可变），
      // 用线性映射保留旧值感觉：800→60%、1400→84%、1800(不限)→100%。
      this.migrateContentWidth();
      if (
        hadLegacyTelemetry ||
        hadLegacyLinkOpenMode ||
        hadLegacyElectronChromiumSandbox ||
        migratedGitCommitMessagePrompt ||
        migratedBuiltInExtensionDefaults
      ) {
        void this.save().catch(() => undefined);
      }
    } catch {
      this.settings = { ...defaultSettings };
      this.applyLocalizedDefaultGitCommitMessagePrompt({});
    }
    // showThinking 不再作为可持久化的独立配置项，完全跟随 pi agent 的 hideThinkingBlock。
    // 启动时重新读取以确保每次启动都使用最新值，而非缓存的 defaultSettings。
    const computedShowThinking = readPiAgentShowThinking(this.piAgentSettingsFile);
    this.settings.showThinking = computedShowThinking ?? true;
    // 每次启动都校准安装类型：Windows 便携版由 electron-builder 注入运行时环境变量,
    // 该信号比旧 settings 更可信,可修正用户从安装版/旧版本迁移后残留的 installed 记录。
    await this.detectAndSaveInstallationType();
    return this.get();
  }

  /**
   * Keep the built-in commit prompt aligned with the UI language while preserving custom templates.
   * Older settings files contain the Chinese built-in prompt, so it is migrated only when the
   * persisted value is empty or still exactly one of the two built-in defaults.
   */
  private applyLocalizedDefaultGitCommitMessagePrompt(parsed: Partial<AppSettings>): boolean {
    const persistedPrompt = parsed.gitCommitMessagePrompt;
    if (typeof persistedPrompt === "string" && !isDefaultGitCommitMessagePrompt(persistedPrompt)) {
      return false;
    }

    const localizedPrompt = getDefaultGitCommitMessagePrompt(
      resolveGitCommitMessagePromptLocale(this.settings.language, this.getSystemLocale()),
    );
    if (this.settings.gitCommitMessagePrompt === localizedPrompt) return false;
    this.settings.gitCommitMessagePrompt = localizedPrompt;
    return true;
  }

  /**
   * 旧版 contentMaxWidth(px) → chatContentWidthPct(%) 迁移：
   * - 新字段已存在（已迁移/用户已设置）→ 不动作；
   * - 否则按旧 px 线性映射到 60–100%（1800=不限→100%，800→60%），写回持久化。
   */
  private migrateContentWidth() {
    const pct = this.settings.chatContentWidthPct;
    if (typeof pct === "number" && Number.isFinite(pct)) return;
    const legacyPx = this.settings.contentMaxWidth;
    let mapped = 100;
    if (typeof legacyPx === "number" && legacyPx > 0 && legacyPx < 1800) {
      // 线性映射：px∈[800,1800) → pct∈[60,100)，其余（≤0 或 ≥1800=不限）→ 100
      mapped = Math.min(100, Math.max(60, Math.round(((legacyPx - 800) / 1000) * 40 + 60)));
    }
    this.settings.chatContentWidthPct = mapped;
    void this.save().catch(() => undefined);
  }

  get() {
    // showThinking 由 pi agent 的 hideThinkingBlock 动态决定，每次 get() 都重新读取
    const computed = readPiAgentShowThinking(this.piAgentSettingsFile);
    return { ...this.settings, showThinking: computed ?? true };
  }

  async update(patch: Partial<AppSettings>) {
    // showThinking 完全由 pi agent 的 hideThinkingBlock 控制，不允许通过桌面设置修改
    const { showThinking: _, ...safePatch } = patch;
    const languageChanged = Object.hasOwn(safePatch, "language");
    const promptWasDefault = isDefaultGitCommitMessagePrompt(this.settings.gitCommitMessagePrompt);
    const promptProvided = Object.hasOwn(safePatch, "gitCommitMessagePrompt");
    this.settings = { ...this.settings, ...safePatch };
    // 用户只切换语言且仍使用内置模板时，同步模板语言；自定义模板不随语言变化。
    if (languageChanged && !promptProvided && promptWasDefault) {
      this.settings.gitCommitMessagePrompt = getDefaultGitCommitMessagePrompt(
        resolveGitCommitMessagePromptLocale(this.settings.language, this.getSystemLocale()),
      );
    }
    await this.save();
    // 配置变更审计（统一在此留痕，覆盖 IPC 与 pet/extension/editors 等所有直写路径）：
    // 只记变更的 key 列表，不记值——避免 proxyUrl 等敏感内容落盘；值变更回查用 save 前的内存态
    void getAppLogger()?.info("settings", "Settings updated", { keys: Object.keys(safePatch) });
    return this.get();
  }

  /**
   * 检查 rpcTimeout 是否小于 600 秒（600000ms），若是则自动提升至 600 秒。
   * 在应用启动后异步执行，避免用户配置的过小超时导致 RPC 调用频繁超时。
   */
  async ensureRpcTimeoutMinimum() {
    if (this.settings.rpcTimeout < 600_000) {
      await this.update({ rpcTimeout: 600_000 });
    }
  }

  private async save() {
    await mkdir(dirname(this.filePath), { recursive: true });
    // showThinking 由 pi agent 的 hideThinkingBlock 决定，不持久化到桌面 settings.json
    const { showThinking: _unused, ...persistable } = this.settings;
    await writeFile(this.filePath, JSON.stringify(persistable, null, 2), "utf8");
  }

  /**
   * 检测并保存安装类型。
   * 
   * Windows:
   *   - PORTABLE_EXECUTABLE_DIR 存在 → portable（便携版 .exe）
   *   - 否则 → installed（NSIS 安装版或其他）
   * 
   * macOS/Linux:
   *   - 由于 electron-builder 不为 dmg/AppImage 等设置特殊环境变量，
   *     且解压后的应用无法判断原始分发格式，统一标记为 installed。
   *   - 用户从 ZIP 手动解压的情况无法区分，视为已安装。
   * 
   * Windows 便携版的环境变量是运行时事实,必须允许覆盖旧的持久化值；
   * 否则用户曾经被记录为 installed 后,便携版会一直推荐安装版更新包。
   */
  private async detectAndSaveInstallationType() {
    let installationType: "portable" | "installed";

    // Windows: electron-builder portable 目标会在运行时注入 PORTABLE_EXECUTABLE_DIR。
    if (process.platform === "win32") {
      const isPortable = process.env.PORTABLE_EXECUTABLE_DIR !== undefined;
      installationType = isPortable ? "portable" : "installed";
    } else {
      // macOS 和 Linux: electron-builder 不提供统一环境变量区分原始分发格式。
      installationType = "installed";
    }

    if (this.settings.installationType === installationType) return;

    this.settings.installationType = installationType;
    await this.save();
  }
}
