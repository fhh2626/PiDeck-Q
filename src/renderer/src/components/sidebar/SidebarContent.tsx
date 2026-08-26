import { Search, Settings, Sliders, FolderPlus, Loader2 } from "lucide-react";
import { useState, type ReactNode } from "react";
import type { AgentTab, Project, SessionRecord, SessionSummary, WorktreeEntry } from "../../../../shared/types";
import {
  AgentContextMenu,
  DraftSessionContextMenu,
  ProjectContextMenu,
  SessionContextMenu,
  SessionManagerModal,
  SessionSourceFilterMenu,
  WorktreeCreateDialog,
  RpcLogOpenedDialog,
} from "./SidebarParts";
import { RpcLogViewer } from "./RpcLogViewer";
import { sessionRecordToSummary } from "../../atoms";
import { t } from "../../i18n";
import { showNotice } from "../../utils/notice";
import { getBoundSidebarRuntimeAgent, getBoundSidebarRuntimeAgentByAgentId, hasLiveSidebarRuntime, type SidebarController, type SidebarRpcLog } from "../../hooks/useSidebarController";
import { ProjectTree } from "./ProjectTree";
import { Button } from "../ui-shadcn/button";
import { Input } from "../ui-shadcn/input";

export type SidebarActions = {
  projects: {
    add: () => Promise<void>;
    select: (projectId: string) => void;
    refresh: (projectId: string) => Promise<void>;
    reorder: (sourceProjectId: string, targetProjectId: string) => Promise<void>;
    reveal: (project: Project) => Promise<void>;
    openWithEditor: (project: Project) => void;
    importSessions: (project: Project, source: "codex" | "claude" | "opencode") => void;
    manageResources: (project: Project) => void;
    toggleWorktree: (project: Project) => Promise<void>;
    copyPath: (project: Project) => Promise<void>;
    remove: (project: Project) => Promise<void>;
    changeChatPath?: (project: Project) => Promise<void>;
  };
  sessions: {
    /** 单击默认 preview；双击传 permanent。侧栏拖拽分屏也会走 open。 */
    open: (
      projectId: string,
      sessionId: string,
      tabMode?: "preview" | "permanent",
    ) => Promise<void>;
    /** 侧栏会话开始拖拽（与 Tab 栏共用 MIME，可拖到聊天区边缘分屏） */
    beginDrag?: (sessionId: string) => void;
    endDrag?: () => void;
    createDraft: (projectId: string) => Promise<void>;
    createAnonymous: (projectId: string) => Promise<void>;
    deleteDraft: (session: SessionRecord) => Promise<void>;
    rename: (projectId: string, session: SessionSummary) => void;
    export: (projectId: string, session: SessionSummary) => Promise<void>;
    copy: (projectId: string, session: SessionSummary) => Promise<void>;
    copyPath: (session: SessionSummary) => Promise<void>;
    openFile: (session: SessionSummary) => Promise<void>;
    delete: (projectId: string, session: SessionSummary) => Promise<void>;
    /** 归档会话（可恢复） */
    archive: (projectId: string, session: SessionSummary) => Promise<void>;
    /** 恢复归档会话 */
    unarchive: (session: SessionSummary, projectId?: string) => Promise<void>;
    /** 列出已归档会话 */
    listArchived: () => Promise<SessionSummary[]>;  };
  agents: {
    rename: (agent: AgentTab) => void;
    export: (agent: AgentTab) => Promise<void>;
    copySession: (agent: AgentTab) => Promise<void>;
    copyPath: (agent: AgentTab) => Promise<void>;
    openSessionFile: (agent: AgentTab) => Promise<void>;
    close: (agent: AgentTab) => Promise<void>;
  };
  worktrees: {
    create: (projectId: string, branchName: string) => Promise<void>;
    remove: (parentProjectId: string, entry: WorktreeEntry, childProject?: Project) => Promise<void>;
  };
  rpc: {
    getLogging: (agentId: string) => Promise<boolean>;
    setLogging: (agentId: string, enabled: boolean) => Promise<boolean>;
    listLogs: (agentId: string) => Promise<SidebarRpcLog[]>;
  };
};

export type SidebarContentProps = {
  controller: SidebarController;
  actions: SidebarActions;
  currentProjectId?: string;
  currentSessionId?: string;
  worktreesByProject: Readonly<Record<string, readonly WorktreeEntry[]>>;
  branchByProject?: Readonly<Record<string, string | null | undefined>>;
  creatingWorktree?: boolean;
  isLanWeb?: boolean;
  chrome?: ReactNode;
  onOpenSettings?: () => void;
  onOpenConfig?: () => void;
};

export function SidebarContent(props: SidebarContentProps) {
  const { controller, actions } = props;
  const menu = controller.menu;
  const menuProject = menu?.kind === "project"
    ? controller.catalog.projects.find((project) => project.id === menu.projectId)
    : undefined;
  const menuAgent = menu?.kind === "agent"
    ? controller.catalog.agents.find((agent) => agent.id === menu.agentId)
    : undefined;
  // agent 是否有 live runtime：没有运行中的 pi 子进程时，RPC 日志记录无法开启
  // （记录靠主进程旁路拦截子进程通信，进程不存在则无日志可记）。
  // 注意不能拿 menuAgent.sessionId 直接查 runtimeBySessionId：AgentTab.sessionId
  // 是 pi 自身会话 id，而 runtimeBySessionId 的 key 是会话记录 id，必须按 agentId 反查。
  const menuAgentCanRpcLog = menuAgent !== undefined
    && getBoundSidebarRuntimeAgentByAgentId(controller.catalog, menuAgent.id) !== undefined;
  // “RPC 日志已打开”提醒弹框的打开目标 agent id（null = 关闭）
  const [rpcLogOpenedAgentId, setRpcLogOpenedAgentId] = useState<string | null>(null);
  const [addingProject, setAddingProject] = useState(false);
  const handleAddProject = async () => {
    if (addingProject) return;
    setAddingProject(true);
    try {
      await actions.projects.add();
    } finally {
      setAddingProject(false);
    }
  };
  const menuSessionRecord = menu?.kind === "session"
    ? controller.catalog.sessionsByProject[menu.projectId]?.find((session) => session.id === menu.sessionId)
    : undefined;
  const menuDraft = menu?.kind === "draft"
    ? controller.catalog.sessionsByProject[menu.projectId]?.find((session) => session.id === menu.sessionId)
    : undefined;
  const menuDraftRuntime = menuDraft
    ? controller.catalog.runtimeBySessionId[menuDraft.id]
    : undefined;
  const menuSession = menuSessionRecord ? sessionRecordToSummary(menuSessionRecord) : undefined;
  const menuSessionRuntimeAgent = menuSessionRecord
    ? getBoundSidebarRuntimeAgent(controller.catalog, menuSessionRecord.id)
    : undefined;
  const managerProject = controller.sessionManagerProjectId
    ? controller.catalog.projects.find((project) => project.id === controller.sessionManagerProjectId)
    : undefined;
  const currentProject = props.currentProjectId
    ? controller.catalog.projects.find((project) => project.id === props.currentProjectId)
    : undefined;
  const currentRootProject = currentProject?.worktreeParentId
    ? controller.catalog.projects.find((project) => project.id === currentProject.worktreeParentId) ?? currentProject
    : currentProject;

  return (
    <aside
      // @container：侧栏宽度容器查询基准——行操作按钮（绝对浮层）按侧栏实际宽度
      // 决定 hover 时文本是否压缩让位（pr 留出按钮空间 + 截断，见各树的 @max-[255px] 变体），
      // 不用把宽度穿进树组件
      className="chat-list-pane v3-braun @container flex h-full min-w-0 flex-col overflow-hidden bg-sidebar text-sidebar-foreground"
      aria-label={t("app.search")}
    >
      {/* 品牌区提到 body 外：贴侧栏顶边，不被 sidebar-body 的 px/py 顶开（logo 怼左上）。 */}
      {props.chrome}
      <div className="sidebar-body flex min-h-0 flex-1 flex-col gap-2 px-2 pt-1 pb-1">
        {/* 搜索只过滤导航和当前项目内容；会话加载仍由 controller/App 的懒加载策略负责。 */}
        <div className="search-row grid shrink-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded-[10px] bg-muted/25 p-1">
          <div className="search-box relative min-w-0">
            <Search
              size={12}
              className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              value={controller.search}
              onChange={(event) => controller.setSearch(event.target.value)}
              placeholder={t("app.search")}
              className="h-6 pl-7 text-caption"
            />
          </div>
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="round-add size-6 shrink-0"
            disabled={addingProject}
            aria-busy={addingProject}
            onClick={() => void handleAddProject()}
            title={t("app.addProject")}
            aria-label={t("app.addProject")}
          >
            {addingProject ? <Loader2 className="size-3.5 animate-spin" /> : <FolderPlus className="size-3.5" />}
          </Button>
        </div>

        {/* 单一滚动区承载项目与展开内容，避免项目导航/详情双滚动和重复标题。
            scrollbar-gutter: stable：滚动条出现/消失时列表宽度不跳变（与抽屉一致）。 */}
        <section className="conversation-list min-h-0 flex-1 overflow-x-hidden overflow-y-auto [scrollbar-gutter:stable]">
          <ProjectTree
            controller={controller}
            actions={actions}
            currentProjectId={currentRootProject?.id}
            selectedProjectId={props.currentProjectId}
            currentSessionId={props.currentSessionId}
            worktreesByProject={props.worktreesByProject}
            branchByProject={props.branchByProject}
          />
        </section>
      </div>
      {/* 底栏贴侧栏左下角：无垂直内边距，水平仅留 2px 防贴边裁切。 */}
      {!props.isLanWeb && (
        <div className="toolbar-actions sidebar-bottom-actions flex shrink-0 items-center gap-0 border-t border-border/40 px-0.5 py-0">
          <div className="sidebar-bottom-primary-actions flex min-w-0 flex-1 items-center gap-0">
            <Button type="button" variant="ghost" size="icon-sm" className="icon-button settings-icon size-8 rounded-none text-muted-foreground hover:bg-muted hover:text-foreground" title={t("settings.title")} aria-label={t("settings.title")} onClick={props.onOpenSettings}><Settings className="size-4" /></Button>
            <Button type="button" variant="ghost" size="icon-sm" className="icon-button config-icon size-8 rounded-none text-muted-foreground hover:bg-muted hover:text-foreground" title={t("config.title")} aria-label={t("config.title")} onClick={props.onOpenConfig}><Sliders className="size-4" /></Button>
          </div>
        </div>
      )}

      {controller.sourceFilterMenu && (
        <SessionSourceFilterMenu
          menu={controller.sourceFilterMenu}
          filter={controller.sourceFilterFor(controller.sourceFilterMenu.projectId)}
          onToggleSource={(source) =>
            controller.toggleSourceFilter(controller.sourceFilterMenu!.projectId, source)
          }
          onClear={() => controller.clearSourceFilter(controller.sourceFilterMenu!.projectId)}
          onClose={controller.closeSourceFilter}
        />
      )}
      {menuProject && menu?.kind === "project" && (
        <ProjectContextMenu
          menu={{ x: menu.x, y: menu.y, project: menuProject }}
          onClose={controller.closeMenu}
          onRevealProject={() => { void actions.projects.reveal(menuProject); controller.closeMenu(); }}
          onOpenWithEditor={() => { actions.projects.openWithEditor(menuProject); controller.closeMenu(); }}
          onImportCodexSessions={() => { actions.projects.importSessions(menuProject, "codex"); controller.closeMenu(); }}
          onImportClaudeSessions={() => { actions.projects.importSessions(menuProject, "claude"); controller.closeMenu(); }}
          onImportOpenCodeSessions={() => { actions.projects.importSessions(menuProject, "opencode"); controller.closeMenu(); }}
          onManageProjectResources={() => { actions.projects.manageResources(menuProject); controller.closeMenu(); }}
          onManageSessions={() => { controller.openSessionManager(menuProject.id); controller.closeMenu(); }}
          onFilterSessions={() => { controller.openSourceFilter(menuProject.id, menu.x, menu.y + 20); controller.closeMenu(); }}
          onToggleWorktree={() => { void actions.projects.toggleWorktree(menuProject); controller.closeMenu(); }}
          onRefreshProject={() => { void actions.projects.refresh(menuProject.id); controller.closeMenu(); }}
          onCopyProjectPath={() => { void actions.projects.copyPath(menuProject); controller.closeMenu(); }}
          onRemoveProject={() => { void actions.projects.remove(menuProject); controller.closeMenu(); }}
        />
      )}
      {menuAgent && menu?.kind === "agent" && (
        <AgentContextMenu
          menu={{ x: menu.x, y: menu.y, agent: menuAgent }}
          onClose={controller.closeMenu}
          onRename={() => { actions.agents.rename(menuAgent); controller.closeMenu(); }}
          onExport={() => { void actions.agents.export(menuAgent); controller.closeMenu(); }}
          onCopySession={() => { void actions.agents.copySession(menuAgent); controller.closeMenu(); }}
          onCopySessionFilePath={() => { void actions.agents.copyPath(menuAgent); controller.closeMenu(); }}
          onOpenSessionFile={() => { void actions.agents.openSessionFile(menuAgent); controller.closeMenu(); }}
          onToggleRpcLogging={() => {
            // 兜底：置灰的菜单项点击不触发 onSelect，这里防御 agent 状态在菜单打开期间变化的情况
            if (!menuAgentCanRpcLog) {
              showNotice(t("menu.rpcLoggingRequiresRuntime"), 2500);
              controller.closeMenu();
              return;
            }
            controller.closeMenu();
            if (controller.isAgentRpcLogging(menuAgent.id)) {
              // 已开启：菜单项显示「关闭RPC日志」→ 直接关闭记录（历史文件保留，30 天自动清理）
              void actions.rpc.setLogging(menuAgent.id, false).then((enabled) => {
                controller.setAgentRpcLogging(menuAgent.id, enabled);
                showNotice(enabled ? t("rpc.loggingDisableFailed") : t("rpc.loggingDisabled"), 2500);
              });
              return;
            }
            void actions.rpc.setLogging(menuAgent.id, true).then((enabled) => {
              controller.setAgentRpcLogging(menuAgent.id, enabled);
              if (enabled) {
                // 开启成功弹提醒框（含“查看日志”入口），不再自动打开日志弹窗
                setRpcLogOpenedAgentId(menuAgent.id);
              } else {
                showNotice(t("rpc.loggingEnableFailed"), 2500);
              }
            });
          }}
          isRpcLogging={controller.isAgentRpcLogging(menuAgent.id)}
          rpcToggleDisabled={!menuAgentCanRpcLog}
          onOpenLogs={() => { controller.openRpcLogs(menuAgent.id); controller.closeMenu(); }}
          onCloseAgent={() => { void actions.agents.close(menuAgent); controller.closeMenu(); }}
        />
      )}
      {menuDraft && menu?.kind === "draft" && menuDraft.status === "draft" && !hasLiveSidebarRuntime(menuDraftRuntime) && (
        <DraftSessionContextMenu
          menu={{ x: menu.x, y: menu.y }}
          onClose={controller.closeMenu}
          onDelete={() => { void actions.sessions.deleteDraft(menuDraft); controller.closeMenu(); }}
        />
      )}
      {menuSession && menu?.kind === "session" && (
        <SessionContextMenu
          menu={{ x: menu.x, y: menu.y, session: menuSession }}
          onClose={controller.closeMenu}
          onRename={() => { actions.sessions.rename(menu.projectId, menuSession); controller.closeMenu(); }}
          onExport={() => { void actions.sessions.export(menu.projectId, menuSession); controller.closeMenu(); }}
          onCopySession={() => { void actions.sessions.copy(menu.projectId, menuSession); controller.closeMenu(); }}
          onCopySessionFilePath={() => { void actions.sessions.copyPath(menuSession); controller.closeMenu(); }}
          onOpenSessionFile={() => { void actions.sessions.openFile(menuSession); controller.closeMenu(); }}
          canRpcLog={Boolean(menuSessionRuntimeAgent)}
          rpcToggleDisabled={!menuSessionRuntimeAgent}
          isRpcLogging={menuSessionRuntimeAgent ? controller.isAgentRpcLogging(menuSessionRuntimeAgent.id) : false}
          onToggleRpcLogging={() => {
            // 历史会话（无 runtime）不会渲染该项；兜底防御状态变化
            if (!menuSessionRuntimeAgent) {
              showNotice(t("menu.rpcLoggingRequiresRuntime"), 2500);
              controller.closeMenu();
              return;
            }
            controller.closeMenu();
            if (controller.isAgentRpcLogging(menuSessionRuntimeAgent.id)) {
              // 已开启：菜单项显示「关闭RPC日志」→ 直接关闭记录
              void actions.rpc.setLogging(menuSessionRuntimeAgent.id, false).then((enabled) => {
                controller.setAgentRpcLogging(menuSessionRuntimeAgent.id, enabled);
                showNotice(enabled ? t("rpc.loggingDisableFailed") : t("rpc.loggingDisabled"), 2500);
              });
              return;
            }
            void actions.rpc.setLogging(menuSessionRuntimeAgent.id, true).then((enabled) => {
              controller.setAgentRpcLogging(menuSessionRuntimeAgent.id, enabled);
              if (enabled) {
                setRpcLogOpenedAgentId(menuSessionRuntimeAgent.id);
              } else {
                showNotice(t("rpc.loggingEnableFailed"), 2500);
              }
            });
          }}
          onOpenLogs={() => {
            if (menuSessionRuntimeAgent) controller.openRpcLogs(menuSessionRuntimeAgent.id);
            controller.closeMenu();
          }}
          onArchiveSession={() => { void actions.sessions.archive(menu.projectId, menuSession); controller.closeMenu(); }}
          onDeleteSession={() => { void actions.sessions.delete(menu.projectId, menuSession); controller.closeMenu(); }}
        />
      )}
      {managerProject && (
        <SessionManagerModal
          sessions={(controller.catalog.sessionsByProject[managerProject.id] ?? []).flatMap((record) => record.filePath ? [{
            id: record.id, filePath: record.filePath, name: record.title, preview: record.preview,
            updatedAt: record.updatedAt, messageCount: record.messageCount, source: record.source,
          }] : [])}
          onClose={controller.closeSessionManager}
          onRename={(session) => actions.sessions.rename(managerProject.id, session)}
          onExport={(session) => void actions.sessions.export(managerProject.id, session)}
          onDelete={(sessions) => Promise.all(sessions.map((session) => actions.sessions.delete(managerProject.id, session))).then(controller.closeSessionManager)}
          onArchive={(sessions) => Promise.all(sessions.map((session) => actions.sessions.archive(managerProject.id, session))).then(controller.closeSessionManager)}
          onUnarchive={(archived) => actions.sessions.unarchive(archived, managerProject.id)}
          listArchived={actions.sessions.listArchived}
        />
      )}
      {controller.worktreeCreateProjectId && (
        <WorktreeCreateDialog
          projectId={controller.worktreeCreateProjectId}
          creating={Boolean(props.creatingWorktree)}
          onCreate={(branchName) => void actions.worktrees.create(controller.worktreeCreateProjectId!, branchName).then(controller.closeWorktreeCreate)}
          onClose={controller.closeWorktreeCreate}
        />
      )}
      {controller.rpcLogAgentId && (
        <RpcLogViewer
          agentId={controller.rpcLogAgentId}
          loadHistory={actions.rpc.listLogs}
          getLogging={actions.rpc.getLogging}
          setLogging={actions.rpc.setLogging}
          onClose={controller.closeRpcLogs}
        />
      )}
      {/* “RPC 日志已打开”提醒：点击菜单后弹框，可直达日志查看弹窗 */}
      {rpcLogOpenedAgentId && (
        <RpcLogOpenedDialog
          onView={() => {
            controller.openRpcLogs(rpcLogOpenedAgentId);
            setRpcLogOpenedAgentId(null);
          }}
          onClose={() => setRpcLogOpenedAgentId(null)}
        />
      )}
    </aside>
  );
}
