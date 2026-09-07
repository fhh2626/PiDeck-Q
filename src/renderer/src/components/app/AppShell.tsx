import { useEffect, useRef, useState, type ReactNode, type CSSProperties } from "react";
import {
  type Layout,
  type LayoutChangedMeta,
  type PanelImperativeHandle,
} from "react-resizable-panels";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "../ui-shadcn/resizable";
import { AppHeader } from "../AppHeader";
import { WorkspaceDrawerHost } from "../workspace/WorkspaceDrawerHost";
import { useNotifyLayoutResized } from "../../hooks/useNotifyLayoutResized";
import { LIST_WIDTH_MIN, LIST_WIDTH_MAX } from "../../hooks/useResize";
import {
  DRAWER_WIDTH_MIN,
  DRAWER_WIDTH_MIN_PINNED,
  DRAWER_WIDTH_MAX,
  type WorkspaceDrawerPanel,
} from "../../hooks/useWorkspacePanels";
import { cn } from "../../lib/utils";
import { shouldCommitPanelPixels } from "../../lib/shellPanelLayout";
import type { WindowResizeEdge } from "../../../../shared/desktop/NativeHostTypes";
import { shouldBeginWindowDrag } from "../../utils/windowChromeDrag";

/**
 * 工作台外壳（#115 U5 布局换装）：三栏水平布局由 react-resizable-panels 接管。
 *
 * 状态归属约定：
 * - App 侧的 px 状态（listWidth/drawerWidth/listCollapsed/drawerCollapsed）仍是
 *   单一事实源，同时驱动 CSS 变量（hover 宽度、抽屉内部动画等旧样式仍依赖它们）。
 * - 面板库负责拖拽交互；拖拽**过程中不回写 React 状态**（每个 pointermove 都
 *   setState 会让整个工作台每帧重渲染，且 defaultSize 随动会触发库重布局，
 *   两者叠加就是肉眼可见的抖动）；拖拽释放/键盘调整完成时经 Group 的
 *   onLayoutChanged 统一提交一次。外部状态变化（标题栏折叠按钮、恢复默认宽度）
 *   经 imperative resize/collapse/expand 同步回面板。
 * - 宽度变化超过 1px 才回写/同步，避免 state → resize → layout 的反馈回路。
 *
 * 折叠语义对齐旧实现：
 * - 侧栏 collapsedSize=14（旧版收起后保留 14px 边缘提示条，恢复走标题栏按钮）；
 *   拖拽低于 minSize 自动折叠。
 * - 抽屉 collapsedSize=0；未钉住时可拖拽折叠，钉住（pinned）时禁止折叠且最小 220px。
 *
 * 已知变化：抽屉/侧栏开合不再有 120ms grid 过渡动画（面板布局为即时宽度），
 * 由下方 drawer-content-enter / list-content-enter 内容动画替代：
 * 面板宽度即时变化（避免 width 动画掉帧），内容层补一次 transform+opacity
 * 进入动画制造“滑出/淡入”感；CSS animation 播完自动恢复默认样式，不留
 * transform（Windows 静止态 transform 会降级 ClearType）。关闭保持即时。
 */

export interface AppShellProps {
  listCollapsed: boolean;
  listWidth: number;
  drawer: WorkspaceDrawerPanel | null;
  drawerCollapsed: boolean;
  drawerWidth: number;
  drawerPinned: boolean;
  useNativeTitleBar: boolean;
  /** 当前运行平台；mac 自定义标题栏要避开系统红绿灯，不能再画一套 Win 按钮。 */
  platform: NodeJS.Platform;

  chatPaneRef: React.RefObject<HTMLElement | null>;
  terminalRowHeight: number;
  /** 聊天内容区占面板百分比（60–100），注入 --chat-content-pct-set，由 CSS 容器查询自适应分屏 */
  chatContentWidthPct: number;

  sidebarContent: ReactNode;
  chatPaneContent: ReactNode;
  drawerContent: (panel: WorkspaceDrawerPanel) => ReactNode;
  /** 抽屉活动栏，用于切换当前可用工作区面板，由 App 注入；抽屉打开时常驻。 */
  drawerRail?: ReactNode;
  outlineContent: ReactNode;

  setListCollapsed: (v: boolean) => void;
  setListWidth: (v: number) => void;
  setDrawerCollapsed: (v: boolean) => void;
  setDrawerWidth: (v: number) => void;
  onToggleListCollapsed: () => void;
  onDrawerCollapse: () => void;
  onDrawerClose: () => void;
  onDrawerRestore: () => void;
  onToggleDrawerPin: () => void;

  toggleAlwaysOnTop: () => Promise<boolean>;
  minimizeWindow: () => void;
  toggleMaximizeWindow: () => Promise<boolean>;
  isWindowMaximized: () => Promise<boolean>;
  onWindowMaximizedChange: (callback: (maximized: boolean) => void) => () => void;
  closeWindow: () => void;
  beginWindowDrag: () => void;
  beginWindowResize: (edge: WindowResizeEdge) => void;
  enableNativeResize: boolean;

  children?: ReactNode;
}

/** 侧栏收起后保留的边缘提示条宽度（对齐旧 grid 实现） */
const LIST_COLLAPSED_SIZE = 0;
// 侧栏宽度上下限由 useResize 统一导出（LIST_WIDTH_MIN/MAX），
// 与 localStorage 持久化读取时的 clamp 范围同源，避免两处漂移。

export function AppShell(props: AppShellProps) {
  const {
    listCollapsed, listWidth,
    drawer, drawerCollapsed, drawerWidth, drawerPinned,
    useNativeTitleBar,
    platform,
    chatPaneRef, terminalRowHeight, chatContentWidthPct,
    sidebarContent, chatPaneContent, drawerContent, drawerRail, outlineContent,
    setListCollapsed, setListWidth, setDrawerCollapsed, setDrawerWidth,
    onToggleListCollapsed,
    onDrawerCollapse, onDrawerClose, onDrawerRestore, onToggleDrawerPin,
    toggleAlwaysOnTop, minimizeWindow, toggleMaximizeWindow, isWindowMaximized, onWindowMaximizedChange, closeWindow, beginWindowDrag,
    beginWindowResize, enableNativeResize,
    children,
  } = props;

  const listPanelRef = useRef<PanelImperativeHandle | null>(null);
  const drawerPanelRef = useRef<PanelImperativeHandle | null>(null);
  const groupRef = useRef<HTMLDivElement | null>(null);
  // 开合 effect 不把 width 放进依赖（否则每次回写都会再 expand/resize 一轮）。
  // 打开折叠面板时用 ref 读最新保存宽度，避免 expand() 落到 minSize。
  const listWidthRef = useRef(listWidth);
  const drawerWidthRef = useRef(drawerWidth);
  listWidthRef.current = listWidth;
  drawerWidthRef.current = drawerWidth;
  // RO 同步回调只读 ref，避免每次回写触发 effect 重订阅
  const drawerOpenRef = useRef(false);
  const listOpenRef = useRef(false);
  drawerOpenRef.current = Boolean(drawer) && !drawerCollapsed;
  listOpenRef.current = !listCollapsed;
  const notifyLayoutResized = useNotifyLayoutResized();

  // 抽屉/侧栏“刚打开”标志：closed→open 时给内容容器挂一次进入动画类；
  // 动画结束（onAnimationEnd）移除。面板库 collapse/expand 是即时宽度，
  // 内容动画只动 transform/opacity，且播完无残留。
  const [drawerEntering, setDrawerEntering] = useState(false);
  const [listEntering, setListEntering] = useState(false);
  const prevDrawerOpenRef = useRef(false);
  const prevListOpenRef = useRef(false);
  useEffect(() => {
    const open = Boolean(drawer) && !drawerCollapsed;
    if (open && !prevDrawerOpenRef.current) setDrawerEntering(true);
    prevDrawerOpenRef.current = open;
  }, [drawer, drawerCollapsed]);
  useEffect(() => {
    const open = !listCollapsed;
    if (open && !prevListOpenRef.current) setListEntering(true);
    prevListOpenRef.current = open;
  }, [listCollapsed]);

  // ── 折叠状态 → 面板（标题栏按钮、抽屉头部按钮等外部来源） ──
  useEffect(() => {
    const panel = listPanelRef.current;
    if (!panel) return;
    if (listCollapsed) { if (!panel.isCollapsed()) panel.collapse(); }
    // expand() 无上次展开宽度时落到 minSize(100)；全屏/还原时会被当成新宽度。
    else if (panel.isCollapsed()) panel.resize(listWidthRef.current);
  }, [listCollapsed]);

  // 抽屉 Panel 常驻挂载（drawer=null 时折叠 0 宽），此 effect 统一同步折叠态；
  // 推迟一帧 + 容错：常驻挂载后约束始终就绪，保留 try/catch 仅为防御。
  useEffect(() => {
    const panel = drawerPanelRef.current;
    if (!panel) return;
    const frame = requestAnimationFrame(() => {
      try {
        // drawer 为空时必须折叠（常驻挂载下避免空面板意外展开）
        if (!drawer || drawerCollapsed) {
          if (!panel.isCollapsed()) panel.collapse();
        } else if (panel.isCollapsed()) {
          // expand() 无历史会落到 minSize(180)。清缓存后保存宽度是默认 320，
          // 写成 180 再被宽度 effect resize(320)，就是打开抽屉后一直闪、点一下才停。
          panel.resize(drawerWidthRef.current);
        }
      } catch { /* 约束未就绪，忽略本轮同步 */ }
    });
    return () => cancelAnimationFrame(frame);
  }, [drawerCollapsed, drawer]);

  // ── 外部宽度变化 → 面板（跳过拖拽回写产生的等值同步，防反馈回路） ──
  useEffect(() => {
    const panel = listPanelRef.current;
    if (!panel || listCollapsed) return;
    if (Math.abs(panel.getSize().inPixels - listWidth) > 1) panel.resize(listWidth);
  }, [listWidth, listCollapsed]);

  useEffect(() => {
    const panel = drawerPanelRef.current;
    if (!panel || !drawer || drawerCollapsed) return;
    const frame = requestAnimationFrame(() => {
      try {
        if (Math.abs(panel.getSize().inPixels - drawerWidth) > 1) panel.resize(drawerWidth);
      } catch { /* 约束未就绪 */ }
    });
    return () => cancelAnimationFrame(frame);
  }, [drawerWidth, drawer, drawerCollapsed]);

  // ── 容器缩放（zoomFactor / 窗口拉伸 / 全屏切换）→ 面板像素回写 ──
  // 库的 onLayoutChanged 只报告百分比布局变化：preserve-relative-size 下
  // zoom 前后百分比不变，W(上次,本次) 判定相同直接跳过，AppShell 收不到通知，
  // outline-hover 的 --drawer-* 就停在旧像素（表现为“缩放后悬浮菜单不跟随”）。
  // 这里用 ResizeObserver 直察 Group 容器：容器尺寸变化必触发，且回调排在库的
  // RO 之后（库先 observe），getSize() 读到的已是新布局；列表/抽屉折叠时跳过。
  useEffect(() => {
    const el = groupRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      if (drawerOpenRef.current) {
        const drawerPanel = drawerPanelRef.current;
        if (drawerPanel) {
          const px = Math.round(drawerPanel.getSize().inPixels);
          if (px > 1 && Math.abs(px - drawerWidthRef.current) > 1)
            setDrawerWidth(px);
        }
      }
      if (listOpenRef.current) {
        const listPanel = listPanelRef.current;
        if (listPanel) {
          const px = Math.round(listPanel.getSize().inPixels);
          if (px > LIST_COLLAPSED_SIZE && Math.abs(px - listWidthRef.current) > 1)
            setListWidth(px);
        }
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ── 布局落定 → 状态回写 ──
  // onLayoutChanged 在一次布局变更“完成”时触发（拖拽释放、分隔条键盘调整、容器缩放）。
  // 折叠状态只在用户交互时回写。抽屉像素宽走 shouldCommitPanelPixels：缩放后跟像素，
  // 折叠 0 / expand→min 的瞬时值不写。
  function handleLayoutChanged(_layout: Layout, meta: LayoutChangedMeta) {
    // 无论交互还是程序化变更，布局落定后都通知悬浮层重算一次。
    notifyLayoutResized();
    const drawerPanel = drawerPanelRef.current;
    const drawerMin = drawerPinned ? DRAWER_WIDTH_MIN_PINNED : DRAWER_WIDTH_MIN;
    if (drawerPanel && drawer && !drawerCollapsed) {
      // 缩放后 --drawer-* 仍要跟像素走；但 expand→min 的瞬时值不能盖掉保存宽度。
      const next = shouldCommitPanelPixels({
        px: drawerPanel.getSize().inPixels,
        savedWidth: drawerWidth,
        minSize: drawerMin,
        isUserInteraction: meta.isUserInteraction,
      });
      if (next !== null) setDrawerWidth(next);
    }

    if (!meta.isUserInteraction) return;
    const listPanel = listPanelRef.current;
    if (listPanel) {
      const px = Math.round(listPanel.getSize().inPixels);
      const collapsed = listPanel.isCollapsed() || px <= LIST_COLLAPSED_SIZE + 1;
      if (collapsed !== listCollapsed) setListCollapsed(collapsed);
      if (!collapsed) {
        const next = shouldCommitPanelPixels({
          px,
          savedWidth: listWidth,
          minSize: LIST_WIDTH_MIN,
          isUserInteraction: true,
        });
        if (next !== null) setListWidth(next);
      }
    }
    if (drawerPanel) {
      const px = Math.round(drawerPanel.getSize().inPixels);
      const collapsed = drawerPanel.isCollapsed() || px <= 1;
      if (collapsed) {
        // 拖拽折叠仅允许未钉住场景（pinned 面板 collapsible=false，不会走到这）
        if (!drawerCollapsed) setDrawerCollapsed(true);
      } else if (drawerCollapsed) {
        setDrawerCollapsed(false);
      }
    }
  }

  return (
    <div
      className={[
        "wechat-shell",
        drawer && !drawerCollapsed ? "drawer-open" : "",
        listCollapsed ? "list-collapsed" : "",
        drawerCollapsed ? "drawer-collapsed" : "",
        useNativeTitleBar ? "" : "custom-titlebar-enabled",
        // mac 自定义标题栏：系统红绿灯占左上角，右侧不再叠 Win 风格控件。
        !useNativeTitleBar && platform === "darwin" ? "mac-custom-titlebar" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      style={
        {
          "--list-width": `${listCollapsed ? 0 : listWidth}px`,
          "--list-expanded-width": `${listWidth}px`,
          "--list-hover-width": `${Math.max(190, listWidth)}px`,
          "--drawer-width": `${drawer && !drawerCollapsed ? drawerWidth : 0}px`,
          "--drawer-col-w": `${drawer && !drawerCollapsed ? drawerWidth : 0}px`,
          "--drawer-splitter-w": `${drawer && !drawerCollapsed ? 6 : 0}px`,
        } as CSSProperties
      }
      onPointerDownCapture={(event) => {
        // Electron still honors -webkit-app-region: drag. Only the Qt host
        // needs an explicit system-move RPC, and preventDefault there would
        // steal Chromium's drag on the Electron custom titlebar.
        if (useNativeTitleBar || !enableNativeResize) return;
        if (event.button !== 0) return;
        if (!shouldBeginWindowDrag(event.target)) return;
        event.preventDefault();
        beginWindowDrag();
      }}
      onDoubleClickCapture={(event) => {
        if (useNativeTitleBar || !enableNativeResize) return;
        if (!shouldBeginWindowDrag(event.target)) return;
        event.preventDefault();
        void toggleMaximizeWindow();
      }}
    >
      <AppHeader
        useNativeTitleBar={useNativeTitleBar}
        platform={platform}
        toggleAlwaysOnTop={toggleAlwaysOnTop}
        minimizeWindow={minimizeWindow}
        toggleMaximizeWindow={toggleMaximizeWindow}
        isWindowMaximized={isWindowMaximized}
        onWindowMaximizedChange={onWindowMaximizedChange}
        closeWindow={closeWindow}
        beginWindowResize={beginWindowResize}
        enableNativeResize={enableNativeResize}
      />
      <ResizablePanelGroup orientation="horizontal" className="shell-panel-group" elementRef={groupRef} onLayoutChanged={handleLayoutChanged}>
        <ResizablePanel
          id="list"
          panelRef={listPanelRef}
          collapsible
          collapsedSize={LIST_COLLAPSED_SIZE}
          minSize={LIST_WIDTH_MIN}
          maxSize={LIST_WIDTH_MAX}
          defaultSize={listCollapsed ? LIST_COLLAPSED_SIZE : listWidth}
          className="shell-panel-list"
        >
          <div
            className={cn("h-full min-w-0", listEntering && "list-content-enter")}
            onAnimationEnd={(event) => {
              if (event.target === event.currentTarget) setListEntering(false);
            }}
          >
            {sidebarContent}
          </div>
        </ResizablePanel>
        <ResizableHandle className="splitter splitter-left" />

        <ResizablePanel id="chat" minSize={360} className="shell-panel-chat">
          <main
            ref={chatPaneRef}
            className="chat-pane"
            style={
              {
                "--terminal-row-h": `${terminalRowHeight}px`,
                // 内容宽度百分比（60–100）：消息区/输入框用 var(--chat-content-pct-set) 做 width。
                "--chat-content-pct-set": `${chatContentWidthPct}%`,
              } as CSSProperties
            }
          >
            {chatPaneContent}
          </main>
        </ResizablePanel>

        {/* 抽屉面板常驻挂载：drawer=null 时折叠为 0 宽，避免动态挂载导致
            Group 布局时序错误（Invalid panel layout / constraints not found）。
            内容由 WorkspaceDrawerHost 的空态兜底。 */}
        <ResizableHandle
          className="splitter splitter-right"
          data-active={Boolean(drawer) && !drawerCollapsed}
        />
        <ResizablePanel
          id="drawer"
          panelRef={drawerPanelRef}
          collapsible={!drawerPinned}
          collapsedSize={0}
          minSize={drawerPinned ? DRAWER_WIDTH_MIN_PINNED : DRAWER_WIDTH_MIN}
          maxSize={DRAWER_WIDTH_MAX}
          defaultSize={0}
          className="shell-panel-drawer"
        >
          <div
            className={cn("h-full min-w-0", drawerEntering && "drawer-content-enter")}
            onAnimationEnd={(event) => {
              if (event.target === event.currentTarget) setDrawerEntering(false);
            }}
          >
            <WorkspaceDrawerHost
              panel={drawer}
              collapsed={drawerCollapsed}
              pinned={drawerPinned}
              onCollapse={onDrawerCollapse}
              onClose={onDrawerClose}
              onRestore={onDrawerRestore}
              onTogglePin={onToggleDrawerPin}
              rail={drawerRail}
              renderPanel={(panel) => drawerContent(panel)}
            />
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>
      {/* 大纲浮层必须放在 Group 外：v4 只认 data-panel / data-separator 直系子节点，
          夹在 panel 之间会污染分隔条命中区计算（absolute 也不算例外）。 */}
      {outlineContent}
      {children}
    </div>
  );
}
