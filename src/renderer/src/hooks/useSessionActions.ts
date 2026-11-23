import type { MutableRefObject } from "react";
import type {
  CreateAnonymousSessionResult,
  Project,
  SessionRecord,
  SessionLaunchPreferences,
  SessionSummary,
} from "../../../shared/types";
import { isSameSessionPath } from "../agentListDisplay";
import { t } from "../i18n";
import { deleteSessionWithConfirmation } from "./deleteSessionWithConfirmation";
import type { ConfirmDialogConfig } from "../utils/confirmationQueue";

export type RefreshProjectSessions = (
  projectId: string,
  silent?: boolean,
) => Promise<SessionSummary[] | SessionRecord[] | undefined>;

export interface UseSessionActionsOptions {
  openSessionRequestRef: MutableRefObject<number>;
  creatingSessionDraftRef: MutableRefObject<Set<string>>;
  activeProjectId: string | undefined;
  sessionsProjectId: string | undefined;
  projects: Project[];
  setActiveProjectId: (value: React.SetStateAction<string | undefined>) => void;
  setCurrentSessionId: (value: React.SetStateAction<string | undefined>) => void;
  getSessionRecord: (sessionId: string) => SessionRecord | undefined;
  getProjectSessionRecords: (projectId: string) => SessionRecord[];
  upsertSession: (session: SessionRecord) => void;
  removeSessionState: (sessionId: string) => void;
  removeSessionComposerState: (sessionId: string) => void;
  refreshProjectSessions: RefreshProjectSessions;
  api: {
    sessions: {
      copyRecord: (sessionId: string) => Promise<{ cancelled?: boolean; targetSessionId?: string }>;
      exportRecordHtml: (sessionId: string) => Promise<{ path: string }>;
      deleteRecord: (sessionId: string, options?: import("../../../shared/types").SessionDeleteOptions) => Promise<import("../../../shared/types").SessionDeleteResult>;
      archiveRecord: (sessionId: string) => Promise<boolean>;
      unarchiveRecord: (archivedPath: string) => Promise<boolean>;
      listArchived: () => Promise<SessionSummary[]>;
      createDraft: (input: { projectId: string; title: string } & SessionLaunchPreferences) => Promise<SessionRecord>;
      createAnonymous: (input: { projectId: string; title: string } & SessionLaunchPreferences) => Promise<CreateAnonymousSessionResult>;
    };
  };
  showToast: (message: string, duration?: number) => void;
  showConfirm: (config: ConfirmDialogConfig) => void;
  clearConfirm: () => void;
}

/**
 * 会话选择与草稿创建。共享请求序号保证异步结果不会覆盖用户的后续导航。
 */
export function useSessionActions(options: UseSessionActionsOptions) {
  const {
    openSessionRequestRef,
    creatingSessionDraftRef,
    activeProjectId,
    sessionsProjectId,
    projects,
    setActiveProjectId,
    setCurrentSessionId,
    getSessionRecord,
    getProjectSessionRecords,
    upsertSession,
    removeSessionState,
    removeSessionComposerState,
    refreshProjectSessions,
    api,
    showToast,
    showConfirm,
    clearConfirm,
  } = options;

  function commitSessionSelection(
    projectId: string,
    sessionId: string | undefined,
    scrollToEnd: boolean,
  ) {
    setActiveProjectId(projectId);
    setCurrentSessionId(sessionId);
    void scrollToEnd;
  }

  function selectProject(projectId: string) {
    ++openSessionRequestRef.current;
    commitSessionSelection(projectId, undefined, false);
  }

  function selectSession(
    projectId: string,
    sessionId: string,
    scrollToEnd = true,
  ) {
    ++openSessionRequestRef.current;
    commitSessionSelection(projectId, sessionId, scrollToEnd);
  }

  async function copySession(
    sessionId: string,
    projectId = sessionsProjectId ?? activeProjectId,
  ) {
    if (!projectId) return;
    const result = await api.sessions.copyRecord(sessionId);
    if (result.cancelled) {
      showToast(t("app.sessionCopyCancelled"));
      return;
    }
    showToast(t("app.sessionCopied"));
    await refreshProjectSessions(projectId);
  }

  async function exportHistorySession(session: SessionSummary) {
    const result = await api.sessions.exportRecordHtml(session.id);
    showToast(t("app.exportedPath", { path: result.path }), 3500);
  }

  async function deleteHistorySession(session: SessionSummary) {
    const projectId = sessionsProjectId ?? activeProjectId;
    return deleteSessionWithConfirmation({
      sessionId: session.id, sessionTitle: session.name || session.id,
      deleteRecord: api.sessions.deleteRecord, showConfirm, clearConfirm,
      onSuccess: async () => {
        removeSessionState(session.id);
        removeSessionComposerState(session.id);
        // The history panel owns its final success notice and waits for this result.
        if (projectId) await refreshProjectSessions(projectId);
      },
      onError: (error) => showToast(error instanceof Error ? error.message : String(error), 4000),
    });
  }

  /** 归档历史会话：文件移入归档目录并从列表移除（可恢复，区别于删除） */
  async function archiveHistorySession(session: SessionSummary) {
    try {
      await api.sessions.archiveRecord(session.id);
      removeSessionState(session.id);
      removeSessionComposerState(session.id);
      showToast(t("app.sessionArchived"), 2200);
      const projectId = sessionsProjectId ?? activeProjectId;
      if (projectId) await refreshProjectSessions(projectId);
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), 4000);
    }
  }

  /** 恢复归档会话：文件移回原路径并重新入目录 */
  async function unarchiveHistorySession(archivedPath: string) {
    await api.sessions.unarchiveRecord(archivedPath);
    showToast(t("app.sessionRestored"), 2200);
    const projectId = sessionsProjectId ?? activeProjectId;
    if (projectId) await refreshProjectSessions(projectId);
  }

  /** 列出已归档会话（恢复管理 UI 用） */
  async function listArchivedSessions() {
    return api.sessions.listArchived();
  }

  // ── Sidebar session actions ──
  async function openSidebarSession(
    projectId: string,
    session: SessionSummary,
  ): Promise<string | undefined> {
    const requestSequence = ++openSessionRequestRef.current;
    const cachedRecord = getSessionRecord(session.id);
    let record: SessionRecord | undefined =
      cachedRecord?.projectId === projectId
        ? cachedRecord
        : getProjectSessionRecords(projectId).find(
            (candidate) =>
              candidate.filePath &&
              isSameSessionPath(
                candidate.filePath,
                session.filePath,
                candidate.environment,
              ),
          );
    if (!record) {
      try {
        await refreshProjectSessions(projectId, true);
        if (requestSequence !== openSessionRequestRef.current) return undefined;
        record = getProjectSessionRecords(projectId).find(
          (candidate) =>
            candidate.filePath &&
            isSameSessionPath(
              candidate.filePath,
              session.filePath,
              candidate.environment,
            ),
        );
      } catch (error) {
        if (requestSequence !== openSessionRequestRef.current) return undefined;
        showToast(error instanceof Error ? error.message : String(error), 4000);
        return undefined;
      }
    }
    if (!record || requestSequence !== openSessionRequestRef.current) return undefined;
    commitSessionSelection(projectId, record.id, true);
    return record.id;
  }

  async function openSidebarSessionById(
    projectId: string,
    sessionId: string,
  ): Promise<string | undefined> {
    const requestSequence = ++openSessionRequestRef.current;
    let record: SessionRecord | undefined = getSessionRecord(sessionId);
    if (!record || record.projectId !== projectId) {
      try {
        await refreshProjectSessions(projectId, true);
        if (requestSequence !== openSessionRequestRef.current) return undefined;
        record = getProjectSessionRecords(projectId).find(
          (candidate) => candidate.id === sessionId,
        );
      } catch (error) {
        if (requestSequence !== openSessionRequestRef.current) return undefined;
        showToast(error instanceof Error ? error.message : String(error), 4000);
        return undefined;
      }
    }
    if (!record || requestSequence !== openSessionRequestRef.current) return undefined;
    commitSessionSelection(projectId, record.id, true);
    return record.id;
  }

  async function copySidebarSession(projectId: string, session: SessionSummary) {
    await copySession(session.id, projectId);
  }

  async function exportSidebarSession(_projectId: string, session: SessionSummary) {
    const result = await api.sessions.exportRecordHtml(session.id);
    showToast(t("app.exportedPath", { path: result.path }), 3500);
  }

  async function createSessionDraft(
    projectId = activeProjectId,
    preferences: SessionLaunchPreferences = {},
  ): Promise<SessionRecord | undefined> {
    if (!projectId || creatingSessionDraftRef.current.has(projectId)) return undefined;
    const project = projects.find((item) => item.id === projectId);
    if (!project) return undefined;
    creatingSessionDraftRef.current.add(projectId);
    const requestSequence = ++openSessionRequestRef.current;
    try {
      const session = await api.sessions.createDraft({
        projectId,
        title: `${project.name} agent`,
        ...preferences,
      });
      upsertSession(session);
      // Keep the created record available without taking focus from newer navigation.
      if (requestSequence === openSessionRequestRef.current) {
        commitSessionSelection(projectId, session.id, true);
      }
      return session;
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), 4000);
      return undefined;
    } finally {
      creatingSessionDraftRef.current.delete(projectId);
    }
  }

  async function createAnonymousSession(
    projectId = activeProjectId,
    preferences: SessionLaunchPreferences = {},
  ): Promise<SessionRecord | undefined> {
    if (!projectId || creatingSessionDraftRef.current.has(projectId)) return undefined;
    const project = projects.find((item) => item.id === projectId);
    if (!project) return undefined;
    creatingSessionDraftRef.current.add(projectId);
    const requestSequence = ++openSessionRequestRef.current;
    try {
      const { session } = await api.sessions.createAnonymous({
        projectId,
        title: t("app.anonymousChatTitle", { name: project.name }),
        ...preferences,
      });
      upsertSession(session);
      // Keep the created record available without taking focus from newer navigation.
      if (requestSequence === openSessionRequestRef.current) {
        commitSessionSelection(projectId, session.id, true);
      }
      return session;
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), 4000);
      return undefined;
    } finally {
      creatingSessionDraftRef.current.delete(projectId);
    }
  }

  return {
    selectProject,
    selectSession,
    copySession,
    exportHistorySession,
    deleteHistorySession,
    archiveHistorySession,
    unarchiveHistorySession,
    listArchivedSessions,
    openSidebarSession,
    openSidebarSessionById,
    copySidebarSession,
    exportSidebarSession,
    createSessionDraft,
    createAnonymousSession,
  };
}
