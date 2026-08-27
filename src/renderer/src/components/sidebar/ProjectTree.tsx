import { ChevronsDownUp, ChevronRight, Ellipsis, Filter, Folder, FolderCog, FolderOpen, FolderPlus, HatGlasses, Plus } from "lucide-react";
import type { DragEvent } from "react";
import type { Project, WorktreeEntry } from "../../../../shared/types";
import type { SidebarController } from "../../hooks/useSidebarController";
import { t } from "../../i18n";
import type { SidebarActions } from "./SidebarContent";
import { SessionTree } from "./SessionTree";
import { WorktreeTree } from "./WorktreeTree";
import { PathTooltip } from "../ui-shadcn/PathTooltip";
import { Button } from "../ui-shadcn/button";
import { cn } from "../../lib/utils";

/** pure official：项目/会话树行共享的 shadcn 风格底（hover=accent 面，active 同系）
 * 默认透明背景，只有激活的行才显示背景色和阴影，避免所有行都像浮层卡片。 */
// Be UI AI Sidebar 的资源树强调“容器可展开、资源可选中”：项目行保持轻量，
// 只有当前资源使用 inset surface，避免每个项目都变成独立卡片。
// 根项目行保留折叠层级，但收窄左右留白，给窄侧栏中的目录名多留出可用宽度。
const treeRowClass =
  "group conversation relative flex min-h-8 w-full items-center gap-1.5 rounded-lg border border-transparent pl-1 pr-16 py-0 text-body text-foreground shadow-none transition-[background-color,border-color,box-shadow] duration-200 hover:border-border-subtle hover:bg-muted/60 hover:text-foreground";

/** 项目行右侧操作按钮的虚化模式：absolute 浮层，不参与布局（不挤压项目名文字），
 * 默认隐藏（pointer-events 一并关闭防误触），行 hover / 行内聚焦时显现。
 * 窄侧栏（<256px）时按钮会盖住项目名：conversation-body 上
 * @max-[255px]:group-hover:pr-29 在 hover 时压出 116px 右侧留白（4 个按钮宽），
 * 文本截断让位但保持可见——2027-01 用户反馈：整行淡出到透明会导致标题不可读，
 * 必须点击激活才能看到文字；压缩+截断只损失尾部文字，不影响辨认。 */
const dimmedActionsClass =
	"pointer-events-none absolute top-1/2 right-1 flex -translate-y-1/2 items-center gap-1 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100";

function isChatProject(project: Project) {
  return project.kind === "chat";
}

function displayProjectDirectoryName(project: Project) {
  if (isChatProject(project)) return "Chat";
  const normalizedPath = project.path.replace(/\\/g, "/").replace(/\/+$/, "");
  return normalizedPath.split("/").pop() || project.name || project.path;
}

function matchesProject(project: Project, search: string, controller: SidebarController) {
  if (!search) return true;
  const query = search.toLowerCase();
  // 搜索项目时把直属 worktree 视为同一工作区树，否则用户搜到 worktree 分支/会话
  // 后根项目会被过滤掉，导致结果实际存在却无法展开查看。
  const relatedProjects = controller.catalog.projects.filter(
    (candidate) => candidate.id === project.id || candidate.worktreeParentId === project.id,
  );
  return relatedProjects.some((related) => {
    if (`${related.name}${related.path}`.toLowerCase().includes(query)) return true;
    if (controller.catalog.agents.some((agent) => agent.projectId === related.id &&
      `${agent.title}${agent.cwd}${agent.sessionId ?? ""}`.toLowerCase().includes(query))) return true;
    return (controller.catalog.sessionsByProject[related.id] ?? []).some((session) =>
      `${session.title}${session.preview}${session.filePath ?? ""}`.toLowerCase().includes(query));
  });
}

export function ProjectTree(props: {
  controller: SidebarController;
  actions: SidebarActions;
  currentProjectId?: string;
  /** 实际选中的项目（可能是 worktree 子项目），用于高亮工作区行。 */
  selectedProjectId?: string;
  currentSessionId?: string;
  worktreesByProject: Readonly<Record<string, readonly WorktreeEntry[]>>;
  branchByProject?: Readonly<Record<string, string | null | undefined>>;
}) {
  const rootProjects = props.controller.catalog.projects.filter((project) =>
    !project.worktreeParentId && matchesProject(project, props.controller.search.trim(), props.controller),
  );
  const dragStart = (event: DragEvent<HTMLButtonElement>, projectId: string) => {
    if (props.controller.search.trim()) return;
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", projectId);
    props.controller.startProjectDrag(projectId);
  };
  const drop = (event: DragEvent<HTMLButtonElement>, projectId: string) => {
    event.preventDefault();
    const source = event.dataTransfer.getData("text/plain") || props.controller.drag.sourceProjectId;
    props.controller.finishProjectDrag();
    if (props.controller.search.trim()) return;
    if (source && source !== projectId) void props.actions.projects.reorder(source, projectId);
  };
  const renderProject = (project: Project) => {
      const collapsed = props.controller.isProjectCollapsed(project.id);
      const isCurrent = props.currentProjectId === project.id;
      const projectDirectoryName = displayProjectDirectoryName(project);
      const sourceFilter = props.controller.sourceFilterFor(project.id);
      const dragging = props.controller.drag.sourceProjectId === project.id;
      const dragOver = props.controller.drag.overProjectId === project.id;
      const rootProjectSessions = props.controller.catalog.sessionsByProject[project.id] ?? [];
      // 运行态属于具体会话，而不是项目容器；项目行只负责导航，避免多个 Agent 同时运行时
      // 项目头像出现无法指向目标会话的聚合动画。
      return <div key={project.id} className={cn("project-group mb-1.5", project.worktreeEnabled && "worktree-enabled")}>
        <div
          className={cn(
            treeRowClass,
            !props.controller.search.trim() && "project-draggable",
            dragging && "dragging opacity-60",
            dragOver && "drag-over ring-1 ring-border",
            isCurrent && "active border-border-strong bg-accent/20 text-foreground shadow-sm",
          )}
          data-active={isCurrent || undefined}
          onContextMenu={(event) => { event.preventDefault(); void props.controller.openMenu({ kind: "project", projectId: project.id, x: event.clientX, y: event.clientY }); }}
        >
          <button
            type="button"
            className={cn("project-fold grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground", collapsed && "folded")}
            title={collapsed ? t("app.projectExpand") : t("app.projectCollapse")}
            aria-label={collapsed ? t("app.projectExpand") : t("app.projectCollapse")}
            onClick={() => props.controller.toggleProject(project.id)}
          >
            <ChevronRight size={14} className={cn("transition-transform", !collapsed && "rotate-90")} />
          </button>
          {/* 触发区包整行选择按钮：只包截断的 <strong> 时，快划过右侧气泡会立刻离开关闭。 */}
          <PathTooltip content={`${projectDirectoryName}\n${project.path}`}>
            <button
              type="button"
              className="flex min-w-0 flex-1 items-center gap-1 py-0 pr-1 text-left"
              draggable={!props.controller.search.trim()}
              onDragStart={(event) => dragStart(event, project.id)}
              onDragOver={(event) => { if (props.controller.drag.sourceProjectId && props.controller.drag.sourceProjectId !== project.id) { event.preventDefault(); props.controller.setProjectDropTarget(project.id); } }}
              onDragLeave={() => props.controller.setProjectDropTarget(undefined)}
              onDrop={(event) => drop(event, project.id)}
              onDragEnd={props.controller.finishProjectDrag}
              onClick={() => {
                // 项目主行同时承担选择和手风琴切换，让项目卡片本身保持唯一且明确的导航入口。
                props.controller.toggleProject(project.id);
                props.actions.projects.select(project.id);
              }}
            >
              <span className="grid size-5 shrink-0 place-items-center text-muted-foreground" aria-hidden="true">
                {collapsed ? <Folder size={14} /> : <FolderOpen size={14} />}
              </span>
              <div className="conversation-body min-w-0 flex-1 transition-[padding-right] @max-[255px]:group-hover:pr-29 @max-[255px]:group-focus-within:pr-29">
                <div className="conversation-title flex min-w-0 items-center">
                  <strong className="min-w-0 flex-1 truncate font-medium">{projectDirectoryName}</strong>
                </div>
                {/* 项目名称只承担导航信息；详细会话状态由下方的 Agent/历史会话行承担。 */}
              </div>
            </button>
          </PathTooltip>
          <div className={cn(dimmedActionsClass, "pr-1", props.controller.menu?.kind === "project" && props.controller.menu.projectId === project.id && "pointer-events-auto opacity-100")}>
            {sourceFilter !== null && (
              <button
                type="button"
                className="grid size-6 place-items-center rounded-md text-muted-foreground hover:bg-background/80 hover:text-foreground"
                title={t("menu.filterSessions")}
                aria-label={t("menu.filterSessions")}
                onClick={(event) => props.controller.openSourceFilter(project.id, event.clientX, event.clientY)}
              >
                <Filter size={12} />
              </button>
            )}
            {/* worktree 模式下新建/匿名入口已挪到主工作区行（WorktreeTree），
                项目行不再重复提供，避免入口分散 */}
            {isCurrent && !project.worktreeEnabled && (
              <button type="button" className="grid size-6 place-items-center rounded-md text-muted-foreground hover:bg-background/80 hover:text-foreground" title={t("app.projectNewAgent")} aria-label={t("app.projectNewAgent")} onClick={() => void props.actions.sessions.createDraft(project.id)}><Plus size={14} /></button>
            )}
            {!project.worktreeEnabled && (
              <div className="flex items-center gap-1">
                {!isCurrent && (
                  <button type="button" className="grid size-6 place-items-center rounded-md text-muted-foreground hover:bg-background/80 hover:text-foreground" title={t("app.projectNewAgent")} aria-label={t("app.projectNewAgent")} onClick={() => void props.actions.sessions.createDraft(project.id)}><Plus size={14} /></button>
                )}
                <button type="button" className="grid size-6 place-items-center rounded-md text-muted-foreground hover:bg-background/80 hover:text-foreground" title={t("app.anonymousChat")} aria-label={t("app.anonymousChat")} onClick={() => void props.actions.sessions.createAnonymous(project.id)}><HatGlasses size={14} /></button>
              </div>
            )}
            {/* 三个点：把项目右键菜单变成可见入口，让用户知道项目行还有更多操作 */}
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={t("sidebar.moreActions")}
              title={t("sidebar.moreActions")}
              onClick={(event) => {
                event.stopPropagation();
                const rect = event.currentTarget.getBoundingClientRect();
                void props.controller.openMenu({ kind: "project", projectId: project.id, x: rect.right, y: rect.bottom });
              }}
            >
              <Ellipsis size={14} aria-hidden="true" />
            </Button>
          </div>
        </div>
        {!collapsed && (
          <div className="relative ml-3 mt-1 mr-1 space-y-0.5 pl-2 pb-1">
            {/* 展开内容不依赖当前选中项，项目切换只改变高亮，避免两棵会话树同时伸缩造成布局抖动。 */}
            {project.worktreeEnabled ? (
              <WorktreeTree
                project={project}
                controller={props.controller}
                actions={props.actions}
                currentProjectId={props.selectedProjectId}
                currentSessionId={props.currentSessionId}
                sessions={rootProjectSessions}
                agents={props.controller.catalog.agents}
                entries={props.worktreesByProject[project.id] ?? []}
                branch={props.branchByProject?.[project.id]}
              />
            ) : (
              <SessionTree
                project={project}
                sessions={rootProjectSessions}
                agents={props.controller.catalog.agents}
                currentSessionId={props.currentSessionId}
                controller={props.controller}
                actions={props.actions}
              />
            )}
          </div>
        )}
      </div>;
  };

  const chatProjects = rootProjects.filter(isChatProject);
  const workspaceProjects = rootProjects.filter((project) => !isChatProject(project));
  // 任一工作区项目展开即视为“展开态”，供标题栏批量折叠按钮切换文案与 aria-expanded。
  // 基于完整 catalog（非搜索过滤后视图）计算，避免搜索时按钮状态与目录全局状态不一致。
  const anyWorkspaceExpanded = props.controller.catalog.projects.some(
    (project) => !project.worktreeParentId && !isChatProject(project) && !props.controller.isProjectCollapsed(project.id),
  );
  return <>
    {chatProjects.map((project) => {
      const collapsed = props.controller.isProjectCollapsed(project.id);
      const sessions = props.controller.catalog.sessionsByProject[project.id] ?? [];
      return (
        <section key={project.id} className="mb-4" aria-label={t("app.chatProject")} role="treeitem" aria-expanded={!collapsed}>
          {/* 与下方「项目」标题栏共用：同 px-2 + text-caption，避免 section p-1 / 标题 px-1 叠出明显错位。
              整行可点击切换折叠：折叠态下只看到标题栏时，点标题区即可展开，避免「不知道下面还有会话」；
              行为与右侧折叠按钮一致（右侧按钮需 stopPropagation 防止二次触发）。 */}
          <div
            className="flex cursor-pointer select-none items-center justify-between rounded-md px-2 pb-1 transition-colors hover:bg-muted/30"
            title={collapsed ? t("app.projectExpand") : t("app.projectCollapse")}
            role="button"
            tabIndex={0}
            onClick={() => props.controller.toggleProject(project.id)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                props.controller.toggleProject(project.id);
              }
            }}
            onContextMenu={(event) => {
              event.preventDefault();
              void props.controller.openMenu({ kind: "project", projectId: project.id, x: event.clientX, y: event.clientY });
            }}
          >
            <span className="text-caption font-medium text-muted-foreground">{t("app.chatProject")}</span>
            <div className="flex items-center gap-0.5">
              <button
                type="button"
                className="grid size-6 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                title={collapsed ? t("app.projectExpand") : t("app.projectCollapse")}
                aria-label={collapsed ? t("app.projectExpand") : t("app.projectCollapse")}
                aria-expanded={!collapsed}
                onClick={(event) => {
                  event.stopPropagation();
                  props.controller.toggleProject(project.id);
                }}
              >
                {/* Chat 没有可点击的父项目行，折叠入口固定放在标题栏，避免展开后无法恢复。 */}
                <ChevronsDownUp size={14} aria-hidden="true" />
              </button>
              {props.actions.projects.changeChatPath && (
                <button
                  type="button"
                  className="grid size-6 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  title={`${t("app.chatProjectSettings")}\n${project.path}`}
                  aria-label={t("app.chatProjectSettings")}
                  onClick={(event) => {
                    event.stopPropagation();
                    void props.actions.projects.changeChatPath?.(project);
                  }}
                >
                  {/* Chat 是固定父项目，设置入口必须挂在父标题栏，不能依赖当前是否已有会话。 */}
                  <FolderCog size={13} aria-hidden="true" />
                </button>
              )}
              <button
                type="button"
                className="grid size-6 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                title={t("app.newSession")}
                aria-label={t("app.newSession")}
                onClick={(event) => {
                  event.stopPropagation();
                  void props.actions.sessions.createDraft(project.id);
                }}
              >
                <Plus size={13} aria-hidden="true" />
              </button>
              <button
                type="button"
                className="grid size-6 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                title={t("app.anonymousChat")}
                aria-label={t("app.anonymousChat")}
                onClick={(event) => {
                  event.stopPropagation();
                  void props.actions.sessions.createAnonymous(project.id);
                }}
              >
                <HatGlasses size={13} aria-hidden="true" />
              </button>
            </div>
          </div>
          {!collapsed && (
            <div className="relative ml-3 space-y-0.5 pl-2">
              <SessionTree
                project={project}
                sessions={sessions}
                agents={props.controller.catalog.agents}
                currentSessionId={props.currentSessionId}
                controller={props.controller}
                actions={props.actions}
              />
            </div>
          )}
        </section>
      );
    })}
    {workspaceProjects.length > 0 && (
      <section aria-label={t("app.sidebarProjects")} role="tree">
        {/* 标题栏右侧提供添加项目与批量折叠入口，行为与搜索框旁的 FolderPlus 按钮一致；
            与 Chat 标题栏按钮（size-6 圆角悬浮层）同款视觉，避免层级混乱。 */}
        {/* 标题栏整行可点击：切换全部项目展开/折叠（与右侧批量折叠按钮一致），
            避免项目全折叠时点击无反应、不知道下面还有项目。 */}
        <div
          className="flex cursor-pointer select-none items-center justify-between rounded-md px-1 pb-1 transition-colors hover:bg-muted/30"
          title={anyWorkspaceExpanded ? t("app.projectCollapseAll") : t("app.projectExpandAll")}
          role="button"
          tabIndex={0}
          onClick={() => props.controller.toggleCollapseAllProjects()}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              props.controller.toggleCollapseAllProjects();
            }
          }}
        >
          <span className="text-caption font-medium text-muted-foreground">{t("app.sidebarProjects")}</span>
          <div className="flex items-center gap-0.5">
            <button
              type="button"
              className="grid size-6 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              title={anyWorkspaceExpanded ? t("app.projectCollapseAll") : t("app.projectExpandAll")}
              aria-label={anyWorkspaceExpanded ? t("app.projectCollapseAll") : t("app.projectExpandAll")}
              aria-expanded={anyWorkspaceExpanded}
              onClick={(event) => {
                event.stopPropagation();
                props.controller.toggleCollapseAllProjects();
              }}
            >
              {/* 与 Chat 标题栏同款折叠图标：点击在「全部折叠/全部展开」之间切换 */}
              <ChevronsDownUp size={14} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="grid size-6 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              title={t("app.addProject")}
              aria-label={t("app.addProject")}
              onClick={(event) => {
                event.stopPropagation();
                void props.actions.projects.add();
              }}
            >
              <FolderPlus size={13} aria-hidden="true" />
            </button>
          </div>
        </div>
        {workspaceProjects.map(renderProject)}
      </section>
    )}
    {/* 无任何工作区项目（新用户只有内置 Chat）：显式渲染「项目」分组 + 空态引导。
        此前该分组整体不渲染，侧边栏只剩搜索行一个 24px + 图标，用户不知道可以
        添加自己的项目目录，误以为 PiDeck 只能聊天（issue #149 同类反馈）。
        对标 dsh-web 侧边栏：无工作区时给出显眼的目录添加引导。 */}
    {workspaceProjects.length === 0 && (
      <section aria-label={t("app.sidebarProjects")} className="mt-1">
        <div className="px-1 pb-1 text-caption font-medium text-muted-foreground">
          {t("app.sidebarProjects")}
        </div>
        <div className="mx-1 rounded-lg border border-dashed border-border-subtle bg-muted/20 px-3 py-4 text-center">
          <FolderPlus className="mx-auto mb-2 size-5 text-muted-foreground" aria-hidden="true" />
          <div className="text-body font-medium text-foreground">{t("sidebar.emptyProjectsTitle")}</div>
          <p className="mt-1 text-caption text-muted-foreground">{t("sidebar.emptyProjectsDesc")}</p>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="mt-3"
            onClick={() => void props.actions.projects.add()}
          >
            <FolderPlus className="size-3.5" aria-hidden="true" />
            {t("app.addProject")}
          </Button>
        </div>
      </section>
    )}
  </>;
}
