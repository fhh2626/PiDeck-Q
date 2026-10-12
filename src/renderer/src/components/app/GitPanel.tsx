import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import { useSetAtom } from "jotai";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Check,
  ChevronDown,
  ChevronsDownUp,
  ChevronsUpDown,
  ClipboardPaste,
  GitBranch,
  Loader2,
  Plus,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import { Button } from "../ui-shadcn/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "../ui-shadcn/context-menu";
import { ConfirmDialog } from "./AppParts";
import { dismissNotice, showNotice, type NoticeId } from "../../utils/notice";
import { htmlToPlainText, readClipboardHtmlConsistent, readClipboardText } from "../../utils/clipboard";
import type {
  BranchDiffResult,
  CommitDetail,
  CommitEntry,
  GitAheadBehind,
  GitChangedFile,
  GitResource,
  GitResourceGroupType,
  GitResourceGroups,
} from "../../../../shared/types";
import { GitStatus } from "../../../../shared/types";
import { settingsOpenAtom } from "../../atoms";
import { t } from "../../i18n";
import {
  fileNameOnly,
  FileTree,
  getCollapsibleChangeDirs,
  ResourceGroup,
  ResourceRow,
} from "./git/GitResourceTree";
import { GitCompactFilter, PaneHeader } from "./git/GitPanelControls";
import { SourceControlGraph } from "./git/GitGraph";
import { getViewportBoundMenuPlacement } from "./git/floatingMenuPosition";
import { Input } from "../ui-shadcn/input";
import { Textarea } from "../ui-shadcn/textarea";
import { Label } from "../../components/ui-shadcn/label";

type GitPanelProps = {
  projectId: string;
  /** 项目根目录路径，用于将绝对路径转为相对路径显示 */
  projectRoot?: string;
  commitLog: (
    projectId: string,
    options?: { maxEntries?: number; ref?: string; allBranches?: boolean },
  ) => Promise<CommitEntry[]>;
  commitDetail: (
    projectId: string,
    ref: string,
  ) => Promise<CommitDetail | null>;
  onOpenCommitFileDiff: (
    commit: CommitEntry,
    file: GitChangedFile,
  ) => void | Promise<void>;
  onOpenWorkspaceFileDiff: (
    group: GitResourceGroupType,
    path: string,
  ) => void | Promise<void>;
  /** 行内“打开文件”按钮：在编辑器面板打开该文件 */
  onOpenFile?: (path: string) => void;
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
  branches: string[];
  currentBranch: string | null;
  /** 切换分支 */
  onSwitchBranch?: (branch: string) => void;
  /** 创建新分支 */
  onCreateBranch?: (branchName: string) => void;
  cherryPick?: (projectId: string, hash: string) => Promise<void>;
  revert?: (projectId: string, hash: string) => Promise<void>;
  reset?: (
    projectId: string,
    hash: string,
    mode: "soft" | "mixed" | "hard",
  ) => Promise<void>;
  dropCommit?: (projectId: string, hash: string) => Promise<void>;
  /** AI 生成提交摘要 */
  generateCommitMessage?: (
    projectId: string,
    stagedPaths?: string[],
  ) => Promise<import("../../../../shared/types").GitGenerateCommitMessageResult>;
  /** 初始化 Git 仓库 */
  gitInit?: (projectId: string) => Promise<void>;
  /** Push：将当前分支推送到远程 */
  push?: (projectId: string) => Promise<void>;
  /** Pull：从远程拉取并合并到当前分支 */
  pull?: (projectId: string) => Promise<void>;
  /** Fetch：刷新远程跟踪引用，供定时轮询 ahead/behind 角标 */
  fetch?: (projectId: string) => Promise<void>;
  /** 当前分支相对上游的提交差距；无上游返回 null（不显示角标） */
  aheadBehind?: (projectId: string) => Promise<GitAheadBehind | null>;
  /** 从磁盘删除变更文件（移入回收站） */
  deleteFiles?: (projectId: string, paths: string[]) => Promise<void>;
};

type PaneId = "changes" | "graph" | "compare";
type PaneHeights = Record<PaneId, number>;
type PaneOpenState = Record<PaneId, boolean>;
type PaneState = { heights: PaneHeights; open: PaneOpenState };
type SmartCommitPreference = {
  enableSmartCommit: boolean;
  suggestSmartCommit: boolean;
};

const EMPTY_GROUPS: GitResourceGroups = {
  merge: [],
  index: [],
  workingTree: [],
  untracked: [],
};
const PANE_IDS: PaneId[] = ["changes", "graph", "compare"];
const PANE_MIN_BODY_HEIGHT = 24;
// 头部实际高度 h-8 = 32px（Tailwind rem 基准 16px）。早期按 26px 预算：
// 折叠时溢出 6px 被 overflow-hidden 裁掉，折叠按钮视觉偏下且底部被切。
const PANE_HEADER_HEIGHT = 32;
/* 分支栏大约高度，用于 fitPaneHeights 中从可用空间预减，避免未计入分支栏高度导致 pane body 溢出 */
const BRANCH_BAR_HEIGHT = 36;
const PANE_RESIZE_STEP = 20;
const PANE_RESIZE_LARGE_STEP = 60;

function visiblePaneIds(open: PaneOpenState): PaneId[] {
  return PANE_IDS.filter((id) => open[id]);
}

function resizePair(
  state: PaneState,
  beforeId: PaneId,
  afterId: PaneId,
  beforeHeight: number,
  afterHeight: number,
): PaneState {
  return {
    ...state,
    heights: {
      ...state.heights,
      [beforeId]: Math.max(PANE_MIN_BODY_HEIGHT, Math.round(beforeHeight)),
      [afterId]: Math.max(PANE_MIN_BODY_HEIGHT, Math.round(afterHeight)),
    },
  };
}

/**
 * Allocate every visible body against the real drawer budget. Collapsed panes still
 * consume their header row; the last visible pane receives spare room, matching the
 * way VS Code keeps its view container filled without destroying persisted sizes.
 */
function fitPaneHeights(
  state: PaneState,
  availableHeight: number,
): PaneHeights {
  const visible = visiblePaneIds(state.open);
  const heights = { ...state.heights };
  if (!visible.length) return heights;

  const bodyBudget = Math.max(
    PANE_MIN_BODY_HEIGHT * visible.length,
    availableHeight - PANE_IDS.length * PANE_HEADER_HEIGHT - BRANCH_BAR_HEIGHT,
  );
  const requestedTotal = visible.reduce((sum, id) => sum + heights[id], 0);
  if (requestedTotal < bodyBudget) {
    // 仅当只有一个 pane 可见时才把剩余空间灌入该 pane（保持 VS Code SCM 视图行为）；
    // 多个 pane 同时可见时保持各自请求高度，多余空间由抽屉底部自然留白，
    // 避免第一个 pane 过度膨胀把后续 pane 挤出可视区。
    if (visible.length === 1) {
      heights[visible[0]] += bodyBudget - requestedTotal;
    }
    return heights;
  }
  if (requestedTotal === bodyBudget) return heights;

  const minimumTotal = PANE_MIN_BODY_HEIGHT * visible.length;
  const distributable = Math.max(0, bodyBudget - minimumTotal);
  const requestedAboveMinimum = visible.reduce(
    (sum, id) => sum + Math.max(0, heights[id] - PANE_MIN_BODY_HEIGHT),
    0,
  );
  for (const id of visible) {
    const requested = Math.max(0, heights[id] - PANE_MIN_BODY_HEIGHT);
    heights[id] =
      PANE_MIN_BODY_HEIGHT +
      (requestedAboveMinimum > 0
        ? Math.round((distributable * requested) / requestedAboveMinimum)
        : 0);
  }
  return heights;
}

function adjacentVisiblePane(
  open: PaneOpenState,
  pane: PaneId,
  direction: -1 | 1,
): PaneId | null {
  const start = PANE_IDS.indexOf(pane);
  for (
    let index = start + direction;
    index >= 0 && index < PANE_IDS.length;
    index += direction
  ) {
    const candidate = PANE_IDS[index];
    if (open[candidate]) return candidate;
  }
  return null;
}

function paneStateStorageKey(projectId: string): string {
  return `pideck:git-panel:${projectId}:pane-state:v3`;
}

function smartCommitStorageKey(projectId: string): string {
  return `pideck:git-panel:${projectId}:smart-commit:v1`;
}

function readSmartCommitPreference(projectId: string): SmartCommitPreference {
  try {
    const value = JSON.parse(
      localStorage.getItem(smartCommitStorageKey(projectId)) ?? "null",
    ) as Partial<SmartCommitPreference> | null;
    return {
      enableSmartCommit: value?.enableSmartCommit === true,
      // VS Code defaults suggestSmartCommit to true until the user chooses Never.
      suggestSmartCommit: value?.suggestSmartCommit !== false,
    };
  } catch {
    return { enableSmartCommit: false, suggestSmartCommit: true };
  }
}

function writeSmartCommitPreference(
  projectId: string,
  value: SmartCommitPreference,
): void {
  try {
    localStorage.setItem(
      smartCommitStorageKey(projectId),
      JSON.stringify(value),
    );
  } catch {
    // The choice remains valid for this renderer session when storage is unavailable.
  }
}

function defaultPaneState(): PaneState {
  return {
    heights: { changes: 100, graph: 200, compare: 160 },
    open: { changes: true, graph: false, compare: false },
  };
}

function readPaneState(projectId: string): PaneState {
  const fallback = defaultPaneState();
  try {
    const raw = localStorage.getItem(paneStateStorageKey(projectId));
    if (!raw) return fallback;
    const value = JSON.parse(raw) as Partial<PaneState>;
    const heights = PANE_IDS.reduce((result, id) => {
      const height = value.heights?.[id];
      result[id] =
        typeof height === "number" && Number.isFinite(height)
          ? Math.max(PANE_MIN_BODY_HEIGHT, Math.round(height))
          : fallback.heights[id];
      return result;
    }, {} as PaneHeights);
    const open = PANE_IDS.reduce((result, id) => {
      result[id] =
        typeof value.open?.[id] === "boolean"
          ? value.open[id]
          : fallback.open[id];
      return result;
    }, {} as PaneOpenState);
    return { heights, open };
  } catch {
    return fallback;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function PaneSash(props: {
  before: PaneId;
  after: PaneId;
  beforeHeight: number;
  afterHeight: number;
  onResize: (beforeHeight: number, afterHeight: number) => void;
}) {
  const frameRef = useRef<number | undefined>(undefined);
  const pendingHeightsRef = useRef<{ before: number; after: number } | null>(
    null,
  );

  const flushPendingHeights = () => {
    if (frameRef.current !== undefined) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = undefined;
    }
    const pending = pendingHeightsRef.current;
    pendingHeightsRef.current = null;
    if (pending) props.onResize(pending.before, pending.after);
  };

  const scheduleHeights = (before: number, after: number) => {
    pendingHeightsRef.current = { before, after };
    if (frameRef.current !== undefined) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = undefined;
      const pending = pendingHeightsRef.current;
      pendingHeightsRef.current = null;
      if (pending) props.onResize(pending.before, pending.after);
    });
  };

  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startY = event.clientY;
    const startBeforeHeight = props.beforeHeight;
    const startAfterHeight = props.afterHeight;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const onMove = (moveEvent: PointerEvent) => {
      const requestedBefore = startBeforeHeight + moveEvent.clientY - startY;
      const before = Math.max(
        PANE_MIN_BODY_HEIGHT,
        Math.min(
          requestedBefore,
          startBeforeHeight + startAfterHeight - PANE_MIN_BODY_HEIGHT,
        ),
      );
      const after = startBeforeHeight + startAfterHeight - before;
      scheduleHeights(before, after);
    };
    const onEnd = () => {
      flushPendingHeights();
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onEnd);
      window.removeEventListener("pointercancel", onEnd);
      document.body.classList.remove("is-git-pane-resizing");
    };
    document.body.classList.add("is-git-pane-resizing");
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onEnd);
    window.addEventListener("pointercancel", onEnd);
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? PANE_RESIZE_LARGE_STEP : PANE_RESIZE_STEP;
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    const direction = event.key === "ArrowUp" ? -1 : 1;
    const requestedBefore = props.beforeHeight + direction * step;
    const before = Math.max(
      PANE_MIN_BODY_HEIGHT,
      Math.min(
        requestedBefore,
        props.beforeHeight + props.afterHeight - PANE_MIN_BODY_HEIGHT,
      ),
    );
    const after = props.beforeHeight + props.afterHeight - before;
    props.onResize(before, after);
  };

  return (
    <div
      className="git-pane-sash relative z-[1] box-border h-1.5 shrink-0 basis-1.5 -my-[3px] cursor-row-resize touch-none before:absolute before:top-0.5 before:right-0 before:left-0 before:h-px before:bg-[var(--git-panel-border)] before:transition-[background-color,height] before:duration-150 hover:before:h-0.5 hover:before:bg-[var(--color-accent)] focus-visible:before:h-0.5 focus-visible:before:bg-[var(--color-accent)]"
      role="separator"
      tabIndex={0}
      aria-orientation="horizontal"
      aria-label={t("git.resizePanes")}
      aria-valuemin={PANE_MIN_BODY_HEIGHT}
      aria-valuemax={Math.max(
        PANE_MIN_BODY_HEIGHT,
        props.beforeHeight + props.afterHeight - PANE_MIN_BODY_HEIGHT,
      )}
      aria-valuenow={props.beforeHeight}
      data-before={props.before}
      data-after={props.after}
      onPointerDown={startResize}
      onKeyDown={onKeyDown}
    />
  );
}

export function GitPanel(props: GitPanelProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  // “未配置模型”提示的“去设置”按钮：直接打开设置弹窗（Git 段在常用设置 tab）
  const setSettingsOpen = useSetAtom(settingsOpenAtom);
  const projectIdRef = useRef(props.projectId);
  projectIdRef.current = props.projectId;
  const statusRequestRef = useRef(0);
  const statusRunningRequestRef = useRef<{
    projectId: string;
    request: number;
  } | null>(null);
  const mutationRequestRef = useRef(0);
  const mutationRunningRef = useRef(false);
  const [availableHeight, setAvailableHeight] = useState(720);
  const [groups, setGroups] = useState<GitResourceGroups>(EMPTY_GROUPS);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [commitMessage, setCommitMessage] = useState("");
  const commitInputRef = useRef<HTMLTextAreaElement | null>(null);
  /** 右键“粘贴”在光标处插入文本：受控组件用 setRangeText 不触发 onChange，
   *  手动拼 next 值 + 恢复光标位置（rAF 等重渲染后再定位） */
  const pasteIntoCommitInput = (text: string) => {
    if (!text) return;
    const el = commitInputRef.current;
    const start = el?.selectionStart ?? commitMessage.length;
    const end = el?.selectionEnd ?? commitMessage.length;
    const next = commitMessage.slice(0, start) + text + commitMessage.slice(end);
    setCommitMessage(next);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + text.length, start + text.length);
    });
  };
  /** 原样粘贴：剪贴板有 HTML 时保留段落/换行结构转纯文本，否则直接读纯文本 */
  /** 粘贴：剪贴板有 HTML 时保留段落/换行结构转纯文本（textarea 只能纯文本），否则直接读纯文本 */
  const pasteCommitClipboard = () => {
    // 只接受与当前纯文本同源的 HTML（剪贴板残留问题见 readClipboardHtmlConsistent）
    const html = readClipboardHtmlConsistent();
    pasteIntoCommitInput(html ? htmlToPlainText(html) : readClipboardText());
  };
  const [committing, setCommitting] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [pulling, setPulling] = useState(false);
  const [mutating, setMutating] = useState(false);
  const [notAGitRepo, setNotAGitRepo] = useState(false);
  const [gitNotInstalled, setGitNotInstalled] = useState(false);
  const [initializing, setInitializing] = useState(false);
  const [smartCommitPreference, setSmartCommitPreference] =
    useState<SmartCommitPreference>(() =>
      readSmartCommitPreference(props.projectId),
    );
  const [showSmartCommitPrompt, setShowSmartCommitPrompt] = useState(false);
  const [discardTarget, setDiscardTarget] = useState<{
    group: "workingTree" | "untracked";
    path: string;
  } | null>(null);
  /** 右键“删除文件”确认目标 */
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  /** 当前分支相对上游的提交差距：ahead 显示在 push、behind 显示在 pull */
  const [aheadBehind, setAheadBehind] = useState<GitAheadBehind | null>(null);
  /** 提交摘要生成互斥：ref 同步防抖，连点不发出第二个请求（主进程另有 genBusy 兜底） */
  const commitGenRequestRef = useRef(false);
  /** 进行中的“正在生成提交信息”进度 toast id，结束时收起 */
  const commitGenProgressRef = useRef<NoticeId | undefined>(undefined);
  const [resourceOpen, setResourceOpen] = useState({
    merge: true,
    staged: true,
    changes: true,
  });
  /** 变更文件树的目录折叠态（merge/staged/working 共享，供「收起/展开全部」） */
  const [collapsedChangeDirs, setCollapsedChangeDirs] = useState<Set<string>>(() => new Set());
  const [paneState, setPaneState] = useState<PaneState>(() =>
    readPaneState(props.projectId),
  );

  useEffect(() => {
    const element = panelRef.current;
    if (!element) return;
    const updateHeight = () =>
      setAvailableHeight(
        Math.max(PANE_MIN_BODY_HEIGHT, Math.round(element.clientHeight)),
      );
    updateHeight();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", updateHeight);
      return () => window.removeEventListener("resize", updateHeight);
    }
    const observer = new ResizeObserver(updateHeight);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    // 项目切换会复用同一个 GitPanel 实例；递增序号让旧项目进行中的 status/mutation 结果失效。
    statusRequestRef.current += 1;
    mutationRequestRef.current += 1;
    const next = readPaneState(props.projectId);
    setPaneState({ ...next, heights: fitPaneHeights(next, availableHeight) });
    setGroups(EMPTY_GROUPS);
    setError(null);
    setCommitMessage("");
    setCommitting(false);
    mutationRunningRef.current = false;
    setMutating(false);
    setResourceOpen({ merge: true, staged: true, changes: true });
    setCollapsedChangeDirs(new Set());
    setSmartCommitPreference(readSmartCommitPreference(props.projectId));
    setShowSmartCommitPrompt(false);
    setDiscardTarget(null);
    setDeleteTarget(null);
    setAheadBehind(null);
    // 项目切换：复位摘要生成状态；进行中的旧请求结果带 projectId 校验，不会写入新项目
    setCommitGenLoading(false);
    commitGenRequestRef.current = false;
    dismissNotice(commitGenProgressRef.current);
    commitGenProgressRef.current = undefined;
    setNotAGitRepo(false);
  }, [props.projectId]);

  useEffect(() => {
    setPaneState((current) => ({
      ...current,
      heights: fitPaneHeights(current, availableHeight),
    }));
  }, [availableHeight]);

  useEffect(() => {
    try {
      localStorage.setItem(
        paneStateStorageKey(props.projectId),
        JSON.stringify(paneState),
      );
    } catch {
      // Storage can be blocked in preview/web mode; pane interaction must still work for this session.
    }
  }, [paneState, props.projectId]);

  /**
   * 拉取最新 Git 工作区状态。
   *
   * @param silent - 静默模式：不显示 loading 动画、不清除已有错误和分组数据；
   *                 用于后台轮询，避免闪烁和打断用户正在查看的 Diff 内容。
   */
  const refresh = useCallback(
    async (silent = false) => {
      // 静默轮询不打断 mutation，也不与前一个 status 请求重叠；否则慢于 5 秒的请求会彼此作废，列表永久不更新。
      if (
        silent &&
        (mutationRunningRef.current ||
          statusRunningRequestRef.current?.projectId === props.projectId)
      )
        return;
      const request = ++statusRequestRef.current;
      const projectId = props.projectId;
      const runningRequest = { projectId, request };
      statusRunningRequestRef.current = runningRequest;
      if (!silent) {
        setLoading(true);
        setError(null);
      }
      try {
        const next = await props.getStatus(projectId);
        if (
          request === statusRequestRef.current &&
          projectId === projectIdRef.current
        ) {
          setGroups(next);
          // 刷新成功说明当前目录可用，恢复仓库/工具标记（手动 git init 或安装 git 后自动恢复轮询）
          setNotAGitRepo(false);
          setGitNotInstalled(false);
        }
      } catch (caught) {
        if (
          request === statusRequestRef.current &&
          projectId === projectIdRef.current
        ) {
          const msg = errorMessage(caught);
          // 检测"不是 Git 仓库"的错误，展示初始化提示（无论是否静默都要置位，
          // 否则面板打开期间仓库状态变化时轮询永远停不下来）
          if (/not a git repository|fatal:/.test(msg)) {
            setNotAGitRepo(true);
          } else if (/command not found|ENOENT|spawn.*git.*ENOENT/i.test(msg)) {
            setGitNotInstalled(true);
          }
          if (!silent) {
            setGroups(EMPTY_GROUPS);
            if (/not a git repository|fatal:/.test(msg)) {
              setError("");
            } else if (/command not found|ENOENT|spawn.*git.*ENOENT/i.test(msg)) {
              setError("");
            } else {
              setError(msg);
            }
          }
          // 静默失败不影响已展示的旧分组数据；不做错误信息变更。
        }
      } finally {
        if (statusRunningRequestRef.current === runningRequest)
          statusRunningRequestRef.current = null;
        if (
          request === statusRequestRef.current &&
          projectId === projectIdRef.current &&
          !silent
        )
          setLoading(false);
      }
    },
    [props.getStatus, props.projectId],
  );

  // 打开 Git drawer 时首次加载；依赖 refresh 引用稳定。
  useEffect(() => {
    void refresh();
  }, [refresh]);

  // 静默轮询：每 5 秒拉取一次最新工作区状态，不显示 loading 动画、不覆盖错误。
  // 非 git 仓库 / 未安装 git 时暂停轮询——状态恢复（git init / 安装 git）后由
  // refresh 成功路径清标记，interval 随依赖重建自动恢复。
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (notAGitRepo || gitNotInstalled) return;
      void refresh(true);
    }, 5000);
    return () => window.clearInterval(timer);
  }, [refresh, notAGitRepo, gitNotInstalled]);

  /**
   * 刷新 push/pull 角标：先 fetch 远程跟踪引用，再对比本地差距。
   * 静默失败（无远程/离线/非仓库）时保持上次角标，不打扰用户。
   */
  const refreshAheadBehind = useCallback(async () => {
    if (!props.fetch || !props.aheadBehind) return;
    const projectId = props.projectId;
    try {
      await props.fetch(projectId);
      if (projectId !== projectIdRef.current) return;
      const result = await props.aheadBehind(projectId);
      if (projectId === projectIdRef.current) setAheadBehind(result);
    } catch {
      // 静默失败：离线/无远程时角标保持上次已知值，不弹错误
    }
  }, [props.fetch, props.aheadBehind, props.projectId]);

  // 定时 fetch 远程：每 5 分钟刷新一次 ahead/behind 角标；首次挂载也立即刷一次。
  // 非 git 仓库 / 未安装 git 时暂停（fetch 同样会 spawn git 报错）。
  useEffect(() => {
    if (!props.fetch || !props.aheadBehind) return;
    void refreshAheadBehind();
    const timer = window.setInterval(() => {
      if (notAGitRepo || gitNotInstalled) return;
      void refreshAheadBehind();
    }, 5 * 60_000);
    return () => window.clearInterval(timer);
  }, [refreshAheadBehind, props.fetch, props.aheadBehind, notAGitRepo, gitNotInstalled]);

  const toggleResource = (key: keyof typeof resourceOpen) => {
    setResourceOpen((current) => ({ ...current, [key]: !current[key] }));
  };
  const togglePane = (id: PaneId) => {
    setPaneState((current) => {
      const open = { ...current.open, [id]: !current.open[id] };
      const next = { ...current, open };
      return { ...next, heights: fitPaneHeights(next, availableHeight) };
    });
  };
  const resizePanes = (
    before: PaneId,
    after: PaneId,
    beforeHeight: number,
    afterHeight: number,
  ) => {
    setPaneState((current) =>
      resizePair(current, before, after, beforeHeight, afterHeight),
    );
  };

  const workingChanges = useMemo(() => {
    // VS Code 语义：Changes 组始终显示全部变更（含已暂存），Staged 组单独列已暂存；
    // 同一文件同时在 index 与 workingTree（暂存后又改）时只列一次，避免重复行
    const seen = new Set<string>();
    const result: GitResource[] = [];
    for (const r of [...groups.workingTree, ...groups.untracked, ...groups.index]) {
      if (seen.has(r.path)) continue;
      seen.add(r.path);
      result.push(r);
    }
    return result;
  }, [groups.workingTree, groups.untracked, groups.index]);
  /** 已暂存路径集合：Changes 组中这些文件不再显示 stage/rollback 行内按钮 */
  const stagedPathSet = useMemo(
    () => new Set(groups.index.map((r) => r.path)),
    [groups.index],
  );
  const stagedCount = groups.index.length;
  const hasUnresolvedConflicts = groups.merge.length > 0;
  // VS Code enables the action for either staged changes or working-tree changes
  // when smart commit is enabled/suggested; the command decides whether to prompt.
  const hasChangesToCommit =
    stagedCount > 0 ||
    (workingChanges.length > 0 &&
      (smartCommitPreference.enableSmartCommit ||
        smartCommitPreference.suggestSmartCommit));
  const canCommit =
    Boolean(commitMessage.trim()) &&
    hasChangesToCommit &&
    !hasUnresolvedConflicts &&
    !committing &&
    !mutating;
  const total = groups.merge.length + stagedCount + workingChanges.length;

  // 合并 merge/staged/working 的可折叠目录，驱动顶部「收起/展开全部」按钮状态
  const collapsibleChangeDirs = useMemo(() => {
    const dirs = new Set<string>();
    for (const list of [groups.merge, groups.index, workingChanges]) {
      for (const dir of getCollapsibleChangeDirs(list, props.projectRoot)) {
        dirs.add(dir);
      }
    }
    return dirs;
  }, [groups.merge, groups.index, workingChanges, props.projectRoot]);

  const canCollapseChangeDirs = collapsibleChangeDirs.size > 0;
  const allChangeDirsCollapsed =
    canCollapseChangeDirs &&
    [...collapsibleChangeDirs].every((dir) => collapsedChangeDirs.has(dir));
  const allChangeDirsExpanded =
    !canCollapseChangeDirs ||
    [...collapsibleChangeDirs].every((dir) => !collapsedChangeDirs.has(dir));

  const toggleChangeDir = useCallback((dir: string) => {
    setCollapsedChangeDirs((prev) => {
      const next = new Set(prev);
      if (next.has(dir)) next.delete(dir);
      else next.add(dir);
      return next;
    });
  }, []);

  const collapseAllChangeDirs = useCallback(() => {
    setCollapsedChangeDirs(new Set(collapsibleChangeDirs));
  }, [collapsibleChangeDirs]);

  const expandAllChangeDirs = useCallback(() => {
    setCollapsedChangeDirs(new Set());
  }, []);

  const act = async (operation: () => Promise<void>) => {
    if (mutationRunningRef.current || committing) return;
    const mutationRequest = ++mutationRequestRef.current;
    mutationRunningRef.current = true;
    setMutating(true);
    const projectId = props.projectId;
    try {
      await operation();
      if (projectId === projectIdRef.current) await refresh();
    } catch (caught) {
      // Do not let refresh clear the mutation error before the user can read it.
      if (projectId === projectIdRef.current) setError(errorMessage(caught));
    } finally {
      if (mutationRequest === mutationRequestRef.current) {
        mutationRunningRef.current = false;
        if (projectId === projectIdRef.current) setMutating(false);
      }
    }
  };

  const runCommit = async (stageAll: boolean) => {
    const message = commitMessage.trim();
    if (
      !message ||
      committing ||
      mutating ||
      hasUnresolvedConflicts ||
      mutationRunningRef.current
    )
      return;
    const projectId = props.projectId;
    const mutationRequest = ++mutationRequestRef.current;
    mutationRunningRef.current = true;
    setCommitting(true);
    setError(null);
    try {
      if (stageAll) {
        const paths = workingChanges.map((resource) => resource.path);
        if (paths.length > 0) await props.stageFiles(projectId, paths);
      }
      await props.commit(projectId, message);
      if (projectId !== projectIdRef.current) return;
      setCommitMessage("");
      await refresh();
    } catch (caught) {
      if (projectId === projectIdRef.current) setError(errorMessage(caught));
    } finally {
      if (mutationRequest === mutationRequestRef.current) {
        mutationRunningRef.current = false;
        if (projectId === projectIdRef.current) setCommitting(false);
      }
    }
  };

  const doCommit = async () => {
    if (!canCommit) return;
    if (stagedCount > 0) {
      await runCommit(false);
      return;
    }
    if (smartCommitPreference.enableSmartCommit) {
      await runCommit(true);
      return;
    }
    if (smartCommitPreference.suggestSmartCommit && workingChanges.length > 0) {
      setShowSmartCommitPrompt(true);
    }
  };

  const chooseSmartCommit = (choice: "yes" | "always" | "never") => {
    setShowSmartCommitPrompt(false);
    if (choice === "never") {
      const next = { ...smartCommitPreference, suggestSmartCommit: false };
      setSmartCommitPreference(next);
      writeSmartCommitPreference(props.projectId, next);
      return;
    }
    if (choice === "always") {
      const next = { enableSmartCommit: true, suggestSmartCommit: true };
      setSmartCommitPreference(next);
      writeSmartCommitPreference(props.projectId, next);
    }
    void runCommit(true);
  };

  const confirmDiscard = () => {
    const target = discardTarget;
    if (!target) return;
    setDiscardTarget(null);
    void act(() =>
      props.discardFile(props.projectId, target.group, target.path),
    );
  };

  /** 右键菜单“删除文件”确认：移入回收站，可恢复 */
  const confirmDelete = () => {
    const path = deleteTarget;
    // 先取局部引用再收窄：TS 不保留对 props 属性在闭包内的收窄
    const deleteFiles = props.deleteFiles;
    if (!path || !deleteFiles) return;
    setDeleteTarget(null);
    void act(() => deleteFiles(props.projectId, [path]));
  };

  /**
   * 生成提交摘要（AI）。
   * - 防抖：ref 互斥，进行中/连点直接忽略，杜绝启动第二个 agent 导致内存暴涨
   * - 进度：生成期间展示持久 toast，结束统一收起
   * - 超时：主进程 60s 上限返回 GIT_COMMIT_TIMEOUT，提示更久并带“重试”入口
   * - 项目保护：切项目后旧请求结果不写入新项目的提交框
   */
  const runGenerateCommitMessage = useCallback(async () => {
    if (!props.generateCommitMessage) return;
    if (groups.index.length === 0) {
      showNotice(t("git.stageBeforeGenerateCommitMessage"), 3000);
      return;
    }
    if (commitGenRequestRef.current) return;
    commitGenRequestRef.current = true;
    setCommitGenLoading(true);
    commitGenProgressRef.current = showNotice(
      t("git.generateCommitMessageProgress"),
      0,
    );
    const projectId = props.projectId;
    try {
      const result = await props.generateCommitMessage(projectId);
      if (projectId !== projectIdRef.current) return;
      if (result.ok) {
        if (result.message) setCommitMessage(result.message);
      } else if (result.code === "GIT_COMMIT_MODEL_REQUIRED") {
        // 未配置：提示 + “去设置”按钮直达设置弹窗（Git 段在常用设置 tab）
        showNotice(result.message, 8000, "error", undefined, {
          action: {
            label: t("git.goSettings"),
            onClick: () => setSettingsOpen(true),
          },
        });
      } else if (result.code === "GIT_COMMIT_TIMEOUT") {
        // 生成超时（主进程 60s 上限）：提示更久并给重试入口；重试复用同一防抖锁
        showNotice(result.message, 10000, "error", undefined, {
          action: {
            label: t("git.retryGenerate"),
            onClick: () => void runGenerateCommitMessage(),
          },
        });
      } else {
        showNotice(result.message, 5000, "error");
      }
    } catch (err) {
      if (projectId !== projectIdRef.current) return;
      showNotice(
        err instanceof Error ? err.message : t("git.generateCommitMessageFailed"),
        5000,
        "error",
      );
    } finally {
      commitGenRequestRef.current = false;
      setCommitGenLoading(false);
      dismissNotice(commitGenProgressRef.current);
      commitGenProgressRef.current = undefined;
    }
  }, [props.generateCommitMessage, props.projectId, groups.index.length]);

  const doPush = async () => {
    if (!props.push || mutationRunningRef.current) return;
    const projectId = props.projectId;
    const mutationRequest = ++mutationRequestRef.current;
    mutationRunningRef.current = true;
    setPushing(true);
    setError(null);
    try {
      await props.push(projectId);
      if (projectId !== projectIdRef.current) return;
      await refresh();
      await refreshAheadBehind();
    } catch (caught) {
      if (projectId === projectIdRef.current) {
        const msg = errorMessage(caught);
        setError(msg);
        showNotice(msg, 10000, "error");
      }
    } finally {
      if (mutationRequest === mutationRequestRef.current) {
        mutationRunningRef.current = false;
        if (projectId === projectIdRef.current) setPushing(false);
      }
    }
  };

  const doPull = async () => {
    if (!props.pull || mutationRunningRef.current) return;
    const projectId = props.projectId;
    const mutationRequest = ++mutationRequestRef.current;
    mutationRunningRef.current = true;
    setPulling(true);
    setError(null);
    try {
      await props.pull(projectId);
      if (projectId !== projectIdRef.current) return;
      await refresh();
      await refreshAheadBehind();
    } catch (caught) {
      if (projectId === projectIdRef.current) {
        const msg = errorMessage(caught);
        setError(msg);
        showNotice(msg, 10000, "error");
      }
    } finally {
      if (mutationRequest === mutationRequestRef.current) {
        mutationRunningRef.current = false;
        if (projectId === projectIdRef.current) setPulling(false);
      }
    }
  };

  const visibleSashAfterChanges = adjacentVisiblePane(
    paneState.open,
    "changes",
    1,
  );
  const visibleSashAfterGraph = adjacentVisiblePane(paneState.open, "graph", 1);
  const paneStyle = (id: PaneId): React.CSSProperties =>
    ({
      "--git-pane-height": `${paneState.heights[id]}px`,
    }) as React.CSSProperties;

  const renderSash = (before: PaneId, after: PaneId) => (
    <PaneSash
      before={before}
      after={after}
      beforeHeight={paneState.heights[before]}
      afterHeight={paneState.heights[after]}
      onResize={(beforeHeight, afterHeight) =>
        resizePanes(before, after, beforeHeight, afterHeight)
      }
    />
  );

  /** 新建分支弹窗状态 */
  const [commitGenLoading, setCommitGenLoading] = useState(false);
  const [branchOpen, setBranchOpen] = useState(false);
  const [branchCreating, setBranchCreating] = useState(false);
  const [newBranchName, setNewBranchName] = useState("");
  const [branchDropdownStyle, setBranchDropdownStyle] = useState<React.CSSProperties>({});
  const branchBarRef = useRef<HTMLDivElement>(null);
  const branchTriggerRef = useRef<HTMLButtonElement>(null);
  const branchDropdownRef = useRef<HTMLDivElement>(null);

  const updateBranchDropdownPosition = useCallback(() => {
    if (!branchTriggerRef.current) return;
    const rect = branchTriggerRef.current.getBoundingClientRect();
    // 菜单宽度跟触发器走（随抽屉自适应），再由 placement 钳进视口；不再写死 240。
    const preferredWidth = Math.max(Math.ceil(rect.width), 160);
    const placement = getViewportBoundMenuPlacement(
      rect,
      { width: window.innerWidth, height: window.innerHeight },
      { preferredWidth, maxHeight: 300, gap: 2 },
    );
    setBranchDropdownStyle({
      position: "fixed",
      left: placement.left,
      top: placement.top,
      bottom: placement.bottom,
      width: placement.width,
      maxHeight: placement.maxHeight,
      zIndex: 9999,
    });
  }, []);

  // 点击外部关闭分支下拉
  useEffect(() => {
    if (!branchOpen) return;
    updateBranchDropdownPosition();
    const handler = (event: MouseEvent) => {
      const target = event.target as Node;
      // Portal 出来的菜单不再是 branchBar 的后代，二者都属于菜单交互区。
      if (
        branchBarRef.current?.contains(target) ||
        branchDropdownRef.current?.contains(target)
      ) {
        return;
      }
      setBranchOpen(false);
      setBranchCreating(false);
      setNewBranchName("");
    };
    const handleScroll = () => updateBranchDropdownPosition();
    const handleResize = () => updateBranchDropdownPosition();
    document.addEventListener("mousedown", handler);
    window.addEventListener("scroll", handleScroll, true);
    window.addEventListener("resize", handleResize);
    return () => {
      document.removeEventListener("mousedown", handler);
      window.removeEventListener("scroll", handleScroll, true);
      window.removeEventListener("resize", handleResize);
    };
  }, [branchOpen, updateBranchDropdownPosition]);

  return (
    <div
      ref={panelRef}
      className="git-panel flex h-full min-h-0 flex-col overflow-hidden bg-background text-foreground"
      aria-label={t("git.sourceControl")}
    >
      {/* 当前分支 + 切换下拉（pure official：outline 触发器 + popover 菜单） */}
      <div className="flex shrink-0 items-center gap-1 border-b border-border/40 bg-background px-2 py-1.5" ref={branchBarRef}>
        <Button
          ref={branchTriggerRef}
          type="button"
          variant="outline"
          className="inline-flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md border border-border bg-background px-2 text-left text-xs text-foreground hover:bg-accent"
          onClick={() => {
            if (!branchOpen) updateBranchDropdownPosition();
            setBranchOpen((v) => !v);
          }}
          title={
            props.currentBranch
              ? t("app.branchCurrent", {
                  branch: props.currentBranch,
                  count: props.branches.length,
                })
              : undefined
          }
        >
          <GitBranch size={14} className="shrink-0 text-muted-foreground" />
          <span className="git-branch-label min-w-0 flex-1 truncate">
            {props.currentBranch || t("app.branchNone")}
          </span>
          {props.branches.length > 0 && (
            <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-muted px-1.5 text-[11px] font-medium tabular-nums text-muted-foreground">{props.branches.length}</span>
          )}
          <ChevronDown
            size={12}
            className={`shrink-0 text-muted-foreground transition-transform duration-150${branchOpen ? " rotate-180" : ""}`}
          />
        </Button>
        {notAGitRepo && (
          <Button
            type="button"
            variant="ghost" size="icon-sm" className="size-7 inline-grid size-7 place-items-center rounded-md border border-border text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            title={t("git.initInBranchBar")}
            disabled={initializing}
            onClick={async () => {
              if (!props.gitInit) return;
              setInitializing(true);
              try {
                await props.gitInit(props.projectId);
                setNotAGitRepo(false);
                void refresh();
              } catch (caught) {
                setError(errorMessage(caught));
              }
              setInitializing(false);
            }}
          >
            {initializing ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <Plus size={14} />
            )}
          </Button>
        )}
        {branchOpen &&
          createPortal(
            <div
              ref={branchDropdownRef}
              className="z-50 max-h-[calc(100vh-16px)] max-w-[calc(100vw-16px)] overflow-auto rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md"
              style={branchDropdownStyle}
            >
            {props.branches.map((branch) => (
              <Button
                type="button"
                key={branch}
                variant="ghost"
                size="sm"
                className={`h-auto flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs hover:bg-accent${branch === props.currentBranch ? " bg-accent font-semibold text-[color:var(--color-accent)]" : ""}`}
                title={branch}
                onClick={() => {
                  if (branch !== props.currentBranch)
                    props.onSwitchBranch?.(branch);
                  setBranchOpen(false);
                }}
              >
                {branch === props.currentBranch && (
                  <Check size={14} className="shrink-0 text-[color:var(--color-accent)]" />
                )}
                <span className="truncate">{branch}</span>
              </Button>
            ))}
            <div className="my-1 h-px bg-border" />
            {branchCreating ? (
              <div className="flex items-center gap-1 px-1 py-1">
                <Input
                  className="h-7 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  placeholder={
                    t("app.branchNewPlaceholder") ??
                    t("app.branchNewPlaceholder")
                  }
                  value={newBranchName}
                  onChange={(e) => setNewBranchName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && newBranchName.trim()) {
                      props.onCreateBranch?.(newBranchName.trim());
                      setBranchCreating(false);
                      setNewBranchName("");
                      setBranchOpen(false);
                    }
                    if (e.key === "Escape") {
                      setBranchCreating(false);
                      setNewBranchName("");
                    }
                  }}
                  autoFocus
                />
                <Button
                  type="button"
                  variant="default"
                  size="icon-sm"
                  className="inline-grid size-7 place-items-center rounded-md bg-primary text-primary-foreground disabled:opacity-40"
                  disabled={!newBranchName.trim()}
                  onClick={() => {
                    props.onCreateBranch?.(newBranchName.trim());
                    setBranchCreating(false);
                    setNewBranchName("");
                    setBranchOpen(false);
                  }}
                >
                  <Check size={14} />
                </Button>
              </div>
            ) : (
              <Button
                type="button"
                variant="ghost" size="sm" className="h-auto flex w-full items-center gap-1.5 rounded-sm px-2 py-1.5 text-left text-xs text-text-secondary hover:bg-accent"
                onClick={() => setBranchCreating(true)}
              >
                <Plus size={14} />
                <span>{t("app.branchCreate")}</span>
              </Button>
            )}
          </div>,
          document.body,
        )}
      </div>
      <section
        id="git-pane-changes"
        className={`flex min-h-0 flex-[0_0_auto] flex-col overflow-hidden border-b border-[var(--git-panel-border)] bg-[var(--git-panel-bg)] last:border-b-0${paneState.open.changes ? " h-[calc(var(--git-pane-height)+32px)]" : " h-[32px]"}`}
        style={paneStyle("changes")}
      >
        <PaneHeader
          id="changes"
          title={t("git.changes")}
          open={paneState.open.changes}
          onToggle={() => togglePane("changes")}
        >
          {loading && (
            <Loader2
              size={14}
              className="animate-spin"
              aria-label={t("common.loading")}
            />
          )}
          {/* 与文件树一致：收起/展开全部变更目录 */}
          <Button
            type="button"
            variant="ghost" size="icon-sm" className="size-7"
            title={t("drawer.collapseAllDirs")}
            aria-label={t("drawer.collapseAllDirs")}
            disabled={!canCollapseChangeDirs || allChangeDirsCollapsed}
            onClick={collapseAllChangeDirs}
          >
            <ChevronsDownUp size={14} />
          </Button>
          <Button
            type="button"
            variant="ghost" size="icon-sm" className="size-7"
            title={t("drawer.expandAllDirs")}
            aria-label={t("drawer.expandAllDirs")}
            disabled={!canCollapseChangeDirs || allChangeDirsExpanded}
            onClick={expandAllChangeDirs}
          >
            <ChevronsUpDown size={14} />
          </Button>
          <Button
            type="button"
            variant="ghost" size="icon-sm" className="size-7"
            title={t("common.refresh")}
            aria-label={t("common.refresh")}
            onClick={() => {
              void refresh();
              // 手动刷新必须同步刷新 push/pull 角标：角标走 5 分钟定时 fetch，
              // 用户主动点击时应立即对比远程，否则刚 push 完角标仍是旧值
              void refreshAheadBehind();
            }}
          >
            <RefreshCw size={14} />
          </Button>
          {props.push && (
            <div className="relative inline-flex items-center">
              <Button
                type="button"
                variant="ghost" size="icon-sm" className="size-7"
                title={
                  aheadBehind && aheadBehind.ahead > 0
                    ? t("git.pushAhead", { count: aheadBehind.ahead })
                    : t("git.push")
                }
                aria-label={t("git.push")}
                disabled={pushing || mutationRunningRef.current}
                onClick={() => void doPush()}
              >
                {pushing ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <ArrowUpFromLine size={14} />
                )}
              </Button>
              {/* 领先角标：本地上游提交数，提示需要推送。
                  背景用 --color-info 而非 --color-accent：accent 暗色反转为近白（#fafafa），
                  与固定 text-white 组合会白底白字不可读；info 明暗两套都是深蓝系，白字对比稳定 */}
              {!pushing && aheadBehind && aheadBehind.ahead > 0 && (
                <span
                  className="pointer-events-none absolute -top-1 -right-1 inline-flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-[var(--color-info)] px-0.5 text-[9px] leading-none font-semibold text-white tabular-nums"
                  aria-label={t("git.pushAhead", { count: aheadBehind.ahead })}
                >
                  {aheadBehind.ahead}
                </span>
              )}
            </div>
          )}
          {props.pull && (
            <div className="relative inline-flex items-center">
              <Button
                type="button"
                variant="ghost" size="icon-sm" className="size-7"
                title={
                  aheadBehind && aheadBehind.behind > 0
                    ? t("git.pullBehind", { count: aheadBehind.behind })
                    : t("git.pull")
                }
                aria-label={t("git.pull")}
                disabled={pulling || mutationRunningRef.current}
                onClick={() => void doPull()}
              >
                {pulling ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <ArrowDownToLine size={14} />
                )}
              </Button>
              {/* 落后角标：远程领先本地的提交数，提示需要拉取（颜色同领先角标，见上注释） */}
              {!pulling && aheadBehind && aheadBehind.behind > 0 && (
                <span
                  className="pointer-events-none absolute -top-1 -right-1 inline-flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-[var(--color-info)] px-0.5 text-[9px] leading-none font-semibold text-white tabular-nums"
                  aria-label={t("git.pullBehind", { count: aheadBehind.behind })}
                >
                  {aheadBehind.behind}
                </span>
              )}
            </div>
          )}
        </PaneHeader>
        {paneState.open.changes && (
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            {gitNotInstalled ? (
              <div className="flex flex-col items-center gap-3 px-4 py-10 text-center">
                <div className="text-[32px] leading-none opacity-60">⚡</div>
                <div className="text-sm font-semibold text-text-primary">{t("git.gitNotInstalled")}</div>
                <div className="max-w-[360px] text-xs leading-[22px] text-text-tertiary">{t("git.gitNotInstalledDesc")}</div>
              </div>
            ) : notAGitRepo ? (
              <div className="flex flex-col items-center gap-4 px-4 py-8 text-center">
                <div className="text-[13px] leading-[22px] text-[var(--git-desc-fg)]">{t("git.notAGitRepo")}</div>
                <Button
                  type="button"
                  variant="ghost" size="sm" className=" h-auto px-2.5 text-[13px]"
                  disabled={initializing}
                  onClick={async () => {
                    if (!props.gitInit) return;
                    setInitializing(true);
                    try {
                      await props.gitInit(props.projectId);
                      setNotAGitRepo(false);
                      // 初始化完成后刷新状态
                      void refresh();
                    } catch (caught) {
                      setError(errorMessage(caught));
                    }
                    setInitializing(false);
                  }}
                >
                  {initializing ? (
                    <Loader2 size={14} className="animate-spin" />
                  ) : (
                    t("git.initRepo")
                  )}
                </Button>
              </div>
            ) : (
            <div className="flex shrink-0 flex-col gap-2 border-b border-[var(--git-panel-border)] bg-[var(--git-panel-bg)] px-2.5 pt-2 pb-1.5">
              <ContextMenu>
                <ContextMenuTrigger asChild>
                  <Textarea
                    ref={commitInputRef}
                    className="git-scm-input min-h-14 max-h-[100px] w-full resize-y rounded-sm border border-[var(--git-input-border)] bg-[var(--git-input-bg)] px-2 py-1 text-[13px] leading-[20px] text-[var(--git-panel-fg)] outline-none placeholder:text-[var(--git-desc-fg)]"
                placeholder={t("git.commitPlaceholder", {
                  branch: props.currentBranch ?? "HEAD",
                })}
                value={commitMessage}
                onChange={(event) => setCommitMessage(event.target.value)}
                onKeyDown={(event) => {
                  if (
                    (event.ctrlKey || event.metaKey) &&
                    event.key === "Enter"
                  ) {
                    event.preventDefault();
                    void doCommit();
                  }
                }}
                rows={3}
              />
                </ContextMenuTrigger>
                <ContextMenuContent alignOffset={-6}>
                  <ContextMenuItem onSelect={pasteCommitClipboard}>
                    <ClipboardPaste size={13} strokeWidth={2} aria-hidden="true" />
                    {t("common.paste")}
                  </ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
              <div className="flex items-stretch gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="min-w-8 border border-border-subtle bg-bg-panel text-text-secondary hover:bg-bg-hover hover:text-text-primary"
                  title={
                    commitGenLoading
                      ? t("git.generateCommitMessageProgress")
                      : t("git.generateCommitMessage")
                  }
                  aria-label={t("git.generateCommitMessage")}
                  disabled={commitGenLoading || mutating}
                  onClick={() => void runGenerateCommitMessage()}
                >
                  {commitGenLoading ? (
                    <Loader2 size={14} className="animate-spin" />
                  ) : (
                    <Sparkles size={14} />
                  )}
                </Button>
                <Button
                  variant="default"
                  className="git-commit-btn min-w-0 flex-1"
                  loading={committing}
                  disabled={!canCommit}
                  onClick={() => void doCommit()}
                >
                  {committing ? t("git.committing") : t("git.commit")}
                </Button>
              </div>
            </div>
            )}

            {error && <div className="flex min-h-[22px] shrink-0 items-center gap-1 px-[9px] text-[13px] text-[var(--git-conflict)]">{error}</div>}
            {!loading && total === 0 && !error && (
              <div className="git-status-msg flex min-h-[22px] shrink-0 items-center gap-1 px-[9px] text-[13px] text-[var(--git-desc-fg)]">{t("git.noPendingChanges")}</div>
            )}

            <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain [scrollbar-gutter:stable]">
              {groups.merge.length > 0 && (
                <ResourceGroup
                  title={t("git.mergeChanges")}
                  count={groups.merge.length}
                  open={resourceOpen.merge}
                  onToggle={() => toggleResource("merge")}
                >
                  <FileTree
                    resources={groups.merge}
                    groupType="merge"
                    onOpenWorkspaceFileDiff={props.onOpenWorkspaceFileDiff}
                    mutating={mutating || committing}
                    projectRoot={props.projectRoot}
                    collapsedDirs={collapsedChangeDirs}
                    onToggleDir={toggleChangeDir}
                  />
                </ResourceGroup>
              )}
              {groups.index.length > 0 && (
                <ResourceGroup
                  title={t("git.stagedChanges")}
                  count={groups.index.length}
                  open={resourceOpen.staged}
                  onToggle={() => toggleResource("staged")}
                  allAction={() =>
                    act(() =>
                      props.unstageFiles(
                        props.projectId,
                        groups.index.map((resource) => resource.path),
                      ),
                    )
                  }
                  allLabel={t("git.unstageAll")}
                  allDisabled={mutating || committing}
                >
                  <FileTree
                    resources={groups.index}
                    groupType="index"
                    onOpenWorkspaceFileDiff={props.onOpenWorkspaceFileDiff}
                    mutating={mutating || committing}
                    unstageFile={(path) => act(() => props.unstageFiles(props.projectId, [path]))}
                    deleteFile={props.deleteFiles ? (path) => setDeleteTarget(path) : undefined}
                    onOpenFile={props.onOpenFile}
                    projectRoot={props.projectRoot}
                    collapsedDirs={collapsedChangeDirs}
                    onToggleDir={toggleChangeDir}
                  />
                </ResourceGroup>
              )}
              {workingChanges.length > 0 && (
                <ResourceGroup
                  title={t("git.changes")}
                  count={workingChanges.length}
                  open={resourceOpen.changes}
                  onToggle={() => toggleResource("changes")}
                  allAction={() =>
                    act(() =>
                      props.stageFiles(
                        props.projectId,
                        workingChanges.map((resource) => resource.path),
                      ),
                    )
                  }
                  allLabel={t("git.stageAll")}
                  allDisabled={mutating || committing}
                >
                  <FileTree
                    resources={workingChanges}
                    groupType="workingTree"
                    onOpenWorkspaceFileDiff={props.onOpenWorkspaceFileDiff}
                    mutating={mutating || committing}
                    stageFile={(path) => act(() => props.stageFiles(props.projectId, [path]))}
                    discardFile={(path, group) => setDiscardTarget({ group, path })}
                    deleteFile={props.deleteFiles ? (path) => setDeleteTarget(path) : undefined}
                    onOpenFile={props.onOpenFile}
                    stagedPaths={stagedPathSet}
                    projectRoot={props.projectRoot}
                    collapsedDirs={collapsedChangeDirs}
                    onToggleDir={toggleChangeDir}
                  />
                </ResourceGroup>
              )}
            </div>
          </div>
        )}
      </section>

      {visibleSashAfterChanges &&
        renderSash("changes", visibleSashAfterChanges)}

      <SourceControlGraph
        projectId={props.projectId}
        commitLog={props.commitLog}
        commitDetail={props.commitDetail}
        onOpenCommitFileDiff={props.onOpenCommitFileDiff}
        branches={props.branches}
        currentBranch={props.currentBranch}
        open={paneState.open.graph}
        height={paneState.heights.graph}
        onToggle={() => togglePane("graph")}
        cherryPick={props.cherryPick}
        revert={props.revert}
        reset={props.reset}
        dropCommit={props.dropCommit}
      />

      {paneState.open.graph &&
        visibleSashAfterGraph &&
        renderSash("graph", visibleSashAfterGraph)}

      <CompareChanges
        projectId={props.projectId}
        branches={props.branches}
        branchCompare={props.branchCompare}
        open={paneState.open.compare}
        height={paneState.heights.compare}
        onToggle={() => togglePane("compare")}
      />

      {discardTarget &&
        createPortal(
          <ConfirmDialog
            title={
              discardTarget.group === "untracked"
                ? t("git.discardUntrackedConfirmTitle")
                : t("git.discardConfirmTitle")
            }
            message={
              discardTarget.group === "untracked"
                ? t("git.discardUntrackedConfirmMessage", {
                    path: fileNameOnly(discardTarget.path),
                  })
                : t("git.discardConfirmMessage", {
                    path: fileNameOnly(discardTarget.path),
                  })
            }
            danger
            confirmLabel={
              discardTarget.group === "untracked"
                ? t("common.delete")
                : t("app.retractDiscard")
            }
            onConfirm={confirmDiscard}
            onCancel={() => setDiscardTarget(null)}
          />,
          document.body,
        )}

      {/* 右键“删除文件”确认：文件移入回收站（可恢复），danger 提示 */}
      {deleteTarget &&
        createPortal(
          <ConfirmDialog
            title={t("git.deleteFileConfirmTitle")}
            message={t("git.deleteFileConfirmMessage", {
              path: fileNameOnly(deleteTarget),
            })}
            danger
            confirmLabel={t("common.delete")}
            onConfirm={confirmDelete}
            onCancel={() => setDeleteTarget(null)}
          />,
          document.body,
        )}

      {showSmartCommitPrompt &&
        createPortal(
          <div
            className="absolute inset-0 z-[1200] flex items-center justify-center bg-[var(--overlay-backdrop-soft)] p-6"
            role="presentation"
            onClick={() => setShowSmartCommitPrompt(false)}
          >
            <div
              className="w-[min(520px,calc(100vw-48px))] rounded-lg border border-border-subtle bg-bg-panel p-4 font-sans text-text-primary shadow-[var(--shadow-modal)]"
              role="alertdialog"
              aria-modal="true"
              aria-labelledby="git-smart-commit-title"
              onClick={(event) => event.stopPropagation()}
            >
              <strong id="git-smart-commit-title" className="text-base leading-6">
                {t("git.smartCommitTitle")}
              </strong>
              <p className="my-3 mb-4 text-sm leading-[22px] whitespace-pre-line text-text-secondary">{t("git.smartCommitPrompt")}</p>
              <div className="flex flex-wrap justify-end gap-2">
                <Button
                  type="button"
                  variant="outline" size="sm"
                  onClick={() => setShowSmartCommitPrompt(false)}
                >
                  {t("common.cancel")}
                </Button>
                <Button
                  type="button"
                  variant="outline" size="sm"
                  onClick={() => chooseSmartCommit("never")}
                >
                  {t("git.smartCommitNever")}
                </Button>
                <Button
                  type="button"
                  variant="outline" size="sm"
                  onClick={() => chooseSmartCommit("always")}
                >
                  {t("git.smartCommitAlways")}
                </Button>
                <Button
                  type="button"
                  variant="default" size="sm"
                  autoFocus
                  onClick={() => chooseSmartCommit("yes")}
                >
                  {t("git.smartCommitYes")}
                </Button>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}

function CompareChanges(props: {
  projectId: string;
  branches: string[];
  branchCompare: GitPanelProps["branchCompare"];
  open: boolean;
  height: number;
  onToggle: () => void;
}) {
  const [base, setBase] = useState("");
  const [target, setTarget] = useState("");
  const [result, setResult] = useState<BranchDiffResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestSequence = useRef(0);

  useEffect(() => {
    // Branch names overlap across projects; comparison state must not cross that boundary.
    requestSequence.current += 1;
    setBase("");
    setTarget("");
    setResult(null);
    setError(null);
    setLoading(false);
  }, [props.projectId]);

  useEffect(() => {
    if (props.branches.length >= 2 && (!base || !target)) {
      setTarget(props.branches[0] ?? "");
      setBase(props.branches[1] ?? "");
    }
  }, [base, props.branches, target]);

  const run = async () => {
    if (!base || !target || base === target) return;
    const request = ++requestSequence.current;
    const projectId = props.projectId;
    setLoading(true);
    setError(null);
    try {
      const next = await props.branchCompare(projectId, base, target);
      if (request === requestSequence.current && projectId === props.projectId)
        setResult(next);
    } catch (caught) {
      if (
        request === requestSequence.current &&
        projectId === props.projectId
      ) {
        setResult(null);
        setError(errorMessage(caught));
      }
    } finally {
      if (request === requestSequence.current && projectId === props.projectId)
        setLoading(false);
    }
  };

  return (
    <section
      id="git-pane-compare"
      className={`flex min-h-0 flex-[0_0_auto] flex-col overflow-hidden border-b border-[var(--git-panel-border)] bg-[var(--git-panel-bg)] last:border-b-0${props.open ? " h-[calc(var(--git-pane-height)+32px)]" : " h-[32px]"}`}
      style={
        { "--git-pane-height": `${props.height}px` } as React.CSSProperties
      }
    >
      <PaneHeader
        id="compare"
        title={t("git.compareChanges")}
        count={result?.files.length}
        open={props.open}
        onToggle={props.onToggle}
      />
      {props.open && (
        <div className="flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto overscroll-contain [scrollbar-gutter:stable]">
          <div className="git-compare-controls">
            <Label>
              <span>{t("git.base")}</span>
              <GitCompactFilter
                value={base}
                ariaLabel={t("git.base")}
                options={[
                  { value: "", label: t("git.selectBase") },
                  ...props.branches.map((branch) => ({
                    value: branch,
                    label: branch,
                  })),
                ]}
                onChange={(value) => setBase(value)}
              />
            </Label>
            <span className="flex items-center pb-px text-[var(--git-desc-fg)]" aria-hidden="true">
              →
            </span>
            <Label>
              <span>{t("git.compare")}</span>
              <GitCompactFilter
                value={target}
                ariaLabel={t("git.compare")}
                options={[
                  { value: "", label: t("git.selectCompare") },
                  ...props.branches.map((branch) => ({
                    value: branch,
                    label: branch,
                  })),
                ]}
                onChange={(value) => setTarget(value)}
              />
            </Label>
            <Button
              type="button"
              variant="ghost" size="sm" className=" h-auto px-2.5 text-[13px]"
              disabled={!base || !target || base === target || loading}
              onClick={() => void run()}
            >
              {loading ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                t("git.compare")
              )}
            </Button>
          </div>
          {error && <div className="flex min-h-[22px] shrink-0 items-center gap-1 px-[9px] text-[13px] text-[var(--git-conflict)]">{error}</div>}
          {result && (
            <>
              <div className="flex-[0_0_auto] border-t border-[var(--git-panel-border)] px-2.5 py-1 text-[11px] text-[var(--git-desc-fg)]">
                {t("git.compareSummary", {
                  ahead: result.ahead,
                  behind: result.behind,
                  count: result.files.length,
                })}
              </div>
              <div className="min-h-0 flex-1 overflow-auto overscroll-contain">
                {result.files.map((file) => (
                  <ResourceRow
                    key={file.path}
                    status={0 as GitStatus}
                    letter=""
                    path={file.path}
                    compareStatus={file.status}
                  />
                ))}
              </div>
            </>
          )}
          {!result && !error && (
            <div className="flex min-h-[22px] shrink-0 items-center gap-1 px-[9px] text-[13px] text-[var(--git-desc-fg)]">{t("git.compareHint")}</div>
          )}
        </div>
      )}
    </section>
  );
}
