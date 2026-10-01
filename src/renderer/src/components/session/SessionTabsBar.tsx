import { useAtomValue } from "jotai";
import {
  ChevronDown,
  ChevronRight,
  CircleStop,
  CircleX,
  Folder,
  MessagesSquare,
  PanelLeft,
  PanelRight,
  Pin,
  PinOff,
  Plus,
  RotateCw,
  X,
} from "lucide-react";
import {
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  sessionRecordByIdAtomFamily,
  sessionRuntimeBySessionIdAtomFamily,
} from "../../atoms";
import { t } from "../../i18n";
import { AnimatedBadge, type AnimatedBadgeStatus } from "../motion/animated-badge";
import { Button } from "../ui-shadcn/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui-shadcn/dropdown-menu";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "../ui-shadcn/popover";
import { cn } from "../../lib/utils";

import { SESSION_TAB_DRAG_MIME } from "../../utils/sessionSplitEdge";

/**
 * 分屏组预设色板（浏览器标签组风格）。
 * 第一个为默认色，与 SPLIT_GROUP_DEFAULT_COLOR 保持一致；labelKey 走 i18n。
 */
export const SPLIT_GROUP_COLOR_PALETTE = [
  { name: "blue", value: "#0091ff", labelKey: "session.splitGroup.color.blue" },
  { name: "green", value: "#30a46c", labelKey: "session.splitGroup.color.green" },
  { name: "yellow", value: "#f5d90a", labelKey: "session.splitGroup.color.yellow" },
  { name: "orange", value: "#f76b15", labelKey: "session.splitGroup.color.orange" },
  { name: "red", value: "#e5484d", labelKey: "session.splitGroup.color.red" },
  { name: "purple", value: "#8e4ec6", labelKey: "session.splitGroup.color.purple" },
  { name: "pink", value: "#d6409f", labelKey: "session.splitGroup.color.pink" },
  { name: "gray", value: "#8d8d8d", labelKey: "session.splitGroup.color.gray" },
] as const;

/**
 * 会话 Tab 栏（浏览器式多 Tab）：标题栏下方展示当前打开的所有会话。
 *
 * 生命周期约定（省内存 + 复用 Agent 的最佳实践）：
 * - 点击 Tab = 切换会话（只改 currentSessionId，不启动/停止任何 Agent）；
 * - 关闭 Tab = 仅从列表移除，**不 kill Agent**——后台 Agent 保持运行，
 *   再次打开同一会话时复用已绑定运行时并重新加载最新历史；
 * - 全部 Agent 只在应用整体退出时统一停止（main 进程 before-quit 路径）。
 *
 * 固定（pin）与排序：
 * - 固定 Tab 前置、宽度更小、无关闭按钮，右键/下拉菜单可取消固定；
 * - 拖拽 Tab 可排序，固定/普通区间交叉拖动会自动转换固定状态；
 * - 拖到聊天区边缘可分屏（见 SessionSplitStage）。
 *
 * 操作入口（融合对方收敛方案）：
 * - 每个会话 Tab 的下拉按钮（或右键）打开操作菜单：切换到该会话、固定、
 *   停止（关闭会话，仅当前 Tab）、重启（仅当前 Tab）、关闭/关闭其他/关闭全部；
 * - 当前 Tab 识别：背景浮起（bg-accent/20 + shadow-sm + 强边框），
 *   与左侧 SessionTree 选中态同一套语义，不再画底部横条（曾因过粗被弃用）。

/**
 * 会话状态 → AnimatedBadge 状态映射（颜色语义与用户约定一致）：
 * - starting=loading（启动中：蓝色旋转徽章）
 * - running/pending/waiting=loading + 黄色覆盖（运行/等待中：黄色旋转徽章）
 * - idle=neutral（未启动：白色/灰色图标）
 * - error=danger（失败：红色图标）
 * detached/closed/未启动返回 undefined，不渲染徽章（避免把“未运行”误读成某种状态）。
 */
function sessionStatusBadge(
	status?: string | null,
): { status: AnimatedBadgeStatus; colorClass?: string } | undefined {
	if (!status || status === "detached") return undefined;
	switch (status) {
		case "error":
			return { status: "danger" };
		case "idle":
			return { status: "neutral" };
		// 启动中：官方 loading（primary 蓝）旋转；运行/等待：同 loading 旋转但覆盖为黄色
		case "starting":
			return { status: "loading" };
		case "running":
		case "pending":
		case "waiting":
			return {
				status: "loading",
				colorClass: "text-amber-500 dark:text-amber-400",
			};
		default:
			return undefined;
	}
}

/** “+” 下拉里的新建目标：聊天对话区或已打开项目 */
export type NewSessionTarget = {
  projectId: string;
  label: string;
  isChat: boolean;
};

/** 工作台文件/Diff Tab：与会话 Tab 共用同一条栏、同一套视觉（不再单独绿条栏） */
export type WorkbenchEditorTabItem = {
  id: string;
  label: string;
  title?: string;
  preview?: boolean;
  active?: boolean;
};

export type SessionTabsBarProps = {
  tabs: readonly string[];
  pinnedTabs: readonly string[];
  /** VS Code 式预览 Tab（斜体）；至多一个 */
  previewTabId?: string | null;
  currentSessionId?: string;
  onSelect: (sessionId: string) => void;
  /** 双击预览 Tab → 常驻（与侧栏双击同语义） */
  onPromotePreview?: (sessionId: string) => void;
  onClose: (sessionId: string) => void;
  onCloseOthers: (sessionId: string) => void;
  onCloseAll: () => void;
  /** 新建会话目标（聊天区置顶 + 已打开项目），由 App 从项目库存装配 */
  newSessionTargets: readonly NewSessionTarget[];
  onNewSessionInProject: (projectId: string) => void;
  onTogglePin: (sessionId: string) => void;
  onReorder: (sourceId: string, targetId: string, position: "before" | "after") => void;
  /** 右侧抽屉总开关：打开/关闭整块右侧面板（活动栏在抽屉内、系统按钮下方）。 */
  onToggleDrawer?: () => void;
  drawerOpen?: boolean;
  /** 左侧栏已收起时，在 Tab 栏左侧提供展开入口（替代浮动按钮）。 */
  listCollapsed?: boolean;
  onToggleListCollapsed?: () => void;
  /** 当前会话的状态/操作区；嵌入 Tab 栏后不再单独占用标题行。 */
  actions?: ReactNode;
  /** 开始/结束拖拽会话 Tab 时通知外层（用于分屏落点预览）。 */
  onDragSessionChange?: (sessionId: string | null) => void;
  /** 分屏组：分屏内会话聚合为组（浏览器标签组风格：颜色标记 + 展开/收起）。 */
  splitGroupIds?: readonly string[];
  /** 分屏组胶囊收起状态（收起时组内 Tab 隐藏，只显示组头） */
  splitGroupCollapsed?: boolean;
  onToggleSplitGroup?: () => void;
  /** 分屏组自定义名称（空则用默认文案） */
  splitGroupName?: string;
  /** 分屏组颜色（组色条 + 组内 Tab 竖条） */
  splitGroupColor?: string;
  onSplitGroupRename?: (name: string) => void;
  onSplitGroupColorChange?: (color: string) => void;
  /** 取消分屏：全部会话退出分屏布局 */
  onExitAllSplit?: () => void;
  /**
   * 中间栏打开的文件/Diff Tab。挂在同一条 session-tabs-bar 上，
   * 避免内容区再开第二套「绿条」Tab 栏。
   */
  editorTabs?: readonly WorkbenchEditorTabItem[];
  onSelectEditorTab?: (tabId: string) => void;
  onCloseEditorTab?: (tabId: string) => void;
  onPromoteEditorPreview?: (tabId: string) => void;
  /** 当前会话的停止（关闭会话）能力：只对当前会话 Tab 生效。 */
  canStopCurrent?: boolean;
  onStopCurrent?: () => void;
  /** 当前会话的重启能力：只对当前会话 Tab 生效。 */
  canRestartCurrent?: boolean;
  isRestartingCurrent?: boolean;
  onRestartCurrent?: () => void;
};

export function SessionTabsBar(props: SessionTabsBarProps) {
  const { tabs, pinnedTabs, currentSessionId, previewTabId } = props;
  const tabItems = useMemo(() => tabs.map((sessionId) => ({ sessionId })), [tabs]);
  const dragSourceRef = useRef<string | null>(null);
  const dragTargetRef = useRef<{ targetId: string; position: "before" | "after" } | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  // 拖拽插入指示：当前悬停的目标 Tab 与插入侧（before=左缘 / after=右缘）
  const [dragIndicator, setDragIndicator] = useState<{ targetId: string; position: "before" | "after" } | null>(null);
  // 分屏组管理菜单（右键胶囊打开）：重命名草稿
  const [splitGroupMenuOpen, setSplitGroupMenuOpen] = useState(false);
  const [splitGroupNameDraft, setSplitGroupNameDraft] = useState("");

  // —— 滚动容器 ref（拖拽排序与新建菜单共用）——
  const scrollRef = useRef<HTMLDivElement>(null);

  /** onDragOver 期间按鼠标位置相对目标 Tab 中点决定插入前后 */
  const handleDragOver = (event: React.DragEvent, targetId: string) => {
    if (!dragSourceRef.current || dragSourceRef.current === targetId) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const rect = event.currentTarget.getBoundingClientRect();
    const position = event.clientX < rect.left + rect.width / 2 ? "before" : "after";
    dragTargetRef.current = { targetId, position };
    // 指示线随悬停实时更新；仅位置变化时 setState，避免高频 re-render
    setDragIndicator((current) =>
      current?.targetId === targetId && current.position === position ? current : { targetId, position },
    );
  };

  const handleDrop = (event: React.DragEvent) => {
    event.preventDefault();
    const sourceId = dragSourceRef.current;
    const target = dragTargetRef.current;
    dragSourceRef.current = null;
    dragTargetRef.current = null;
    setDraggingId(null);
    setDragIndicator(null);
    props.onDragSessionChange?.(null);
    if (sourceId && target) {
      props.onReorder(sourceId, target.targetId, target.position);
    }
  };

  const handleDragEnd = () => {
    dragSourceRef.current = null;
    dragTargetRef.current = null;
    setDraggingId(null);
    setDragIndicator(null);
    props.onDragSessionChange?.(null);
  };

  // 下拉经 Portal 挂到 body；勿写 px-*（会盖掉自定义标题栏为窗口控件留的 padding-right）。
  // 抽屉开关始终在本栏最右侧；打开抽屉后靠 CSS 取消窗口控件让位，避免按钮被空出一截。
  return (
    <div className="session-tabs-bar flex h-10 shrink-0 items-center gap-1 overflow-hidden border-b border-border/40 bg-background/80 pl-[max(0.5rem,var(--session-tabs-left-inset,0.5rem))]">
      {props.listCollapsed && props.onToggleListCollapsed ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="list-toggle-native size-7 shrink-0"
          aria-label={t("app.expandList")}
          title={t("app.expandList")}
          onClick={props.onToggleListCollapsed}
        >
          <PanelLeft className="size-3.5" aria-hidden="true" />
        </Button>
      ) : null}
      <div
        ref={scrollRef}
        className="session-tabs-scroll relative flex min-w-0 flex-1 items-center gap-1 overflow-x-auto overflow-y-hidden [scrollbar-width:none]"
      >
        {(() => {
          // 分屏组：组内会话聚合渲染（组头胶囊 + 颜色标记）；收起时组内 Tab 隐藏
          const splitGroupIds = props.splitGroupIds ?? [];
          const splitGroupSet = new Set(splitGroupIds);
          const hasSplitGroup = splitGroupIds.length > 1;
          const groupCollapsed = hasSplitGroup && Boolean(props.splitGroupCollapsed);
          const renderTab = (sessionId: string, grouped: boolean, groupColor?: string) => (
            <SessionTab
              key={sessionId}
              sessionId={sessionId}
              grouped={grouped}
              groupColor={groupColor}
              active={sessionId === currentSessionId}
              pinned={pinnedTabs.includes(sessionId)}
              preview={sessionId === previewTabId}
              dragging={draggingId === sessionId}
              // 指示线插在目标 Tab 的边缘：before=左缘，after=右缘
              indicator={
                dragIndicator && dragIndicator.targetId === sessionId
                  ? dragIndicator.position
                  : null
              }
              // 停止/重启只对当前会话有意义（作用于其绑定的 Agent 运行时），非当前 Tab 不显示
              canStop={sessionId === currentSessionId ? props.canStopCurrent : undefined}
              onStop={sessionId === currentSessionId ? props.onStopCurrent : undefined}
              canRestart={sessionId === currentSessionId ? props.canRestartCurrent : undefined}
              isRestarting={
                sessionId === currentSessionId ? props.isRestartingCurrent : undefined
              }
              onRestart={sessionId === currentSessionId ? props.onRestartCurrent : undefined}
              onSelect={props.onSelect}
              onPromotePreview={props.onPromotePreview}
              onClose={props.onClose}
              onCloseOthers={props.onCloseOthers}
              onCloseAll={props.onCloseAll}
              onTogglePin={props.onTogglePin}
              onDragStart={(event) => {
                dragSourceRef.current = sessionId;
                dragTargetRef.current = null;
                setDraggingId(sessionId);
                props.onDragSessionChange?.(sessionId);
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData(SESSION_TAB_DRAG_MIME, sessionId);
                event.dataTransfer.setData("text/plain", sessionId);
              }}
              onDragOver={(event) => handleDragOver(event, sessionId)}
              onDrop={handleDrop}
              onDragEnd={handleDragEnd}
            />
          );
          return tabItems.map(({ sessionId }) => {
            if (!hasSplitGroup || !splitGroupSet.has(sessionId)) {
              return renderTab(sessionId, false);
            }
            // 组内会话：只在组内第一个位置渲染「组头胶囊 +（展开时）组内全部 Tab」
            if (sessionId !== splitGroupIds[0]) return null;
            const groupHasFocus =
              currentSessionId != null && splitGroupSet.has(currentSessionId);
            const groupName =
              props.splitGroupName?.trim() || t("session.splitGroup.label");
            const groupColor =
              props.splitGroupColor || SPLIT_GROUP_COLOR_PALETTE[0].value;
            // role="group" 挂在外层容器（容纳胶囊 + 组内 Tab），按钮保持原生 button 语义；
            // aria-expanded/aria-controls 挂在按钮上；右键打开组管理菜单（Popover），
            // 左键点击仍是展开/收起（与浏览器标签组一致）
            return (
              <Popover
                open={splitGroupMenuOpen}
                onOpenChange={setSplitGroupMenuOpen}
                key={`split-group:${sessionId}`}
              >
                <PopoverAnchor asChild>
                  <div
                    role="group"
                    aria-label={groupName}
                    className="flex min-w-0 items-center gap-1"
                  >
                    <button
                      type="button"
                      aria-expanded={!groupCollapsed}
                      aria-controls="session-split-group-tabs"
                      aria-label={
                        groupCollapsed
                          ? t("session.splitGroup.expand")
                          : t("session.splitGroup.collapse")
                      }
                      title={
                        groupCollapsed
                          ? t("session.splitGroup.expand")
                          : t("session.splitGroup.collapse")
                      }
                      onClick={props.onToggleSplitGroup}
                      onContextMenu={(event) => {
                        // 右键：打开组管理菜单（重命名/颜色/取消分屏）
                        event.preventDefault();
                        setSplitGroupNameDraft(groupName);
                        setSplitGroupMenuOpen(true);
                      }}
                      className={cn(
                        "flex h-7 shrink-0 cursor-pointer select-none items-center gap-1.5 rounded-md border border-dashed px-2 text-caption transition-colors",
                        groupHasFocus
                          ? "border-accent/60 bg-accent/15 text-foreground"
                          : "border-border-strong/60 bg-accent/5 text-muted-foreground hover:bg-accent/15 hover:text-foreground",
                      )}
                    >
                      {/* 组颜色标记：左侧色条（浏览器标签组同款，颜色可自定义） */}
                      <span
                        className="h-3 w-1 shrink-0 rounded-full"
                        style={{ backgroundColor: groupColor }}
                        aria-hidden="true"
                      />
                      <span className="max-w-40 truncate whitespace-nowrap">
                        {groupName} {splitGroupIds.length}
                      </span>
                      {groupCollapsed ? (
                        <ChevronRight className="size-3" aria-hidden="true" />
                      ) : (
                        <ChevronDown className="size-3" aria-hidden="true" />
                      )}
                    </button>
                    {!groupCollapsed && (
                      <div
                        id="session-split-group-tabs"
                        className="flex min-w-0 items-center gap-1"
                      >
                        {splitGroupIds.map((id) =>
                          renderTab(id, true, groupColor),
                        )}
                      </div>
                    )}
                  </div>
                </PopoverAnchor>
                {/* 组管理菜单：重命名 + 颜色选择 + 取消分屏（其余按钮不要） */}
                <PopoverContent
                  align="start"
                  sideOffset={6}
                  className="w-64 p-3"
                >
                  <div className="flex flex-col gap-3">
                    <input
                      type="text"
                      value={splitGroupNameDraft}
                      placeholder={t("session.splitGroup.renamePlaceholder")}
                      maxLength={24}
                      aria-label={t("session.splitGroup.rename")}
                      onChange={(event) => setSplitGroupNameDraft(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.currentTarget.blur();
                        }
                      }}
                      onBlur={() => {
                        const next = splitGroupNameDraft.trim();
                        if (next && next !== (props.splitGroupName ?? "")) {
                          props.onSplitGroupRename?.(next);
                        }
                      }}
                      className="h-8 w-full rounded-md border border-border-strong bg-background px-2 text-caption text-foreground outline-none placeholder:text-muted-foreground/60 focus:border-accent focus:ring-1 focus:ring-accent/40"
                    />
                    {/* 颜色选择排（浏览器标签组同款：预设色板） */}
                    <div
                      className="flex items-center gap-2"
                      role="radiogroup"
                      aria-label={t("session.splitGroup.color")}
                    >
                      {SPLIT_GROUP_COLOR_PALETTE.map((c) => (
                        <button
                          key={c.name}
                          type="button"
                          role="radio"
                          aria-checked={groupColor === c.value}
                          aria-label={t(c.labelKey)}
                          title={t(c.labelKey)}
                          onClick={() => props.onSplitGroupColorChange?.(c.value)}
                          className={cn(
                            "size-5 rounded-full transition-transform hover:scale-110",
                            groupColor === c.value &&
                              "ring-2 ring-offset-2 ring-offset-popover",
                          )}
                          style={{
                            backgroundColor: c.value,
                            ...(groupColor === c.value
                              ? { boxShadow: `0 0 0 1px ${c.value}` }
                              : {}),
                          }}
                        />
                      ))}
                    </div>
                    {/* 取消分屏：全部会话退出分屏布局 */}
                    <button
                      type="button"
                      onClick={() => {
                        setSplitGroupMenuOpen(false);
                        props.onExitAllSplit?.();
                      }}
                      className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-caption text-muted-foreground transition-colors hover:bg-accent/10 hover:text-foreground"
                    >
                      <CircleX className="size-3.5" aria-hidden="true" />
                      {t("session.splitGroup.exitAll")}
                    </button>
                  </div>
                </PopoverContent>
              </Popover>
            );
          });
        })()}
        {/* 浏览器式新建入口：跟在最后一张标签后面，下拉选择新建到哪个项目 */}
        <NewSessionMenu
          targets={props.newSessionTargets}
          onSelect={props.onNewSessionInProject}
        />
        {/* 文件/Diff 与会话共用本栏：同一套 session-tab 皮，不另开绿条栏 */}
        {props.editorTabs && props.editorTabs.length > 0 ? (
          <>
            <span
              className="mx-0.5 h-4 w-px shrink-0 bg-border/50"
              aria-hidden="true"
            />
            {props.editorTabs.map((tab) => (
              <EditorWorkbenchTab
                key={tab.id}
                tab={tab}
                onSelect={props.onSelectEditorTab}
                onClose={props.onCloseEditorTab}
                onPromotePreview={props.onPromoteEditorPreview}
              />
            ))}
          </>
        ) : null}
      </div>
      {/* 右侧抽屉总开关：固定在会话 Tab 栏最右侧；面板切换图标在抽屉内活动栏。 */}
      {props.onToggleDrawer ? (
        <div className="session-tabs-actions flex shrink-0 items-center gap-1 border-l border-border/30 pl-1">
          {props.actions}
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className={`header-drawer-toggle size-7${props.drawerOpen ? " active" : ""}`}
            title={props.drawerOpen ? t("app.closeDrawer") : t("app.openDrawer")}
            aria-label={props.drawerOpen ? t("app.closeDrawer") : t("app.openDrawer")}
            onClick={props.onToggleDrawer}
          >
            <PanelRight className="size-3.5" aria-hidden="true" />
          </Button>
        </div>
      ) : props.actions != null ? (
        <div className="session-tabs-actions flex shrink-0 items-center gap-1 border-l border-border/30 pl-1">
          {props.actions}
        </div>
      ) : null}
    </div>
  );
}

/**
 * 工作台文件/Diff Tab：视觉复用 session-tab，不引入第二套绿条样式。
 * 与会话 Tab 正交：不参与会话拖拽/固定，只转发选中/关闭/预览晋升。
 */
function EditorWorkbenchTab(props: {
  tab: WorkbenchEditorTabItem;
  onSelect?: (tabId: string) => void;
  onClose?: (tabId: string) => void;
  onPromotePreview?: (tabId: string) => void;
}) {
  const { tab } = props;
  return (
    <div
      role="tab"
      aria-selected={Boolean(tab.active)}
      title={tab.title ?? tab.label}
      className={cn(
        "session-tab group relative flex h-7 shrink-0 cursor-pointer select-none items-center gap-1.5 rounded-md border px-2 text-caption transition-colors",
        "w-fit max-w-40",
        // 选中态与侧栏 SessionTree 一致：背景浮起 + 强边框 + 轻阴影（浏览器 Tab 惯例）
        tab.active
          ? "border-border-strong bg-accent/20 font-medium text-foreground shadow-sm"
          : "border-transparent text-muted-foreground hover:bg-accent/50 hover:text-foreground",
        tab.preview && "italic font-normal text-muted-foreground",
      )}
      onClick={() => props.onSelect?.(tab.id)}
      onDoubleClick={() => {
        if (tab.preview) props.onPromotePreview?.(tab.id);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          props.onSelect?.(tab.id);
        }
      }}
      tabIndex={0}
    >
      <span className={cn("min-w-0 flex-1 truncate", tab.preview && "italic")}>
        {tab.label}
      </span>
      <button
        type="button"
        role="tab-close"
        aria-label={t("tabs.close")}
        title={t("tabs.close")}
        className={cn(
          "inline-grid size-4 shrink-0 place-items-center rounded-sm text-muted-foreground/70 hover:bg-accent hover:text-foreground",
          tab.active ? "opacity-60 hover:opacity-100" : "opacity-0 group-hover:opacity-60",
        )}
        onClick={(event) => {
          event.stopPropagation();
          props.onClose?.(tab.id);
        }}
      >
        <X className="size-3" />
      </button>
    </div>
  );
}

function SessionTab(props: {
  sessionId: string;
  active: boolean;
  /** 固定 Tab：前置、窄宽度、无关闭按钮 */
  pinned: boolean;
  /** VS Code 预览：斜体，双击后常驻 */
  preview: boolean;
  /** 分屏组内 Tab：左侧显示组颜色标记 */
  grouped?: boolean;
  /** 分屏组颜色（组内 Tab 左侧竖条；与胶囊色条一致） */
  groupColor?: string;
  dragging: boolean;
  /** 拖拽插入指示：before=左缘竖线，after=右缘竖线 */
  indicator?: "before" | "after" | null;
  /** 停止（关闭会话）入口（仅当前会话 Tab 传入）：canStop=false 时禁用 */
  canStop?: boolean;
  onStop?: () => void;
  /** 重启入口（仅当前会话 Tab 传入）：canRestart=false 时禁用，isRestarting 时显示“重启中…” */
  canRestart?: boolean;
  isRestarting?: boolean;
  onRestart?: () => void;
  onSelect: (sessionId: string) => void;
  onPromotePreview?: (sessionId: string) => void;
  onClose: (sessionId: string) => void;
  onCloseOthers: (sessionId: string) => void;
  onCloseAll: () => void;
  onTogglePin: (sessionId: string) => void;
  onDragStart: (event: React.DragEvent) => void;
  onDragOver: (event: React.DragEvent) => void;
  onDrop: (event: React.DragEvent) => void;
  onDragEnd: () => void;
}) {
  const { sessionId, active, pinned, preview, dragging } = props;
  const record = useAtomValue(sessionRecordByIdAtomFamily(sessionId));
  const runtime = useAtomValue(sessionRuntimeBySessionIdAtomFamily(sessionId));
  const status = runtime?.status;
  // 状态徽章语义与侧栏 SessionTree 状态点一致（idle=蓝、running/starting=黄、error=红）；
  // 未启动（无 runtime）不显示徽章，避免把“未运行”误读成某种状态。
  const badge = sessionStatusBadge(status);
  const title = record?.title || t("common.untitled");
  // 操作菜单（受控）：下拉按钮点击或右键 Tab 打开；Tab 本体点击仍是切换，
  // 拖拽排序与中键关闭与菜单互不干扰（drag/auxclick 不触发 click）。
  const [menuOpen, setMenuOpen] = useState(false);

  const select = () => props.onSelect(sessionId);
  const close = () => props.onClose(sessionId);

  return (
    <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
      <div
        role="tab"
        aria-selected={active}
        data-session-id={sessionId}
        title={title}
        draggable
        onDragStart={props.onDragStart}
        onDragOver={props.onDragOver}
        onDrop={props.onDrop}
        onDragEnd={props.onDragEnd}
        onClick={select}
        onDoubleClick={() => {
          // 双击预览 Tab → 常驻（侧栏双击同语义）；已常驻则忽略
          if (preview) props.onPromotePreview?.(sessionId);
        }}
        onAuxClick={(event) => {
          // 中键关闭（固定 Tab 忽略，需先取消固定），与浏览器 Tab 行为一致
          if (event.button === 1 && !pinned) close();
        }}
        onContextMenu={(event) => {
          // 右键打开操作菜单（与下拉按钮一致）
          event.preventDefault();
          setMenuOpen(true);
        }}
        className={cn(
          "session-tab group relative flex h-7 shrink-0 cursor-pointer select-none items-center gap-1.5 rounded-md border px-2 text-caption transition-colors",
          // 固定 Tab 与普通 Tab 同宽策略（按内容收缩，上限 128px）：固定 Tab 无关闭按钮，
          // hover 不会因按钮出现而跳动，无需 w-20 占位；固定宽度反而让 Pin 图标挤占标题空间
          "w-fit max-w-32",
          dragging && "opacity-50",
          // 选中态与侧栏 SessionTree 一致：背景浮起 + 强边框 + 轻阴影
          active
            ? "border-border-strong bg-accent/20 font-medium text-foreground shadow-sm"
            : "border-transparent text-muted-foreground hover:bg-accent/50 hover:text-foreground",
          preview && "italic font-normal text-muted-foreground",
        )}
      >
        {badge && (
          // beui AnimatedBadge bare 模式：去掉胶囊边框/背景，仅保留图标滚动/旋转动画；
          // 图标经 [&_svg] 稳定选择器缩到 10px；运行中通过 colorClass 覆盖成黄色旋转。
          <AnimatedBadge
            status={badge.status}
            size="sm"
            bare
            pulse={false}
            className={cn("[&_svg]:h-2.5 [&_svg]:w-2.5", badge.colorClass)}
            aria-hidden="true"
          />
        )}
        {props.grouped && (
          // 分屏组颜色标记：左侧竖条（与组头胶囊同色，颜色可自定义）
          <span
            className="h-3 w-0.5 shrink-0 rounded-full"
            style={{
              backgroundColor: props.groupColor || "var(--color-accent)",
            }}
            aria-hidden="true"
          />
        )}
        {pinned && <Pin className="size-3 shrink-0 text-muted-foreground/70" aria-hidden="true" />}
        <span className={cn("min-w-0 flex-1 truncate", preview && "italic")}>{title}</span>
        {/* 拖拽插入指示线：2px 主题色竖线，贴在目标 Tab 左/右缘 */}
        {props.indicator && (
          <span
            aria-hidden="true"
            className={cn(
              "pointer-events-none absolute top-1 bottom-1 w-0.5 rounded-full bg-primary",
              props.indicator === "before" ? "-left-0.5" : "-right-0.5",
            )}
          />
        )}
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            role="tab-menu"
            aria-label={t("tabs.moreActions")}
            title={t("tabs.moreActions")}
            className={cn(
              "inline-grid size-4 shrink-0 place-items-center rounded-sm text-muted-foreground/70 hover:bg-accent hover:text-foreground",
              // 与关闭按钮同规则：非激活 Tab 悬停才显示；菜单打开时保持可见
              active || menuOpen ? "opacity-60 hover:opacity-100" : "opacity-0 group-hover:opacity-60",
            )}
            onClick={(event) => {
              // 下拉按钮只打开菜单、不触发 Tab 切换：阻断冒泡（Radix 的 toggle 在同一元素上仍会执行）
              event.stopPropagation();
            }}
          >
            <ChevronDown className="size-3" aria-hidden="true" />
          </button>
        </DropdownMenuTrigger>
        {!pinned && (
          <button
            type="button"
            role="tab-close"
            aria-label={t("tabs.close")}
            title={t("tabs.close")}
            className={cn(
              "inline-grid size-4 shrink-0 place-items-center rounded-sm text-muted-foreground/70 hover:bg-accent hover:text-foreground",
              active ? "opacity-60 hover:opacity-100" : "opacity-0 group-hover:opacity-60",
            )}
            onClick={(event) => {
              event.stopPropagation();
              close();
            }}
          >
            <X className="size-3" />
          </button>
        )}
      </div>
      <DropdownMenuContent align="start" side="bottom" className="min-w-40">
        {/* 停止/重启按 agent 状态置灰：用内联 style 而非 className——
            shadcn 默认 data-[disabled]:opacity-50 在部分主题/层序下不显眼，
            内联样式特异性最高，任何 CSS 都覆盖不了，保证灰化可见。 */}
        <DropdownMenuItem onSelect={() => props.onTogglePin(sessionId)}>
          <span className="inline-flex items-center gap-2">
            {pinned ? <PinOff className="size-3.5" aria-hidden="true" /> : <Pin className="size-3.5" aria-hidden="true" />}
            {pinned ? t("tabs.unpin") : t("tabs.pin")}
          </span>
        </DropdownMenuItem>
        {active && props.onStop && (
          <DropdownMenuItem
            disabled={!props.canStop}
            style={!props.canStop ? { opacity: 0.4 } : undefined}
            onSelect={props.onStop}
          >
            <span className="inline-flex items-center gap-2">
              <CircleStop className="size-3.5" aria-hidden="true" />
              {t("tabs.closeSession")}
            </span>
          </DropdownMenuItem>
        )}
        {active && props.onRestart && (
          <DropdownMenuItem
            disabled={!props.canRestart || props.isRestarting}
            style={!props.canRestart || props.isRestarting ? { opacity: 0.4 } : undefined}
            onSelect={props.onRestart}
          >
            <span className="inline-flex items-center gap-2">
              <RotateCw className={cn("size-3.5", props.isRestarting && "animate-spin")} aria-hidden="true" />
              {props.isRestarting ? t("app.restarting") : t("app.restart")}
            </span>
          </DropdownMenuItem>
        )}
        {!pinned && (
          <DropdownMenuItem onSelect={close}>
            <span className="inline-flex items-center gap-2">
              <X className="size-3.5" aria-hidden="true" />
              {t("tabs.close")}
            </span>
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => props.onCloseOthers(sessionId)}>
          <span className="inline-flex items-center gap-2">
            <CircleX className="size-3.5" aria-hidden="true" />
            {t("tabs.closeOthers")}
          </span>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={props.onCloseAll}>
          <span className="inline-flex items-center gap-2">
            <X className="size-3.5" aria-hidden="true" />
            {t("tabs.closeAll")}
          </span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * 新建会话入口（浏览器式 “+”）：固定在标签带末端，下拉选择新建目标。
 * 聊天对话区置顶，之后是已打开的工作区项目；目标列表由 App 装配好传入，
 * 这里只做展示与选择回调，不接触项目库存。
 */
function NewSessionMenu(props: {
  targets: readonly NewSessionTarget[];
  onSelect: (projectId: string) => void;
}) {
  const chatTargets = props.targets.filter((target) => target.isChat);
  const projectTargets = props.targets.filter((target) => !target.isChat);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="session-tabs-new ml-0.5 inline-grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground"
          title={t("tabs.new")}
          aria-label={t("tabs.new")}
        >
          <Plus className="size-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="bottom" className="min-w-44">
        {chatTargets.map((target) => (
          <DropdownMenuItem key={target.projectId} onSelect={() => props.onSelect(target.projectId)}>
            <span className="inline-flex items-center gap-2">
              <MessagesSquare className="size-3.5 text-muted-foreground" aria-hidden="true" />
              {target.label}
            </span>
          </DropdownMenuItem>
        ))}
        {chatTargets.length > 0 && projectTargets.length > 0 && <DropdownMenuSeparator />}
        {projectTargets.map((target) => (
          <DropdownMenuItem key={target.projectId} onSelect={() => props.onSelect(target.projectId)}>
            <span className="inline-flex min-w-0 items-center gap-2">
              <Folder className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
              <span className="truncate">{target.label}</span>
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
