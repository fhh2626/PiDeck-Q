import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  BranchDiffResult,
  CommitDetail,
  CommitEntry,
  ExternalEditor,
  GitChangedFile,
  GitResourceGroupType,
  GitResourceGroups,
  GitWorkspaceFileDiff,
} from "../../../shared/types";

export const DRAWER_ANIMATION_MS = 120;
export const EDITOR_TAB_LIMIT = 5;
export const EDITOR_TAB_TEXT_BUDGET = 24 * 1024 * 1024;

export type WorkspaceDrawerPanel = "files" | "sessions" | "editor" | "git";
export type WorkspaceEditorMode = "view" | "diff";

export type WorkspaceEditorTab = {
  id: string;
  filePath: string;
  mode: WorkspaceEditorMode;
  originalContent: string;
  modifiedContent?: string;
  allowSave: boolean;
  tabKey?: string;
  label?: string;
  preserveDrawer?: boolean;
  lastAccess: number;
};

export type WorkspaceGitDiffSnapshot = GitWorkspaceFileDiff & {
  projectId: string;
  label: string;
};

export type GitDiffLifecycleState = {
  request: number;
  snapshot: WorkspaceGitDiffSnapshot | null;
  displayMode: "modal" | "drawer";
};

/** Closing or leaving Git invalidates both the snapshot and every in-flight response. */
export function invalidateGitDiffState(state: GitDiffLifecycleState): GitDiffLifecycleState {
  return {
    request: state.request + 1,
    snapshot: null,
    displayMode: "drawer",
  };
}

export function isCurrentGitDiffResponse(input: {
  request: number;
  currentRequest: number;
  responseProjectId: string;
  activeProjectId: string | null;
}) {
  return input.request === input.currentRequest && input.responseProjectId === input.activeProjectId;
}

/** The adapter deliberately mirrors GitPanel's resource boundary, without exposing renderer state. */
export type WorkspaceGitResourceAdapter = {
  commitLog: (
    projectId: string,
    options?: { maxEntries?: number; ref?: string; allBranches?: boolean },
  ) => Promise<CommitEntry[]>;
  commitDetail: (projectId: string, ref: string) => Promise<CommitDetail | null>;
  branchCompare: (
    projectId: string,
    base: string,
    target: string,
  ) => Promise<BranchDiffResult>;
  getStatus: (projectId: string) => Promise<GitResourceGroups>;
  stageFiles: (projectId: string, paths: string[]) => Promise<void>;
  unstageFiles: (projectId: string, paths: string[]) => Promise<void>;
  discardFile: (
    projectId: string,
    group: "workingTree" | "untracked",
    path: string,
  ) => Promise<void>;
  commit: (projectId: string, message: string) => Promise<void>;
  workspaceFileDiff: (
    projectId: string,
    group: GitResourceGroupType,
    path: string,
  ) => Promise<GitWorkspaceFileDiff | null>;
  commitFileDiff: (
    projectId: string,
    hash: string,
    path: string,
    originalPath?: string,
  ) => Promise<(GitWorkspaceFileDiff & { originalPath?: string }) | null>;
};

export type WorkspaceExternalEditorAdapter = {
  list: () => Promise<ExternalEditor[]>;
  openProject: (editor: ExternalEditor, projectPath: string) => Promise<void>;
};

export type WorkspacePanelOptions = {
  projectId?: string | null;
  git?: WorkspaceGitResourceAdapter;
  editors?: WorkspaceExternalEditorAdapter;
  storage?: Pick<Storage, "getItem" | "setItem">;
  drawerStoragePrefix?: string;
};

function readDrawerState(storage: WorkspacePanelOptions["storage"], key: string) {
  if (!storage) return null;
  try {
    const parsed: unknown = JSON.parse(storage.getItem(key) ?? "null");
    if (!parsed || typeof parsed !== "object") return null;
    const value = parsed as { panel?: unknown; pinned?: unknown };
    const validPanel = value.panel === null || ["files", "sessions", "editor", "git"].includes(String(value.panel));
    return validPanel && typeof value.pinned === "boolean"
      ? { panel: value.panel as WorkspaceDrawerPanel | null, pinned: value.pinned }
      : null;
  } catch {
    return null;
  }
}

function writeDrawerState(
  storage: WorkspacePanelOptions["storage"],
  key: string,
  panel: WorkspaceDrawerPanel | null,
  pinned: boolean,
) {
  try {
    storage?.setItem(key, JSON.stringify({ panel, pinned }));
  } catch {
    // Storage is a convenience; panel commands must continue working when it is unavailable.
  }
}

/** 抽屉宽度默认值与可调范围（AppShell 布局约束同源，禁止两处漂移）。 */
export const DEFAULT_DRAWER_WIDTH = 320;
export const DRAWER_WIDTH_MIN = 180;
export const DRAWER_WIDTH_MIN_PINNED = 220;
export const DRAWER_WIDTH_MAX = 560;
/** 抽屉宽度是全局布局偏好（与项目无关），不按项目拆分存储键。 */
export const DRAWER_WIDTH_STORAGE_KEY = "pid:drawer-width";

/** 读取持久化抽屉宽度：无存储/损坏/越界一律回退默认值，并 clamp 到可调范围。 */
export function readDrawerWidth(storage: WorkspacePanelOptions["storage"]): number {
  if (!storage) return DEFAULT_DRAWER_WIDTH;
  try {
    const raw = storage.getItem(DRAWER_WIDTH_STORAGE_KEY);
    if (raw === null) return DEFAULT_DRAWER_WIDTH;
    const width = Number(raw);
    if (!Number.isFinite(width)) return DEFAULT_DRAWER_WIDTH;
    return Math.min(DRAWER_WIDTH_MAX, Math.max(DRAWER_WIDTH_MIN, Math.round(width)));
  } catch {
    return DEFAULT_DRAWER_WIDTH;
  }
}

/** 写入持久化抽屉宽度；存储不可用时静默跳过，布局功能不受影响。 */
export function writeDrawerWidth(storage: WorkspacePanelOptions["storage"], width: number) {
  try {
    storage?.setItem(DRAWER_WIDTH_STORAGE_KEY, String(width));
  } catch {
    // Storage is a convenience; layout must keep working when it is unavailable.
  }
}

export function useWorkspacePanels(options: WorkspacePanelOptions = {}) {
  const projectId = options.projectId ?? null;
  const projectIdRef = useRef(projectId);
  const gitRef = useRef(options.git);
  const editorsRef = useRef(options.editors);
  const storageRef = useRef(options.storage ?? (typeof window !== "undefined" ? window.localStorage : undefined));
  const drawerPrefixRef = useRef(options.drawerStoragePrefix ?? "pid:project-drawer:");
  projectIdRef.current = projectId;
  gitRef.current = options.git;
  editorsRef.current = options.editors;
  storageRef.current = options.storage ?? (typeof window !== "undefined" ? window.localStorage : undefined);

  const [gitDiff, setGitDiff] = useState<WorkspaceGitDiffSnapshot | null>(null);
  const [gitDiffDisplayMode, setGitDiffDisplayMode] = useState<"modal" | "drawer">("drawer");
  const gitRequestRef = useRef(0);
  const invalidateGitDiff = useCallback(() => {
    const next = invalidateGitDiffState({
      request: gitRequestRef.current,
      snapshot: null,
      displayMode: "drawer",
    });
    gitRequestRef.current = next.request;
    setGitDiff(next.snapshot);
    setGitDiffDisplayMode(next.displayMode);
  }, []);

  const [drawer, setDrawer] = useState<WorkspaceDrawerPanel | null>(null);
  const [drawerCollapsed, setDrawerCollapsed] = useState(false);
  // 抽屉宽度：全局布局偏好（与项目无关），初始值从 localStorage 恢复并 clamp 到可调范围。
  // 写入方：AppShell onLayoutChanged 经 shouldCommitPanelPixels 过滤——拖拽、缩放后的真实像素。
  // 折叠 0 与 expand()→minSize 的瞬时值不写，避免与 resize(保存宽) 互顶闪动。
  const [drawerWidth, setDrawerWidth] = useState(() => readDrawerWidth(storageRef.current));
  useEffect(() => {
    writeDrawerWidth(storageRef.current, drawerWidth);
  }, [drawerWidth]);
  const [drawerPinnedByProject, setDrawerPinnedByProject] = useState<Record<string, WorkspaceDrawerPanel>>({});
  const drawerRef = useRef<WorkspaceDrawerPanel | null>(null);
  const drawerPinnedByProjectRef = useRef<Record<string, WorkspaceDrawerPanel>>({});
  const drawerPinnedPanel = projectId ? drawerPinnedByProject[projectId] : undefined;
  const drawerPinned = Boolean(drawerPinnedPanel && drawer === drawerPinnedPanel);
  const drawerPinnedRef = useRef(false);
  drawerRef.current = drawer;
  drawerPinnedByProjectRef.current = drawerPinnedByProject;
  drawerPinnedRef.current = drawerPinned;

  const loadDrawerState = useCallback((id: string) =>
    readDrawerState(storageRef.current, `${drawerPrefixRef.current}${id}`), []);
  const saveDrawerState = useCallback((id: string, panel: WorkspaceDrawerPanel | null, pinned: boolean) =>
    writeDrawerState(storageRef.current, `${drawerPrefixRef.current}${id}`, panel, pinned), []);

  // 项目上下文水合（null → 首个 projectId）不得视为「切换项目」：
  // 用户在水合完成前已手动打开的抽屉会被保存态重置误关（E2E 与快速操作均可复现）。
  // 仅 A → B 的真实项目切换才重置/恢复抽屉；首次水合只在抽屉仍为空时应用保存态。
  const prevProjectIdRef = useRef<string | null>(null);
  useEffect(() => {
    const prevProjectId = prevProjectIdRef.current;
    prevProjectIdRef.current = projectId;
    const isInitialHydration = prevProjectId === null;
    if (!projectId) {
      // 项目被移除/清空才重置；首次水合前的 null 阶段不动用户已打开的抽屉
      if (!isInitialHydration) {
        setDrawer(null);
        setDrawerCollapsed(false);
      }
      return;
    }
    const saved = loadDrawerState(projectId);
    if (!isInitialHydration || !drawerRef.current) {
      setDrawer(saved?.panel ?? null);
      setDrawerCollapsed(false);
    }
    setDrawerPinnedByProject((current) => {
      const next = { ...current };
      if (saved?.pinned && saved.panel) next[projectId] = saved.panel;
      else delete next[projectId];
      return next;
    });
  }, [loadDrawerState, projectId]);

  const openDrawer = useCallback((panel: WorkspaceDrawerPanel) => {
    const pinnedPanel = projectIdRef.current ? drawerPinnedByProjectRef.current[projectIdRef.current] : undefined;
    if (pinnedPanel && pinnedPanel !== panel) return;
    const next = drawerRef.current === panel && !drawerPinnedRef.current ? null : panel;
    if (next !== "git") invalidateGitDiff();
    if (projectIdRef.current) saveDrawerState(projectIdRef.current, next, Boolean(pinnedPanel && next === pinnedPanel));
    setDrawer(next);
    setDrawerCollapsed(false);
  }, [invalidateGitDiff, saveDrawerState]);

  const closeDrawer = useCallback(() => {
    if (drawerPinnedRef.current) return;
    invalidateGitDiff();
    if (projectIdRef.current) saveDrawerState(projectIdRef.current, null, false);
    setDrawer(null);
  }, [invalidateGitDiff, saveDrawerState]);

  const collapseDrawer = useCallback(() => {
    if (!drawerPinnedRef.current) setDrawerCollapsed(true);
  }, []);

  const expandDrawer = useCallback(() => setDrawerCollapsed(false), []);

  const toggleDrawerPinned = useCallback(() => {
    const id = projectIdRef.current;
    const currentDrawer = drawerRef.current;
    if (!id || !currentDrawer) return;
    const willPin = !drawerPinnedRef.current;
    setDrawerPinnedByProject((current) => {
      const next = { ...current };
      if (willPin) next[id] = currentDrawer;
      else delete next[id];
      return next;
    });
    saveDrawerState(id, currentDrawer, willPin);
  }, [saveDrawerState]);

  const closeGitDiff = useCallback(() => {
    invalidateGitDiff();
  }, [invalidateGitDiff]);

  const openWorkspaceFileDiff = useCallback(async (group: GitResourceGroupType, path: string) => {
    const id = projectIdRef.current;
    const request = ++gitRequestRef.current;
    const diff = id ? await gitRef.current?.workspaceFileDiff(id, group, path) : null;
    if (!id || !isCurrentGitDiffResponse({
      request,
      currentRequest: gitRequestRef.current,
      responseProjectId: id,
      activeProjectId: projectIdRef.current,
    })) return null;
    if (!diff) return null;
    setDrawer("git");
    setDrawerCollapsed(false);
    setGitDiffDisplayMode("drawer");
    setGitDiff({ ...diff, projectId: id, label: diff.path.split(/[\\/]/).pop() ?? diff.path });
    return diff;
  }, []);

  const openCommitFileDiff = useCallback(async (commit: CommitEntry, file: GitChangedFile) => {
    const id = projectIdRef.current;
    const request = ++gitRequestRef.current;
    const diff = id ? await gitRef.current?.commitFileDiff(id, commit.hash, file.path, file.originalPath) : null;
    if (!id || !isCurrentGitDiffResponse({
      request,
      currentRequest: gitRequestRef.current,
      responseProjectId: id,
      activeProjectId: projectIdRef.current,
    })) return null;
    if (!diff) return null;
    setDrawer("git");
    setDrawerCollapsed(false);
    setGitDiffDisplayMode("drawer");
    setGitDiff({ ...diff, projectId: id, label: `${diff.path.split(/[\\/]/).pop() ?? diff.path} (${commit.shortHash})` });
    return diff;
  }, []);

  const toggleGitDiffDisplayMode = useCallback(() => {
    setGitDiffDisplayMode((mode) => {
      if (mode === "drawer") return "modal";
      setDrawer("git");
      setDrawerCollapsed(false);
      return "drawer";
    });
  }, []);

  const gitPanelAdapter = useMemo<WorkspaceGitResourceAdapter>(() => ({
    commitLog: (...args) => gitRef.current?.commitLog(...args) ?? Promise.reject(new Error("Git service is unavailable")),
    commitDetail: (...args) => gitRef.current?.commitDetail(...args) ?? Promise.reject(new Error("Git service is unavailable")),
    branchCompare: (...args) => gitRef.current?.branchCompare(...args) ?? Promise.reject(new Error("Git service is unavailable")),
    getStatus: (...args) => gitRef.current?.getStatus(...args) ?? Promise.reject(new Error("Git service is unavailable")),
    stageFiles: (...args) => gitRef.current?.stageFiles(...args) ?? Promise.reject(new Error("Git service is unavailable")),
    unstageFiles: (...args) => gitRef.current?.unstageFiles(...args) ?? Promise.reject(new Error("Git service is unavailable")),
    discardFile: (...args) => gitRef.current?.discardFile(...args) ?? Promise.reject(new Error("Git service is unavailable")),
    commit: (...args) => gitRef.current?.commit(...args) ?? Promise.reject(new Error("Git service is unavailable")),
    workspaceFileDiff: (...args) => gitRef.current?.workspaceFileDiff(...args) ?? Promise.reject(new Error("Git service is unavailable")),
    commitFileDiff: (...args) => gitRef.current?.commitFileDiff(...args) ?? Promise.reject(new Error("Git service is unavailable")),
  }), []);

  const [externalEditors, setExternalEditors] = useState<ExternalEditor[]>([]);
  const [externalEditorsOpen, setExternalEditorsOpen] = useState(false);
  const [externalEditorsAnchor, setExternalEditorsAnchor] = useState<{ x: number; y: number } | null>(null);
  const [externalEditorsTargetPath, setExternalEditorsTargetPath] = useState<string | null>(null);
  const editorRequestRef = useRef(0);
  const loadExternalEditors = useCallback(async (forProjectId = projectIdRef.current) => {
    const request = ++editorRequestRef.current;
    const list = await editorsRef.current?.list();
    if (request !== editorRequestRef.current || projectIdRef.current !== forProjectId) return [];
    const next = list ?? [];
    setExternalEditors(next);
    return next;
  }, []);
  const openExternalEditorChooser = useCallback((projectPath: string, anchor?: { x: number; y: number }) => {
    setExternalEditorsTargetPath(projectPath);
    setExternalEditorsAnchor(anchor ?? null);
    setExternalEditorsOpen(true);
    void loadExternalEditors();
  }, [loadExternalEditors]);
  const closeExternalEditorChooser = useCallback(() => {
    editorRequestRef.current += 1;
    setExternalEditorsOpen(false);
    setExternalEditorsAnchor(null);
    setExternalEditorsTargetPath(null);
  }, []);
  const externalEditorsTargetPathRef = useRef<string | null>(null);
  externalEditorsTargetPathRef.current = externalEditorsTargetPath;
  const openProjectInExternalEditor = useCallback(async (editor: ExternalEditor) => {
    const id = projectIdRef.current;
    const path = externalEditorsTargetPathRef.current;
    const request = ++editorRequestRef.current;
    if (!path || !editorsRef.current) return;
    setExternalEditorsOpen(false);
    await editorsRef.current.openProject(editor, path);
    if (request !== editorRequestRef.current || projectIdRef.current !== id) return;
    setExternalEditorsAnchor(null);
    setExternalEditorsTargetPath(null);
  }, []);

  useEffect(() => {
    invalidateGitDiff();
    editorRequestRef.current += 1;
    setExternalEditorsOpen(false);
    setExternalEditorsAnchor(null);
    setExternalEditorsTargetPath(null);
  }, [invalidateGitDiff, projectId]);

  return {
    drawer,
    drawerCollapsed,
    drawerWidth,
    setDrawerWidth,
    drawerPinned,
    drawerPinnedPanel,
    openDrawer,
    closeDrawer,
    collapseDrawer,
    expandDrawer,
    toggleDrawerPinned,
    gitDiff,
    gitDiffDisplayMode,
    closeGitDiff,
    openWorkspaceFileDiff,
    openCommitFileDiff,
    toggleGitDiffDisplayMode,
    gitPanelAdapter,
    externalEditors,
    externalEditorsOpen,
    externalEditorsAnchor,
    externalEditorsTargetPath,
    loadExternalEditors,
    openExternalEditorChooser,
    closeExternalEditorChooser,
    openProjectInExternalEditor,
  };
}
