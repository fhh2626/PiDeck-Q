import { memo, useEffect, useState, type ComponentType, type ReactNode } from "react";
import { SquarePen } from "lucide-react";
import { BrowserSurface } from "./BrowserSurface";
import { LazyWrapper } from "../../hooks/useLazyComponent";
import type { WorkspaceDrawerPanel } from "../../hooks/useWorkspacePanels";
import { t } from "../../i18n";
import { Button } from "../ui-shadcn/button";

// ── port objects (typed loosely — type tightening is a follow-up task) ──

/**
 * 重 Drawer 面板按需 import：静态 import 只会「延迟 mount」，这些大模块仍进初始 bundle；
 * 改成动态 import 后，Git drawer 第一次真正打开才加载 GitPanel 的 JS chunk，
 * DrawerContent（files/sessions，含 file-icons 等重依赖）同样按需加载。
 *
 * 采用 MarkdownStream 的「全局 Promise 缓存 + 失败清缓存」模式：
 * - 模块级 promise 缓存：未打开 drawer 时 chunk 不下载；打开后组件缓存到模块级，
 *   后续切走/再开立即命中，不再闪一次加载占位。
 * - import 失败清缓存：重新打开 drawer 可重试，不会永久卡在失败态。
 *
 * 注意：这里 props 用 any，是为了在「面板未加载」时不强制把 GitPanel/DrawerContent 的
 * props 类型静态拉进来（它们内部 type 未导出，内联 props 更直接）。
 */
type DrawerPanelComponent = ComponentType<any>;
let gitPanelPromise: Promise<DrawerPanelComponent> | undefined;
let cachedGitPanel: DrawerPanelComponent | null = null;
function loadGitPanel(): Promise<DrawerPanelComponent> {
  if (cachedGitPanel) return Promise.resolve(cachedGitPanel);
  if (!gitPanelPromise) {
    gitPanelPromise = import("../app/GitPanel")
      .then((m) => {
        cachedGitPanel = m.GitPanel;
        return cachedGitPanel;
      })
      .catch((error: unknown) => {
        gitPanelPromise = undefined;
        throw error;
      });
  }
  return gitPanelPromise;
}
let drawerContentPromise: Promise<DrawerPanelComponent> | undefined;
let cachedDrawerContent: DrawerPanelComponent | null = null;
function loadDrawerContent(): Promise<DrawerPanelComponent> {
  if (cachedDrawerContent) return Promise.resolve(cachedDrawerContent);
  if (!drawerContentPromise) {
    drawerContentPromise = import("../session/DrawerContent")
      .then((m) => {
        cachedDrawerContent = m.DrawerContent;
        return cachedDrawerContent;
      })
      .catch((error: unknown) => {
        drawerContentPromise = undefined;
        throw error;
      });
  }
  return drawerContentPromise;
}

/**
 * 按需加载的面板宿主：import 中显示 loading 占位，import 后渲染真实面板；
 * 失败时显示错误占位（不 crash 整个 App），重新打开 drawer 会重试。
 */
const LazyPanel = memo(function LazyPanel(props: {
  loader: () => Promise<DrawerPanelComponent>;
  placeholder: ReactNode;
  children: (Component: DrawerPanelComponent) => ReactNode;
}) {
  const [Component, setComponent] = useState<DrawerPanelComponent | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    setFailed(false);
    props
      .loader()
      .then((Component) => {
        if (active) setComponent(Component);
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, [props.loader]);

  if (failed) {
    return (
      <div className="drawer-content-frame grid min-h-0 flex-1 place-items-center text-body text-muted-foreground">
        {t("drawer.lazyFailed")}
      </div>
    );
  }
  if (!Component) {
    return (
      <div className="drawer-content-frame min-h-0 flex-1">{props.placeholder}</div>
    );
  }
  return <>{props.children(Component)}</>;
});

export interface DrawerEditorPort {
  editorMode: string;
  activeTab: any;
  activeTabId: string | null;
  editorTabs: any[];
  toggleEditorMode: () => void;
  selectEditorTab: (id: string) => void;
  closeEditorTab: (id: string) => void;
  closeEditor: () => void;
  readEditorFileContent: (path: string) => Promise<string>;
  readEditorOriginalContent: any;
  saveEditorFileContent: ((path: string, content: string) => Promise<void>) | undefined;
  prevDrawerPanelRef: React.MutableRefObject<WorkspaceDrawerPanel | null>;
  clearEditorBack: () => WorkspaceDrawerPanel | null;
  maxEditorFileSizeMB: number;
}

export interface DrawerGitPort {
  enableGitManagement: boolean;
  activeProjectId: string | undefined;
  gitDrawerDiff: any;
  gitDiffDisplayMode: string;
  openCommitFileDiff: any;
  openWorkspaceFileDiff: any;
  toggleGitDiffDisplayMode: () => void;
  closeGitDiff: () => void;
  gitApi: any;
  gitInfo: any;
  switchBranch: any;
  createBranch: any;
}

export interface DrawerChromePort {
  onOpenDrawer: (panel: WorkspaceDrawerPanel) => void;
  onCloseDrawer: () => void;
  onCollapseDrawer: () => void;
}

export interface DrawerBrowserPort {
  browserFullscreen: boolean;
  onCloseBrowser: () => void;
  onMinimizeBrowser: () => void;
  onEnterBrowserFullscreen: () => void;
}

export interface DrawerFilesPort {
  sessionsProject: any;
  sessionsProjectId: string | undefined;
  files: any[];
  sessions: any[];
  sessionSourceFilter: Record<string, Set<string> | null>;
  sessionHistoryLoading: boolean;
  expandedDirs: Set<string>;
  onToggleDirectory: (dir: string) => void;
  onCollapseAllDirectories: () => void;
  setFileMenu: any;
  refreshFiles: any;
  projects: any[];
  refreshProjectSessions: any;
  runOpenSidebarSession: any;
  isSameSessionPath: any;
  runCopySession: any;
  runExportHistorySession: any;
  runDeleteHistorySession: any;
  viewFilePath: any;
  openFilePath: any;
  /** 在中间栏编辑器打开（可编辑 tab）；Git 变更行内“打开”按钮使用 */
  openEditorTab: any;
  api: any;
  t: any;
  /** 当前项目根目录：文件面板空白处拖入/粘贴/右键菜单的落点 */
  projectRoot: string | undefined;
  /** 从 OS 拖入文件（复制到目标目录） */
  onDropFiles: (targetDir: string, files: FileList) => void;
  /** 粘贴剪贴板文件（Ctrl+V / 右键菜单） */
  onPasteFiles: (targetDir: string) => void;
  /** 文件树内部拖拽移动 */
  onMoveFiles: (sourcePaths: string[], targetDir: string) => void;
}

export interface DrawerSurfaceProps {
  drawer: WorkspaceDrawerPanel | null;
  drawerCollapsed: boolean;
  editor: DrawerEditorPort;
  git: DrawerGitPort;
  chrome: DrawerChromePort;
  browser: DrawerBrowserPort;
  files: DrawerFilesPort;
}

export function DrawerSurface(props: DrawerSurfaceProps) {
  const { drawer, drawerCollapsed, editor, git, chrome, browser, files } = props;

  // 面板 import 中/未就绪的加载占位（git 与 files/sessions 共用），与下方 LazyWrapper
  // 的 placeholder 同文案，保持视觉一致。
  const panelPlaceholder = (
    <div style={{
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      height: "100%",
      color: "var(--text-secondary)",
      fontSize: "14px"
    }}>
      {t("drawer.lazyLoading")}
    </div>
  );

  return (
    <>
      {/* 各面板不再挂「标题 + ×」顶栏：关闭/切换改走会话 Tab 栏右侧活动图标。 */}
      {drawer === "editor" && !drawerCollapsed ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
          <SquarePen size={28} className="text-muted-foreground/50" aria-hidden="true" />
          <div className="text-body font-medium text-foreground">{t("editor.emptyTitle")}</div>
          <p className="max-w-60 text-caption text-muted-foreground">{t("editor.emptyHint")}</p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => chrome.onOpenDrawer("files")}
          >
            {t("editor.emptyOpenFiles")}
          </Button>
        </div>
      ) : drawer === "browser" && !drawerCollapsed ? (
        <div className="drawer-content-frame flex min-h-0 flex-1 flex-col overflow-hidden">
          <BrowserSurface
            fullscreen={browser.browserFullscreen}
            onClose={browser.onCloseBrowser}
            onMinimize={browser.onMinimizeBrowser}
            onEnterFullscreen={browser.onEnterBrowserFullscreen}
          />
        </div>
      ) : git.enableGitManagement && drawer === "git" && !drawerCollapsed && git.activeProjectId ? (
        <LazyPanel
          loader={loadGitPanel}
          placeholder={panelPlaceholder}
        >
          {(Component) => (
            <div className="drawer-content-frame flex min-h-0 flex-1 flex-col overflow-hidden">
              <div className="git-drawer-stack">
                <div className="git-drawer-source">
                  <Component
                    projectId={git.activeProjectId}
                    projectRoot={files.projects.find((project: any) => project.id === git.activeProjectId)?.path}
                    commitLog={git.gitApi.commitLog}
                    commitDetail={git.gitApi.commitDetail}
                    onOpenCommitFileDiff={git.openCommitFileDiff}
                    onOpenWorkspaceFileDiff={git.openWorkspaceFileDiff}
                    onOpenFile={files.openEditorTab}
                    branchCompare={git.gitApi.branchCompare}
                    getStatus={git.gitApi.status}
                    stageFiles={git.gitApi.stage}
                    unstageFiles={git.gitApi.unstage}
                    discardFile={git.gitApi.discard}
                    commit={git.gitApi.commit}
                    branches={git.gitInfo.branches}
                    currentBranch={git.gitInfo.current}
                    onSwitchBranch={git.switchBranch}
                    onCreateBranch={git.createBranch}
                    cherryPick={git.gitApi.cherryPick}
                    revert={git.gitApi.revert}
                    reset={git.gitApi.reset}
                    dropCommit={git.gitApi.dropCommit}
                    generateCommitMessage={git.gitApi.generateCommitMessage}
                    gitInit={git.gitApi.init}
                    push={git.gitApi.push}
                    pull={git.gitApi.pull}
                    fetch={git.gitApi.fetch}
                    aheadBehind={git.gitApi.aheadBehind}
                    deleteFiles={git.gitApi.deleteFiles}
                  />
                </div>
              </div>
            </div>
          )}
        </LazyPanel>
      ) : drawer && drawer !== "browser" && drawer !== "editor" && drawer !== "git" ? (
        <LazyWrapper
          // 滚动层上移到这里：files/sessions 面板自身不再滚动（见 timeline.css
          // .files-panel/.sessions-panel 注释），占位与内容共用同一滚动容器，配合
          // scrollbar-gutter: stable 让内容宽度不随滚动条出现/消失跳变——
          // 否则切 tab 重挂时占位(无滚动条,320) → 内容(有滚动条,310) 瞬间收窄，
          // 且树高度跨阈值时滚动条反复出现/消失，形成“呼吸式”宽度摆动。
          className="drawer-content-frame overflow-y-auto overscroll-contain [scrollbar-gutter:stable]"
          enabled={true}
          threshold={0}
          rootMargin="50px"
          placeholder={panelPlaceholder}
        >
          <LazyPanel
            loader={loadDrawerContent}
            placeholder={panelPlaceholder}
          >
            {(Component) => (
              <Component
                panel={drawer}
                project={drawer === "sessions" ? files.sessionsProject : undefined}
                files={files.files}
                sessions={(files.sessionsProjectId && files.sessionSourceFilter[files.sessionsProjectId as string]) ? files.sessions.filter(
                  (s: any) => !s.parentSessionPath && (files.sessionSourceFilter[files.sessionsProjectId as string]!)!.has(s.source ?? "pi"),
                ).concat(files.sessions.filter((s: any) => s.parentSessionPath && (files.sessionSourceFilter[files.sessionsProjectId as string]!)!.has(s.source ?? "pi"))) : files.sessions}
                sessionsLoading={files.sessionHistoryLoading}
                expandedDirs={files.expandedDirs}
                onToggleDirectory={files.onToggleDirectory}
                onCollapseAllDirectories={files.onCollapseAllDirectories}
                onClose={chrome.onCloseDrawer}
                onFileContextMenu={(node: any, x: number, y: number) => files.setFileMenu({ node, x, y })}
                onRefreshFiles={() => {
                  files.refreshFiles(git.activeProjectId);
                }}
                onOpenFolder={() => {
                  const p = files.projects.find((p: any) => p.id === git.activeProjectId);
                  if (p) void files.api.files.open(p.path);
                }}
                projectRoot={files.projectRoot}
                onDropFiles={files.onDropFiles}
                onPasteFiles={files.onPasteFiles}
                onMoveFiles={files.onMoveFiles}
                onRefreshSessions={() => {
                  const projectId = files.sessionsProjectId ?? git.activeProjectId;
                  if (projectId) void files.refreshProjectSessions(projectId, true);
                }}
                onOpenSession={(session: any) =>
                  void files.runOpenSidebarSession(
                    files.sessionsProjectId ?? git.activeProjectId ?? "",
                    session,
                  )
                }
                onRenameSession={async (filePath: string, newName: string) => {
                  const session = files.sessions.find((candidate: any) =>
                    files.isSameSessionPath(
                      candidate.filePath,
                      filePath,
                      candidate.wsl ? "wsl" : "native",
                    ),
                  );
                  if (!session) return;
                  await files.api.sessions.updateRecord(session.id, { title: newName });
                  const projectId = files.sessionsProjectId ?? git.activeProjectId;
                  if (projectId) await files.refreshProjectSessions(projectId, true);
                }}
                onCopySession={(session: any) =>
                  files.runCopySession(
                    session.id,
                    files.sessionsProjectId ?? git.activeProjectId,
                  )
                }
                onExportSession={files.runExportHistorySession}
                onDeleteSession={files.runDeleteHistorySession}
                onViewFile={files.viewFilePath}
                onOpenFile={files.openFilePath}
              />
            )}
          </LazyPanel>
        </LazyWrapper>
      ) : null}
    </>
  );
}
