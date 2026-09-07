import { useState, useRef, useEffect } from "react";
import type { Project, FileTreeNode, GitBranchInfo, WorktreeEntry, SessionSummary, SessionRecord } from "../../../shared/types";
import type { SessionLoadState } from "../atoms/session-atoms";
import { sessionRecordToSummary } from "../atoms/session-selectors";
import { requestProjectInventory } from "../utils/projectInventoryRequests";

const SESSION_REFRESH_TIMEOUT_MS = 20_000;
const SIDEBAR_PROJECT_CHILD_PAGE_SIZE = 5;
const EMPTY_FILE_TREE: FileTreeNode[] = [];

type ActiveProjectFiles = {
  projectId: string | undefined;
  files: FileTreeNode[];
};

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

type UseProjectSyncInput = {
  projects: Project[];
  activeProjectId: string | undefined;
  setProjects: (projects: Project[]) => void;
  setActiveProjectId: (id: string) => void;
  replaceProjectSessions: (input: { projectId: string; sessions: SessionRecord[] }) => void;
  api: {
    projects: { list: () => Promise<Project[]> };
    git: { worktreeList: (projectId: string) => Promise<WorktreeEntry[]>; branches: (projectId: string) => Promise<{ current: string | null; branches: string[] }> };
    sessions: {
      listCatalog: (projectId: string, options?: { scan?: boolean }) => Promise<SessionRecord[]>;
      /** 后台扫描完成推送（主进程 → 渲染层）；可选，缺省时退化为纯轮询。 */
      onCatalogRefreshed?: (listener: (input: { projectId: string }) => void) => () => void;
    };
    files: { list: (projectId: string) => Promise<FileTreeNode[]> };
  };
  showToast: (message: string, duration?: number) => void;
  setSessionCatalogLoadState?: (input: { projectId: string; state: SessionLoadState }) => void;
  t: typeof import("../i18n").t;
};

type ProjectSessionRefreshResult = SessionSummary[] | SessionRecord[] | undefined;
type ProjectSessionRefreshPromise = Promise<ProjectSessionRefreshResult>;
type ProjectSessionRefreshCompletion = {
  promise: ProjectSessionRefreshPromise;
  resolve: (value: ProjectSessionRefreshResult | PromiseLike<ProjectSessionRefreshResult>) => void;
  reject: (reason?: unknown) => void;
};

function createProjectSessionRefreshCompletion(): ProjectSessionRefreshCompletion {
  let resolveCompletion!: (value: ProjectSessionRefreshResult | PromiseLike<ProjectSessionRefreshResult>) => void;
  let rejectCompletion!: (reason?: unknown) => void;
  const promise = new Promise<ProjectSessionRefreshResult>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  return { promise, resolve: resolveCompletion, reject: rejectCompletion };
}

export function useProjectSync(input: UseProjectSyncInput) {
  const {
    projects,
    activeProjectId,
    setProjects,
    setActiveProjectId,
    replaceProjectSessions,
    api,
    showToast,
    setSessionCatalogLoadState,
    t,
  } = input;
  const [worktreesByProject, setWorktreesByProject] = useState<Record<string, WorktreeEntry[]>>({});
  const [branchByProject, setBranchByProject] = useState<Record<string, string | null>>({});
  const [projectFiles, setProjectFiles] = useState<ActiveProjectFiles>({
    projectId: undefined,
    files: EMPTY_FILE_TREE,
  });
  // useEffect 在提交后才清理旧 state；渲染时先按项目身份过滤，保证切换后的
  // 第一帧也不会把上一项目的文件树挂到新项目名下。
  const files = projectFiles.projectId === activeProjectId
    ? projectFiles.files
    : EMPTY_FILE_TREE;
  const [gitInfo, setGitInfo] = useState<GitBranchInfo>({ current: null, branches: [] });
  const [sessionLoadingByProject, setSessionLoadingByProject] = useState<Record<string, boolean>>({});
  const [visibleProjectChildCountByProject, setVisibleProjectChildCountByProject] = useState<Record<string, number>>({});
  const activeProjectIdRef = useRef(activeProjectId);
  activeProjectIdRef.current = activeProjectId;
  const fileRequestRef = useRef(0);
  const gitInfoRequestRef = useRef(0);
  // request sequence 只记录启动顺序；只有成功应用的请求才能推进数据 authority。
  const sessionRequestByProjectRef = useRef<Record<string, number>>({});
  const sessionLatestAppliedRequestByProjectRef = useRef<Record<string, number | undefined>>({});
  // 数据 authority 与前台 loading 所有权分离：后台 catalog-refreshed 可以推进数据版本，
  // 但不能让原本显示 spinner 的前台请求失去清理 loading 的机会。
  const sessionLoadingRequestByProjectRef = useRef<Record<string, number | undefined>>({});
  const sessionRefreshRunningRef = useRef<Set<string>>(new Set());
  const sessionRefreshPendingRef = useRef<Set<string>>(new Set());
  const sessionRefreshCompletionByProjectRef = useRef<Record<string, ProjectSessionRefreshCompletion | undefined>>({});

  async function refreshProjects() {
    const next = await requestProjectInventory(api.projects.list);
    if (!next) return;
    setProjects(next);
    if (!activeProjectId && next.length > 0) setActiveProjectId(next[0].id);
    for (const p of next) { if (p.worktreeEnabled) void refreshWorktrees(p.id); }
  }

  async function refreshWorktrees(projectId: string) {
    try {
      const [entries, branchInfo] = await Promise.all([
        api.git.worktreeList(projectId),
        api.git.branches(projectId).catch(() => ({ current: null, branches: [] })),
      ]);
      setWorktreesByProject((prev) => ({ ...prev, [projectId]: entries }));
      setBranchByProject((prev) => ({ ...prev, [projectId]: branchInfo.current }));
      const next = await requestProjectInventory(api.projects.list);
      if (next) setProjects(next);
    } catch { setWorktreesByProject((prev) => ({ ...prev, [projectId]: [] })); }
  }

  async function refreshSessions(projectId = activeProjectId): Promise<SessionSummary[]> {
    if (!projectId) return [];
    const refreshed: ProjectSessionRefreshResult = await refreshProjectSessions(projectId, true);
    if (!refreshed) return [];
    return refreshed
      .map((session) => "projectId" in session ? sessionRecordToSummary(session) : session)
      .filter((session): session is SessionSummary => Boolean(session))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async function runProjectSessionRefresh(
    projectId: string,
    silent: boolean,
    completion: ProjectSessionRefreshCompletion,
  ): Promise<void> {
    const request = (sessionRequestByProjectRef.current[projectId] ?? 0) + 1;
    sessionRequestByProjectRef.current[projectId] = request;
    sessionRefreshRunningRef.current.add(projectId);

    let result: ProjectSessionRefreshResult = undefined;
    let error: unknown;
    let failed = false;
    try {
      if (!silent) {
        sessionLoadingRequestByProjectRef.current[projectId] = request;
        setSessionLoadingByProject((c) => ({ ...c, [projectId]: true }));
        setSessionCatalogLoadState?.({ projectId, state: { status: "loading" } });
        await new Promise<void>((r) => setTimeout(r, 0));
      }
      const records = await withTimeout(
        api.sessions.listCatalog(projectId),
        SESSION_REFRESH_TIMEOUT_MS,
        t("app.sessionRefreshTimeout"),
      );
      const latestAppliedRequest = sessionLatestAppliedRequestByProjectRef.current[projectId];
      if (latestAppliedRequest !== undefined && request < latestAppliedRequest) {
        // 新请求已经成功应用时，旧请求只能完成自己的 Promise，不能回写数据或状态。
        result = records;
      } else {
        replaceProjectSessions({ projectId, sessions: records });
        sessionLatestAppliedRequestByProjectRef.current[projectId] = request;
        setSessionCatalogLoadState?.({ projectId, state: { status: "ready" } });
        const sorted = records
          .map(sessionRecordToSummary)
          .filter((session): session is SessionSummary => Boolean(session))
          .sort((a, b) => b.updatedAt - a.updatedAt);
        setVisibleProjectChildCountByProject((c) => ({ ...c, [projectId]: c[projectId] ?? SIDEBAR_PROJECT_CHILD_PAGE_SIZE }));
        result = sorted;
      }
    } catch (caughtError) {
      failed = true;
      error = caughtError;
      // 失败请求不能覆盖已经成功应用的数据；只有没有任何成功 authority，
      // 且该请求仍是最新启动请求时，才把 catalog 置为 error。
      if (
        sessionRequestByProjectRef.current[projectId] === request &&
        sessionLatestAppliedRequestByProjectRef.current[projectId] === undefined
      ) {
        const message = caughtError instanceof Error ? caughtError.message : String(caughtError);
        setSessionCatalogLoadState?.({
          projectId,
          state: { status: "error", error: message },
        });
      }
    } finally {
      const isCurrentCompletion = sessionRefreshCompletionByProjectRef.current[projectId] === completion;
      const isCurrentRequest = sessionRequestByProjectRef.current[projectId] === request;
      const ownsForegroundLoading =
        sessionLoadingRequestByProjectRef.current[projectId] === request;
      if (isCurrentRequest) sessionRefreshRunningRef.current.delete(projectId);
      if (ownsForegroundLoading) {
        delete sessionLoadingRequestByProjectRef.current[projectId];
        setSessionLoadingByProject((c) => ({ ...c, [projectId]: false }));
        // stale foreground 请求只负责结束自己创建的 spinner；ready/error 必须由
        // 成功应用数据的 authority 或当前失败请求写入，避免旧请求反向覆盖状态。
      }
      if (!isCurrentCompletion) {
        if (failed) completion.reject(error);
        else completion.resolve(result);
        return;
      }
      if (sessionRefreshPendingRef.current.delete(projectId)) {
        startProjectSessionRefresh(projectId, true, completion);
        return;
      }
      delete sessionRefreshCompletionByProjectRef.current[projectId];
      if (failed) completion.reject(error);
      else completion.resolve(result);
    }
  }

  function startProjectSessionRefresh(
    projectId: string,
    silent: boolean,
    completion: ProjectSessionRefreshCompletion,
  ) {
    void runProjectSessionRefresh(projectId, silent, completion).catch((unexpectedError) => {
      if (sessionRefreshCompletionByProjectRef.current[projectId] === completion) {
        sessionRefreshRunningRef.current.delete(projectId);
        sessionRefreshPendingRef.current.delete(projectId);
        delete sessionRefreshCompletionByProjectRef.current[projectId];
      }
      completion.reject(unexpectedError);
    });
  }

  // ── 后台扫描完成推送（2026-08 展开项目卡顿优化）──
  // 主进程后台扫描合并完成后推送 catalog-refreshed：以 scan:false 静默拉取合并结果，
  // 复用 request 序号防止过期响应覆盖更新数据；silent（无 loading 态、不打断用户操作）。
  useEffect(() => {
    if (!api.sessions.onCatalogRefreshed) return;
    const unsubscribe = api.sessions.onCatalogRefreshed(({ projectId }) => {
      const request = (sessionRequestByProjectRef.current[projectId] ?? 0) + 1;
      sessionRequestByProjectRef.current[projectId] = request;
      void api.sessions
        .listCatalog(projectId, { scan: false })
        .then((records) => {
          const latestAppliedRequest = sessionLatestAppliedRequestByProjectRef.current[projectId];
          if (latestAppliedRequest !== undefined && request < latestAppliedRequest) return;
          replaceProjectSessions({ projectId, sessions: records });
          sessionLatestAppliedRequestByProjectRef.current[projectId] = request;
          setSessionCatalogLoadState?.({ projectId, state: { status: "ready" } });
        })
        .catch((caughtError) => {
          // 没有任何成功数据时，当前后台刷新负责结束 loading/error 状态；
          // 不弹 toast，下一次轮询/推送仍可纠正。
          if (
            sessionRequestByProjectRef.current[projectId] !== request ||
            sessionLatestAppliedRequestByProjectRef.current[projectId] !== undefined
          ) return;
          const message = caughtError instanceof Error ? caughtError.message : String(caughtError);
          setSessionCatalogLoadState?.({
            projectId,
            state: { status: "error", error: message },
          });
        });
    });
    return unsubscribe;
    // replaceProjectSessions/api 由 App 以稳定引用提供（useCallback/useMemo），依赖安全
  }, [api, replaceProjectSessions]);

  function refreshProjectSessions(projectId: string, silent = false): ProjectSessionRefreshPromise {
    const current = sessionRefreshCompletionByProjectRef.current[projectId];
    if (current) {
      sessionRefreshPendingRef.current.add(projectId);
      return current.promise;
    }
    const completion = createProjectSessionRefreshCompletion();
    sessionRefreshCompletionByProjectRef.current[projectId] = completion;
    startProjectSessionRefresh(projectId, silent, completion);
    return completion.promise;
  }

  async function refreshProjectTree(project: Project) {
    await refreshProjectSessions(project.id);
    if (project.worktreeEnabled) {
      await refreshWorktrees(project.id);
      const latestProjects = await requestProjectInventory(api.projects.list);
      if (!latestProjects) return;
      setProjects(latestProjects);
      const childProjects = latestProjects.filter((p) => p.worktreeParentId === project.id);
      await Promise.all(childProjects.map((child) => refreshProjectSessions(child.id).catch(() => undefined)));
    }
    showToast(t("app.projectRefreshed", {}), 1800);
  }

  async function refreshFiles(projectId = activeProjectId, silent = false) {
    // 文件树只表示当前项目。旧项目的复制/移动回调可能在切换后才到达；
    // 必须在递增 generation 前拒绝，否则它会误取消新项目正在进行的加载。
    if (!projectId || activeProjectIdRef.current !== projectId) return;
    const request = fileRequestRef.current + 1;
    fileRequestRef.current = request;
    const next = await api.files.list(projectId);
    if (
      fileRequestRef.current !== request ||
      activeProjectIdRef.current !== projectId
    ) return;
    setProjectFiles({ projectId, files: next });
    if (!silent) showToast(t("app.filesRefreshed", {}), 1800);
  }

  async function refreshGitInfo(projectId = activeProjectId) {
    if (!projectId || activeProjectIdRef.current !== projectId) return;
    const request = gitInfoRequestRef.current + 1;
    gitInfoRequestRef.current = request;
    let next: GitBranchInfo;
    try {
      next = await api.git.branches(projectId);
    } catch (error) {
      // 只允许当前项目的最新失败清空状态；旧项目失败不能抹掉新项目结果。
      if (
        gitInfoRequestRef.current === request &&
        activeProjectIdRef.current === projectId
      ) {
        setGitInfo({ current: null, branches: [] });
        setBranchByProject((current) => ({ ...current, [projectId]: null }));
      }
      throw error;
    }
    if (
      gitInfoRequestRef.current !== request ||
      activeProjectIdRef.current !== projectId
    ) return;
    setGitInfo((current) =>
      current.current === next.current &&
      current.branches.join("\n") === next.branches.join("\n")
        ? current
        : next,
    );
    setBranchByProject((current) => ({ ...current, [projectId]: next.current }));
  }

  function setProjectBranch(projectId: string, branch: string | null) {
    setBranchByProject((current) => ({ ...current, [projectId]: branch }));
  }

  useEffect(() => {
    // 项目身份变化时先让旧树退出屏幕，再加载新项目。两个请求共用各自的
    // request generation；即使旧 IPC 无法取消，迟到结果也不能回写当前项目。
    fileRequestRef.current += 1;
    gitInfoRequestRef.current += 1;
    setProjectFiles({ projectId: activeProjectId, files: EMPTY_FILE_TREE });
    setGitInfo({ current: null, branches: [] });
    if (!activeProjectId) return;
    void refreshFiles(activeProjectId, true).catch(() => undefined);
    void refreshGitInfo(activeProjectId).catch(() => undefined);
  }, [activeProjectId]);

  return { worktreesByProject, branchByProject, files, gitInfo, setGitInfo, setProjectBranch, sessionLoadingByProject, setSessionLoadingByProject, visibleProjectChildCountByProject, setVisibleProjectChildCountByProject, refreshProjects, refreshWorktrees, refreshSessions, refreshProjectSessions, refreshFiles, refreshGitInfo, refreshProjectTree };
}
