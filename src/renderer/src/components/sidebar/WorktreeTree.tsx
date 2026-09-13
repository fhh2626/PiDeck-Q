import { ChevronDown, ChevronRight, GitBranch, HatGlasses, Plus, Trash2 } from "lucide-react";
import type { AgentTab, Project, SessionRecord, WorktreeEntry } from "../../../../shared/types";
import type { SidebarController } from "../../hooks/useSidebarController";
import { t } from "../../i18n";
import type { SidebarActions } from "./SidebarContent";
import { SessionTree } from "./SessionTree";
import { Button } from "../ui-shadcn/button";
import { PathTooltip } from "../ui-shadcn/PathTooltip";
import { cn } from "../../lib/utils";
import { mergeWorkspaceTreeRows, type WorkspaceTreeRow } from "./workspaceTreeModel";

// 主工作区是根项目展开后的首个导航项，字号需要与父项目保持一致；
// 其他 worktree 只是该项目的分支入口，渲染时会覆写为较小的 text-control，避免子项抢占层级。
const workspaceRowClass =
  "workspace-tree-row group relative flex min-h-7 min-w-0 items-center gap-0.5 rounded-sm px-0.5 py-0 text-body text-foreground transition-[background-color,box-shadow] duration-fast hover:bg-muted/60";
const workspaceSelectClass =
  "flex min-h-7 min-w-0 flex-1 items-center gap-1.5 rounded-sm px-1.5 py-0 text-left text-body text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground disabled:cursor-default disabled:hover:bg-transparent disabled:hover:text-muted-foreground";
const workspaceActionClass = "text-muted-foreground hover:bg-muted hover:text-foreground";
const workspaceSessionsClass = "min-w-0 basis-[calc(100%-24px)] ml-6 pl-2";

/**
 * 操作按钮（+/匿名/删除）以 absolute 浮层呈现，必须锚定在「标题行」这一层：
 * 外层行容器还包着展开的会话列表（flex-wrap 换行），若直接对行容器 top-1/2 定位，
 * 按钮会跑到「标题 + 全部历史会话」整块的中心，压住历史会话行、挡住点击。
 * 窄侧栏（<256px）时按钮会盖住标题：行文本上 @max-[255px]:group-hover:pr-* 压出
 * 按钮宽度的右侧留白，文本截断让位但保持可见（淡出到透明会不可读，已弃用），
 * 与项目行/会话行同一套策略。主工作区行 2 按钮 52px，子工作区行 3 按钮 78px。
 */
function WorkspaceRowActions(props: {
  children: React.ReactNode;
}) {
  return (
    <div className="workspace-tree-actions pointer-events-none absolute top-1/2 right-0.5 flex -translate-y-1/2 items-center gap-0.5 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100">
      {props.children}
    </div>
  );
}

export function WorktreeTree(props: {
  project: Project;
  controller: SidebarController;
  actions: SidebarActions;
  currentProjectId?: string;
  currentSessionId?: string;
  sessions: readonly SessionRecord[];
  agents: readonly AgentTab[];
  entries: readonly WorktreeEntry[];
  branch?: string | null;
}) {
  const childProjects = props.controller.catalog.projects.filter(
    (project) => project.worktreeParentId === props.project.id,
  );
  const rows = mergeWorkspaceTreeRows(props.entries, childProjects);
  // 主工作区折叠态复用 worktree 展开集合，key 用根项目路径（与任何 worktree 路径都不冲突）。
  // 注意语义反转：集合里存在 = 已折叠（worktree 行是存在 = 展开），因为主工作区默认展开。
  const mainSessionsKey = props.project.path;
  const mainCollapsed = props.controller.expandedWorktreePaths.has(mainSessionsKey);
  const mainRowId = `worktree-main-sessions-${props.project.id}`;

  return (
    <div className="workspace-tree min-w-0 py-1 pl-1">
      <section className="workspace-tree-main" aria-label={t("app.worktreeMainWorkspace")}>
        <div className={workspaceRowClass}>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="workspace-tree-expand shrink-0 text-muted-foreground"
            aria-expanded={!mainCollapsed}
            aria-controls={mainRowId}
            aria-label={mainCollapsed ? t("app.projectExpand") : t("app.projectCollapse")}
            title={mainCollapsed ? t("app.projectExpand") : t("app.projectCollapse")}
            onClick={() => props.controller.toggleWorktreeSessions(mainSessionsKey)}
          >
            {mainCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className={cn(
              "conversation worktree-workspace-header h-7 justify-start text-left",
              workspaceSelectClass,
              props.currentProjectId === props.project.id && "active bg-accent/60 text-foreground",
            )}
            onClick={() => props.actions.projects.select(props.project.id)}
            title={t("app.worktreeMainWorkspace")}
          >
            <span className="worktree-main-branch-icon grid size-5 shrink-0 place-items-center text-muted-foreground"><GitBranch size={14} /></span>
            <span className="conversation-body min-w-0 flex-1 transition-[padding-right] @max-[255px]:group-hover:pr-[52px] @max-[255px]:group-focus-within:pr-[52px]">
              <span className="conversation-title flex min-w-0 items-center gap-1.5">
                <strong className="min-w-0 truncate font-medium">{t("app.worktreeMainWorkspace")}</strong>
                <span className="worktree-main-branch min-w-0 truncate text-control text-muted-foreground">{props.branch ?? t("app.worktreeBranchLoading")}</span>
              </span>
            </span>
          </Button>
          {/* 新建入口放在工作区行上（hover 显现，与其他工作区行一致）：
              根项目行在 worktree 模式下不再承担 +/匿名，避免入口藏得深。
              主工作区的会话列表在行外（section 内），行容器高度只有标题行，锚定安全。 */}
          <WorkspaceRowActions>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className={workspaceActionClass}
              title={t("app.projectNewAgent")}
              aria-label={t("app.projectNewAgent")}
              onClick={() => void props.actions.sessions.createDraft(props.project.id)}
            >
              <Plus size={13} />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className={workspaceActionClass}
              title={t("app.anonymousChat")}
              aria-label={t("app.anonymousChat")}
              onClick={() => void props.actions.sessions.createAnonymous(props.project.id)}
            >
              <HatGlasses size={13} />
            </Button>
          </WorkspaceRowActions>
        </div>
        {/* Worktree 模式下主工作区是默认展开的第一项；根项目历史必须挂在这里，
            不能等 Worktree 列表渲染完再由 ProjectTree 追加到所有工作区之后。 */}
        {!mainCollapsed && (
          <div id={mainRowId} className={cn("workspace-tree-main-sessions", workspaceSessionsClass)}>
            <SessionTree
              project={props.project}
              sessions={props.sessions}
              agents={props.agents}
              currentSessionId={props.currentSessionId}
              controller={props.controller}
              actions={props.actions}
            />
          </div>
        )}
      </section>

      <section className="workspace-tree-list" aria-label={t("app.worktreeOtherWorkspaces")}>
        <header className="workspace-tree-section-header mt-2 flex min-h-7 items-center justify-between gap-2 border-t border-border/40 px-2 pt-1 text-micro text-muted-foreground">
          <span className="min-w-0 truncate">{t("app.worktreeOtherWorkspaces")}</span>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="workspace-tree-create"
            title={t("app.worktreeNew")}
            aria-label={t("app.worktreeNew")}
            onClick={() => props.controller.openWorktreeCreate(props.project.id)}
          >
            <Plus size={13} />
          </Button>
        </header>

        {rows.map((row) => (
          <WorkspaceTreeRowView
            key={row.key}
            row={row}
            rootProject={props.project}
            controller={props.controller}
            actions={props.actions}
            currentProjectId={props.currentProjectId}
            currentSessionId={props.currentSessionId}
          />
        ))}
      </section>
    </div>
  );
}

/**
 * 单个工作区行：选择、展开和破坏性操作拆成并列控件，避免嵌套 button/role=button
 * 造成 click 冒泡串线。只有真实 child project 才显示会话和删除/新建操作。
 */
function WorkspaceTreeRowView(props: {
  row: WorkspaceTreeRow;
  rootProject: Project;
  controller: SidebarController;
  actions: SidebarActions;
  currentProjectId?: string;
  currentSessionId?: string;
}) {
  const { row } = props;
  const childProject = row.project;
  const expanded = Boolean(childProject && props.controller.expandedWorktreePaths.has(row.path));
  const rowId = `worktree-sessions-${row.key.replace(/[^a-z0-9]+/gi, "-")}`;
  const isActive = childProject?.id === props.currentProjectId;

  return (
    // 选中态只高亮分支名行（select 按钮），不能把外层 wrapper 整行压暗——
    // wrapper 还包着展开的会话列表，整行变色会让整个工作区区块发暗。
    <div className={cn(workspaceRowClass, "flex-wrap text-muted-foreground")}>
      {/* 标题行单独成相对容器：会话列表（flex-wrap 换到下一行）留在外层，
          操作按钮 absolute 锚定本行，不会压到展开的历史会话上。 */}
      <div className="workspace-tree-header relative flex min-w-0 flex-1 items-center gap-0.5">
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="workspace-tree-expand shrink-0 text-muted-foreground"
          aria-expanded={expanded}
          aria-controls={childProject ? rowId : undefined}
          aria-label={expanded ? t("app.projectCollapse") : t("app.projectExpand")}
          title={expanded ? t("app.projectCollapse") : t("app.projectExpand")}
          disabled={!childProject}
          onClick={() => props.controller.toggleWorktreeSessions(row.path)}
        >
          {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </Button>

        {/* 悬浮展示完整分支名 + 工作区路径（分支名在行内常被 truncate） */}
        <PathTooltip content={`${row.branch}${row.directory !== row.branch ? ` (${row.directory})` : ""}\n${row.path}`}>
          <button
            type="button"
            className={cn(
              "workspace-tree-select",
              workspaceSelectClass,
              // 子 worktree 是父项目下的分支入口，不应与父项目/主工作区争夺视觉层级。
              "text-control",
              // 窄侧栏 hover 压出 3 按钮（78px）留白；transition-all 让压缩动画与配色过渡共存
              "transition-all @max-[255px]:group-hover:pr-[78px] @max-[255px]:group-focus-within:pr-[78px]",
              isActive && "bg-accent/60 text-foreground",
            )}
            disabled={!childProject}
            onClick={() => childProject && props.actions.projects.select(childProject.id)}
            onContextMenu={(event) => {
              if (!childProject) return;
              event.preventDefault();
              void props.controller.openMenu({
                kind: "project",
                projectId: childProject.id,
                x: event.clientX,
                y: event.clientY,
              });
            }}
          >
            <GitBranch className="size-3.5 shrink-0" aria-hidden="true" />
            <span className={cn("min-w-0 flex-1 truncate", isActive ? "font-normal" : "font-medium")}>{row.branch}</span>
            {row.directory !== row.branch && (
              <span className="workspace-tree-directory max-w-20 shrink-0 truncate text-micro text-muted-foreground">{row.directory}</span>
            )}
          </button>
        </PathTooltip>

        {childProject && (
          <WorkspaceRowActions>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className={workspaceActionClass}
              title={t("app.projectNewAgent")}
              aria-label={t("app.projectNewAgent")}
              onClick={() => void props.actions.sessions.createDraft(childProject.id)}
            >
              <Plus size={13} />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className={workspaceActionClass}
              title={t("app.anonymousChat")}
              aria-label={t("app.anonymousChat")}
              onClick={() => void props.actions.sessions.createAnonymous(childProject.id)}
            >
              <HatGlasses size={13} />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="text-muted-foreground hover:bg-danger-soft hover:text-danger"
              title={t("menu.removeProject")}
              aria-label={t("menu.removeProject")}
              onClick={() => void props.actions.worktrees.remove(props.rootProject.id, {
                path: row.path,
                branch: row.branch,
              }, childProject)}
            >
              <Trash2 size={13} />
            </Button>
          </WorkspaceRowActions>
        )}
      </div>

      {expanded && childProject && (
        <div id={rowId} className={cn("workspace-tree-sessions", workspaceSessionsClass)}>
          <SessionTree
            project={childProject}
            sessions={props.controller.catalog.sessionsByProject[childProject.id] ?? []}
            agents={props.controller.catalog.agents}
            currentSessionId={props.currentSessionId}
            controller={props.controller}
            actions={props.actions}
            nested
            visibleChildCount={props.controller.visibleChildCountFor(childProject.id)}
            onShowMore={() => props.controller.showMoreChildren(childProject.id)}
          />
        </div>
      )}
    </div>
  );
}
