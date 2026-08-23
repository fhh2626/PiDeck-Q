import {
  createContext,
  useContext,
  useMemo,
  type MutableRefObject,
  type ReactNode,
  type RefObject,
} from "react";
import type { AgentTab, AgentUiResponse, ChatMessage, GitBranchInfo, ImageContent, Project, TerminalTarget } from "../../../../shared/types";
import type { QueuedPrompt } from "../../hooks/useQueuedPrompt";
import type { NoticeId } from "../../utils/notice";

/**
 * 会话栏共享服务：跨分屏双栏稳定不变的回调与资源。
 * 身份（sessionId / focused）不进这里，避免大 props 袋透传。
 *
 * 拆成两个 Context 缩小更新范围（2026-08 渲染性能优化）：
 * - SessionPaneActionsContext：行为与稳定资源（回调 / ref / api），更新频率低；
 * - SessionPaneStateContext：真正会变化的数据（terminal / gitInfo / agents / ...），更新频率高。
 * 只读 actions 的高频组件（Composer / pickers）不再被 terminal height、gitInfo、
 * environmentDialog 等 state 变化唤醒——这是拆分的意义所在。
 *
 * 不一次拆成十几个 Context（避免过度设计），只拆 actions/state 两轨。
 */

/** 行为与稳定资源：跨分屏双栏共享、引用尽量稳定的回调 / ref / api。 */
export type SessionPaneActions = {
  /** 把某会话从预览 Tab 晋升为常驻 Tab（发消息等主动交互时调用；非预览时幂等） */
  promoteSessionToPermanent: (sessionId: string) => void;
  showToast: (msg: string, dur?: number) => void;
  onOpenFile: (path: string) => void;
  onDiffFile: (path: string) => void;
  onPreviewImage: (img: ImageContent | null) => void;
  abortAgent: (agentId?: string) => Promise<void>;
  restartActiveAgent: (agentId?: string) => Promise<void>;
  runCreateSessionDraft: () => Promise<void>;
  enqueueSessionPrompt: (
    sessionId: string,
    snapshot: {
      displayText: string;
      message: string;
      images?: ImageContent[];
      agentMode: string;
      behavior?: "steer" | "followUp";
    },
  ) => boolean;
  insertQuickPrompt: (sessionId: string, message: string) => void;
  ensureSessionId?: (sessionId: string) => Promise<string>;
  resendUserMessage?: (message: ChatMessage) => void;
  editMessage?: (messageId: string, newText: string) => void;
  deleteMessage?: (messageId: string) => void;
  forkFromUserMessage?: (message: ChatMessage) => void;
  openSidebarSessionById?: (projectId: string, sessionId: string) => Promise<void>;
  queueRetract: (sessionId: string, prompt: QueuedPrompt) => void;
  queueDiscard: (sessionId: string, promptId: string) => void;
  queueFlushBySessionRef: MutableRefObject<Set<string>>;
  setTerminalOpenForOwner: (open: boolean) => void;
  setTerminalCollapsedForOwner: (collapsed: boolean) => void;
  setTerminalHeightByOwner: (
    updater: (cur: Record<string, number>) => Record<string, number>,
  ) => void;
  /** 修改内置对话区（Chat）的聊天记录保存目录（弹选择器 + 主进程写入 + 重扫会话） */
  changeChatPath: (project: Project) => Promise<void>;
  showNotice: (
    msg: string,
    dur?: number,
    kind?: "info" | "warning" | "error",
  ) => NoticeId | undefined;
  api: {
    sessions: {
      sendUiResponse: (input: {
        sessionId: string;
        requestId: string;
        agentId: string;
        runtimeGeneration: number;
        response: AgentUiResponse;
      }) => Promise<void>;
    };
  };
  jumpToMessageRef: MutableRefObject<((messageId: string) => void) | null>;
  /** 面板级退出分屏（全屏按钮）：该会话从布局移除，同组兄弟合并占据其位置 */
  exitSessionSplit: (sessionId: string) => void;
};

/** 真正会变化的数据：terminal / gitInfo / agents 等，更新频率高。 */
export type SessionPaneState = {
  isLanWeb: boolean;
  forkingMessageId?: string | null;
  agents: AgentTab[];
  queuedPromptsBySession: Record<string, QueuedPrompt[]>;
  restartingAgentId: string | null;
  sessionDurationByAgent: Record<string, number>;
  activeProjectId: string | undefined;
  gitInfo: GitBranchInfo;
  showThinking: boolean;
  validCommandNames: Set<string>;
  validFilePaths: Set<string>;
  terminalOpen: boolean;
  terminalDockClosing: boolean;
  terminalDockVisible: boolean;
  terminalCollapsed: boolean;
  availableTerminalHeight: number;
  /** 终端归属键（agent:<id> / project:<id>）：dock 实例与状态回写按它隔离 */
  terminalOwnerKey?: string;
  /** agent 或 project 终端目标（App 层按 owner 解析） */
  terminalTarget?: TerminalTarget;
  configOpen: boolean;
  environmentDialog: boolean;
  layoutRefs: {
    chatHeaderRef: RefObject<HTMLDivElement | null>;
    composerRef: RefObject<HTMLElement | null>;
    composerOffsetHeight: number;
    terminalRowHeight: number;
  };
};

/** 兼容既有代码：actions + state 的完整组合（等价于拆分前的单一对象）。 */
export type SessionPaneServices = SessionPaneActions & SessionPaneState;

const SessionPaneActionsContext = createContext<SessionPaneActions | null>(null);
const SessionPaneStateContext = createContext<SessionPaneState | null>(null);

export function SessionPaneServicesProvider(props: {
  value: SessionPaneServices;
  children: ReactNode;
}) {
  // 拆分后两轨各自 memo：actions 轨依赖稳定的回调/ref，state 轨依赖会变化的数据。
  // 只读 actions 的组件（Composer/pickers）在只有 state 变化时拿到同一个 actions
  // 引用，从而不被唤醒。App 侧已对 value 做 useMemo，这里再按子集 memo 一次，
  // 让「字段引用稳定但外层对象换了」的情况也能命中缓存。
  const actionsValue = useMemo<SessionPaneActions>(
    () => ({
      promoteSessionToPermanent: props.value.promoteSessionToPermanent,
      showToast: props.value.showToast,
      onOpenFile: props.value.onOpenFile,
      onDiffFile: props.value.onDiffFile,
      onPreviewImage: props.value.onPreviewImage,
      abortAgent: props.value.abortAgent,
      restartActiveAgent: props.value.restartActiveAgent,
      runCreateSessionDraft: props.value.runCreateSessionDraft,
      enqueueSessionPrompt: props.value.enqueueSessionPrompt,
      insertQuickPrompt: props.value.insertQuickPrompt,
      ensureSessionId: props.value.ensureSessionId,
      resendUserMessage: props.value.resendUserMessage,
      editMessage: props.value.editMessage,
      deleteMessage: props.value.deleteMessage,
      forkFromUserMessage: props.value.forkFromUserMessage,
      openSidebarSessionById: props.value.openSidebarSessionById,
      queueRetract: props.value.queueRetract,
      queueDiscard: props.value.queueDiscard,
      queueFlushBySessionRef: props.value.queueFlushBySessionRef,
      setTerminalOpenForOwner: props.value.setTerminalOpenForOwner,
      setTerminalCollapsedForOwner: props.value.setTerminalCollapsedForOwner,
      setTerminalHeightByOwner: props.value.setTerminalHeightByOwner,
      changeChatPath: props.value.changeChatPath,
      showNotice: props.value.showNotice,
      api: props.value.api,
      jumpToMessageRef: props.value.jumpToMessageRef,
      exitSessionSplit: props.value.exitSessionSplit,
    }),
    [
      props.value.promoteSessionToPermanent,
      props.value.showToast,
      props.value.onOpenFile,
      props.value.onDiffFile,
      props.value.onPreviewImage,
      props.value.abortAgent,
      props.value.restartActiveAgent,
      props.value.runCreateSessionDraft,
      props.value.enqueueSessionPrompt,
      props.value.insertQuickPrompt,
      props.value.ensureSessionId,
      props.value.resendUserMessage,
      props.value.editMessage,
      props.value.deleteMessage,
      props.value.forkFromUserMessage,
      props.value.openSidebarSessionById,
      props.value.queueRetract,
      props.value.queueDiscard,
      props.value.queueFlushBySessionRef,
      props.value.setTerminalOpenForOwner,
      props.value.setTerminalCollapsedForOwner,
      props.value.setTerminalHeightByOwner,
      props.value.changeChatPath,
      props.value.showNotice,
      props.value.api,
      props.value.jumpToMessageRef,
      props.value.exitSessionSplit,
    ],
  );

  const stateValue = useMemo<SessionPaneState>(
    () => ({
      isLanWeb: props.value.isLanWeb,
      forkingMessageId: props.value.forkingMessageId,
      agents: props.value.agents,
      queuedPromptsBySession: props.value.queuedPromptsBySession,
      restartingAgentId: props.value.restartingAgentId,
      sessionDurationByAgent: props.value.sessionDurationByAgent,
      activeProjectId: props.value.activeProjectId,
      gitInfo: props.value.gitInfo,
      showThinking: props.value.showThinking,
      validCommandNames: props.value.validCommandNames,
      validFilePaths: props.value.validFilePaths,
      terminalOpen: props.value.terminalOpen,
      terminalDockClosing: props.value.terminalDockClosing,
      terminalDockVisible: props.value.terminalDockVisible,
      terminalCollapsed: props.value.terminalCollapsed,
      availableTerminalHeight: props.value.availableTerminalHeight,
      terminalOwnerKey: props.value.terminalOwnerKey,
      terminalTarget: props.value.terminalTarget,
      configOpen: props.value.configOpen,
      environmentDialog: props.value.environmentDialog,
      layoutRefs: props.value.layoutRefs,
    }),
    [
      props.value.isLanWeb,
      props.value.forkingMessageId,
      props.value.agents,
      props.value.queuedPromptsBySession,
      props.value.restartingAgentId,
      props.value.sessionDurationByAgent,
      props.value.activeProjectId,
      props.value.gitInfo,
      props.value.showThinking,
      props.value.validCommandNames,
      props.value.validFilePaths,
      props.value.terminalOpen,
      props.value.terminalDockClosing,
      props.value.terminalDockVisible,
      props.value.terminalCollapsed,
      props.value.availableTerminalHeight,
      props.value.terminalOwnerKey,
      props.value.terminalTarget,
      props.value.configOpen,
      props.value.environmentDialog,
      props.value.layoutRefs,
    ],
  );

  return (
    <SessionPaneActionsContext.Provider value={actionsValue}>
      <SessionPaneStateContext.Provider value={stateValue}>
        {props.children}
      </SessionPaneStateContext.Provider>
    </SessionPaneActionsContext.Provider>
  );
}

export function useSessionPaneActions(): SessionPaneActions {
  const value = useContext(SessionPaneActionsContext);
  if (!value) {
    throw new Error("useSessionPaneActions must be used under SessionPaneServicesProvider");
  }
  return value;
}

export function useSessionPaneState(): SessionPaneState {
  const value = useContext(SessionPaneStateContext);
  if (!value) {
    throw new Error("useSessionPaneState must be used under SessionPaneServicesProvider");
  }
  return value;
}

/** 兼容既有调用点：组合两个 Context 返回完整服务对象。
 * 高频/重组件应改调 useSessionPaneActions() / useSessionPaneState() 之一，
 * 只订阅自己需要的轨，否则拆分收益打折。 */
export function useSessionPaneServices(): SessionPaneServices {
  return {
    ...useSessionPaneActions(),
    ...useSessionPaneState(),
  };
}
