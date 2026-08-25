import { useCallback, useEffect, useRef, useState } from "react";
import type { AppFocusSessionTarget } from "../../../shared/types";
import { useAtomValue, useSetAtom, useStore } from "jotai";
import {
  sessionRecordByIdAtomFamily,
  sessionRecordsAtom,
  sessionTabIdsAtom,
} from "../atoms";
import {
  openPermanentSessionTab,
  openPreviewSessionTab,
  reorderSessionTabs,
  togglePinSessionTab,
  type SessionTabOpenMode,
} from "../utils/sessionTabs";
import {
  buildSplitLayoutFromDrop,
  edgeToOrientation,
  insertRootPaneFromDrop,
  nestSplitPaneFromDrop,
  replaceSplitPaneFromDrop,
  resolveSplitAfterClose,
  resolveSplitHostSessionId,
  splitLayoutSessionIds,
  type SessionSplitDropTarget,
  type SessionSplitLayout,
} from "../utils/sessionSplitEdge";

const PINNED_TABS_STORAGE_KEY = "pideck.pinnedSessionTabIds";
const SPLIT_GROUP_COLLAPSED_KEY = "pideck.splitGroupCollapsed";
const SPLIT_GROUP_CONFIG_KEY = "pideck.splitGroupConfig";
/** 分屏组默认颜色（色板第一个，蓝色） */
export const SPLIT_GROUP_DEFAULT_COLOR = "#0091ff";

export type SessionWorkspaceFocusHandlers = {
  /** 切换当前会话焦点（不改 Tab 预览/常驻状态） */
  focusSession: (projectId: string, sessionId: string) => void;
  /** 无剩余 Tab 时回到项目空态 */
  focusProject: (projectId: string) => void;
};

/**
 * 会话工作区 chrome：Tab 列表 / 预览 / Pin / 分屏 / 拖拽落点。
 *
 * 与「选中哪个会话」正交——选中由 useSessionActions 负责；本 hook 只登记/维护
 * 顶栏与分屏布局。App 只做装配，不写 chrome 业务分支。
 */
export function useSessionWorkspaceChrome(options: {
  currentSessionId: string | undefined;
  activeProjectId: string | undefined;
}) {
  const { currentSessionId, activeProjectId } = options;
  const store = useStore();
  const sessionTabIds = useAtomValue(sessionTabIdsAtom);
  const setSessionTabIds = useSetAtom(sessionTabIdsAtom);
  const sessionRecords = useAtomValue(sessionRecordsAtom);

  const focusHandlersRef = useRef<SessionWorkspaceFocusHandlers>({
    focusSession: () => undefined,
    focusProject: () => undefined,
  });
  const latestFocusTargetIdRef = useRef<string | null>(null);

  const [pinnedSessionTabIds, setPinnedSessionTabIds] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem(PINNED_TABS_STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed)
        ? parsed.filter((id): id is string => typeof id === "string")
        : [];
    } catch {
      return [];
    }
  });
  const [previewSessionTabId, setPreviewSessionTabId] = useState<string | null>(null);
  const [splitLayout, setSplitLayout] = useState<SessionSplitLayout | null>(null);
  const [draggingSessionId, setDraggingSessionId] = useState<string | null>(null);
  /** 分屏组胶囊在 Tab 栏的收起状态（持久化） */
  const [splitGroupCollapsed, setSplitGroupCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(SPLIT_GROUP_COLLAPSED_KEY) === "1";
    } catch {
      return false;
    }
  });
  /** 分屏组自定义配置（名称/颜色，持久化；重启后重新分屏时沿用） */
  const [splitGroupConfig, setSplitGroupConfig] = useState<{
    name: string;
    color: string;
  }>(() => {
    try {
      const raw = localStorage.getItem(SPLIT_GROUP_CONFIG_KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      if (
        parsed &&
        typeof parsed.name === "string" &&
        typeof parsed.color === "string"
      ) {
        return { name: parsed.name, color: parsed.color };
      }
    } catch {
      // 配置损坏时回退默认
    }
    return { name: "", color: SPLIT_GROUP_DEFAULT_COLOR };
  });

  // 最新快照：供 drop/close 回调避免闭包陈旧
  const tabsSnapshotRef = useRef({
    tabs: sessionTabIds,
    pinned: pinnedSessionTabIds,
    previewId: previewSessionTabId,
    split: splitLayout,
    currentSessionId,
    activeProjectId,
  });
  tabsSnapshotRef.current = {
    tabs: sessionTabIds,
    pinned: pinnedSessionTabIds,
    previewId: previewSessionTabId,
    split: splitLayout,
    currentSessionId,
    activeProjectId,
  };
  // 会话记录消失时清理 Tab / pin / preview / 分屏，并自动切换焦点
  useEffect(() => {
    let nextTabIds: string[] | undefined;
    setSessionTabIds((current) => {
      const next = current.filter((id) => Boolean(sessionRecords[id]));
      nextTabIds = next;
      return next.length === current.length ? current : next;
    });
    setPinnedSessionTabIds((current) => {
      const next = current.filter((id) => Boolean(sessionRecords[id]));
      return next.length === current.length ? current : next;
    });
    setPreviewSessionTabId((current) =>
      current && !sessionRecords[current] ? null : current,
    );
    setSplitLayout((layout) => {
      // 任一栏会话记录消失则整个退出分屏（存活栏会话由 closeTab 的
      // resolveSplitAfterClose 负责晋升单栏，这里只处理记录删除的场景）
      if (!layout) return layout;
      const ids = splitLayoutSessionIds(layout);
      return ids.every((id) => Boolean(sessionRecords[id])) ? layout : null;
    });

    // 如果当前选中的会话已经被删除，自动切到邻近存活 Tab 或项目空态。
    const snap = tabsSnapshotRef.current;
    if (snap.currentSessionId && !sessionRecords[snap.currentSessionId]) {
      const remaining = (nextTabIds ?? snap.tabs).filter((id) => Boolean(sessionRecords[id]));
      if (remaining.length > 0) {
        const deletedIndex = Math.max(0, snap.tabs.indexOf(snap.currentSessionId));
        const nextId = remaining[Math.min(deletedIndex, remaining.length - 1)];
        const record = sessionRecords[nextId];
        if (record) {
          focusHandlersRef.current.focusSession(record.projectId, nextId);
        }
      } else if (snap.activeProjectId) {
        focusHandlersRef.current.focusProject(snap.activeProjectId);
      }
    }
  }, [sessionRecords, setSessionTabIds]);

  useEffect(() => {
    let disposed = false;
    // A newer notification supersedes every retry scheduled for an older target.
    // Without this gate, a late catalog load could focus an obsolete session after
    // the user has already clicked a second notification.
    const focusByTarget = (target: AppFocusSessionTarget) => {
      latestFocusTargetIdRef.current = target.id;
      const tryFocus = (attempt: number) => {
        if (disposed || latestFocusTargetIdRef.current !== target.id) return;
        const record = store.get(sessionRecordByIdAtomFamily(target.sessionId));
        if (record) {
          if (latestFocusTargetIdRef.current !== target.id) return;
          focusHandlersRef.current.focusSession(record.projectId, record.id);
          // ACK only after the stable SessionRecord was found and focus was dispatched.
          // NativeHost compares the id, so a late ACK cannot clear a newer notification.
          void window.piDesktop.app.ackFocusSessionTarget(target.id).catch(() => undefined);
          return;
        }
        if (attempt < 15) {
          setTimeout(() => tryFocus(attempt + 1), 200);
        }
      };
      tryFocus(0);
    };

    const unsubscribe = window.piDesktop.app.onFocusSessionTarget((target) => {
      focusByTarget(target);
    });
    void window.piDesktop.app.getPendingFocusTarget?.().then((target) => {
      if (disposed || !target) return;
      focusByTarget(target);
    });
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [store]);

  /** 由 App 在 session actions 就绪后注入；写 ref 避免与 actions 形成 hook 环依赖 */
  const bindFocusHandlers = useCallback((handlers: SessionWorkspaceFocusHandlers) => {
    focusHandlersRef.current = handlers;
  }, []);

  /** 在 App / 侧栏边界登记 Tab（preview / permanent）；与 selectSession 解耦 */
  const registerOpenSession = useCallback((
    sessionId: string,
    mode: SessionTabOpenMode = "permanent",
  ) => {
    const { tabs, pinned, previewId } = tabsSnapshotRef.current;
    const result =
      mode === "preview"
        ? openPreviewSessionTab(tabs, pinned, previewId, sessionId)
        : openPermanentSessionTab(tabs, pinned, previewId, sessionId);
    setSessionTabIds(result.tabs);
    setPreviewSessionTabId(result.previewId);
  }, [setSessionTabIds]);

  const promotePreview = useCallback((sessionId: string) => {
    registerOpenSession(sessionId, "permanent");
  }, [registerOpenSession]);

  const closeTab = useCallback((sessionId: string) => {
    const snap = tabsSnapshotRef.current;
    const remaining = snap.tabs.filter((id) => id !== sessionId);
    setSessionTabIds(remaining);
    if (snap.previewId === sessionId) setPreviewSessionTabId(null);

    if (snap.split) {
      const resolved = resolveSplitAfterClose(snap.split, sessionId);
      if (!resolved) {
        setSplitLayout(null);
      } else if ("soloSessionId" in resolved) {
        setSplitLayout(null);
        if (snap.currentSessionId === sessionId) {
          const record = store.get(sessionRecordByIdAtomFamily(resolved.soloSessionId));
          if (record) focusHandlersRef.current.focusSession(record.projectId, resolved.soloSessionId);
        }
        if (remaining.length === 0 && snap.activeProjectId) {
          focusHandlersRef.current.focusProject(snap.activeProjectId);
        }
        return;
      } else {
        setSplitLayout(resolved.layout);
        // 分屏仍存在且关闭的是当前聚焦会话：焦点优先留在分屏内幸存会话，
        // 避免焦点游离到 Tab 邻居导致分屏视图隐藏
        if (snap.currentSessionId === sessionId && remaining.length > 0) {
          const splitSurvivors = splitLayoutSessionIds(resolved.layout).filter((id) =>
            remaining.includes(id),
          );
          if (splitSurvivors.length > 0) {
            const record = store.get(sessionRecordByIdAtomFamily(splitSurvivors[0]));
            if (record) {
              focusHandlersRef.current.focusSession(record.projectId, splitSurvivors[0]);
              return;
            }
          }
        }
      }
    }

    if (snap.currentSessionId !== sessionId) return;
    if (remaining.length > 0) {
      const index = snap.tabs.indexOf(sessionId);
      const next = remaining[Math.min(index, remaining.length - 1)];
      const record = store.get(sessionRecordByIdAtomFamily(next));
      if (record) focusHandlersRef.current.focusSession(record.projectId, next);
    } else if (snap.activeProjectId) {
      focusHandlersRef.current.focusProject(snap.activeProjectId);
    }
  }, [setSessionTabIds, store]);

  const closeOtherTabs = useCallback((sessionId: string) => {
    setSessionTabIds((current) => current.filter((id) => id === sessionId));
    setPreviewSessionTabId((current) => (current && current !== sessionId ? null : current));
    setSplitLayout(null);
  }, [setSessionTabIds]);

  const closeAllTabs = useCallback(() => {
    setSessionTabIds([]);
    setPreviewSessionTabId(null);
    setSplitLayout(null);
    const projectId = tabsSnapshotRef.current.activeProjectId;
    if (projectId) focusHandlersRef.current.focusProject(projectId);
  }, [setSessionTabIds]);

  const togglePin = useCallback((sessionId: string) => {
    const { tabs, pinned, previewId } = tabsSnapshotRef.current;
    const next = togglePinSessionTab(tabs, pinned, sessionId);
    setSessionTabIds(next.tabs);
    setPinnedSessionTabIds(next.pinned);
    // Pin 与预览互斥：钉住时升格为常驻视觉
    if (previewId === sessionId) setPreviewSessionTabId(null);
  }, [setSessionTabIds]);

  const reorderTab = useCallback((
    sourceId: string,
    targetId: string,
    position: "before" | "after",
  ) => {
    const { tabs, pinned } = tabsSnapshotRef.current;
    const next = reorderSessionTabs(tabs, pinned, sourceId, targetId, position);
    setSessionTabIds(next.tabs);
    setPinnedSessionTabIds(next.pinned);
  }, [setSessionTabIds]);

  useEffect(() => {
    try {
      localStorage.setItem(SPLIT_GROUP_COLLAPSED_KEY, splitGroupCollapsed ? "1" : "0");
    } catch {
      // 持久化失败不影响功能
    }
  }, [splitGroupCollapsed]);

  useEffect(() => {
    try {
      localStorage.setItem(SPLIT_GROUP_CONFIG_KEY, JSON.stringify(splitGroupConfig));
    } catch {
      // 持久化失败不影响功能
    }
  }, [splitGroupConfig]);

  /**
   * 顶栏 Tab 单击：只切焦点。分屏外会话聚焦时由视图投影决定呈现——
   * 焦点会话不在布局中 → 全屏 solo 显示，分屏布局保留（不再自动替换进分屏）。
   */
  const selectTab = useCallback((sessionId: string) => {
    const record = store.get(sessionRecordByIdAtomFamily(sessionId));
    if (!record) return;
    focusHandlersRef.current.focusSession(record.projectId, sessionId);
  }, [store]);

  const dropSplit = useCallback((draggedSessionId: string, target: SessionSplitDropTarget) => {
    setDraggingSessionId(null);
    const snap = tabsSnapshotRef.current;

    // 分屏拖入 → 常驻（用 snapshot，避免 stale tabs）；侧栏拖入尚未在 Tab 栏的会话也要先登记
    const permanent = openPermanentSessionTab(
      snap.tabs,
      snap.pinned,
      snap.previewId,
      draggedSessionId,
    );
    setSessionTabIds(permanent.tabs);
    setPreviewSessionTabId(permanent.previewId);

    const layout = snap.split;
    // 视图 solo（无布局，或布局存在但焦点会话不在布局中）→ 根层双栏（旧布局随拖拽重组丢弃）
    const inLayout = layout
      ? splitLayoutSessionIds(layout).includes(target.sessionId)
      : false;
    if (!layout || !inLayout) {
      // 单栏：拖到唯一会话面板边缘 → 根层双栏。
      // 宿主 = 被拖命中的面板；拖当前会话自己时退化为 Tab 栏另一会话（否则当前 Tab 无法分屏）
      if (target.kind !== "session-edge") return;
      const hostSessionId = resolveSplitHostSessionId({
        draggedSessionId,
        hitSessionId: target.sessionId,
        tabIds: permanent.tabs,
      });
      if (!hostSessionId) return;
      const next = buildSplitLayoutFromDrop({
        hostSessionId,
        draggedSessionId,
        edge: target.edge,
      });
      if (next) {
        setSplitLayout(next);
      }
      return;
    }

    // 已分屏：中心 → 替换命中会话；边缘按方向分派——
    // 与根层同向 → 根层插入（真三栏）；与根层垂直 → 切分该面板（终端式）
    const next =
      target.kind === "session-center"
        ? replaceSplitPaneFromDrop({
            layout,
            draggedSessionId,
            sessionId: target.sessionId,
          })
        : edgeToOrientation(target.edge) === layout.orientation
          ? insertRootPaneFromDrop({
              layout,
              draggedSessionId,
              sessionId: target.sessionId,
              edge: target.edge,
            })
          : nestSplitPaneFromDrop({
              layout,
              draggedSessionId,
              sessionId: target.sessionId,
              edge: target.edge,
            });
    if (next) {
      setSplitLayout(next);
      // 中心替换了当前聚焦会话：焦点迁到拖入会话，避免「替换聚焦面板后焦点悬空」
      if (
        target.kind === "session-center" &&
        target.sessionId === snap.currentSessionId
      ) {
        const record = store.get(sessionRecordByIdAtomFamily(draggedSessionId));
        if (record) {
          focusHandlersRef.current.focusSession(record.projectId, draggedSessionId);
        }
      }
    }
  }, [setSessionTabIds, store]);

  const beginDrag = useCallback((sessionId: string) => {
    setDraggingSessionId(sessionId);
  }, []);

  const endDrag = useCallback(() => {
    setDraggingSessionId(null);
  }, []);

  /**
   * 面板级退出分屏（全屏按钮）：把指定会话从布局中永久移除，
   * 同组兄弟会话合并占据其位置，其他根层面板不受影响。
   * 焦点保持在退出会话（若当前焦点是它）→ 视图投影自动全屏显示；
   * 点其 Tab 只聚焦（不再自动回归分屏），想重新分屏时拖拽即可。
   */
  const exitSplit = useCallback((sessionId: string) => {
    const layout = tabsSnapshotRef.current.split;
    if (!layout || !splitLayoutSessionIds(layout).includes(sessionId)) return;
    const resolved = resolveSplitAfterClose(layout, sessionId);
    if (!resolved) {
      setSplitLayout(null);
    } else if ("soloSessionId" in resolved) {
      setSplitLayout(null);
    } else {
      setSplitLayout(resolved.layout);
    }
  }, []);

  return {
    // state
    sessionTabIds,
    pinnedSessionTabIds,
    previewSessionTabId,
    splitLayout,
    draggingSessionId,
    splitGroupCollapsed,
    // wiring
    bindFocusHandlers,
    registerOpenSession,
    // commands
    promotePreview,
    closeTab,
    closeOtherTabs,
    closeAllTabs,
    togglePin,
    reorderTab,
    selectTab,
    dropSplit,
    beginDrag,
    endDrag,
    exitSplit,
    /** 取消分屏：全部会话退出分屏布局（会话保留为普通 Tab） */
    exitAllSplit: () => setSplitLayout(null),
    toggleSplitGroupCollapsed: () => setSplitGroupCollapsed((v) => !v),
    setSplitGroupConfig,
    splitGroupConfig,
  };
}

export type SessionWorkspaceChrome = ReturnType<typeof useSessionWorkspaceChrome>;
