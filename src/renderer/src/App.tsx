import {
  lazy,
  Suspense,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useCallback,
} from "react";
import { useAtomValue, useSetAtom, useStore } from "jotai";
import { APP_RELEASES_URL } from "../../shared/appIdentity";
import { SKIN_PRESETS } from "./themePresets";
import { resolveChatTypographyVars } from "./lib/chatTypography";
// 壁纸模式已注入的 token 键（effect 重跑/清除设置时需要跨运行保留，避免漏清）
let injectedWallpaperTokens = new Set<string>();
import {
  Code,
  FolderOpen,
  Pencil,
  SquarePen,
  Terminal,
  GitBranch,
  Sparkles,
} from "lucide-react";
import { showNotice } from "./utils/notice";
import {
  desktopApi as api,
  isLanWeb,
  missingElectronPreload,
} from "./desktopApi";
import { contextControllerSettingsAtom, turnFlowSettingsAtom } from "./atoms/app-ui-atoms";
// 文件链接路由：图片类型走弹窗预览
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "avif", "bmp", "ico"]);
const ConfigModal = lazy(() => import("./ConfigModal").then((m) => ({ default: m.ConfigModal })));
import { type SidebarActions } from "./components/sidebar/SidebarContent";
import { AppSidebar } from "./components/sidebar/AppSidebar";
import { AppBootstrap } from "./components/app/AppBootstrap";
import { SettingsFeatureRoot } from "./components/app/SettingsFeatureRoot";
import { useRename } from "./hooks/useRename";
import { useProjectRuntimeCapabilities } from "./hooks/useRuntimeCapabilities";
import { useSessionRuntimeBridge } from "./hooks/useSessionRuntimeBridge";
import { useAgentLoadNotice } from "./hooks/useAgentLoadNotice";
import { useSessionLayout } from "./hooks/useSessionLayout";
import { useFileEditor , resolveFileLinkPath } from "./hooks/useFileEditor";
import { useOverlayActions } from "./hooks/useOverlayActions";
import { useWorkspacePanels, type WorkspaceDrawerPanel, type WorkspaceExternalEditorAdapter } from "./hooks/useWorkspacePanels";
import { useDrawerPorts } from "./hooks/useDrawerPorts";
import { useTerminalDock } from "./hooks/useTerminalDock";
import { resolveTerminalOwner, terminalOwnerKey } from "./terminalDockState";
import { useImportFlow } from "./hooks/useImportFlow";
import { useQueuedPrompt } from "./hooks/useQueuedPrompt";
import { activeAgentIdAtom } from "./hooks/useSessionRuntimeController";
import { PromptDeliveryUnknownError } from "./utils/promptErrors";
import {
  requireSessionCommand,
  toSessionRuntimeTarget,
} from "./utils/sessionCommands";
import { resolveChatSessionBootstrap } from "./utils/chatSessionBootstrap";
import { detectRendererPlatform } from "./lib/detectRendererPlatform";
import { backgroundImageUrl } from "./utils/backgroundImageUrl";
import { applyRendererZoom } from "./native/rendererZoom";

import { usePiUpdate } from "./hooks/usePiUpdate";
import { useAppUpdateController } from "./hooks/useAppUpdateController";
import { useProjectSync } from "./hooks/useProjectSync";
import { useProjectCommands } from "./hooks/useProjectCommands";
import { useSessionMessageCommands } from "./hooks/useSessionMessageCommands";
import {
  captureHistoryMutationRefresh,
  refreshHistoryAfterMutation,
} from "./hooks/useSessionTimelineController";
import {
  agentInventoryAtom,
  applySessionRuntimeEventAtom,
  currentSessionAtom,
  currentSessionIdAtom,
  currentSessionRuntimeAtom,
  projectInventoryAtom,
  removeSessionComposerStateAtom,
  removeSessionStateAtom,
  replaceProjectInventoryAtom,
  replaceProjectSessionsAtom,
  sessionRecordByIdAtomFamily,
  sessionRecordsByProjectIdAtomFamily,
  sessionIdByRuntimeAgentIdAtomFamily,
  sessionRuntimeBySessionIdAtomFamily,
  sidebarExpandedProjectIdsAtom,
  sessionCatalogLoadStateAtom,
  sessionSummariesByProjectIdAtomFamily,
  sessionDraftByIdAtom,
  setSessionAttachmentsAtom,
  setSessionCatalogLoadStateAtom,
  setSessionDraftAtom,
  upsertSessionAtom,
  anyAgentRuntimeWorkingAtom,
} from "./atoms";
import {
  buildComposerPromptSubmission,
} from "./composerBehavior";
import {
  getDefaultGitCommitMessagePrompt,
  resolveGitCommitMessagePromptLocale,
} from "../../shared/gitCommitMessagePrompt";
import {
  isSameSessionPath,
} from "./agentListDisplay";
import { resolveLocale, setI18nLocale, t, translateI18nDescriptor } from "./i18n";
import {
  isChatProject,
  loadSessionSourceFilter,
  saveSessionSourceFilter,
  isReplacementForPendingAgent,
  isPendingAgentId,
  migrateAgentRecord,
  type PendingAgentTab,
} from "./rendererUtils";
import { useResize } from "./hooks/useResize";
import { useSessionActions } from "./hooks/useSessionActions";
import { useScratchPad } from "./hooks/useScratchPad";
import { useWorktreeActions } from "./hooks/useWorktreeActions";
import { ChatSessionPane } from "./components/session/ChatSessionPane";
import { OutlinePanel } from "./components/session/OutlinePanel";
import { SkillsQuickDialog } from "./components/session/SkillsQuickDialog";
import { SessionSplitStage } from "./components/session/SessionSplitStage";
import { canStopBoundAgent } from "./utils/canStopBoundAgent";
import { splitLayoutSessionIds } from "./utils/sessionSplitEdge";
import { SessionTabsBar } from "./components/session/SessionTabsBar";
import { SessionPaneServicesProvider } from "./components/session/SessionPaneServices";
import { ProjectEmptyState } from "./components/session/ProjectEmptyState";
import { useSessionWorkspaceChrome } from "./hooks/useSessionWorkspaceChrome";
import { ScratchPadOverlay } from "./components/overlays/ScratchPadOverlay";
import { AskPanelOverlay } from "./components/overlays/AskPanelOverlay";
import { SessionRuntimeDock } from "./components/session/SessionRuntimeDock";
import { AppShell } from "./components/app/AppShell";
import { WorkspaceDrawerRail } from "./components/workspace/WorkspaceDrawerRail";
import { DrawerSurface } from "./components/workspace/DrawerSurface";
import { WorkbenchStage } from "./components/workspace/WorkbenchStage";
import { WorkbenchContent } from "./components/workspace/WorkbenchContent";
import { RenameModals } from "./components/RenameModals";
import { SessionActionOverlays } from "./components/overlays/SessionActionOverlays";
import { AppUpdateOverlay } from "./components/overlays/AppUpdateOverlay";
import { ImportOverlayHost } from "./components/overlays/ImportOverlayHost";
import { EnvironmentOverlay } from "./components/overlays/EnvironmentOverlay";
import {
  EnvironmentDialog,
  FileContextMenu,
  ImagePreviewModal,
  LogoMark,
} from "./components/app/AppParts";
import { ExternalEditorOverlay } from "./components/workspace/ExternalEditorOverlay";
import {
  flattenFiles,
  mergeCommands,
} from "./components/app/AppUtils";
// ProjectResourcesModal 仅在打开资源弹层时加载
const ProjectResourcesModal = lazy(() => import("./components/app/ProjectResourcesModal").then((m) => ({ default: m.ProjectResourcesModal })));
import { createDefaultExternalEditorSettings } from "../../shared/types";
import type {
  AgentRuntimeState,
  AgentTab,
  AppFocusSessionTarget,
  AppInfo,
  AppSettings,
  FileTreeNode,
  ImageContent,
  PiCommand,
  Project,
  SessionLaunchPreferences,
  SessionRecord,
  SessionSummary,
  ComposerAgentMode,
  SessionRuntimeTarget,
  TerminalTarget,
} from "../../shared/types";

export function App() {
  if (missingElectronPreload) {
    return (
      <div className="boot-screen root-loading">
        {/* 与 EmptyState / index.html 启动标同一 path，避免 LogoMark 再套一层不同底色 */}
        <div className="boot-logo root-loading-logo" aria-hidden="true">
          <svg viewBox="140 140 520 520" width="48" height="48">
            <defs>
              <linearGradient id="root-loading-logo-silver" x1="0.2" y1="0" x2="0.8" y2="1">
                <stop stopColor="#ffffff" />
                <stop offset="0.5" stopColor="#f4f4f5" />
                <stop offset="1" stopColor="#a7a8ab" />
              </linearGradient>
            </defs>
            <path
              fill="url(#root-loading-logo-silver)"
              fillRule="evenodd"
              d="M165.29 165.29H517.36V400H400V517.36H282.65V634.72H165.29ZM282.65 282.65V400H400V282.65Z"
            />
            <path fill="url(#root-loading-logo-silver)" d="M517.36 400H634.72V634.72H517.36Z" />
          </svg>
        </div>
        <strong>PiDeck-Q</strong>
        <span>{t("app.preloadMissing")}</span>
      </div>
    );
  }

  const store = useStore();
  // Composer input state is owned by ComposerArea; the root does not subscribe to each key.
  const currentSessionId = useAtomValue(currentSessionIdAtom);
  const currentSession = useAtomValue(currentSessionAtom);
  // currentSessionRuntime / currentSessionRuntimeUi / currentSessionSendState: sync store.get() only.
  // Streaming subscriptions are in SessionRuntimeInjector.
  // Timeline 由各 ChatSessionPane 自持；大纲/修改文件下沉到叶子（OutlinePanel/useFileEditor），
  // App 不再直订 currentSessionMessagesAtom：canonical 消息缓存只在消息边界
  // （message_start 空骨架 / message_end，主进程 50ms 节流 flush）变引用；逐 token 的流式
  // 正文走独立 text-stream 通道直接落到叶子 AnswerOutput，不经过 App 根组件。
  const projects = useAtomValue(projectInventoryAtom);
  const agents = useAtomValue(agentInventoryAtom);
  const setCurrentSessionId = useSetAtom(currentSessionIdAtom);
  const replaceProjectSessions = useSetAtom(replaceProjectSessionsAtom);
  const setProjects = useSetAtom(replaceProjectInventoryAtom);
  const applyRuntimeEvent = useSetAtom(applySessionRuntimeEventAtom);
  const upsertSession = useSetAtom(upsertSessionAtom);
  const setSessionDraft = useSetAtom(setSessionDraftAtom);
  const setSessionAttachments = useSetAtom(setSessionAttachmentsAtom);
  const setSessionCatalogLoadState = useSetAtom(setSessionCatalogLoadStateAtom);
  const removeSessionState = useSetAtom(removeSessionStateAtom);
  const removeSessionComposerState = useSetAtom(removeSessionComposerStateAtom);
  const currentSessionIdRef = useRef<string | undefined>(currentSessionId);
  currentSessionIdRef.current = currentSessionId;
  const openSessionRequestRef = useRef(0);
  const creatingSessionDraftRef = useRef<Set<string>>(new Set());

  // 项目的 git worktree 列表：{ parentId -> WorktreeEntry[] }
  const [pendingAgents, setPendingAgents] = useState<PendingAgentTab[]>([]);
  /** 侧栏 π logo 重播令牌：agent 启动（含历史会话）/关闭时递增，驱动 BrandLockup 动画 */
  const [brandLogoReplayToken, setBrandLogoReplayToken] = useState(0);
  const [activeProjectId, setActiveProjectId] = useState<string>();
  const activeProjectIdRef = useRef<string | undefined>(activeProjectId);
  activeProjectIdRef.current = activeProjectId;
  const activeAgentId = useAtomValue(activeAgentIdAtom);
  // 切换 agent（新会话/恢复会话）时刷新设置，使 pi agent 的 hideThinkingBlock 立即生效
  useEffect(() => {
    if (activeAgentId) {
      void api.settings.get().then(setSettings).catch(() => undefined);
    }
  }, [activeAgentId]);
  const activeAgentIdRef = useRef<string | undefined>(activeAgentId);
  activeAgentIdRef.current = activeAgentId;
  const agentsRef = useRef<AgentTab[]>(agents);
  agentsRef.current = agents;
  const expandedProjects = useAtomValue(sidebarExpandedProjectIdsAtom);

  const [commands, setCommands] = useState<PiCommand[]>([]);
  const [promptTemplateList] = useState<
    Array<{ name: string; path: string; description: string; content: string; argumentHint?: string }>
  >([]);
  const jumpToMessageRef = useRef<((messageId: string) => void) | null>(null);
  // TECH DEBT (Phase 3): promptByAgent / attachedImagesByAgent legacy mirrors removed.
  // All drafts/attachments go through Session atoms (setSessionDraft / setSessionAttachments).

  // contentEditable 的实时值通过 livePromptByAgentRef 保持最新，发送路径始终从这里读取草稿。
  const livePromptByAgentRef = useRef<Record<string, string>>({});

  /** 当前正在重启的 Agent，用于仅给对应会话显示 loading，避免切到其他 Agent 后仍被全局禁用。 */
  const [restartingAgentId, setRestartingAgentId] = useState<string | null>(null);
  const [previewImage, setPreviewImage] = useState<ImageContent | null>(null);

  // composerAgentModes legacy mirror removed — mode restore uses Session atom in useQueuedPrompt.
  /** 客户端队列按 agent 记录 flush 锁，避免 tool-end 与 idle 并发投递。 */
  const queueFlushBySessionRef = useRef<Set<string>>(new Set());

  /** & 会话引用选择缓存：key = chip raw（如 "&My Session"），value = 选中的消息列表 */
  const [sessionRefSelections, setSessionRefSelections] = useState<
    Record<string, { messages: Array<{ role: string; content: string }>; fullContext: boolean; selectedIndices: number[] }>
  >({});

  /** 每个 agent 最后一次会话的开始时间(status 变为 running 时记录),用 ref 避免 effect 闭包陈旧 */
  const sessionStartByAgentRef = useRef<Record<string, number>>({});
  /** 每个 agent 最后一次会话的总时长(ms),仅在会话结束后更新 */
  const [sessionDurationByAgent, setSessionDurationByAgent] = useState<
    Record<string, number>
  >({});
  // 会话区不再维护独立的“修改文件摘要”卡片；diff 入口贴在 edit/write 工具调用处，
  // 避免会话输入框上方摘要与 Git 工作区状态/历史会话恢复互相干扰。
  const agentStatusByAgentRef = useRef<Record<string, AgentTab["status"]>>({});

  // 记录 composer 光标位置,用于光标相关的 @ / 触发检测与建议项替换。
  const [fileMenu, setFileMenu] = useState<{
    x: number;
    y: number;
    node: FileTreeNode;
  } | null>(null);
  /** 右键打开文件菜单时检查剪贴板是否有文件路径，决定是否显示「粘贴」项 */
  const [hasClipboardFiles, setHasClipboardFiles] = useState(false);
  const [renamingFile, setRenamingFile] = useState<{
    path: string;
    name: string;
  } | null>(null);
  const [renamingFileInput, setRenamingFileInput] = useState("");
  /** 历史会话来源过滤（按项目）：undefined=显示全部，Record 含项目ID对应 Set */
  const [sessionSourceFilter] = useState<
  	Record<string, Set<"pi" | "codex" | "claude" | "opencode"> | null>
  >(() => loadSessionSourceFilter());
  /** 编辑器展示模式：弹框或侧栏 */
  // showToast 经 showNotice → sonner 全局 toast（#115）
  // 历史命令：按 agent 隔离，agent 关闭即清除（不持久化）
  const promptHistoryRef = useRef<Record<string, string[]>>({});

  // Drawer state delegated to useWorkspacePanels.
  // 外部编辑器适配器：将 desktopApi 包装为 WorkspaceExternalEditorAdapter，
  // 供 useWorkspacePanels 的 loadExternalEditors / openProjectInExternalEditor 使用。
  const editorsAdapter = useMemo<WorkspaceExternalEditorAdapter>(() => ({
    list: () => api.editors.list(),
    openProject: (editor, projectPath) => api.editors.openProject(editor, projectPath),
  }), []);
  const workspace = useWorkspacePanels({ projectId: activeProjectId, editors: editorsAdapter });
  const drawer = workspace.drawer;
  const drawerCollapsed = workspace.drawerCollapsed;
  // 右侧栏总开关：已打开则关闭，否则打开 files（默认关闭，手动打开）
  const toggleRightDrawer = useCallback(() => {
    if (workspace.drawer) {
      workspace.closeDrawer();
      return;
    }
    workspace.openDrawer("files");
  }, [workspace]);
  const externalEditors = workspace.externalEditors;
  const editorsOpen = workspace.externalEditorsOpen;
  const editorsAnchor = workspace.externalEditorsAnchor;
  const editorsTargetPath = workspace.externalEditorsTargetPath;
  // Adapters for useFileEditor (expects setDrawer/setDrawerCollapsed).
  const setDrawer = useCallback((panel: WorkspaceDrawerPanel | null) => {
    // Open guard for git is handled by the enableGitManagement effect below.
    if (panel) workspace.openDrawer(panel);
    else workspace.closeDrawer();
  }, [workspace.openDrawer, workspace.closeDrawer]);
  const setDrawerCollapsed = useCallback((collapsed: boolean) => {
    if (collapsed) workspace.collapseDrawer();
    else workspace.expandDrawer();
  }, [workspace.collapseDrawer, workspace.expandDrawer]);
  const saveExpandedDirs = useCallback((projectId: string, dirs: Set<string>) => {
    try {
      localStorage.setItem(PROJECT_EXPANDED_DIRS_KEY_PREFIX + projectId, JSON.stringify([...dirs]));
    } catch { /* ignore */ }
  }, []);

  const loadExpandedDirs = useCallback((projectId: string): Set<string> => {
    try {
      const key = PROJECT_EXPANDED_DIRS_KEY_PREFIX + projectId;
      let raw = localStorage.getItem(key);
      if (!raw) {
        const legacyAgents = agentsRef.current.filter((a) => a.projectId === projectId).map((a) => a.id);
        for (const agentId of legacyAgents) {
          const oldKey = `pid:agent-expanded-dirs:${agentId}`;
          const value = localStorage.getItem(oldKey);
          if (value) {
            if (!localStorage.getItem(key)) localStorage.setItem(key, value);
            localStorage.removeItem(oldKey);
            raw = value;
            break;
          }
        }
      }
      if (raw) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) return new Set(arr);
      }
    } catch { /* ignore */ }
    return new Set();
  }, []);
  /** 打开文件编辑器前所在的抽屉面板，供返回按钮恢复 */
  const [sessionsProjectId, setSessionsProjectId] = useState<string>();
  const [projectResourcesProject, setProjectResourcesProject] = useState<Project | null>(null);
  const sessions = useAtomValue(
    sessionSummariesByProjectIdAtomFamily(sessionsProjectId ?? ""),
  );

  // ===== 项目同步 hook (H3) =====
  const {
    worktreesByProject,
    branchByProject,
    files,
    gitInfo,
    setGitInfo,
    setProjectBranch,
    setSessionLoadingByProject,
    setVisibleProjectChildCountByProject,
    refreshProjects,
    refreshWorktrees,
    refreshProjectSessions,
    refreshFiles,
    refreshGitInfo,
    refreshProjectTree,
  } = useProjectSync({
    projects,
    activeProjectId,
    setProjects,
    setActiveProjectId,
    replaceProjectSessions,
    api: {
      projects: { list: api.projects.list },
      git: { worktreeList: api.git.worktreeList, branches: api.git.branches },
      sessions: {
        listCatalog: api.sessions.listCatalog,
        onCatalogRefreshed: api.sessions.onCatalogRefreshed,
      },
      files: { list: api.files.list },
    },
    showToast,
    setSessionCatalogLoadState,
    t,
  });

  // 回答结束后的会话列表后台静默刷新：500ms 尾沿去抖。
  // 多个 Agent 同时结束回答时只扫描一次，避免重复 IPC 与列表抖动。
  const answerEndRefreshTimerRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const scheduleAnswerEndRefresh = useCallback((projectId: string) => {
    const existing = answerEndRefreshTimerRef.current[projectId];
    if (existing) clearTimeout(existing);
    answerEndRefreshTimerRef.current[projectId] = setTimeout(() => {
      delete answerEndRefreshTimerRef.current[projectId];
      void refreshProjectSessions(projectId, true).catch(() => undefined);
    }, 500);
  }, [refreshProjectSessions]);

  // === import flow hook ===
  const {
    codexImportProject,
    setCodexImportProject,
    claudeImportProject,
    setClaudeImportProject,
    openCodeImportProject,
    setOpenCodeImportProject,
    codexImportController,
    claudeImportController,
    openCodeImportController,
    openCodexImport,
    openClaudeImport,
    openOpenCodeImport,
  } = useImportFlow({
    setProjectMenu: () => undefined,
    refreshProjectSessions,
    showToast,
    scanCodexSessions: api.codexSessions.scan,
    importCodexSessionsApi: api.codexSessions.import,
    scanClaudeSessions: api.claudeSessions.scan,
    importClaudeSessionsApi: api.claudeSessions.import,
    scanOpenCodeSessions: api.openCodeSessions.scan,
    importOpenCodeSessionsApi: api.openCodeSessions.import,
    t,
  });

  const rename = useRename({
    renameAgent: async (id, name) => {
      const agent = agentsRef.current.find((candidate) => candidate.id === id);
      const sessionId = store.get(sessionIdByRuntimeAgentIdAtomFamily(id));
      if (!agent || !sessionId) throw new Error("Session runtime is not bound");
      const updated = await api.sessions.updateRecord(sessionId, { title: name });
      upsertSession(updated);
      return { ...agent, title: updated.title };
    },
    renameSession: (id, name) => api.sessions.updateRecord(id, { title: name }),
    showToast,
    refreshProjectSessions,
    closeAgentMenu: () => undefined,
  });

  const getProjectSessionRecords = (projectId: string) =>
    store.get(sessionRecordsByProjectIdAtomFamily(projectId));
  const getSessionRecord = (sessionId: string) =>
    store.get(sessionRecordByIdAtomFamily(sessionId));
  const getRuntimeTargetForSession = (sessionId: string | undefined) =>
    sessionId
      ? toSessionRuntimeTarget(sessionId, store.get(sessionRuntimeBySessionIdAtomFamily(sessionId)))
      : undefined;
  const getRuntimeTargetForAgent = (agentId: string | undefined) => {
    if (!agentId) return undefined;
    const sessionId = store.get(sessionIdByRuntimeAgentIdAtomFamily(agentId));
    return getRuntimeTargetForSession(sessionId);
  };
  const [sessionHistoryLoading, setSessionHistoryLoading] = useState(false);
  const appUpdate = useAppUpdateController({
    checkUpdate: api.app.checkUpdate,
    downloadUpdate: (asset) => api.app.downloadUpdate(asset),
    installUpdate: (filePath) => api.app.installUpdate(filePath),
    onUpdateProgress: (cb) => api.app.onUpdateProgress(cb),
    openExternal: (url) => api.app.openExternal(url),
  }, false);

  // upToDateVersion: hook does not expose this; used by AppUpdateOverlay for "up to date" toast.
  const [upToDateVersion, setUpToDateVersion] = useState<string | null>(null);
  const [configOpen, setConfigOpen] = useState(false);

  const PROJECT_EXPANDED_DIRS_KEY_PREFIX = "pid:project-expanded-dirs:";

  // localStorage 只负责首屏；展开项目的权威设置必须等首次 settings.get 返回后才参与迁移。
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [expandedProjectsReady, setExpandedProjectsReady] = useState(false);
  const [settings, setSettings] = useState<AppSettings>({
    useNativeTitleBar: true,
    showNativeMenu: false,
    sendShortcut: "enter-send",
    theme: "system",
    accent: "default",
	themeSkin: "classic-green",
	customThemeOverrides: {},
	backgroundImage: "",
	backgroundImageOpacity: 0.8,
    language: "system",
    startupWindowMode: "last",
    piEnvironmentChecked: false,
    piRuntimePreference: "auto",
    piTypescriptPath: "",
    piRustPath: "",
    sessionTabOpenMode: "preview",
    enableGitManagement: true,
    gitCommitMessagePrompt: getDefaultGitCommitMessagePrompt(
      resolveGitCommitMessagePromptLocale(resolveLocale("system")),
    ),
    gitCommitMessageProvider: "",
    gitCommitMessageModel: "",
    closeToTray: true,
    singleInstance: true,
    enableNotifications: true,
    // 人文关怀提醒默认开启：与主进程 SettingsStore 默认一致，首屏未拉到真实设置前不关闭提醒
    agentCountReminderEnabled: true,
    // showThinking 由 pi agent 的 hideThinkingBlock 控制，启动后从主进程加载的真实值会覆盖此处
    showThinking: true,
    // 流式对话行为：默认不自动展开中间过程；新一轮默认收起非最新轮（与 SettingsStore 一致）
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
    chatContentWidthPct: 80,
    maxEditorFileSizeMB: 5,
    externalEditors: createDefaultExternalEditorSettings(),
    favoriteModels: [],

    // 字体配置：与 main SettingsStore 默认值保持一致，避免启动时闪烁
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
    removedBuiltInExtensions: ["pideck-q-better-compaction.ts"],
    hiddenBuiltinPromptNames: [],
    disableUpdateCheck: false,
    piRpcOffline: true,
    piRpcNoExtensions: false,
    piRpcNoSkills: false,
  });

  // 流式对话行为设置同步给 turn 组件（TurnRow 直接订阅 atom，避免 5 层 props 透传；
  // 设置变化低频，全局订阅成本可忽略）。
  const setTurnFlowSettings = useSetAtom(turnFlowSettingsAtom);
  useEffect(() => {
    setTurnFlowSettings({
      expandInterimDuringStream: settings.expandInterimDuringStream,
      collapsePrevRunsOnNewTurn: settings.collapsePrevRunsOnNewTurn,
    });
  }, [
    settings.expandInterimDuringStream,
    settings.collapsePrevRunsOnNewTurn,
    setTurnFlowSettings,
  ]);

  const setContextControllerSettings = useSetAtom(contextControllerSettingsAtom);
  useEffect(() => {
    setContextControllerSettings({
      piRpcNoExtensions: Boolean(settings.piRpcNoExtensions),
      removedBuiltInExtensions: settings.removedBuiltInExtensions ?? [],
    });
  }, [
    settings.piRpcNoExtensions,
    settings.removedBuiltInExtensions,
    setContextControllerSettings,
  ]);

  // Guard: hide git drawer when git management is disabled.
  // Equivalent to: if (panel === "git" && !settings.enableGitManagement) return
  // Pinned cleanup (filter(([, panel]) => panel !== "git")) is handled inside useWorkspacePanels.
  useEffect(() => {
    if (settings.enableGitManagement) return;
    // setDrawer((current) => current === "git" ? null : current)
    if (drawer === "git") workspace.closeDrawer();
  }, [settings.enableGitManagement, drawer, workspace.closeDrawer]);

  /* settingsNotice 已改用 showToast（sonner）实现 */
  const [webServiceChanging, setWebServiceChanging] = useState(false);
  const [appInfo, setAppInfo] = useState<AppInfo>({
    version: "-",
    releasesUrl: APP_RELEASES_URL,
    // 同步判定，避免 Mac 首帧在 appInfo IPC 返回前误画 Win 窗口按钮
    platform: detectRendererPlatform(),
    homeDir: "",
  });
  const [systemLanguage, setSystemLanguage] = useState<string | null>(null);
  const resolvedLocale = resolveLocale(settings.language, systemLanguage ?? undefined);
  setI18nLocale(resolvedLocale);

  // ===== Pi 更新/安装/代理 hook (H1) =====
  const piUpdate = usePiUpdate({
    settings,
    setSettings,
    showToast,
    api,
  });
  const { piStatus, piChecking, environmentDialog, setPiStatus, setEnvironmentDialog } = piUpdate;
  // 抽屉宽度状态由 useWorkspacePanels 统一管理（全局 localStorage 持久化，键 pid:drawer-width），
  // AppShell 拖拽提交经 setDrawerWidth 回写；此处不再持有独立 useState，避免双份状态漂移。
  const drawerWidth = workspace.drawerWidth;
  const setDrawerWidth = workspace.setDrawerWidth;
  const [composerOffsetHeight, setComposerOffsetHeight] = useState(0);
  // 终端归属：有 activeAgent → agent owner；引导页/未激活 agent/历史会话 → project owner。
  // 终端 open/collapsed/高度/PTY 实例都按 owner 隔离，切换项目或 agent 绝不串台。
  const terminalOwner = resolveTerminalOwner(activeAgentId, activeProjectId);
  const {
    terminalOpen,
    terminalCollapsed,
    terminalDockVisible,
    terminalDockClosing,
    terminalRowHeight: activeTerminalHeight,
    setTerminalOpenForOwner,
    setTerminalCollapsedForOwner,
    setTerminalHeightByOwner,
    prune: pruneTerminalDockState,
  } = useTerminalDock(terminalOwner);
  // 终端 IPC 目标：agent owner → 当前会话的 runtime target（须绑定已启动 Agent）；
  // project owner（引导页/未激活 agent/历史会话）→ 项目 cwd，主进程按 cwd 隔离 PTY。
  // Chat 项目没有可落地的 cwd，不提供项目终端。
  const terminalTarget: TerminalTarget | undefined = useMemo(() => {
    if (!terminalOwner) return undefined;
    if (terminalOwner.kind === "agent") {
      const runtimeTarget = getRuntimeTargetForSession(currentSessionId);
      return runtimeTarget ? { kind: "agent", ...runtimeTarget } : undefined;
    }
    const project = projects.find((p) => p.id === terminalOwner.id);
    if (!project || isChatProject(project)) return undefined;
    return { kind: "project", projectId: project.id, cwd: project.path };
  }, [terminalOwner, currentSessionId, projects]);
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());
  const [expandedSidebarProjects, setExpandedSidebarProjects] = useState<Set<string>>(new Set());
  const expandedSidebarProjectsRef = useRef(expandedSidebarProjects);
  expandedSidebarProjectsRef.current = expandedSidebarProjects;
  const expandedSidebarFromSettingsRef = useRef(false);
  function saveExpandedSidebarProjectsToLocal(next: Set<string>) {
    try {
      localStorage.setItem("pidek.sidebarExpandedProjectIds", JSON.stringify([...next]));
    } catch {
      // ignore
    }
  }
  const queuedTrackRef = useRef<HTMLDivElement | null>(null);

  const composerTextareaRef = useRef<HTMLDivElement | null>(null);
  // RichInput 受控重渲染后,光标应恢复到的纯文本偏移(供建议选中/清除后恢复选区)。
  const pendingComposerCaretRef = useRef<number | null>(null);
  const pendingAgentsRef = useRef<PendingAgentTab[]>([]);

  const scratchPad = useScratchPad();

  // Drawer loading handled by useWorkspacePanels; only expandedDirs logic remains.
  useEffect(() => {
    if (!activeProjectId) {
      setExpandedDirs(new Set());
      return;
    }
    const dirs = loadExpandedDirs(activeProjectId);
    setExpandedDirs(dirs);
  }, [activeProjectId, loadExpandedDirs]);

  const activeProjectRuntimeCapabilities = useProjectRuntimeCapabilities(activeProjectId);
  const activeProject = projects.find(
    (project) => project.id === activeProjectId,
  );
  const overlays = useOverlayActions();
  const sessionsProject = projects.find(
    (project) => project.id === sessionsProjectId,
  );
  const displayAgents = useMemo(() => {
    const realIds = new Set(agents.map((agent) => agent.id));
    return [
      ...agents,
      ...pendingAgents.filter(
        (agent) =>
          !realIds.has(agent.id) &&
          !agents.some((realAgent) =>
            isReplacementForPendingAgent(realAgent, agent),
          ),
      ),
    ];
  }, [agents, pendingAgents]);

  // === worktree actions hook ===
  const {
    worktreeCreating,
    removingWorktreePaths,
    createWorktree,
    removeWorktree,
    requestRemoveWorktree,
    toggleProjectWorktree,
  } = useWorktreeActions({
    projects,
    displayAgents,
    setProjects,
    refreshWorktrees,
    overlays,
  });

  // displayAgents 的 ref，供只挂载一次的 IPC 监听器读取最新 Agent 列表，避免闭包陈旧
  const displayAgentsRef = useRef(displayAgents);
  displayAgentsRef.current = displayAgents;
  // prompt history persistence lives in session composer controller (session-first).
  // 查看器已移除：activeAgent 直接从 displayAgents / pendingAgents 取，不再有伪 Agent。
  const activeAgent = activeAgentId
    ? [...displayAgents, ...pendingAgents].find((agent) => agent.id === activeAgentId)
    : undefined;

  // Timeline scroll, pagination and jump ownership lives in sessionTimeline.
  // Modern Session drafts and attachments are subscribed by ComposerArea; the root only
  // keeps the legacy queue adapter for agents that do not yet have a Session record.
  function setPromptForAgent(
    agentId: string,
    value: string | ((current: string) => string),
  ) {
    const targetAgentId = agentId;
    // previous 必须从 Session draft atom 读取（权威源）：输入框的编辑/删除都经 composer
    // setDraft 写入 atom，livePromptByAgentRef 只在 setPromptForAgent 内更新，若用它当
    // previous，「右键引用 → 删除 → 再右键引用」会把已删除的旧引用带回输入框。
    const previous = store.get(sessionDraftByIdAtom)[targetAgentId] ?? "";
    const nextValue = typeof value === "function" ? value(previous) : value;
    if (nextValue) livePromptByAgentRef.current[targetAgentId] = nextValue;
    else delete livePromptByAgentRef.current[targetAgentId];
    setSessionDraft({ sessionId: targetAgentId, value: nextValue });
  }


  function getComposerTargetId() {
    return currentSessionIdRef.current ?? activeAgentIdRef.current;
  }


  function setPrompt(value: string | ((current: string) => string)) {
    const targetId = getComposerTargetId();
    if (targetId) setPromptForAgent(targetId, value);
  }

  // Queue ownership extracted to useQueuedPrompt.
  const queue = useQueuedPrompt({
    displayAgentsRef,
    queueFlushBySessionRef,
    composerTextareaRef,
    pendingComposerCaretRef,
    store,
    setComposerCursor: (v: React.SetStateAction<number>) => { /* no-op: cursor managed by composer controller */ },
    showToast,
    unknownDeliveryMessage: t("app.queuedUnknown"),
    dispatchPromptSnapshot,
  });
  useSessionRuntimeBridge({
    onRuntimeCapabilityChanged: ({ sessionId, previous, current, patch }) => {
      if (
        previous?.isExecutingTool &&
        !current.isExecutingTool &&
        (patch.toolStateSequence == null ||
          previous.toolStateSequence == null ||
          patch.toolStateSequence >= previous.toolStateSequence) &&
        queue.isSessionRuntimeBusy(sessionId)
      ) {
        void queue.flushQueuedSteerPrompts(sessionId);
      }
      // 回答结束（流式停止）后后台静默刷新该会话所属项目的历史会话：
      // 子 Agent 会话由扩展直接写盘，只在回答结束时刷新能保证列表最新且无手动刷新成本。
      // refreshProjectSessions 内部会合并并发请求，多个 Agent 同时结束时不会重复扫描。
      if (previous?.isStreaming && !current.isStreaming) {
        const projectId = store.get(sessionRecordByIdAtomFamily(sessionId))?.projectId;
        if (projectId) {
          scheduleAnswerEndRefresh(projectId);
        }
      }
    },
  });
  // 激活 Agent 数量告警：受设置 agentCountReminderEnabled 控制（默认开启），每个启动周期提示一次
  useAgentLoadNotice(settings.agentCountReminderEnabled);
  const activeQueuedPrompts = currentSessionId
    ? (queue.queuedPrompts[currentSessionId] ?? [])
    : [];

  // ── Skills 快捷修改入口的全局安全门控 ──────────────────────────────
  // Skills 是全局 ~/.pi/agent/skills 与 ~/.agents/skills，门控必须全局判断：
  // anyAgentRuntimeWorkingAtom 覆盖任意项目任意 runtime 的 working 状态（含流式/执行工具），
  // 不能用 activeProjectHasBusyAgent（只覆盖当前项目）。
  const anyAgentRuntimeWorking = useAtomValue(anyAgentRuntimeWorkingAtom);
  // pending Agent（新建/重启）在真实 runtime 进入 sessionRuntimeByIdAtom 前也要算 working。
  const hasPendingWorkingAgent = pendingAgents.some(
    (agent) => agent.status === "starting" || agent.status === "running",
  );
  // 待发送队列是全局按 sessionId 保存的：Agent 刚变 idle 但已有 follow-up/steer 排队时，
  // 随后会自动继续工作，此时修改 Skills 会产生 race，也必须禁止。
  const hasQueuedAgentWork = Object.values(queue.queuedPrompts).some(
    (items) => items.length > 0,
  );
  // 关闭前的「有没有工作中的 Agent」单独计算：不能包含 skillsStoppingAgents 自身，
  // 否则 stop 过程中 handleSkillsQuickClose 的 busy 判断会永远为 true。
  const skillsRuntimeBusy =
    anyAgentRuntimeWorking ||
    hasPendingWorkingAgent ||
    hasQueuedAgentWork;
  // Skills 快捷修改期间（stop all 进行中）同样禁止重新打开弹窗/修改。
  const [skillsStoppingAgents, setSkillsStoppingAgents] = useState(false);
  const skillsQuickLocked = skillsRuntimeBusy || skillsStoppingAgents;

  const enqueueSessionPrompt = useCallback((
    sessionId: string,
    snapshot: { displayText: string; message: string; images?: ImageContent[]; agentMode: string; behavior?: "steer" | "followUp" },
  ) => {
    if (!store.get(sessionRuntimeBySessionIdAtomFamily(sessionId))?.agentId) return false;
    return queue.enqueueQueuedPrompt(sessionId, {
      id: crypto.randomUUID(),
      message: snapshot.message,
      displayText: snapshot.displayText,
      images: snapshot.images,
      behavior: snapshot.behavior ?? "steer",
      agentMode: snapshot.agentMode as ComposerAgentMode,
      timestamp: Date.now(),
    });
  }, [store, queue.enqueueQueuedPrompt]);

  /** 空会话快捷操作只负责填入当前 composer；用户仍可修改 prompt 后再点击发送。 */
  const insertQuickPrompt = useCallback((sessionId: string, message: string) => {
    setSessionDraft({ sessionId, value: message });
    requestAnimationFrame(() => {
      document.querySelector<HTMLElement>(".composer-box .rich-input")?.focus();
    });
  }, [setSessionDraft]);

  // activeConversationStatus / activeRuntimeState replaced by sync isAgentCurrentlyBusy().
  // The built-in Chat uses a renderer-only Session ID before its first send.
  // Workspace chrome belongs to that visible conversation surface, not only to
  // persisted catalog records; otherwise Chat loses the dev-equivalent toolbar.

  const activeProjectHasBusyAgent = Boolean(
    activeProjectId && displayAgents.some((agent) =>
      agent.projectId === activeProjectId && (
        agent.status === "starting" ||
        agent.status === "running" ||
        activeProjectRuntimeCapabilities[agent.id]?.isStreaming ||
        activeProjectRuntimeCapabilities[agent.id]?.isExecutingTool
      ),
    ),
  );
  const activeProjectSessionSyncKey = useMemo(() => {
    if (!activeProjectId) return "";
    return displayAgents
      .filter((agent) => agent.projectId === activeProjectId)
      .map((agent) => {
        const runtime = activeProjectRuntimeCapabilities[agent.id];
        return `${agent.id}:${agent.status}:${runtime?.isStreaming ? 1 : 0}:${runtime?.isExecutingTool ? 1 : 0}`;
      })
      .sort()
      .join("|");
  }, [activeProjectId, activeProjectRuntimeCapabilities, displayAgents]);


  // Runtime UI responses are generation-bound in SessionRuntimeUiOverlay.
  // Runtime notifications remain owned by useSessionRuntimeController.

  // Runtime editor text is applied by useSessionComposerController, which owns the draft guard.

  // Layout calculation delegated to useSessionLayout (refs + ResizeObserver + math).
  const sessionLayout = useSessionLayout({
    terminalRequestedHeight: activeTerminalHeight,
    terminalOpen,
    terminalClosing: terminalDockClosing,
    terminalCollapsed,
    queuedPromptCount: activeQueuedPrompts.length,
  });
  const {
    chatPaneRef: sessionChatPaneRef,
    headerRef: sessionHeaderRef,
    composerRef: sessionComposerRef,
    terminalRowHeight,
    availableTerminalHeight,
  } = sessionLayout;

  // Alias hook refs to the names App.tsx expects.
  const chatPaneRef = sessionChatPaneRef;
  const chatHeaderRef = sessionHeaderRef;
  const composerRef = sessionComposerRef;

  // Gate 4.5 — streaming signal / abort helpers
  const {
    listWidth,
    setListWidth,
    listCollapsed,
    setListCollapsed,
    toggleListCollapsed,
  } = useResize();
  useEffect(() => {
    document.documentElement.lang = resolvedLocale;
  }, [resolvedLocale]);

  useEffect(() => {
    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    const applyTheme = () => {
      const resolvedTheme =
        settings.theme === "system"
          ? media?.matches
            ? "dark"
            : "light"
          : settings.theme;
      document.documentElement.dataset.theme = resolvedTheme;
      // 主题色预设：data-accent 驱动 foundation.css 的 accent/logo 变量
      document.documentElement.dataset.accent = settings.accent;
      // 皮肤（换肤）：data-skin 记录当前皮肤 id（变量覆盖在下方 effect 注入）
      document.documentElement.dataset.skin = settings.themeSkin;
    };
    applyTheme();
    if (settings.theme !== "system" || !media) return;
    media.addEventListener?.("change", applyTheme);
    return () => media.removeEventListener?.("change", applyTheme);
    // 依赖 theme 与 accent：只改主题色时也必须重新应用 data-accent（否则界面不变）
  }, [settings.theme, settings.accent, settings.themeSkin]);

  // 皮肤 + 换肤背景图统一管理（原两个 effect 互相清除：皮肤 effect 清 token 时误清壁纸注入、
  // 背景 effect 的 else 分支又误清皮肤 bg 键——合并后顺序固定：先皮肤后壁纸覆盖）
  useEffect(() => {
    const root = document.documentElement;
    const isDark = root.dataset.theme === "dark";
    const BG_TOKENS = [
      "--color-bg-app",
      "--color-bg-sidebar",
      "--color-bg-panel",
      "--color-bg-input",
      "--color-bg-muted",
      "--color-bg-hover",
      "--color-bg-active",
      "--color-background",
      "--color-card",
      // Markdown/表格使用 chat 专属 token；未注入时会继续显示固定白色代码块。
      "--color-chat-card-bg",
      "--color-chat-muted-bg",
      "--color-chat-control-bg",
      "--color-chat-table-bg",
    ];

    // 1. 皮肤变量：先清所有皮肤预设可能触及的键，再应用当前皮肤（light/dark 色板）+ 自定义覆盖
    const skinKeys = new Set<string>();
    for (const p of SKIN_PRESETS) {
      Object.keys(p.light).forEach((k) => skinKeys.add(k));
      Object.keys(p.dark).forEach((k) => skinKeys.add(k));
    }
    Object.keys(settings.customThemeOverrides ?? {}).forEach((k) => skinKeys.add(k));
    for (const k of skinKeys) root.style.removeProperty(`--color-${k}`);
    // 内置 skin 选项已合并进 accent 外观主题；只保留 custom override 的兼容读取，
    // 避免用户同时面对两套互相叠加的背景/边框配置。
    const merged = {
      ...(settings.customThemeOverrides ?? {}),
    };
    for (const [k, v] of Object.entries(merged)) root.style.setProperty(`--color-${k}`, v);

    // 2. 换肤背景图：遮罩同色渐变（浅白/暗黑）+ 壁纸模式 token 半透明注入。
    //    存储语义=图片可见度（0=全遮，1=图全显）；滑块 80% → 遮罩 0.2 → 图 80% 透出。
    root.dataset.bgImage = settings.backgroundImage ? "on" : "off";
    if (settings.backgroundImage) {
      root.style.setProperty(
        "--app-bg-image",
        `url("${backgroundImageUrl(settings.backgroundImage)}")`,
      );
      const alpha = Math.min(1, Math.max(0, 1 - settings.backgroundImageOpacity));
      // 面板不透明度与遮罩同步并加 10% 基础偏移（面板更实一点，可读性更好）：
      // 滑块 80% → 面板 30%；100% → 10%（图完整显示）；0% → 100%（纯色）
      const panelMix = Math.min(100, Math.round(alpha * 100) + 10);
      const rgb = isDark ? "0,0,0" : "255,255,255";
      root.style.setProperty(
        "--app-bg-mask",
        `linear-gradient(rgba(${rgb},${alpha}), rgba(${rgb},${alpha}))`,
      );
      // 半透明 token：getComputedStyle 取当前计算值（含皮肤覆盖）→ 静态 color-mix，无循环引用。
      // 壁纸模式下所有面板统一用 --color-bg-app 作基色 + 同一个 panelMix，
      // 保证侧栏/会话区/抽屉透出的图片明暗完全一致
      const cs = getComputedStyle(root);
      const base = cs.getPropertyValue("--color-bg-app").trim();
      // 供弹窗覆盖规则使用：纯色基色 + 面板不透明度（弹窗 = 面板 + 10% 更实）
      if (base) root.style.setProperty("--wallpaper-base", base);
      root.style.setProperty("--wallpaper-panel-alpha", `${panelMix}%`);
      for (const k of BG_TOKENS) {
        const v = cs.getPropertyValue(k).trim();
        if (v) {
          root.style.setProperty(k, `color-mix(in srgb, ${base} ${panelMix}%, transparent)`);
          injectedWallpaperTokens.add(k);
        }
      }
      // Select/Dropdown/Popover 会 portal 到 body，不能继承 DialogContent 的局部变量。
      // 单独给浮层保留 92% 以上的底色，避免半透明面板 token 让菜单内容透出并误读为“透明坏了”。
      const floatingMix = Math.max(92, Math.min(100, panelMix + 40));
      root.style.setProperty(
        "--color-bg-popover",
        `color-mix(in srgb, ${base} ${floatingMix}%, transparent)`,
      );
      root.style.setProperty("--wallpaper-floating-alpha", `${floatingMix}%`);
      injectedWallpaperTokens.add("--color-bg-popover");
    } else {
      root.style.removeProperty("--app-bg-image");
      root.style.removeProperty("--app-bg-mask");
      // 只清本 effect 注入过的壁纸 token，绝不误清皮肤设置的 bg 键
      for (const k of injectedWallpaperTokens) root.style.removeProperty(k);
      injectedWallpaperTokens.clear();
      root.style.removeProperty("--wallpaper-base");
      root.style.removeProperty("--wallpaper-panel-alpha");
      root.style.removeProperty("--wallpaper-floating-alpha");
    }
  }, [settings.themeSkin, settings.theme, settings.customThemeOverrides, settings.backgroundImage, settings.backgroundImageOpacity]);

  // Native Qt/WebView and Electron both apply zoom in the renderer so the setting
  // keeps identical semantics without relying on webContents.setZoomFactor.
  useLayoutEffect(() => {
    applyRendererZoom(settings.zoomFactor);
  }, [settings.zoomFactor]);
  useEffect(() => api.settings.onApplyWindow((next) => {
    if (typeof next.zoomFactor === "number") applyRendererZoom(next.zoomFactor);
  }), [api.settings]);

  // 字号与命名字体预设由 data 属性选择 CSS token；只有 custom 字体需要注入用户输入。
  // 这一组是纯视觉的 DOM/CSS token 同步，必须用 useLayoutEffect 在 paint 前写入，
  // 否则 useEffect 在 paint 后执行会让首帧先使用 CSS 默认值再切到用户设置（如行距 1.35 → 1.2 收缩闪动）。
  useLayoutEffect(() => {
    const root = document.documentElement;
    const uiFontSize = settings.uiFontSize ?? settings.fontSize;
    const chatFontSize = settings.chatFontSize ?? settings.fontSize;
    const inputFontSize = settings.inputFontSize ?? settings.fontSize;
    root.dataset.uiFontSize = uiFontSize;
    root.dataset.chatFontSize = chatFontSize;
    root.dataset.inputFontSize = inputFontSize;
    root.dataset.chatBodyLineHeight = settings.chatBodyLineHeight;
    root.dataset.chatBlockGap = settings.chatBlockGap;
    root.dataset.chatListDensity = settings.chatListDensity;
    root.dataset.chatCodeDensity = settings.chatCodeDensity;
    for (const [name, value] of Object.entries(resolveChatTypographyVars(settings))) {
      root.style.setProperty(name, value);
    }
    // 旧属性保留，兼容外部依赖或测试仍读取 dataset.fontSize 的场景
    root.dataset.fontSize = settings.fontSize;
    root.dataset.fontBase = settings.fontFamilyBase;
    root.dataset.fontMono = settings.fontFamilyMono;

    const baseCustomFont = settings.fontFamilyBaseCustom.trim();
    if (settings.fontFamilyBase === "custom" && baseCustomFont) {
      root.style.setProperty("--font-family-base", baseCustomFont);
    } else {
      root.style.removeProperty("--font-family-base");
    }

    const monoCustomFont = settings.fontFamilyMonoCustom.trim();
    if (settings.fontFamilyMono === "custom" && monoCustomFont) {
      root.style.setProperty("--font-family-mono", monoCustomFont);
    } else {
      root.style.removeProperty("--font-family-mono");
    }
  }, [
    settings.fontSize,
    settings.uiFontSize,
    settings.chatFontSize,
    settings.inputFontSize,
    settings.chatBodyLineHeight,
    settings.chatBlockGap,
    settings.chatListDensity,
    settings.chatCodeDensity,
    settings.fontFamilyBase,
    settings.fontFamilyBaseCustom,
    settings.fontFamilyMono,
    settings.fontFamilyMonoCustom,
  ]);

  // 大纲与修改文件清单不再由 App 根组件持有原始消息数组并就地计算（消息边界 flush 时
  // 要重算 buildOutline/modifiedFiles）：大纲下沉到 OutlinePanel（自订 outlineItemsAtom），
  // 修改文件下沉到 useFileEditor（自订 modifiedFilesAtom）。这里只保留与消息无关的
  // 文件树扁平化。
  const flatFiles = useMemo(() => flattenFiles(files), [files]);
  // === file editor hook ===
  const {
    editorMode,
    toggleEditorMode,
    editorTabs,
    activeTabId,
    activeTab,
    readEditorFileContent,
    readEditorOriginalContent,
    saveEditorFileContent,
    closeEditorTab,
    selectEditorTab,
    promotePreviewEditorTab,
    previewEditorTabId,
    openFilePath,
    viewFilePath,
    openEditorTab,
    diffFilePath,
    openWorkspaceFileDiff,
    openCommitFileDiff,
    closeGitDiff,
    gitDiffDisplayMode,
    gitDrawerDiff,
    toggleGitDiffDisplayMode,
    prevDrawerPanelRef,
    clearEditorBack,
    closeEditor,
  } = useFileEditor({
    activeProjectId,
    activeProjectIdRef,
    activeAgent: activeAgent ?? null,
    activeProject: activeProject ?? null,
    drawer,
    setDrawer,
    setDrawerCollapsed,
    contentOpenMode: settings.workspaceContentOpenMode ?? "split",
    showToast,
    readFileContent: api.files.readContent,
    readGitOriginalContent: api.git.originalContent,
    writeFileContent: api.files.writeContent,
    openFile: api.files.open,
    workspaceFileDiff: api.git.workspaceFileDiff,
    commitFileDiff: api.git.commitFileDiff,
    t,
  });

  // 会话内文件链接打开路由：按扩展名分级——
  // 图片 → 弹窗预览（readBase64 → ImagePreviewModal）；markdown/html → 中间栏查看
  //（FileDiffViewer 对 .md 默认 preview、.html 用 HtmlPreview 内置渲染）；其他文件 → 编辑器打开。
  // 替代原先的"系统默认应用打开"（.md 会被浏览器接管、体验割裂）
  const handleOpenLinkedFile = useCallback(
    (path: string) => {
      const resolved = resolveFileLinkPath(
        path,
        activeAgent?.cwd ?? activeProject?.path,
      );
      const ext = resolved.split(".").pop()?.toLowerCase() ?? "";
      if (IMAGE_EXTENSIONS.has(ext)) {
        // 图片：读取二进制 → 弹窗预览
        void api.files
          .readBase64(resolved)
          .then((dataUrl) => {
            const m = dataUrl.match(/^data:(.*?);base64,(.*)$/s);
            if (m) setPreviewImage({ type: "image", mimeType: m[1], data: m[2] });
          })
          .catch(() => showToast(t("app.openFileFailed", { error: ext })));
        return;
      }
      // markdown / html / 其他文本文件：统一抽屉查看
      viewFilePath(resolved);
    },
    [activeAgent?.cwd, activeProject?.path, viewFilePath, showToast],
  );

  // 工具抽屉的统一切换语义：当前面板已展开 → 关闭；
  // 其余情况打开/切到目标面板。outline 浮动按钮与抽屉活动栏共用同一套语义，
  // 保证两个入口行为一致。注意必须放在 useFileEditor 之后（依赖 gitDrawerDiff）。
  const handleToolDrawerAction = useCallback((panel: WorkspaceDrawerPanel) => {
    if (workspace.drawer === panel && !workspace.drawerCollapsed) {
      if (panel === "git" && gitDrawerDiff) {
        closeGitDiff();
        return;
      }
      workspace.closeDrawer();
    } else {
      if (panel === "files" && activeProjectId) void refreshFiles(activeProjectId, true);
      workspace.openDrawer(panel);
    }
  }, [workspace, gitDrawerDiff, closeGitDiff, activeProjectId, refreshFiles]);

  const workspaceChrome = useSessionWorkspaceChrome({
    currentSessionId,
    activeProjectId,
  });

  const {
    selectProject: selectProjectCommand,
    selectSession: selectSessionCommand,
    copySession: runCopySession,
    exportHistorySession: runExportHistorySession,
    deleteHistorySession: runDeleteHistorySession,
    openSidebarSession: runOpenSidebarSession,
    openSidebarSessionById: runOpenSidebarSessionById,
    copySidebarSession: runCopySidebarSession,
    exportSidebarSession: runExportSidebarSession,
    createSessionDraft: runCreateSessionDraft,
    createAnonymousSession: runCreateAnonymousSession,
  } = useSessionActions({
    openSessionRequestRef,
    creatingSessionDraftRef,
    activeProjectId,
    sessionsProjectId,
    projects,
    setActiveProjectId,
    setCurrentSessionId,
    getSessionRecord,
    getProjectSessionRecords,
    upsertSession,
    removeSessionState,
    removeSessionComposerState,
    refreshProjectSessions,
    api,
    showToast,
  });

  // 关闭 Tab / 分屏退栏时的焦点切换：只改 currentSession，不碰 Tab 登记
  useEffect(() => {
    workspaceChrome.bindFocusHandlers({
      focusSession: (projectId, sessionId) => {
        selectSessionCommand(projectId, sessionId, true);
      },
      focusProject: (projectId) => {
        selectProjectCommand(projectId);
      },
    });
  }, [workspaceChrome, selectSessionCommand, selectProjectCommand]);

  /** 新建会话：选中 + 登记常驻 Tab（chrome 与 selection 在 App 边界组合） */
  const createSessionDraftWithTab = useCallback(
    async (projectId?: string, preferences: SessionLaunchPreferences = {}) => {
      const session = await runCreateSessionDraft(projectId, preferences);
      if (session) workspaceChrome.registerOpenSession(session.id, "permanent");
      return session;
    },
    [runCreateSessionDraft, workspaceChrome],
  );

  const createAnonymousSessionWithTab = useCallback(
    async (projectId?: string, preferences: SessionLaunchPreferences = {}) => {
      const session = await runCreateAnonymousSession(projectId, preferences);
      if (session) workspaceChrome.registerOpenSession(session.id, "permanent");
      return session;
    },
    [runCreateAnonymousSession, workspaceChrome],
  );

  /** 侧栏/分支打开：选中成功后按 preview|permanent 登记 Tab */
  const openSidebarSessionByIdWithTab = useCallback(
    async (
      projectId: string,
      sessionId: string,
      tabMode: "preview" | "permanent" = "permanent",
    ) => {
      const openedId = await runOpenSidebarSessionById(projectId, sessionId);
      if (openedId) workspaceChrome.registerOpenSession(openedId, tabMode);
    },
    [runOpenSidebarSessionById, workspaceChrome],
  );

  useEffect(() => {
    if (!activeProject) return;
    const action = resolveChatSessionBootstrap({
      isChatProject: isChatProject(activeProject),
      currentSessionId,
      catalogStatus: store.get(sessionCatalogLoadStateAtom)[activeProject.id]?.status,
    });
    if (action.kind === "load") {
      void refreshProjectSessions(activeProject.id).catch(() => undefined);
    }
  }, [
    activeProject,
    currentSessionId,
    refreshProjectSessions,
    selectSessionCommand,
    store,
  ]);

  // 聊天项目点开后与普通项目一致，先进统一引导页；用户从引导页选择
  // 「新建 Agent / 匿名聊天」时通过 createSessionDraft / createAnonymousSession
  // 创建真实 Catalog 会话，因此发送钩子不再需要把 renderer-only 虚拟会话提升为真实会话，
  // 直接透传传入的 sessionId（保持签名以兼容 composer 链路）。
  const ensureSessionForSend = useCallback(
    async (sessionId: string) => sessionId,
    [],
  );

  /** 有效命令名白名单：仅已知命令渲染为 chip */
  const mergedCommands = useMemo(
    () => mergeCommands(commands),
    [commands],
  );
  const validCommandNames = useMemo(
    () => new Set([
      ...mergedCommands.map((c) => c.name),
      ...promptTemplateList.map((t) => t.name),
    ]),
    [mergedCommands, promptTemplateList],
  );

  /** 有效文件路径白名单：仅工作区真实存在的 @ 引用渲染为 chip */
  const validFilePaths = useMemo(
    () => new Set(flatFiles.map((f) => f.relativePath)),
    [flatFiles],
  );

  const projectIdsKey = useMemo(
    () => projects.map((project) => project.id).join("\n"),
    [projects],
  );

  function handleAgentInventoryChanged(nextAgents: AgentTab[]) {
    const previousPendingAgents = pendingAgentsRef.current;
    const remainingPendingAgents = previousPendingAgents.filter(
      (pending) => !nextAgents.some((agent) =>
        isReplacementForPendingAgent(agent, pending),
      ),
    );
    const pendingReplacementById = new Map(
      previousPendingAgents
        .map((pending) => {
          const replacement = nextAgents.find((agent) =>
            isReplacementForPendingAgent(agent, pending),
          );
          return replacement ? [pending.id, replacement.id] : undefined;
        })
        .filter((entry): entry is [string, string] => Boolean(entry)),
    );
    if (remainingPendingAgents.length !== previousPendingAgents.length) {
      pendingAgentsRef.current = remainingPendingAgents;
      setPendingAgents(remainingPendingAgents);
    }
    const draftIds = new Set([
      ...nextAgents.map((agent) => agent.id),
      ...remainingPendingAgents.map((agent) => agent.id),
    ]);
    // 终端状态清理统一由下方 useEffect([displayAgents]) 的 prune 负责：
    // 此处再调一次会在流式 runtime 更新时与 displayAgents effect 重复执行，
    // 形成不必要的 setState 链（历史日志：发送消息后 Maximum update depth）。
    livePromptByAgentRef.current = migrateAgentRecord(
      livePromptByAgentRef.current,
      pendingReplacementById,
      draftIds,
    );
  }

  useEffect(() => {
    handleAgentInventoryChanged(agents);
  }, [agents]);

  const bootstrapProps = {
    onProjectsChanged: (next: Project[]) => {
      if (!activeProjectId && next.length > 0) setActiveProjectId(next[0].id);
    },
    onSettingsApplied: (next: AppSettings) => {
      setSettings(next);
      showToast(t("settings.restartNotice"));
    },
    onTrustRequest: overlays.setTrustRequest,
    onFocusTarget: (target: AppFocusSessionTarget) => {
      const session = store.get(sessionRecordByIdAtomFamily(target.sessionId));
      if (session) selectSessionCommand(session.projectId, session.id, false);
    },
  };

  useEffect(() => {
    void workspace.loadExternalEditors().catch(() => undefined);
    void api.app
      .preferredSystemLanguages()
      .then((languages) => setSystemLanguage(languages.find((language) => typeof language === "string" && language.trim()) ?? null))
      .catch(() => setSystemLanguage(null));
    void api.app
      .info()
      .then(setAppInfo)
      .catch(() => undefined);
    void api.settings.get().then((next) => {
      setSettings(next);
      setSettingsLoaded(true);
      piUpdate.setCustomPiPath(next.customPiPath ?? "");
      if (!Object.values(next.externalEditors).some((editor) => editor.command)) {
        void api.editors
          .redetect()
          .then((updated) => {
            setSettings(updated);
          })
          .then(() => workspace.loadExternalEditors())
          .catch(() => undefined);
      }
      if (!next.piEnvironmentChecked) {
        // 首次检测延后一帧启动,先让主界面完成绘制,避免 packaged app 打开时出现几秒白屏。
        window.setTimeout(() => void piUpdate.checkPiInstall("startup"), 300);
      } else {
        // 后续启动静默重检，自动发现 PATH/版本变化，同时不打扰用户。
        window.setTimeout(() => void piUpdate.refreshPiStatus(), 300);
      }
      if (!next.disableUpdateCheck) {
        window.setTimeout(() => void piUpdate.checkPiCliUpdateOnStartup(), 1200);
      }
    }).catch(() => {
      // 即使 settings IPC 暂不可用，也要允许侧栏继续使用 localStorage/default 状态。
      setSettingsLoaded(true);
    });

  }, []);

  /**
   * 更新侧栏展开集合并双写持久化：
   * 1) localStorage：同步，首屏可读
   * 2) settings.json：主进程 writeFile，dev 强杀/重启也不丢
   */
  const commitExpandedSidebarProjects = useCallback((next: Set<string>) => {
    // 标记已有权威写入，防止启动时迟到的 settings.get 用旧值覆盖用户刚点的展开
    expandedSidebarFromSettingsRef.current = true;
    expandedSidebarProjectsRef.current = next;
    setExpandedSidebarProjects(next);
    saveExpandedSidebarProjectsToLocal(next);
    void api.settings
      .update({ sidebarExpandedProjectIds: [...next] })
      .then((saved) => {
        // 只合并本字段，避免覆盖用户在设置页刚改的其它项的本地缓存
        setSettings((current) => ({
          ...current,
          sidebarExpandedProjectIds: saved.sidebarExpandedProjectIds,
        }));
      })
      .catch(() => undefined);
  }, []);

  /** 展开/折叠某个项目；forceExpand=true 时只展开不切换 */
  const setProjectSidebarExpanded = useCallback(
    (projectId: string, forceExpand?: boolean) => {
      const prev = expandedSidebarProjectsRef.current;
      const next = new Set(prev);
      const shouldExpand = forceExpand ?? !next.has(projectId);
      if (shouldExpand) next.add(projectId);
      else next.delete(projectId);
      const unchanged =
        next.size === prev.size && [...next].every((id) => prev.has(id));
      if (unchanged) return next;
      commitExpandedSidebarProjects(next);
      return next;
    },
    [commitExpandedSidebarProjects],
  );

  useEffect(() => {
    const projectIds = new Set(projects.map((project) => project.id));
    setVisibleProjectChildCountByProject((current) =>
      Object.fromEntries(
        Object.entries(current).filter(([projectId]) =>
          projectIds.has(projectId),
        ),
      ),
    );
    setSessionLoadingByProject((current) =>
      Object.fromEntries(
        Object.entries(current).filter(([projectId]) =>
          projectIds.has(projectId),
        ),
      ),
    );
  }, [projectIdsKey]);

  useEffect(() => {
    // settings.json 覆盖首屏 localStorage 后，按最终展开集合补加载；使用 catalog load state
    // 而不是会话数量判定，空项目也只加载一次。
    if (!expandedProjectsReady) return;
    for (const project of projects) {
      if (!expandedProjects.has(project.id)) continue;
      const loadState = store.get(sessionCatalogLoadStateAtom)[project.id];
      if (loadState?.status === "loading" || loadState?.status === "ready") continue;
      void refreshProjectSessions(project.id).catch(() => undefined);
    }
  }, [expandedProjects, expandedProjectsReady, projectIdsKey, refreshProjectSessions, store]);

  useEffect(() => {
    // When update check is disabled, skip periodic and deferred auto-check.
    if (settings.disableUpdateCheck) return;
    const timer = window.setInterval(
      () => void appUpdate.check("auto"),
      1000 * 60 * 60 * 6,
    );
    window.setTimeout(() => void appUpdate.check("auto"), 5000);
    return () => window.clearInterval(timer);
  }, [settings.disableUpdateCheck]);

  useEffect(() => {
    if (activeAgentId && !isPendingAgentId(activeAgentId))
      void refreshRuntimeState(activeAgentId);
  }, [activeAgentId]);

  useEffect(() => {
    // 只按各自存活集合裁剪：流式事件仅更新 agent 集合，不能误删项目终端状态
    const liveAgentIds = new Set(displayAgents.map((agent) => agent.id));
    const liveProjectIds = new Set(projects.map((project) => project.id));
    pruneTerminalDockState(liveAgentIds, liveProjectIds);
  }, [displayAgents, projects]);

  useEffect(() => {
    // 折叠中的项目不跑周期扫描，避免后台无意义刷会话列表
    if (!expandedProjectsReady || !activeProjectId || !expandedProjects.has(activeProjectId)) return;
    // 进入/退出运行态时都立即扫描一次，保证最终 child session 不因最后一次写入时序而遗漏。
    let disposed = false;
    const scheduleRefresh = () => {
      if (disposed) return;
      void refreshProjectSessions(activeProjectId, true).catch(() => undefined);
    };
    scheduleRefresh();
    if (!activeProjectHasBusyAgent) {
      return () => { disposed = true; };
    }

    // 子会话由扩展直接写盘，运行期间保留低频兜底；工具 start/end 不应重置计时器并触发额外扫描。
    const timer = window.setInterval(scheduleRefresh, 15_000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [activeProjectId, activeProjectHasBusyAgent, activeProjectSessionSyncKey, expandedProjects, expandedProjectsReady]);

  // Composer sizing is owned by the composer panel (react-resizable-panels) since #115 U5.
  // 待发送轨道高度变化只影响面板可用空间，不再回写 composer 高度状态。
  // composerOffsetHeight 仍由 ResizeObserver/布局效应测量，供布局兼容与旧嵌入路径保留。
  useLayoutEffect(() => {
    setComposerOffsetHeight(composerRef.current?.offsetHeight ?? 0);
  }, [activeAgentId, activeQueuedPrompts.length, composerRef]);

  // Outline jumps through the same timeline controller that owns pagination and scroll state.

  useEffect(() => {
    const target = getRuntimeTargetForSession(currentSessionId);
    if (!target) {
      setCommands([]);
      return;
    }
    void api.sessions
      .listRuntimeCommands(target)
      // goal 模式这版先不公开入口；保留底层实现,等待官方 plan/goal 能力稳定后再决定是否恢复。
      .then((result) => setCommands(requireSessionCommand(result).value))
      .catch(() => setCommands([]));
  }, [activeAgentId, currentSessionId]);

  // 持久化会话来源过滤配置
  useEffect(() => {
    try {
      saveSessionSourceFilter(sessionSourceFilter);
    } catch (error) {
      // 静默失败
    }
  }, [sessionSourceFilter]);


  // 追踪 agent 会话开始/结束时间,计算会话时长
  useEffect(() => {
    // 活 agent 集合（agentId 每次 spawn 随机，标签关闭后旧键永久残留 → 按活集合裁剪，2026-10）
    const liveIds = new Set(displayAgents.map((a) => a.id));
    for (const id of Object.keys(agentStatusByAgentRef.current)) {
      if (!liveIds.has(id)) delete agentStatusByAgentRef.current[id];
    }
    for (const id of Object.keys(sessionStartByAgentRef.current)) {
      if (!liveIds.has(id)) delete sessionStartByAgentRef.current[id];
    }
    setSessionDurationByAgent((d) => {
      let changed = false;
      const next: typeof d = {};
      for (const id of Object.keys(d)) {
        if (liveIds.has(id)) next[id] = d[id];
        else changed = true;
      }
      return changed ? next : d;
    });
    for (const agent of displayAgents) {
      if (agent.id !== activeAgentId) continue;
      const previousStatus = agentStatusByAgentRef.current[agent.id];
      if (agent.status === "running") {
        if (previousStatus !== "running") {
          sessionStartByAgentRef.current[agent.id] = Date.now();
        }
      } else if (agent.status === "idle") {
        const start = sessionStartByAgentRef.current[agent.id];
        if (start) {
          setSessionDurationByAgent((d) => ({
            ...d,
            [agent.id]: Date.now() - start,
          }));
        }
      }
      agentStatusByAgentRef.current[agent.id] = agent.status;
    }
  }, [activeAgentId, displayAgents]);

  // 汇报聚焦会话给主进程：非聚焦会话收到 Ask 请求时触发桌面通知（Task 9）
  useEffect(() => {
    void api.sessions.setFocusedSession(currentSessionId).catch(() => undefined);
  }, [currentSessionId]);


  // 侧栏 π logo 业务反馈：新建/历史会话启动/关闭 agent 时重播拼装动画。
  const triggerBrandLogoReplay = useCallback(() => {
    setBrandLogoReplayToken((token) => token + 1);
  }, []);

  // 已删除内置 goal 完成检测。

  // 监听用户发送消息的编辑事件,将消息填入输入框
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ text: string }>).detail;
      if (detail?.text) {
        setPrompt(detail.text);
        // 光标移至文本末尾，利用 RichInput 的 caretRef 机制在渲染后恢复
        pendingComposerCaretRef.current = detail.text.length;
        requestAnimationFrame(() => {
          composerTextareaRef.current?.focus();
        });
      }
    };
    window.addEventListener("user-message-edit", handler);
    return () => window.removeEventListener("user-message-edit", handler);
  }, []);

  // 编辑器右键「引用选中内容」：@path:start-end 引用追加到输入框（与文件树右键 onAttach 同语义）
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ refs?: string[] }>).detail;
      const refs = detail?.refs;
      if (!refs?.length) return;
      setPrompt(
        (current) =>
          `${current}${current.endsWith(" ") || current.length === 0 ? "" : " "}${refs.join(" ")} `,
      );
    };
    window.addEventListener("composer-attach-refs", handler);
    return () => window.removeEventListener("composer-attach-refs", handler);
  }, []);

  useEffect(() => {
    if (!activeProjectId) return;

    // 切换项目时按 catalog load state 判断。空项目成功返回 [] 后也会是 ready，
    // 不能再用列表长度，否则每次选中都会重扫。
    const activeProject = projects.find((p) => p.id === activeProjectId);
    const loadState = store.get(sessionCatalogLoadStateAtom)[activeProjectId];
    if (expandedProjectsReady && activeProject && expandedProjects.has(activeProjectId) && loadState?.status !== "loading" && loadState?.status !== "ready") {
      void refreshProjectSessions(activeProjectId).catch(() => undefined);
    }
  }, [activeProjectId, currentSessionId, displayAgents.length]);

  useEffect(() => {
    if (!activeProjectId) return;
    // 请求序号与项目身份校验由 useProjectSync 统一持有；慢请求即使跨过
    // 下一次轮询或项目切换才结束，也不会把旧分支写回当前工作区。
    const timer = window.setInterval(
      () => void refreshGitInfo(activeProjectId).catch(() => undefined),
      4000,
    );
    return () => window.clearInterval(timer);
  }, [activeProjectId]);

  /** 统一通知：普通消息默认 1.5 秒，异常由 kind 映射为 3 秒；Ask 使用持久 warning toast。 */
  function showToast(message: string, duration?: number, kind?: "info" | "warning" | "error") {
    showNotice(message, duration, kind);
  }

  /**
   * clone / fork 会把同一个 Agent 换绑到新的 SessionRecord。
   * 必须先刷新 catalog 再登记 Tab：否则 chrome 的 prune 看到 records 里还没有新 id，会立刻清掉刚打开的 Tab。
   * 选中与登记都在这里组合——selectSession 本身不碰 Tab。
   */
  async function openReplacedRuntimeSession(
    projectId: string | undefined,
    targetSessionId: string | undefined,
  ) {
    if (!projectId || !targetSessionId) return;
    await refreshProjectSessions(projectId);
    workspaceChrome.registerOpenSession(targetSessionId, "permanent");
    selectSessionCommand(projectId, targetSessionId, true);
  }

  async function cloneAgentSession(agentId: string) {
    try {
      const target = getRuntimeTargetForAgent(agentId);
      if (!target) return;
      const result = requireSessionCommand(await api.sessions.cloneRuntime(target));
      if (result?.cancelled) {
        showToast(t("app.sessionCopyCancelled"));
        return;
      }
      showToast(t("app.currentSessionCopied"));
      await refreshRuntimeState(agentId);
      const projectId = agents.find((agent) => agent.id === agentId)?.projectId ?? activeProjectId;
      await openReplacedRuntimeSession(projectId, result.targetSessionId);
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 5000);
    }
  }

  async function deleteDraftSession(session: SessionRecord) {
    try {
      await api.sessions.deleteRecord(session.id);
      // A false result means another path already removed the catalog record;
      // clear the stale sidebar row the same way as a successful deletion.
      removeSessionState(session.id);
      removeSessionComposerState(session.id);
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), 4000);
    }
  }

  function updateAfterProjectRemoved(
    removedProjectId: string,
    next: Project[],
  ) {
    setVisibleProjectChildCountByProject((current) => {
      const updated = { ...current };
      delete updated[removedProjectId];
      return updated;
    });
    if (activeProjectId === removedProjectId) {
      setActiveProjectId(next[0]?.id);
    }
    if (sessionsProjectId === removedProjectId) {
      setSessionsProjectId(undefined);
      if (drawer === "sessions") workspace.closeDrawer();
    }
  }

  const {
    reorderProjects,
    addProject,
    removeSidebarProject,
    changeChatPath,
    switchBranch,
    createBranch,
  } = useProjectCommands({
    projects,
    activeProjectId,
    gitInfo,
    setProjects,
    setActiveProjectId,
    setGitInfo,
    setProjectBranch,
    refreshProjects,
    refreshProjectSessions,
    onProjectRemoved: updateAfterProjectRemoved,
    showToast,
    overlays,
  });

  function applyAgentRuntimeState(agentId: string, incoming: AgentRuntimeState) {
    const target = getRuntimeTargetForAgent(agentId);
    if (!target) return undefined;
    applyRuntimeEvent({
      ...target,
      sourceChannel: "agents:runtime-state",
      payload: { agentId, state: incoming },
    });
    return store.get(sessionRuntimeBySessionIdAtomFamily(target.sessionId))?.state;
  }

  async function refreshRuntimeState(agentId = activeAgentId) {
    if (!agentId || isPendingAgentId(agentId)) return;
    const target = getRuntimeTargetForAgent(agentId);
    if (!target) return;
    const result = await api.sessions.getRuntimeState(target).catch(() => undefined);
    if (result?.ok) applyAgentRuntimeState(agentId, result.value.value);
  }

  /** 调整菜单位置避免溢出视口 */
  function adjustMenuPos(x: number, y: number, width = 200, height = 260) {
  	const vw = window.innerWidth;
  	const vh = window.innerHeight;
  	return {
  		x: x + width > vw ? Math.max(4, vw - width - 8) : x,
  		y: y + height > vh ? Math.max(4, vh - height - 8) : y,
  	};
  }

  async function closeAgent(agentId: string) {
    // pending / 无 target 必须抛错：Tab 下拉「关闭会话」成功后才会 closeTab。
    // 以前这里静默 return，调用方仍关 Tab，标签没了、进程还在。
    if (isPendingAgentId(agentId)) {
      throw new Error(t("sessionCommand.runtimeBusy"));
    }
    const target = getRuntimeTargetForAgent(agentId);
    if (!target) {
      throw new Error(t("sessionCommand.runtimeUnavailable"));
    }
    requireSessionCommand(await api.sessions.stopRuntime(target));
  }

  // ── Skills 快捷修改后的自动收尾 ────────────────────────────────
  // 弹窗状态：changed 用 ref（toggle 回调只置位，不触发重渲染）；open/stopping 用 state。
  const [skillsQuickOpen, setSkillsQuickOpen] = useState(false);
  const skillsQuickChangedRef = useRef(false);

  /**
   * Skills 修改完成后停止所有当前真实 Agent runtime。
   * 只从 agentsRef（agentInventoryAtom，已绑定真实 runtime）取 ID；
   * displayAgents 混有 pendingAgents（无 runtime target），直接 closeAgent 会报 runtime unavailable。
   * Promise.allSettled：一个 Agent stop 失败不能阻止其他 Agent 被关闭。
   * closeAgent 只 stopRuntime：不 delete SessionRecord、不 removeSessionState、不关 Tab、不 restart。
   */
  async function stopAllAgentsAfterSkillsChange() {
    const agentIds = agentsRef.current.map((agent) => agent.id);
    if (agentIds.length === 0) return;

    setSkillsStoppingAgents(true);
    try {
      const results = await Promise.allSettled(
        agentIds.map((agentId) => closeAgent(agentId)),
      );

      const failed = results.filter((result) => result.status === "rejected");
      if (failed.length > 0) {
        showToast(t("skills.quickStopFailed", { count: failed.length }), 5000);
      } else {
        showToast(t("skills.quickAgentsStopped", { count: agentIds.length }), 2500);
      }
    } finally {
      setSkillsStoppingAgents(false);
    }
  }

  /**
   * Skills 弹窗关闭入口：Dialog 的 X 与 onOpenChange 都走这里。
   * - 本次没改过：直接关，不动任何 Agent。
   * - 改过且此刻仍有 working Agent：拒绝本次关闭请求（保留弹窗 + 提示），绝不能强杀正在生成/执行工具的 Agent；等全部 idle 后用户再点关闭才执行 stop all。
   */
  const handleSkillsQuickClose = useCallback(() => {
    if (skillsStoppingAgents) return;

    // 弹窗打开期间理论上主 UI 不能启动 Agent，但后台队列/runtime 仍可能变化。
    if (skillsQuickChangedRef.current && skillsRuntimeBusy) {
      showToast(t("skills.quickWaitIdle"), 3500);
      return;
    }

    const changed = skillsQuickChangedRef.current;
    skillsQuickChangedRef.current = false;
    setSkillsQuickOpen(false);

    if (changed) {
      void stopAllAgentsAfterSkillsChange();
    }
  }, [skillsStoppingAgents, skillsRuntimeBusy]);

  function requestCloseAgent(agent: AgentTab): Promise<void> {
    if (!agent.noSession) {
      return closeAgent(agent.id).catch((error) => {
        showToast(error instanceof Error ? error.message : String(error), 5000);
      });
    }
    overlays.showConfirm({
      title: t("app.anonymousChatCloseTitle"),
      message: t("app.anonymousChatCloseBody"),
      danger: true,
      confirmLabel: t("common.close"),
      onConfirm: () => {
        overlays.clearConfirm();
        void closeAgent(agent.id).catch((error) => {
          showToast(error instanceof Error ? error.message : String(error), 5000);
        });
      },
    });
    return Promise.resolve();
  }

  async function abortAgent(agentId = activeAgentId) {
    if (!agentId || isPendingAgentId(agentId)) return;
    const target = getRuntimeTargetForAgent(agentId);
    if (!target) {
      showToast(t("sessionCommand.runtimeUnavailable"), 4000);
      return;
    }
    // 立即清除流式状态，让思考气泡和 loading 立刻消失，不等后端 RPC 返回
    const previous = store.get(sessionRuntimeBySessionIdAtomFamily(target.sessionId))?.state;
    if (previous) {
      applyAgentRuntimeState(agentId, { ...previous, isStreaming: false });
    }
    try {
      requireSessionCommand(await api.sessions.abortRuntime(target));
    } catch (error) {
      // abort 失败必须可见：之前此处直接 throw 变成未处理 rejection，
      // 用户点停止后毫无反馈、agent 继续运行，表现为「停止不了」。
      showToast(error instanceof Error ? error.message : String(error), 5000);
    }
    // 不调用 refreshRuntimeState：AgentManager.abort() 会通过 emitState 推送正确状态，
    // 避免后端 get_state 返回过时的 isStreaming: true 覆盖前端立刻设的 false。
  }

  async function restartActiveAgent(agentId = activeAgentId) {
    if (!agentId) return;
    const restartingAgent = agents.find((agent) => agent.id === agentId) ?? activeAgent;
    if (!restartingAgent) return;
    const target = getRuntimeTargetForAgent(restartingAgent.id);
    if (!target) return;
    setRestartingAgentId(restartingAgent.id);
    pendingAgentsRef.current = [
      ...pendingAgentsRef.current.filter(
        (agent) => agent.id !== restartingAgent.id,
      ),
      {
        ...restartingAgent,
        status: "starting",
        pendingKind: "restart",
        pendingStartedAt: Date.now(),
      },
    ];
    setPendingAgents(pendingAgentsRef.current);
    try {
      const replacement = requireSessionCommand(await api.sessions.restartRuntime(target));
      pendingAgentsRef.current = pendingAgentsRef.current.filter(
        (agent) => agent.id !== restartingAgent.id,
      );
      setPendingAgents(pendingAgentsRef.current);
      void refreshRuntimeState(replacement.runtime.agentId);
      showToast(t("app.agentRestarted"), 2000);
    } catch (error) {
      pendingAgentsRef.current = pendingAgentsRef.current.map((agent) =>
        agent.id === restartingAgent.id
          ? { ...agent, status: "error" }
          : agent,
      );
      setPendingAgents(pendingAgentsRef.current);
      showToast(error instanceof Error ? error.message : String(error), 5000);
    } finally {
      setRestartingAgentId((current) =>
        current === restartingAgent.id ? null : current,
      );
    }
  }

  async function exportAgentHtml(agentId: string) {
    if (isPendingAgentId(agentId)) return;
    try {
      const target = getRuntimeTargetForAgent(agentId);
      if (!target) return;
      const result = requireSessionCommand(await api.sessions.exportRuntimeHtml(target)).value as {
        path: string;
      };
      showToast(t("app.exportedPath", { path: result.path }), 3500);
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 5000);
    }
  }

  function isRuntimeTargetBusy(target: SessionRuntimeTarget): boolean {
    const rt = store.get(sessionRuntimeBySessionIdAtomFamily(target.sessionId));
    if (!rt || rt.agentId !== target.agentId) return false;
    return rt.status === "running" || Boolean((rt.state as { isStreaming?: boolean } | undefined)?.isStreaming);
  }

  // isAgentBusy: synchronous store read (steer logic is callback-only, not render-time).
  function isAgentCurrentlyBusy(): boolean {
    if (!currentSessionId) return false;
    const rt = store.get(currentSessionRuntimeAtom);
    return rt?.status === "running" || Boolean((rt?.state as any)?.isStreaming);
  }

  // Drain by stable Session identity so runtime replacement cannot orphan queued work.
  // tool-end 的 steer 投递直接在 onRuntimeState 原始事件上处理，避免批量 render 漏边沿。
  useEffect(() => {
    for (const sessionId of Object.keys(queue.queuedPrompts)) {
      if (queue.canFlushQueuedPrompt(sessionId)) {
        void queue.flushNextQueuedPrompt(sessionId);
      }
    }
  }, [activeProjectRuntimeCapabilities, agents, queue.queuedPrompts]);

  // Session prompt submission is owned by useSessionComposerController.

  // 已删除内置 /goal 与 startNewGoal 实现。

  async function dispatchPromptSnapshot(
    sessionId: string,
    message: string,
    images?: ImageContent[],
    streamingBehavior?: "steer" | "followUp",
    agentMode: ComposerAgentMode = "normal",
    templateDescription?: string,
  ) {
    const submission = buildComposerPromptSubmission(message, agentMode);
    let result: Awaited<ReturnType<typeof api.sessions.sendPrompt>>;
    try {
      result = await api.sessions.sendPrompt({
        sessionId,
        requestId: crypto.randomUUID(),
        message: submission.message,
        images,
        ...(submission.agentMessage ? { agentMessage: submission.agentMessage } : {}),
        ...(templateDescription ? { description: templateDescription } : {}),
        ...(streamingBehavior ? { streamingBehavior } : {}),
      });
    } catch (error) {
      // IPC/fetch 在请求发出后断开时无法判断主进程是否已经提交给 pi；按未知处理，
      // 绝不能把它降级为可重试失败，否则网络/IPC 抖动会造成重复发送。
      throw new PromptDeliveryUnknownError(
        error instanceof Error ? error.message : String(error),
      );
    }
    if (!result.accepted) {
		const localizedError = translateI18nDescriptor(result, result.error);
      if (result.delivery === "unknown") {
        throw new PromptDeliveryUnknownError(localizedError);
      }
      throw new Error(localizedError);
    }
  }

  async function submitPromptSnapshot(
    sessionId: string,
    message: string,
    images?: ImageContent[],
    streamingBehavior?: "steer" | "followUp",
    agentMode: ComposerAgentMode = "normal",
    /** prompt 模板匹配到的 description，作为元数据发给 pi agent 标识意图 */
    templateDescription?: string,
  ) {
    // 非队列入口继续保持原有行为：当前选中 agent 忙碌时默认 steer。
    // 客户端队列 drain 直接调用 dispatchPromptSnapshot，并显式指定其投递语义。
    const behavior =
      streamingBehavior ??
      (sessionId === currentSessionId && isAgentCurrentlyBusy() ? "steer" : undefined);
    try {
      await dispatchPromptSnapshot(
        sessionId,
        message,
        images,
        behavior,
        agentMode,
        templateDescription,
      );
      return true;
    } catch (error) {
      if (error instanceof PromptDeliveryUnknownError) {
        showToast(t("app.queuedUnknown"), 6000);
        return "unknown" as const;
      }
      showToast(error instanceof Error ? error.message : String(error), 4000);
      return false;
    }
  }

  const {
    resendUserMessage,
    editMessage,
    deleteMessage,
    forkFromUserMessage,
    forkingMessageId,
  } = useSessionMessageCommands({
    activeAgentStatus: activeAgent?.status,
    activeProjectId,
    agents,
    isRuntimeTargetBusy,
    getRuntimeTargetForSession,
    submitPromptSnapshot,
    openReplacedRuntimeSession,
    currentSessionIdRef,
    setPromptForAgent,
    showToast,
    overlays,
    captureHistoryMutationRefresh: (sessionId) => captureHistoryMutationRefresh(store, sessionId),
    refreshHistoryAfterMutation: (snapshot) => refreshHistoryAfterMutation({ store }, snapshot),
  });
  /**
   * 打开系统原生文件/文件夹选择器，将选中路径以 @path 引用格式插入到消息中。
   * 仅引用路径，不读取/上传文件内容。
   */
  async function handleAttachFile() {
    try {
      // session-first：路径引用插入由 composer controller 负责；这里仅打开选择器并派发事件。
      const paths = await window.piDesktop.dialog.pickFiles({
        title: t("menu.attachFile"),
      });
      if (paths.length > 0) {
        window.dispatchEvent(new CustomEvent("composer-attach-paths", { detail: { paths } }));
      }
    } catch {
      // 用户取消或出错时不作处理
    }
  }

  async function updateSettings(patch: Partial<AppSettings>) {
    const changesWebService =
      "webServiceEnabled" in patch ||
      "webServiceHost" in patch ||
      "webServicePort" in patch;
    if (changesWebService) {
      setWebServiceChanging(true);
      showToast(
        patch.webServiceEnabled === false
          ? t("app.webStopping")
          : t("app.webApplying"),
      );
    }
    try {
      const next = await api.settings.update(patch);
      setSettings(next);
      let notice = t("app.settingsSaved");
      if (
        "piProxyEnabled" in patch ||
        "piProxyUrl" in patch ||
        "piProxyBypass" in patch
      ) {
        notice = next.piProxyEnabled
          ? t("app.shellProxySaved")
          : t("app.shellProxyDisabled");
        piUpdate.setPiProxyNoticeTone("info");
        piUpdate.setPiProxyNotice(next.piProxyEnabled ? t("app.shellProxySaved") : "");
      }
      if (
        "desktopProxyEnabled" in patch ||
        "desktopProxyUrl" in patch ||
        "desktopProxyBypass" in patch
      ) {
        notice = next.desktopProxyEnabled
          ? t("app.webProxySaved")
          : t("app.webProxyDisabled");
      }
      if ("sendShortcut" in patch) {
        notice = t("app.sendShortcutSaved");
      }
      if (
        "webServiceEnabled" in patch ||
        "webServiceHost" in patch ||
        "webServicePort" in patch
      ) {
        notice = next.webServiceEnabled
          ? t("app.webServiceStarted", { port: next.webServicePort })
          : t("app.webServiceStopped");
      }
      if ("useNativeTitleBar" in patch) {
        notice = t("app.titleBarSaved");
      }
      // 单实例锁在进程启动时申请，修改后需重启才切换多开/复用行为。
      if ("singleInstance" in patch) {
        notice = t("app.settingsSaved"); // 单实例需重启
      }
      // 启动窗口预设仅在下次 createWindow 时应用。
      if ("startupWindowMode" in patch) {
        notice = t("app.settingsSaved"); // 启动窗口需重启
      }
      // WSL/Windows pi 源切换：重新检测 pi 环境、刷新项目和会话列表
      if ("wslEnabled" in patch || "wslDistro" in patch || "wslUser" in patch) {
        void api.pi.check().then((next) => setPiStatus(next)).catch(() => undefined);
        void api.projects.list().then(setProjects).catch(() => undefined);
        if (activeProjectId) {
          void refreshProjectSessions(activeProjectId, true).catch(() => undefined);
        }
      }
      if (
        "piRuntimePreference" in patch ||
        "piTypescriptPath" in patch ||
        "piRustPath" in patch
      ) {
        void api.pi.check().then((next) => setPiStatus(next)).catch(() => undefined);
      }
      showToast(notice);
    } catch (error) {
      setSettings(await api.settings.get());
      showToast(error instanceof Error ? error.message : String(error));
    } finally {
      if (changesWebService) setWebServiceChanging(false);
    }
  }

  async function restartWebService() {
    if (!settings.webServiceEnabled || webServiceChanging) return;
    setWebServiceChanging(true);
    showToast(t("settings.webRestarting"));
    try {
      await api.settings.restartWebService();
      showToast(t("settings.webRestarted"));
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error));
    } finally {
      setWebServiceChanging(false);
    }
  }

  function toggleDirectory(path: string) {
    // 文件树默认折叠,只有用户显式展开目录才显示子项,避免大仓库一打开就产生视觉噪音。
    setExpandedDirs((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      // 持久化展开状态到 localStorage，切换回此项目时恢复
      if (activeProjectId) saveExpandedDirs(activeProjectId, next);
      return next;
    });
  }

  function collapseAllDirectories() {
    const collapsedDirs = new Set<string>();
    setExpandedDirs(collapsedDirs);
    // 全部收起同样持久化，避免用户切换项目后又恢复此前展开的目录。
    if (activeProjectId) saveExpandedDirs(activeProjectId, collapsedDirs);
  }

  async function deleteSidebarSession(projectId: string, session: SessionSummary) {
    try {
      await api.sessions.deleteRecord(session.id);
      removeSessionState(session.id);
      removeSessionComposerState(session.id);
      showToast(t("app.sessionDeleted"), 2200);
      await refreshProjectSessions(projectId);
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), 4000);
    }
  }

  /** 归档会话：从列表移除但不销毁文件，可在会话管理弹窗中恢复 */
  async function archiveSidebarSession(projectId: string, session: SessionSummary) {
    try {
      await api.sessions.archiveRecord(session.id);
      removeSessionState(session.id);
      removeSessionComposerState(session.id);
      showToast(t("app.sessionArchived"), 2200);
      await refreshProjectSessions(projectId);
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), 4000);
    }
  }

  /** 恢复归档会话：文件移回原路径并重新扫描 */
  async function unarchiveSidebarSession(archivedPath: string, projectId = activeProjectId) {
    await api.sessions.unarchiveRecord(archivedPath);
    showToast(t("app.sessionRestored"), 2200);
    // 归档管理弹窗可以从非当前项目打开；必须刷新弹窗所属项目，否则文件已恢复但侧栏仍沿用旧目录快照。
    if (projectId) await refreshProjectSessions(projectId);
  }

  /** 列出已归档会话（会话管理弹窗恢复视图用） */
  function listArchivedSidebarSessions() {
    return api.sessions.listArchived();
  }

  function requestDeleteSidebarSession(projectId: string, session: SessionSummary) {
    const childCount = getProjectSessionRecords(projectId).filter((candidate) =>
      isSameSessionPath(
        candidate.parentSessionPath,
        session.filePath,
      ),
    ).length;
    if (childCount === 0) {
      void deleteSidebarSession(projectId, session);
      return;
    }
    overlays.showConfirm({
      title: t("drawer.sessionDeleteTitle"),
      message: t("drawer.sessionDeleteBodyWithChildren", {
        name: session.name || t("common.untitled"),
        count: childCount,
      }),
      danger: true,
      confirmLabel: t("common.delete"),
      onConfirm: () => {
        overlays.clearConfirm();
        void deleteSidebarSession(projectId, session);
      },
    });
  }

  const sidebarActions: SidebarActions = {
    projects: {
      add: addProject,
      select: (projectId) => {
        selectProjectCommand(projectId);
        // 点开目录只选中项目并显示引导页：不自动创建会话，避免每点一个目录都
        // 悄悄新建一个 agent 会话 tab。创建由用户手动点「启动 Agent / 临时对话」
        // 触发；启动时首项目自动选中除外（见 bootstrapProps.onProjectsChanged）。
        // 空项目也可能已经成功加载；用 catalog 状态区分“空结果”和“尚未扫描”。
        const loadState = store.get(sessionCatalogLoadStateAtom)[projectId];
        if (loadState?.status !== "loading" && loadState?.status !== "ready") {
          void refreshProjectSessions(projectId).catch(() => undefined);
        }
      },
      refresh: async (projectId) => {
        const project = projects.find((candidate) => candidate.id === projectId);
        if (project) await refreshProjectTree(project);
      },
      reorder: reorderProjects,
      reveal: (project) => api.files.showInFolder(project.path),
      openWithEditor: (project) => {
        workspace.openExternalEditorChooser(project.path, { x: 80, y: 80 });
      },
      importSessions: (project, source) => {
        if (source === "codex") return openCodexImport(project);
        if (source === "claude") return openClaudeImport(project);
        return openOpenCodeImport(project);
      },
      manageResources: (project) => setProjectResourcesProject(project),
      toggleWorktree: toggleProjectWorktree,
      copyPath: async (project) => {
        await navigator.clipboard.writeText(project.path);
        showToast(t("common.copied"));
      },
      remove: removeSidebarProject,
      changeChatPath,
    },
    sessions: {
      // 侧栏单击模式由设置 sessionTabOpenMode 控制（默认 preview=临时预览，发消息自动晋升常驻）；
      // 双击仍是显式常驻。tabMode 为 undefined 时用当前设置值。
      open: (projectId, sessionId, tabMode) =>
        openSidebarSessionByIdWithTab(projectId, sessionId, tabMode ?? settings.sessionTabOpenMode),
      beginDrag: workspaceChrome.beginDrag,
      endDrag: workspaceChrome.endDrag,
      createDraft: async (projectId) => {
        await createSessionDraftWithTab(projectId);
      },
      createAnonymous: async (projectId) => {
        await createAnonymousSessionWithTab(projectId);
      },
      deleteDraft: deleteDraftSession,
      rename: rename.openSessionRename,
      export: runExportSidebarSession,
      copy: runCopySidebarSession,
      copyPath: async (session) => {
        await navigator.clipboard.writeText(session.filePath);
        showToast(t("common.copied"));
      },
      openFile: (session) => api.files.open(session.filePath),
      delete: async (projectId, session) => {
        requestDeleteSidebarSession(projectId, session);
      },
      archive: async (projectId, session) => {
        await archiveSidebarSession(projectId, session);
      },
      unarchive: async (archived, projectId) => {
        await unarchiveSidebarSession(archived.filePath, projectId);
      },
      listArchived: () => listArchivedSidebarSessions(),
    },
    agents: {
      rename: rename.openAgentRename,
      export: (agent) => exportAgentHtml(agent.id),
      copySession: (agent) => cloneAgentSession(agent.id),
      copyPath: async (agent) => {
        if (!agent.sessionPath) return;
        await navigator.clipboard.writeText(agent.sessionPath);
        showToast(t("common.copied"));
      },
      openSessionFile: (agent) => agent.sessionPath ? api.files.open(agent.sessionPath) : Promise.resolve(),
      close: requestCloseAgent,
    },
    worktrees: {
      create: async (projectId, branchName) => {
        await createWorktree(projectId, branchName);
      },
      remove: (parentProjectId, entry, childProject) => {
        requestRemoveWorktree(parentProjectId, entry.path, childProject);
        return Promise.resolve();
      },
    },
    rpc: {
      getLogging: (agentId) => {
        const target = getRuntimeTargetForAgent(agentId);
        return target ? api.rpcLogs.getLogging(target) : Promise.resolve(false);
      },
      setLogging: (agentId, enabled) => {
        const target = getRuntimeTargetForAgent(agentId);
        return target ? api.rpcLogs.setLogging(target, enabled) : Promise.resolve(false);
      },
      listLogs: (agentId) => {
        const target = getRuntimeTargetForAgent(agentId);
        return target ? api.rpcLogs.get({ target }) : Promise.resolve([]);
      },
    },
  };

  const sidebarContentNode = (
    <AppSidebar
      listCollapsed={listCollapsed}
      toggleListCollapsed={toggleListCollapsed}
      actions={sidebarActions}
      currentProjectId={activeProjectId}
      currentSessionId={currentSessionId}
      worktreesByProject={worktreesByProject}
      branchByProject={branchByProject}
      creatingWorktree={worktreeCreating}
      isLanWeb={isLanWeb}
      onOpenConfig={() => setConfigOpen(true)}
      settingsExpandedProjectIds={settings.sidebarExpandedProjectIds}
      settingsLoaded={settingsLoaded}
      onExpandedProjectsReady={() => setExpandedProjectsReady(true)}
    />
  );

  // Gate 4.6 — Session view wrapped in SessionRuntimeInjector / ChatSessionPane

  // 会话 Tab 栏始终外置挂载；分屏双栏共享同一条 Tab，单栏也不再嵌入 SessionView。
  const focusSessionPane = useCallback((sessionId: string) => {
    const record = store.get(sessionRecordByIdAtomFamily(sessionId));
    if (record) selectSessionCommand(record.projectId, sessionId, true);
  }, [selectSessionCommand, store]);

  // 切会话过渡：会话区整体做一次 160ms 淡入+微位移（Web Animations API，
  // 不卸载树/不动布局，避免整树重建的卡顿与瞬间替换的生硬）；
  // 首次挂载不播，prefers-reduced-motion 下跳过。
  const chatPaneContentRef = useRef<HTMLDivElement>(null);
  const prevSessionIdRef = useRef(currentSessionId);
  useEffect(() => {
    const el = chatPaneContentRef.current;
    if (!el || prevSessionIdRef.current === currentSessionId) return;
    const prev = prevSessionIdRef.current;
    prevSessionIdRef.current = currentSessionId;
    // 分屏内面板间聚焦切换：各栏都已渲染、内容未变，只有聚焦边框亮起；
    // 整区重播淡入微位移会造成「抖/闪」，静默跳过（边框高亮由
    // .session-split-pane-focused 类切换承担，无动画）。
    const layout = workspaceChrome.splitLayout;
    const splitIds = layout ? splitLayoutSessionIds(layout) : [];
    const prevInSplit = Boolean(layout && prev && splitIds.includes(prev));
    const nextInSplit = Boolean(
      layout && currentSessionId && splitIds.includes(currentSessionId),
    );
    if (prevInSplit && nextInSplit) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const anim = el.animate(
      [
        { opacity: 0, transform: "translateY(4px)" },
        { opacity: 1, transform: "none" },
      ],
      { duration: 160, easing: "cubic-bezier(0.22, 1, 0.36, 1)" },
    );
    return () => anim.cancel();
  }, [currentSessionId, workspaceChrome.splitLayout]);

  const sessionTabsProps = {
    tabs: workspaceChrome.sessionTabIds,
    pinnedTabs: workspaceChrome.pinnedSessionTabIds,
    previewTabId: workspaceChrome.previewSessionTabId,
    currentSessionId,
    onSelect: workspaceChrome.selectTab,
    onPromotePreview: workspaceChrome.promotePreview,
    onClose: workspaceChrome.closeTab,
    onCloseOthers: workspaceChrome.closeOtherTabs,
    onCloseAll: workspaceChrome.closeAllTabs,
    // Tab 栏 “+” 下拉的新建目标：聊天对话区置顶，其余按侧栏项目顺序
    newSessionTargets: projects
      .map((project) => ({
        projectId: project.id,
        label: isChatProject(project) ? t("app.chatProject") : project.name,
        isChat: isChatProject(project),
      }))
      .sort((a, b) => Number(b.isChat) - Number(a.isChat)),
    onNewSessionInProject: (projectId: string) => {
      void createSessionDraftWithTab(projectId);
    },
    onTogglePin: workspaceChrome.togglePin,
    onReorder: workspaceChrome.reorderTab,
    // 分屏组胶囊：分屏内会话聚合为组（颜色标记 + 展开/收起）
    splitGroupIds: workspaceChrome.splitLayout
      ? splitLayoutSessionIds(workspaceChrome.splitLayout)
      : [],
    splitGroupCollapsed: workspaceChrome.splitGroupCollapsed,
    onToggleSplitGroup: workspaceChrome.toggleSplitGroupCollapsed,
    splitGroupName: workspaceChrome.splitGroupConfig.name,
    splitGroupColor: workspaceChrome.splitGroupConfig.color,
    onSplitGroupRename: (name: string) =>
      workspaceChrome.setSplitGroupConfig((config) => ({ ...config, name })),
    onSplitGroupColorChange: (color: string) =>
      workspaceChrome.setSplitGroupConfig((config) => ({ ...config, color })),
    onExitAllSplit: workspaceChrome.exitAllSplit,
    // Tab 下拉运行控制（织入对方收敛方案）：只对当前会话 Tab 生效。
    // 关闭会话 = 停止 Agent 运行 + 移除会话 Tab（与“关闭标签页”仅移除 Tab 不同）
    canStopCurrent: canStopBoundAgent(activeAgent?.status),
    // 会话从未启动（无绑定 agent）时隐藏“关闭会话”：停止无意义，关闭走“关闭标签页”
    onStopCurrent: activeAgentId
      ? () => {
          const sessionId = currentSessionId;
          void (async () => {
            try {
              // 必须 stopRuntime，不能 abort：abort 只取消当前一轮，pi 进程仍占用会话文件。
              // closeAgent 失败会抛错，这里不得先关 Tab。
              await closeAgent(activeAgentId);
              if (sessionId) workspaceChrome.closeTab(sessionId);
            } catch (error) {
              showToast(error instanceof Error ? error.message : String(error), 5000);
            }
          })();
        }
      : undefined,
    canRestartCurrent: Boolean(activeAgentId),
    isRestartingCurrent: restartingAgentId === activeAgentId,
    // 没有绑定运行时的草稿也有会话 ID，但重启只对已启动 Agent 有意义
    onRestartCurrent: activeAgentId
      ? () => void restartActiveAgent(activeAgentId)
      : undefined,
    onToggleDrawer: toggleRightDrawer,
    drawerOpen: Boolean(drawer && !drawerCollapsed),
    listCollapsed,
    onToggleListCollapsed: toggleListCollapsed,
    onDragSessionChange: (sessionId: string | null) => {
      if (sessionId) workspaceChrome.beginDrag(sessionId);
      else workspaceChrome.endDrag();
    },
  };

  const paneLayoutRefs = useMemo(
    () => ({
      chatHeaderRef,
      composerRef,
      composerOffsetHeight,
      terminalRowHeight,
    }),
    [composerOffsetHeight, terminalRowHeight],
  );

  // Actions 轨稳定入口：sessionPaneServices 因 terminal/git 等 State 变化重算时，
  // 这两个回调引用保持不变，SessionPaneActionsContext 才不会跟着更新。
  // 原为 useMemo 内的 inline function，每次 services 重算都会产生新函数引用。
  const runCreateSessionDraftForPane = useCallback(async () => {
    await createSessionDraftWithTab();
  }, [createSessionDraftWithTab]);

  const openSidebarSessionByIdForPane = useCallback(
    (projectId: string, sessionId: string) =>
      openSidebarSessionByIdWithTab(projectId, sessionId, "permanent"),
    [openSidebarSessionByIdWithTab],
  );

  const sessionPaneServices = useMemo(
    () => ({
      isLanWeb,
      promoteSessionToPermanent: workspaceChrome.promotePreview,
      showToast,
      onOpenFile: handleOpenLinkedFile,
      onDiffFile: diffFilePath,
      onPreviewImage: setPreviewImage,
      abortAgent,
      restartActiveAgent,
      runCreateSessionDraft: runCreateSessionDraftForPane,
      enqueueSessionPrompt,
      insertQuickPrompt,
      ensureSessionId: ensureSessionForSend,
      resendUserMessage,
      editMessage,
      deleteMessage,
      forkFromUserMessage,
      forkingMessageId,
      openSidebarSessionById: openSidebarSessionByIdForPane,
      agents: displayAgents,
      queuedPromptsBySession: queue.queuedPrompts,
      queueRetract: queue.retractQueuedPromptForEdit,
      queueDiscard: queue.discardQueuedPrompt,
      queueFlushBySessionRef,
      restartingAgentId,
      sessionDurationByAgent,
      activeProjectId,
      gitInfo,
      showThinking: settings.showThinking,
      validCommandNames,
      validFilePaths,
      terminalOpen,
      terminalDockClosing,
      terminalDockVisible,
      terminalCollapsed,
      availableTerminalHeight: availableTerminalHeight ?? 120,
      terminalOwnerKey: terminalOwner
        ? terminalOwnerKey(terminalOwner)
        : undefined,
      terminalTarget,
      setTerminalOpenForOwner,
      setTerminalCollapsedForOwner,
      setTerminalHeightByOwner,
      configOpen,
      environmentDialog: Boolean(environmentDialog),
      showNotice,
      api,
      changeChatPath,
      jumpToMessageRef,
      layoutRefs: paneLayoutRefs,
      exitSessionSplit: workspaceChrome.exitSplit,
    }),
    [
      abortAgent,
      activeProjectId,
      availableTerminalHeight,
      changeChatPath,
      configOpen,
      deleteMessage,
      diffFilePath,
      displayAgents,
      editMessage,
      enqueueSessionPrompt,
      ensureSessionForSend,
      environmentDialog,
      forkFromUserMessage,
      forkingMessageId,
      gitInfo,
      handleOpenLinkedFile,
      insertQuickPrompt,
      isLanWeb,
      jumpToMessageRef,
      openSidebarSessionByIdForPane,
      paneLayoutRefs,
      queue.discardQueuedPrompt,
      queue.queuedPrompts,
      queue.retractQueuedPromptForEdit,
      queueFlushBySessionRef,
      restartActiveAgent,
      restartingAgentId,
      runCreateSessionDraftForPane,
      resendUserMessage,
      sessionDurationByAgent,
      settings.showThinking,
      setPreviewImage,
      setTerminalCollapsedForOwner,
      setTerminalHeightByOwner,
      setTerminalOpenForOwner,
      showToast,
      terminalCollapsed,
      terminalDockClosing,
      terminalDockVisible,
      terminalOpen,
      terminalOwnerKey,
      terminalTarget,
      validCommandNames,
      validFilePaths,
      workspaceChrome.exitSplit,
      workspaceChrome.promotePreview,
    ],
  );

  const chatPaneSessionNode = (
    <SessionPaneServicesProvider value={sessionPaneServices}>
      {currentSessionId ? (
        <div ref={chatPaneContentRef} className="flex h-full min-h-0 min-w-0 flex-col">
          <SessionSplitStage
            layout={
              // 视图投影：焦点会话在布局中 → 显示分屏；不在（新建/打开/退出分屏）→ 全屏 solo，
              // 布局状态保留，点布局内会话即恢复分屏视图
              workspaceChrome.splitLayout &&
              splitLayoutSessionIds(workspaceChrome.splitLayout).includes(currentSessionId)
                ? workspaceChrome.splitLayout
                : null
            }
            draggingSessionId={workspaceChrome.draggingSessionId}
            onDropSplit={workspaceChrome.dropSplit}
            solo={
              <ChatSessionPane
                key={currentSessionId}
                sessionId={currentSessionId}
                focused
                onFocusPane={() => focusSessionPane(currentSessionId)}
                splitPane={false}
              />
            }
            soloSessionId={currentSessionId}
            tabCount={workspaceChrome.sessionTabIds.length}
            renderSession={(sessionId) => (
              <ChatSessionPane
                key={sessionId}
                sessionId={sessionId}
                focused={currentSessionId === sessionId}
                onFocusPane={() => focusSessionPane(sessionId)}
                splitPane
              />
            )}
          />
        </div>
      ) : (
        // 无当前会话（普通项目点开 / 所有 Tab 关闭）时，普通项目与 Chat 项目
        // 共享统一空态；快捷操作新建 Agent / 匿名聊天，无项目时引导添加项目。
        // 引导页同样可以打开项目级终端（owner=project），在空态下方渲染 dock。
        <>
          <div className="min-h-0 flex-1">
            {/* 无会话空态：启动 Agent / 临时对话入口，创建真实 Catalog 会话后再进时间线。 */}
            <ProjectEmptyState
              activeProject={activeProject}
              onCreateAgent={(preferences) => void createSessionDraftWithTab(undefined, preferences)}
              onCreateAnonymous={(preferences) => void createAnonymousSessionWithTab(undefined, preferences)}
              onAddProject={() => void addProject()}
            />
          </div>
          {!isLanWeb && terminalDockVisible && terminalTarget && (
            <div
              className="shrink-0"
              style={{ height: terminalCollapsed ? 34 : activeTerminalHeight }}
            >
              <SessionRuntimeDock
                key={terminalOwner ? terminalOwnerKey(terminalOwner) : undefined}
                target={terminalTarget}
                mounted={terminalDockVisible}
                open={terminalOpen}
                closing={terminalDockClosing}
                collapsed={terminalCollapsed}
                height={activeTerminalHeight}
                terminal={api.terminal}
                onOpenChange={(open) => setTerminalOpenForOwner(open)}
                onCollapsedChange={(collapsed) => setTerminalCollapsedForOwner(collapsed)}
                onHeightChange={() => {
                  // 引导页终端高度由外层固定容器持有，不需要回写
                }}
              />
            </div>
          )}
        </>
      )}
    </SessionPaneServicesProvider>
  );

  const workbenchTheme: "dark" | "light" =
    typeof document !== "undefined" && document.documentElement.dataset.theme === "dark"
      ? "dark"
      : "light";

  // Git Diff 优先于文件编辑器（同一时刻只挂一份阅读面）
  const workbenchHasGitDiff = Boolean(
    gitDrawerDiff && gitDrawerDiff.projectId === activeProjectId,
  );
  const workbenchHasEditor = Boolean(activeTab) && !workbenchHasGitDiff;
  const workbenchHasContent = workbenchHasGitDiff || workbenchHasEditor;
  const workbenchLayout = workbenchHasGitDiff ? gitDiffDisplayMode : editorMode;

  // 文件/Diff Tab 挂进总 SessionTabsBar：与会话共用一条栏，内容区不再另起绿条 Tab
  const workbenchEditorTabs = workbenchHasGitDiff && gitDrawerDiff
    ? [
        {
          id: gitDrawerDiff.filePath,
          label: gitDrawerDiff.label,
          title: gitDrawerDiff.filePath,
          active: true,
        },
      ]
    : workbenchHasEditor
      ? editorTabs.map((tab) => ({
          id: tab.id,
          label:
            tab.label ??
            tab.filePath.split(/[/\\]/).pop() ??
            tab.filePath,
          title: tab.filePath,
          preview: tab.id === previewEditorTabId,
          active: tab.id === activeTabId,
        }))
      : [];

  const sessionTabsBarNode = (
    <SessionTabsBar
      {...sessionTabsProps}
      editorTabs={workbenchEditorTabs}
      onSelectEditorTab={(tabId) => {
        if (workbenchHasGitDiff) return;
        selectEditorTab(tabId);
      }}
      onCloseEditorTab={(tabId) => {
        if (workbenchHasGitDiff) {
          closeGitDiff();
          return;
        }
        closeEditorTab(tabId);
      }}
      onPromoteEditorPreview={promotePreviewEditorTab}
    />
  );

  const workbenchContentNode = workbenchHasContent ? (
    <WorkbenchContent
      theme={workbenchTheme}
      maxFileSizeMB={settings.maxEditorFileSizeMB}
      gitDiff={workbenchHasGitDiff && gitDrawerDiff ? gitDrawerDiff : null}
      gitDiffDisplayMode={gitDiffDisplayMode}
      onToggleGitDiffMode={toggleGitDiffDisplayMode}
      onCloseGitDiff={closeGitDiff}
      activeTab={workbenchHasEditor && activeTab ? activeTab : null}
      editorMode={editorMode}
      onToggleEditorMode={activeTab?.preserveDrawer ? undefined : toggleEditorMode}
      onCloseEditor={() => { closeEditor(); }}
      readContent={readEditorFileContent}
      readOriginalContent={readEditorOriginalContent}
      saveContent={saveEditorFileContent}
    />
  ) : null;

  const chatPaneContentNode = (
    <WorkbenchStage
      chrome={sessionTabsBarNode}
      layout={workbenchLayout}
      hasContent={workbenchHasContent}
      session={chatPaneSessionNode}
      content={workbenchContentNode}
    />
  );

  // ── DrawerSurface port objects (stable via useMemo) ──
  const drawerPorts = useDrawerPorts({
    editorMode, activeTab, activeTabId, editorTabs,
    toggleEditorMode, selectEditorTab, closeEditorTab, closeEditor,
    readEditorFileContent, readEditorOriginalContent, saveEditorFileContent,
    prevDrawerPanelRef, clearEditorBack,
    maxEditorFileSizeMB: settings.maxEditorFileSizeMB,
    enableGitManagement: settings.enableGitManagement, activeProjectId,
    gitDrawerDiff, gitDiffDisplayMode,
    openCommitFileDiff, openWorkspaceFileDiff,
    toggleGitDiffDisplayMode, closeGitDiff,
    gitApi: api.git, gitInfo,
    switchBranch, createBranch,
    openDrawer: workspace.openDrawer,
    closeDrawer: workspace.closeDrawer,
    collapseDrawer: workspace.collapseDrawer,
    sessionsProject, sessionsProjectId,
    files, sessions,
    sessionSourceFilter, sessionHistoryLoading,
    expandedDirs,
    onToggleDirectory: toggleDirectory,
    onCollapseAllDirectories: collapseAllDirectories,
    setFileMenu: (menu: { x: number; y: number; node: FileTreeNode } | null) => {
      setFileMenu(menu);
      if (!menu) return;
      try {
        setHasClipboardFiles(api.files.getClipboardPaths().length > 0);
      } catch {
        setHasClipboardFiles(false);
      }
    },
    refreshFiles,
    projects,
    refreshProjectSessions,
    runOpenSidebarSession: async (projectId: string, session: SessionSummary) => {
      const openedId = await runOpenSidebarSession(projectId, session);
      if (openedId) workspaceChrome.registerOpenSession(openedId, "permanent");
    },
    isSameSessionPath,
    runCopySession, runExportHistorySession, runDeleteHistorySession,
    viewFilePath, openFilePath, openEditorTab,
    api, t,
    projectRoot: activeProject?.path,
    onDropFiles: (targetDir, fileList) => {
      // 从 OS 拖入：解析本地路径后复制到目标目录（目录不支持跨源复制时跳过）
      const paths: string[] = [];
      for (let i = 0; i < fileList.length; i++) {
        const file = fileList.item(i);
        if (file) {
          const path = api.files.getPathForFile(file);
          if (path) paths.push(path);
        }
      }
      if (paths.length > 0) {
        void api.files.copy(paths, targetDir).then(() => {
          void refreshFiles();
          showToast(t("app.fileCopyDone", { count: paths.length }), 2000);
        }).catch((error) => {
          showToast(error instanceof Error ? error.message : String(error), 4000);
        });
      }
    },
    onPasteFiles: (targetDir) => {
      // 粘贴：从系统剪贴板读取资源管理器复制的文件路径，复制到目标目录
      try {
        const paths = api.files.getClipboardPaths();
        if (paths.length > 0) {
          void api.files.copy(paths, targetDir).then(() => {
            void refreshFiles();
            showToast(t("app.fileCopyDone", { count: paths.length }), 2000);
          }).catch((error) => {
            showToast(t("app.filePasteFailed", { error: error instanceof Error ? error.message : String(error) }), 4000);
          });
        }
      } catch { /* 剪贴板不可用 */ }
    },
    onMoveFiles: (sourcePaths, targetDir) => {
      // 文件树内部拖拽移动：同设备 rename，跨设备 cp+rm
      void api.files.move(sourcePaths, targetDir).then(() => {
        void refreshFiles();
        showToast(t("app.fileMoveDone", { count: sourcePaths.length }), 2000);
      }).catch((error) => {
        showToast(error instanceof Error ? error.message : String(error), 4000);
      });
    },
  });


  return (
    <>
      <AppBootstrap {...bootstrapProps} />
    <AppShell
      listCollapsed={listCollapsed}
      listWidth={listWidth}
      drawer={drawer}
      drawerCollapsed={drawerCollapsed}
      drawerWidth={drawerWidth}
      useNativeTitleBar={settings.useNativeTitleBar}
      platform={appInfo.platform}
      chatPaneRef={chatPaneRef}
      terminalRowHeight={terminalRowHeight}
      chatContentWidthPct={settings.chatContentWidthPct}
      sidebarContent={sidebarContentNode}
      chatPaneContent={chatPaneContentNode}
      drawerRail={
        <WorkspaceDrawerRail
          actions={[
            {
              id: "files",
              label: t("app.files"),
              icon: <FolderOpen size={16} />,
              active: drawer === "files",
              onClick: () => handleToolDrawerAction("files"),
            },
            // 编辑器与文件互为独立面板：文件树负责浏览，编辑器承载所有已打开文件
            {
              id: "editor",
              label: t("editor.fileEditor"),
              icon: <SquarePen size={16} />,
              active: drawer === "editor",
              onClick: () => handleToolDrawerAction("editor"),
            },
            // Git 面板受设置开关与项目上下文双重门控，与 outline 入口保持一致
            ...(settings.enableGitManagement && activeProjectId ? [{
              id: "git",
              label: t("drawer.sourceControl"),
              icon: <GitBranch size={16} />,
              active: drawer === "git",
              onClick: () => handleToolDrawerAction("git"),
            }] : []),
          ]}
        />
      }
      drawerContent={(visibleDrawerPanel) => (
        <DrawerSurface
          drawer={visibleDrawerPanel}
          drawerCollapsed={drawerCollapsed}
          editor={drawerPorts.editor}
          git={drawerPorts.git}
          chrome={drawerPorts.chrome}
          files={drawerPorts.files}
        />
      )}
      outlineContent={
        /* 悬浮工具条常驻：引导页（无会话）/未激活 agent 也保留草稿纸、终端、编辑器入口。
           大纲导航列表在无消息时自动 disabled，不影响工具按钮使用。 */
        <OutlinePanel
          // 分屏下由聚焦 pane 的 timeline 注入 jump 回调（ChatSessionPane 写入 services）
          onJump={(messageId) => jumpToMessageRef.current?.(messageId)}
          extraAction={{
            active: scratchPad.isOpen,
            label: t("scratchPad.openTooltip"),
            onClick: () => scratchPad.toggle(),
            icon: <Pencil size={14} />,
          }}
          // 终端按钮绑定 owner（agent 或项目），不再要求 agent 已激活；
          // web 预览 / 无可用目标（纯聊天无项目）时隐藏，避免指向无处可开的终端
          terminalAction={!isLanWeb && terminalTarget ? {
            active: terminalOpen,
            label: t("app.terminal"),
            onClick: () => {
              setTerminalOpenForOwner(!terminalOpen);
            },
            icon: <Terminal size={14} />,
          } : undefined}
          filesAction={undefined}
          gitAction={undefined}
          editorsAction={{
            active: editorsOpen,
            label: t("app.openWithEditor"),
            onClick: (e) => {
              const projectPath =
                activeAgent?.cwd ||
                (activeProject && !isChatProject(activeProject)
                  ? activeProject.path
                  : null);
              const btn = (e?.currentTarget as HTMLElement)?.closest("button");
              const anchor = btn
                ? adjustMenuPos(btn.getBoundingClientRect().left - 4, btn.getBoundingClientRect().top, 220, 280)
                : undefined;
              workspace.openExternalEditorChooser(projectPath || "", anchor);
            },
            icon: <Code size={14} />,
          }}
          // Skills 快捷入口：仅 Native 显示（LAN Web 不允许直接操作宿主机全局 ~/.pi 与 ~/.agents Skills）。
          // 全局门控：任意项目任意 Agent working / pending working / 有排队消息 / stop all 进行中时禁用。
          skillsAction={!isLanWeb ? {
            active: skillsQuickOpen,
            disabled: skillsQuickLocked,
            label: skillsQuickLocked
              ? t("skills.quickUnavailable")
              : t("config.nav.skills"),
            onClick: () => {
              // 点击瞬间再次检查 busy，防止状态变化与点击之间的 race。
              if (skillsQuickLocked) return;
              skillsQuickChangedRef.current = false;
              setSkillsQuickOpen(true);
            },
            icon: <Sparkles size={14} />,
          } : undefined}
        />
      }
      setListCollapsed={setListCollapsed}
      setListWidth={setListWidth}
      setDrawerCollapsed={setDrawerCollapsed}
      setDrawerWidth={setDrawerWidth}
      onToggleListCollapsed={toggleListCollapsed}
      drawerPinned={workspace.drawerPinned}
      onDrawerCollapse={workspace.collapseDrawer}
      onDrawerClose={workspace.closeDrawer}
      onDrawerRestore={() => workspace.expandDrawer()}
      onToggleDrawerPin={workspace.toggleDrawerPinned}
      toggleAlwaysOnTop={api.app.toggleAlwaysOnTopWindow}
      minimizeWindow={api.app.minimizeWindow}
      toggleMaximizeWindow={api.app.toggleMaximizeWindow}
      isWindowMaximized={api.app.isWindowMaximized}
      onWindowMaximizedChange={api.app.onWindowMaximizedChange}
      closeWindow={api.app.closeWindow}
      beginWindowDrag={api.app.beginWindowDrag}
    >

    {fileMenu && (
      <FileContextMenu
        menu={fileMenu}
        hasClipboardFiles={hasClipboardFiles}
        onPaste={(targetDir) => {
          // 右键菜单「粘贴文件到此处」：读剪贴板路径复制到目标目录
          try {
            const paths = api.files.getClipboardPaths();
            if (paths.length > 0) {
              void api.files.copy(paths, targetDir).then(() => {
                void refreshFiles();
                showToast(t("app.fileCopyDone", { count: paths.length }), 2000);
              }).catch((error) => {
                showToast(t("app.filePasteFailed", { error: error instanceof Error ? error.message : String(error) }), 4000);
              });
            }
          } catch { /* 剪贴板不可用 */ }
          setFileMenu(null);
        }}
        onClose={() => setFileMenu(null)}
        onOpen={() => {
          void api.files.open(fileMenu.node.path);
          setFileMenu(null);
        }}
        onReveal={() => {
          void api.files.showInFolder(fileMenu.node.path);
          setFileMenu(null);
        }}
        onAttach={() => {
          setPrompt(
            (current) =>
              `${current}${current.endsWith(" ") || current.length === 0 ? "" : " "}@${fileMenu.node.relativePath} `,
          );
          setFileMenu(null);
        }}
        onCopyPath={() => {
          void navigator.clipboard.writeText(fileMenu.node.path);
          setFileMenu(null);
          showToast(t("app.pathCopied"), 1200);
        }}
        onRename={() => {
          const node = fileMenu.node;
          setRenamingFile({ path: node.path, name: node.name });
          setRenamingFileInput(node.name);
          setFileMenu(null);
        }}
        onDelete={() => {
          const node = fileMenu.node;
          setFileMenu(null);
          overlays.showConfirm({
            title: node.type === "directory" ? t("drawer.deleteFolderTitle") : t("drawer.deleteFileTitle"),
            message: node.type === "directory"
              ? t("drawer.deleteFolderConfirm", { name: node.name })
              : t("drawer.deleteFileConfirm", { name: node.name }),
            danger: true,
            confirmLabel: t("common.delete"),
            onConfirm: async () => {
              overlays.clearConfirm();
              try {
                await api.files.delete(node.path, true);
                void refreshFiles();
                showToast(t("app.fileDeleted"), 2000);
              } catch (e) {
                console.error("[File] 删除失败:", e);
              }
            },
          });
        }}
      />
    )}

    {projectResourcesProject && (
      <Suspense fallback={null}>
        <ProjectResourcesModal
          project={projectResourcesProject}
          onClose={() => setProjectResourcesProject(null)}
        />
      </Suspense>
    )}
    <RenameModals
      agentRename={rename.renameModalsProps.agentRename}
      fileRename={renamingFile ? {
        path: renamingFile.path,
        name: renamingFile.name,
        inputValue: renamingFileInput,
        onInputChange: setRenamingFileInput,
        onClose: () => setRenamingFile(null),
        onConfirm: (path, newName) => {
          void api.files.rename(path, newName).then(() => {
            void refreshFiles();
            setRenamingFile(null);
            showToast(t("app.fileRenamed"), 2000);
          }).catch((err) => console.error("[File] rename failed:", err));
        },
      } : undefined}
    />

    {/* old conditional wrapping — replaced by EnvironmentOverlay open prop below */}
    <EnvironmentOverlay open={environmentDialog}>
      <EnvironmentDialog
        status={piStatus}
        checking={piChecking}
        onClose={() => {
          setEnvironmentDialog(false);
          piUpdate.setCustomPathResult(null);
          // 关闭时重置安装状态
          piUpdate.setInstallResult(null);
          piUpdate.setInstallCompleted(false);
          piUpdate.setNpmAvailable(null);
        }}
        onRecheck={() => {
          piUpdate.setCustomPathResult(null);
          piUpdate.setNpmAvailable(null);
          piUpdate.setNpmVersion(undefined);
          piUpdate.setInstallResult(null);
          piUpdate.setInstallCompleted(false);
          piUpdate.setInstallUseMirror(false);
          piUpdate.checkPiInstall("manual");
        }}
        onOpenInstallDocs={() =>
          api.app.openExternal(
            "https://pi.dev/docs/latest/quickstart#install",
          )
        }
        customPath={piUpdate.customPiPath}
        customPathValidating={piUpdate.customPathValidating}
        customPathResult={piUpdate.customPathResult}
        onCustomPathChange={(path) => {
          piUpdate.setCustomPiPath(path);
          piUpdate.setCustomPathResult(null);
        }}
        onValidateCustomPath={() =>
          piUpdate.validateCustomPiPath({ closeDialogOnSuccess: true })
        }
        npmAvailable={piUpdate.npmAvailable}
        npmVersion={piUpdate.npmVersion}
        npmChecking={piUpdate.npmChecking}
        installCommand={piUpdate.installCommand}
        installUseMirror={piUpdate.installUseMirror}
        installExecuting={piUpdate.installExecuting}
        installResult={piUpdate.installResult}
        installCompleted={piUpdate.installCompleted}
        onCheckNpm={piUpdate.checkNpm}
        onInstallCommandChange={(cmd) => {
          piUpdate.setInstallCommand(cmd);
          piUpdate.setInstallResult(null);
          piUpdate.setInstallCompleted(false);
        }}
        onToggleInstallMirror={() => {
          piUpdate.setInstallUseMirror((prev) => {
            if (prev) {
              piUpdate.setInstallCommand((cmd) =>
                cmd.replace(
                  /\s+--registry=https:\/\/registry\.npmmirror\.com/g,
                  "",
                ),
              );
            } else {
              piUpdate.setInstallCommand((cmd) =>
                cmd.includes("--registry=")
                  ? cmd
                  : cmd + " --registry=https://registry.npmmirror.com",
              );
            }
            return !prev;
          });
          piUpdate.setInstallResult(null);
          piUpdate.setInstallCompleted(false);
        }}
        onExecInstall={piUpdate.execInstallCommand}
        onRestartApp={() => api.app.restart()}
        onClearCheckFlag={async () => {
          await api.settings.update({ piEnvironmentChecked: false });
          showToast(t("environment.checkFlagCleared"));
        }}
      />
    </EnvironmentOverlay>
    <SettingsFeatureRoot
      settings={settings}
      piUpdate={piUpdate}
      appUpdate={appUpdate}
      webServiceChanging={webServiceChanging}
      onRestartWebService={restartWebService}
      appInfo={appInfo}
      onChange={updateSettings}
      onCurrentVersion={setUpToDateVersion}
    />
    <SessionActionOverlays
      {...overlays.overlayProps}
    />
    <AppUpdateOverlay
      controller={appUpdate}
      releasesUrl={appInfo.releasesUrl}
      openExternal={(url, forceSystem) => api.app.openExternal(url, forceSystem)}
      upToDateVersion={upToDateVersion}
      onDismissUpToDate={() => setUpToDateVersion(null)}
    />
    {previewImage && (
      <ImagePreviewModal
        image={previewImage}
        onClose={() => setPreviewImage(null)}
      />
    )}
    {codexImportProject && <ImportOverlayHost kind="codex" project={codexImportProject} controller={codexImportController} onClose={() => setCodexImportProject(null)} />}
    {claudeImportProject && <ImportOverlayHost kind="claude" project={claudeImportProject} controller={claudeImportController} onClose={() => setClaudeImportProject(null)} />}
    {openCodeImportProject && <ImportOverlayHost kind="opencode" project={openCodeImportProject} controller={openCodeImportController} onClose={() => setOpenCodeImportProject(null)} />}
    <Suspense fallback={null}>
    <ConfigModal
      open={configOpen}
      onClose={() => setConfigOpen(false)}
      onSaved={() => {
        // 配置保存后不再自动 reload,用户可通过 Restart 按钮手动重载
      }}
    />
    </Suspense>

    {/* Scratch Pad（草稿本）：根级渲染，避免受 chat-pane grid 影响定位 */}
    <ScratchPadOverlay controller={scratchPad} />

    {/* Skills 快捷管理小窗口：全局配置，根级渲染，不随某个 session pane 的 mount/unmount 卸载。
        locked 用 skillsRuntimeBusy（不含 skillsStoppingAgents 自身）+ stopping，保证 stop 过程中 toggle 全禁。 */}
    {!isLanWeb && (
      <SkillsQuickDialog
        open={skillsQuickOpen}
        locked={skillsRuntimeBusy || skillsStoppingAgents}
        onChanged={() => {
          skillsQuickChangedRef.current = true;
        }}
        onRequestClose={handleSkillsQuickClose}
      />
    )}

    {/* 并行问询结果弹框（AskPanel）：独立匿名会话的结果展示，根级渲染 */}
    <AskPanelOverlay />

    {/* 外部编辑器选择气泡 */}
    <ExternalEditorOverlay
      open={editorsOpen}
      editors={externalEditors}
      anchor={editorsAnchor}
      projectPath={editorsTargetPath}
      onClose={() => workspace.closeExternalEditorChooser()}
      onOpenProject={(editor, path) => workspace.openProjectInExternalEditor(editor)}
      onError={(error) => showToast(t("app.openEditorFailed", {error: String(error)}), 3000)}
    />

    </AppShell>
    </>
  );
}

// test
