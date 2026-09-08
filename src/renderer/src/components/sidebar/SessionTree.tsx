import { Fragment, type ReactNode } from "react";
import { ChevronDown, Ellipsis, HatGlasses, Trash2 } from "lucide-react";
import type { AgentTab, Project, SessionRecord, SessionSummary } from "../../../../shared/types";
import { collectDisplayedSessionIds, filterAgentsForSidebarDisplay, getProjectAgentSessionDisplay, sessionStatusDotClass, type ProjectChildItem } from "../../agentListDisplay";
import { sessionRecordToSummary } from "../../atoms";
import { t } from "../../i18n";
import { filterSidebarSessions, getBoundSidebarRuntimeAgent, hasLiveSidebarRuntime, type SidebarController } from "../../hooks/useSidebarController";
import { Button } from "../ui-shadcn/button";
import { PathTooltip } from "../ui-shadcn/PathTooltip";
import type { SidebarActions } from "./SidebarContent";
import { SessionSourceBadge } from "../session/SessionSourceBadge";
import { cn } from "../../lib/utils";
import { SESSION_TAB_DRAG_MIME } from "../../utils/sessionSplitEdge";

/** 与 ProjectTree.treeRowClass 同尺寸同圆角：分层后 utility 生效，必须「新学旧」对齐项目行，
 * 不能再用 min-h-11/rounded-xl（会明显高于/圆于项目行）。 */
const sessionRowClass =
	"group/resource conversation agent-row relative flex min-h-7 w-full items-center gap-1.5 rounded-sm border border-transparent px-2 py-0 text-left text-body text-foreground shadow-none transition-[background-color,box-shadow] duration-200 hover:bg-muted/60 hover:text-foreground focus-visible:bg-muted/70 focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset";

/** 行右侧「更多操作（三个点）」按钮：absolute 浮层，不参与布局（不挤压标题文字），
 * 默认隐藏（pointer-events 一并关闭防误触），行 hover / 行内聚焦时显现——
 * 与 WorktreeTree 的 workspace-tree-actions 同一套虚化模式。
 * 窄侧栏（<256px）时按钮会盖住标题：conversation-body 上
 * @max-[255px]:group-hover/row:pr-7 在 hover 时压出 28px 留白（一个按钮宽），
 * 标题截断让位但保持可见（淡出到透明会让标题不可读，须点击激活才能看到，已弃用）。 */
const rowMoreActionsClass =
	"row-more-actions pointer-events-none absolute top-1/2 right-1 -translate-y-1/2 opacity-0 transition-opacity group-hover/row:pointer-events-auto group-hover/row:opacity-100 group-focus-within/row:pointer-events-auto group-focus-within/row:opacity-100";

/** 菜单打开期间保持点亮：菜单弹出后行 hover 会丢失（鼠标移向菜单），
 * 若不加此态按钮会瞬间熄灭，用户会误以为菜单与按钮无关。 */
function rowMoreMenuActiveClass(menuOpen: boolean) {
	return cn(rowMoreActionsClass, menuOpen && "pointer-events-auto opacity-100");
}

/** 会话/Agent 行容器：内容行占满 + 三个点按钮浮层（button 不能嵌 button，
 * 且浮层不占位——窄侧栏时标题文字不会被按钮挤窄）。
 * mt-0.5：行间距 2px，参考 dsh-web 会话列表的紧凑行距。 */
const rowContainerClass = "group/row relative mt-px flex min-h-7 items-center";

function matchesSearch(value: string, search: string) {
  return !search || value.toLowerCase().includes(search.toLowerCase());
}

function formatCodexSubagentName(session: SessionSummary) {
  return [session.codexAgentNickname, session.codexAgentRole].filter(Boolean).join(" · ") ||
    session.name || t("app.codexSubagent");
}

function formatPiSubagentName(session: SessionSummary) {
  return session.name || t("app.piSubagent");
}

/**
 * 复用 Tab 栏的状态点语义，并把点绑定到具体 Agent/历史会话行。
 * 没有 runtime 的历史记录传入 undefined，因此纯打开记录不会被误标成已启动。
 */
function renderRuntimeStatusDot(status?: string | null) {
  const dotClass = sessionStatusDotClass(status);
  if (!dotClass) return null;
  const label = status === "idle"
    ? t("app.statusIdle")
    : status === "error"
      ? t("app.statusError")
      : status === "running" || status === "starting" || status === "pending" || status === "waiting"
        ? t("app.statusRunning")
        : undefined;
  return (
    <span
      className={cn(
        "size-1.5 shrink-0 rounded-full",
        dotClass,
        status === "error" ? "" : "animate-pulse",
      )}
      aria-label={label}
      title={label}
    />
  );
}

export function SessionTree(props: {
  project: Project;
  sessions: readonly SessionRecord[];
  agents: readonly AgentTab[];
  currentSessionId?: string;
  controller: SidebarController;
  actions: SidebarActions;
  nested?: boolean;
  visibleChildCount?: number;
  onShowMore?: () => void;
}) {
  const filter = props.controller.sourceFilterFor(props.project.id);
  const search = props.controller.search.trim();
  const allSummaries = props.sessions.flatMap((session) => {
    const summary = sessionRecordToSummary(session);
    return summary ? [summary] : [];
  });
  const summaries = filterSidebarSessions(allSummaries, filter)
    .filter((session) => matchesSearch(`${session.name ?? ""}${session.preview}${session.filePath}`, search));
  const projectAgents = props.agents.filter((agent) => agent.projectId === props.project.id);
  const displayAgents = filterAgentsForSidebarDisplay({
    agents: projectAgents,
    allSessions: allSummaries,
    visibleSessions: summaries,
    sources: filter,
  });
  const display = getProjectAgentSessionDisplay({
    agents: displayAgents,
    sessions: summaries,
    visibleChildCount: props.visibleChildCount ?? (props.nested ? Number.MAX_SAFE_INTEGER : props.controller.visibleChildCountFor(props.project.id)),
  });
  const displayedSessionIds = collectDisplayedSessionIds(
    display.visibleChildren,
    (agent) => {
      const linked = props.sessions.find(
        (session) => props.controller.catalog.runtimeBySessionId[session.id]?.agentId === agent.id,
      ) ?? summaries.find((session) => session.filePath === agent.sessionPath);
      return linked?.id;
    },
  );
  const draftSessions = props.sessions
    .filter((session) => session.status === "draft")
    .filter((session) => !displayedSessionIds.has(session.id))
    .filter((session) => matchesSearch(session.title, search))
    .filter((session) => filter === null || filter.has(session.source))
    .sort((left, right) => right.updatedAt - left.updatedAt);
  const catalogLoading = props.controller.catalog.catalogLoadStateByProject[props.project.id]?.status === "loading";
  const hasRows = catalogLoading || draftSessions.length > 0 || display.visibleChildren.length > 0 || display.hiddenChildCount > 0;
  if (!hasRows) return null;

  /** 单击走设置默认模式（App 层读 sessionTabOpenMode）；双击显式常驻。
   *  不设本地默认值：undefined 透传后由 App 的 sessions.open 用设置值兜底 */
  const openSession = (sessionId: string, tabMode?: "preview" | "permanent") => {
    void props.actions.sessions.open(props.project.id, sessionId, tabMode);
  };

  const sessionDragProps = (sessionId: string) => ({
    draggable: true,
    onDragStart: (event: React.DragEvent) => {
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData(SESSION_TAB_DRAG_MIME, sessionId);
      // 部分浏览器要求有 text/plain 才能跨区域 drop
      event.dataTransfer.setData("text/plain", sessionId);
      props.actions.sessions.beginDrag?.(sessionId);
    },
    onDragEnd: () => {
      props.actions.sessions.endDrag?.();
    },
  });

  const openContext = (event: React.MouseEvent, session: SessionSummary) => {
    event.preventDefault();
    const runtime = getBoundSidebarRuntimeAgent(props.controller.catalog, session.id);
    void props.controller.openMenu(runtime
      ? { kind: "agent", agentId: runtime.id, x: event.clientX, y: event.clientY }
      : { kind: "session", projectId: props.project.id, sessionId: session.id, x: event.clientX, y: event.clientY });
  };
  const openDraftContext = (event: React.MouseEvent, session: SessionRecord) => {
    event.preventDefault();
    const runtime = props.controller.catalog.runtimeBySessionId[session.id];
    const runtimeAgent = getBoundSidebarRuntimeAgent(props.controller.catalog, session.id);
    if (runtimeAgent) {
      void props.controller.openMenu({
        kind: "agent",
        agentId: runtimeAgent.id,
        x: event.clientX,
        y: event.clientY,
      });
      return;
    }
    // The runtime snapshot can arrive just before the Agent inventory. Suppress
    // a destructive menu in that gap; the main process applies the same guard.
    if (hasLiveSidebarRuntime(runtime)) return;
    void props.controller.openMenu({
      kind: "draft",
      projectId: props.project.id,
      sessionId: session.id,
      x: event.clientX,
      y: event.clientY,
    });
  };
  const renderSubagent = (session: SessionSummary, label: ReactNode) => {
    return (
      <div
        key={session.id}
        className={rowContainerClass}
        onContextMenu={(event) => openContext(event, session)}
      >
        <PathTooltip content={session.filePath}>
          <button
            type="button"
            className={cn(
              sessionRowClass,
              "session-row codex-subagent-sidebar-row pl-2",
              session.id === props.currentSessionId && "active bg-accent/20 text-foreground",
            )}
            onClick={() => openSession(session.id)}
            onDoubleClick={() => openSession(session.id, "permanent")}
            {...sessionDragProps(session.id)}
          >
            <div className="conversation-body min-w-0 flex-1 transition-[padding-right] @max-[255px]:group-hover/row:pr-7 @max-[255px]:group-focus-within/row:pr-7"><div className="conversation-title flex min-w-0 items-center gap-1.5">{label}</div></div>
          </button>
        </PathTooltip>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className={rowMoreMenuActiveClass(
            props.controller.menu?.kind === "session" && props.controller.menu.sessionId === session.id,
          )}
          aria-label={t("sidebar.moreActions")}
          title={t("sidebar.moreActions")}
          onClick={(event) => {
            event.stopPropagation();
            openContext(event, session);
          }}
        >
          <Ellipsis size={14} aria-hidden="true" />
        </Button>
      </div>
    );
  };
  const renderSubagents = (parentKey: string, codex: SessionSummary[], pi: SessionSummary[]) => {
    if (codex.length + pi.length === 0 || !props.controller.expandedSubagentGroups.has(parentKey)) return null;
    // 主侧栏子会话组缩进走 tailwind utility（ml-3），避免 legacy 层 v3-braun 规则覆盖；
    // worktree（nested）子树保留其自身布局规则
    return (
      <div className={cn("codex-subagent-sidebar-group", !props.nested && "ml-3")}>
        {codex.map((session) => renderSubagent(session, <><strong>{formatCodexSubagentName(session)}</strong><SessionSourceBadge source="codex" label={t("app.codexSubagent")} /></>))}
        {pi.map((session) => renderSubagent(session, <strong>{formatPiSubagentName(session)}</strong>))}
      </div>
    );
  };
  const renderToggle = (key: string, count: number) => count > 0 ? (
    <span
      className={cn("subagent-inline-toggle px-1 py-0.5 mr-7")}
      title={t("app.piSubagentCount", { count })}
      onClick={(event) => { event.stopPropagation(); props.controller.toggleSubagentGroup(key); }}
    >
      <ChevronDown size={8} className={props.controller.expandedSubagentGroups.has(key) ? "expanded" : ""} />
      {/* 子 Agent 数量：统一 pill 样式（与项目行会话数徽标同尺寸同圆角），紧凑档 */}
      <span className="subagent-inline-count inline-flex h-3.5 shrink-0 items-center rounded-full px-1 text-[10px] font-medium tabular-nums">{count}</span>
    </span>
  ) : null;

  // main 语义：项目下直接展示统一列表（drafts + 会话/Agent 按时间混排），不分组标题；
  // Tab 栏同款状态点跟随具体 Agent/历史会话行；没有 runtime 的纯历史记录保持无点。
  const renderChild = (child: ProjectChildItem) => {
    const groupKey = `${props.project.id}:${child.key}`;
    const childCount = child.codexSubagents.length + child.piSubagents.length;
    if (child.type === "agent") {
      const agentSession = props.sessions.find((session) => (
        props.controller.catalog.runtimeBySessionId[session.id]?.agentId === child.agent.id
      )) ?? summaries.find((session) => session.filePath === child.agent.sessionPath);
      return <Fragment key={child.key}>
        {/* 运行中 Agent 行：标题常被 truncate（如 "JZSSC40..."），悬浮展示完整标题 */}
        <div
          className={rowContainerClass}
          onContextMenu={(event) => { event.preventDefault(); void props.controller.openMenu({ kind: "agent", agentId: child.agent.id, x: event.clientX, y: event.clientY }); }}
        >
          <PathTooltip content={child.agent.title}>
            <button
              type="button"
              className={cn(
                sessionRowClass,
                agentSession?.id === props.currentSessionId && "active bg-accent/20 text-foreground",
              )}
              onClick={() => { if (agentSession) openSession(agentSession.id); }}
              onDoubleClick={() => { if (agentSession) openSession(agentSession.id, "permanent"); }}
              {...(agentSession ? sessionDragProps(agentSession.id) : {})}
            >
              {renderRuntimeStatusDot(child.agent.status)}
              <div className="conversation-body min-w-0 flex-1 transition-[padding-right] @max-[255px]:group-hover/row:pr-7 @max-[255px]:group-focus-within/row:pr-7"><div className="conversation-title flex min-w-0 items-center gap-1.5">
                <strong className="min-w-0 flex-1 truncate font-medium">{child.agent.title}</strong>
                {child.agent.noSession && <span className="anonymous-indicator" title={t("app.anonymousChat")}><HatGlasses size={11} aria-hidden="true" /></span>}
                {renderToggle(groupKey, childCount)}
              </div></div>
            </button>
          </PathTooltip>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className={rowMoreMenuActiveClass(
              props.controller.menu?.kind === "agent" && props.controller.menu.agentId === child.agent.id,
            )}
            aria-label={t("sidebar.moreActions")}
            title={t("sidebar.moreActions")}
            onClick={(event) => {
              event.stopPropagation();
              const rect = event.currentTarget.getBoundingClientRect();
              void props.controller.openMenu({ kind: "agent", agentId: child.agent.id, x: rect.right, y: rect.bottom });
            }}
          >
            <Ellipsis size={14} aria-hidden="true" />
          </Button>
        </div>
        {renderSubagents(groupKey, child.codexSubagents, child.piSubagents)}
      </Fragment>;
    }
    const runtime = getBoundSidebarRuntimeAgent(props.controller.catalog, child.session.id);
    const runtimeSnapshot = props.controller.catalog.runtimeBySessionId[child.session.id];
    return <Fragment key={child.session.id}>
      {/* 悬浮第一行展示完整会话名（行内常被 truncate），第二行展示文件路径 */}
      <div
        className={rowContainerClass}
        onContextMenu={(event) => openContext(event, child.session)}
      >
        <PathTooltip content={`${child.session.name || t("common.untitled")}\n${child.session.filePath}`}>
          <button
            type="button"
            className={cn(
              sessionRowClass,
              // 历史会话不是运行中的 Agent：只给这一类内容增加层级缩进，避免项目标题与历史记录贴在同一列。
              // 历史会话需要比运行中 Agent 更松的点击区域和行间距，避免连续记录挤成一块。
              "session-row history-session-row mx-0 min-h-7 pl-2 pr-2 py-0",
              child.session.id === props.currentSessionId && "active bg-accent/20 text-foreground",
            )}
            onClick={() => openSession(child.session.id)}
            onDoubleClick={() => openSession(child.session.id, "permanent")}
            {...sessionDragProps(child.session.id)}
          >
          {renderRuntimeStatusDot(runtimeSnapshot?.status)}
          <div className="conversation-body min-w-0 flex-1 transition-[padding-right] @max-[255px]:group-hover/row:pr-7 @max-[255px]:group-focus-within/row:pr-7"><div className="conversation-title flex min-w-0 items-center gap-1.5">
            {/* 历史会话（无运行态）文字降一级，与活跃 Agent/运行中会话形成层级差 */}
            <strong className={cn("min-w-0 flex-1 truncate", runtime ? "font-medium" : "font-normal text-muted-foreground/90")}>{child.session.name || t("common.untitled")}</strong>
            {child.session.source && child.session.source !== "pi" && <SessionSourceBadge source={child.session.source} />}
            {renderToggle(groupKey, childCount)}
          </div></div>
        </button>
        </PathTooltip>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className={rowMoreMenuActiveClass(
            props.controller.menu?.kind === "session" && props.controller.menu.sessionId === child.session.id,
          )}
          aria-label={t("sidebar.moreActions")}
          title={t("sidebar.moreActions")}
          onClick={(event) => {
            event.stopPropagation();
            openContext(event, child.session);
          }}
        >
          <Ellipsis size={14} aria-hidden="true" />
        </Button>
      </div>
      {renderSubagents(groupKey, child.codexSubagents, child.piSubagents)}
    </Fragment>;
  };

  return (
    <div className={cn(
      props.nested ? "worktree-children m-0 border-0 bg-transparent p-0" : "session-card",
      "flex flex-col gap-0",
    )}>
      {draftSessions.map((session) => {
        const runtime = props.controller.catalog.runtimeBySessionId[session.id];
        const canDelete = !hasLiveSidebarRuntime(runtime);
        return (
          <div
            key={`draft:${session.id}`}
            className={cn("draft-session-row group/draft grid items-center gap-1", canDelete ? "grid-cols-[minmax(0,1fr)_2rem]" : "grid-cols-1 has-runtime")}
            onContextMenu={(event) => openDraftContext(event, session)}
          >
          <PathTooltip content={session.title}>
            <button
              type="button"
              className={cn(
                sessionRowClass,
                "session-row draft-session-trigger",
                session.id === props.currentSessionId && "active bg-accent/20 text-foreground",
              )}
              onClick={() => openSession(session.id)}
              onDoubleClick={() => openSession(session.id, "permanent")}
              {...sessionDragProps(session.id)}
            >
              <div className="conversation-body min-w-0 flex-1 transition-[padding-right] @max-[255px]:group-hover/row:pr-7 @max-[255px]:group-focus-within/row:pr-7"><div className="conversation-title flex min-w-0 items-center gap-1.5">
                {renderRuntimeStatusDot(runtime?.status)}
                <strong className="min-w-0 flex-1 truncate font-medium">{session.title}</strong>
              </div></div>
            </button>
          </PathTooltip>
            {canDelete && (
              <Button variant="ghost" size="icon"
                className="draft-session-delete"
                aria-label={t("common.delete")} title={t("common.delete")}
                onClick={() => void props.actions.sessions.deleteDraft(session)}
              >
                <Trash2 size={14} aria-hidden="true" />
              </Button>
            )}
          </div>
        );
      })}
      {catalogLoading && <div className="project-session-loading"><div className="loader" /><span>{t("app.projectSessionsLoading")}</span></div>}
      {display.visibleChildren.map(renderChild)}

      {display.hiddenChildCount > 0 ? (
        <Button
          variant="ghost" size="sm" className={`h-auto justify-start px-2 text-micro opacity-80 transition-opacity hover:opacity-100 ${props.nested ? "worktree-sessions-more" : "session-more-row"}`}
          onClick={props.onShowMore ?? (() => props.controller.showMoreChildren(props.project.id))}
        >
          <span>{props.nested
            ? t("app.worktreeShowMoreSessions", { count: display.hiddenChildCount })
            : t("app.projectShowMoreChildren", { count: display.hiddenChildCount })}
          </span>
        </Button>
      ) : props.controller.hasExpandedChildren(props.project.id) ? (
        /* 展开过「查看更多」后提供收起入口，与展开按钮同款样式 */
        <Button
          variant="ghost" size="sm" className={`h-auto justify-start px-2 text-micro opacity-80 transition-opacity hover:opacity-100 ${props.nested ? "worktree-sessions-more" : "session-more-row"}`}
          onClick={() => props.controller.collapseChildren(props.project.id)}
        >
          <span>{t("app.projectCollapseChildren")}</span>
        </Button>
      ) : null}
    </div>
  );
}
