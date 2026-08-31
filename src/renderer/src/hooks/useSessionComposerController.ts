import { useAtomValue, useSetAtom, useStore } from "jotai";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import type { NativeClipboardSnapshot } from "../../../shared/desktop/NativeHostTypes";
import type {
  FileTreeNode,
  ImageContent,
  PiCommand,
  SessionSummary,
} from "../../../shared/types";
import {
  sessionAttachmentsByIdAtom,
  sessionComposerModeByIdAtom,
  sessionDraftByIdAtom,
  sessionMessagesCacheAtom,
  sessionRecordByIdAtomFamily,
  sessionRuntimeBySessionIdAtomFamily,
  sessionRuntimeUiBySessionIdAtomFamily,
  sessionSendStateByIdAtom,
  sessionSummariesByProjectIdAtomFamily,
  setSessionAttachmentsAtom,
  setSessionComposerModeAtom,
  setSessionDraftAtom,
  setSessionSendStateAtom,
} from "../atoms";
import {
  getComposerEnterIntent,
  isComposingKeyboardEvent,
  parseArgumentHint,
  translateBuiltinPromptDescription,
  extractUserPrompts,
  mergePromptHistory,
  type PromptTemplateInfo,
} from "../composerBehavior";
import {
  buildCompletionSuggestionItems,
  fileNodeDragPayloadToRef,
  flattenFiles,
  mergeCommands,
  PI_FILE_NODE_DRAG_MIME,
  PI_FILE_PATH_DRAG_MIME,
  readFileNodeDragPayload,
} from "../components/app/AppUtils";
import { SESSION_TAB_DRAG_MIME } from "../utils/sessionSplitEdge";
import {
  formatFilePathRef,
  parseRichInputChips,
  unwrapFileChipPath,
  type ComposerChip,
} from "../components/session/composer/chips";
import {
  applyCompletion,
  canKeepCompletionAtCursor,
  canStartCompletion,
  updateCompletion,
  type CompletionChar,
  type CompletionSession,
} from "../components/session/composer/completion";
import type { ComposerCaretRequest } from "../components/session/composer/types";
import {
  getComposerCaretCoords,
  getComposerCaretOffset,
} from "../components/session/composer/caretCoords";
import { desktopApi, isNativeRuntime } from "../desktopApi";
import { t } from "../i18n";
import {
  COMPOSER_IMAGE_MAX_BYTES,
  ComposerImageError,
  dataUrlToFile,
  getClipboardImageFiles,
  getDroppedImageFiles,
  imageMimeTypeFromPath,
  isImageFilePath,
  processComposerImageFile,
} from "../utils/composerImages";
import { showNotice } from "../utils/notice";
import { htmlToPlainText } from "../utils/clipboard";
import { shouldRequestNativeClipboardSnapshot } from "../native/nativeClipboardPaste";
import {
  requireSessionCommand,
  toSessionRuntimeTarget,
} from "../utils/sessionCommands";
import { isUserFacingSessionStart } from "./useSessionTimelineController";
import { useSessionSend, type EnqueuePromptSnapshot } from "./useSessionSend";

/**
 * compact 错误友好文案：requireSessionCommand 的 message 是 i18n 通用失败，
 * pi 原错在 debugDetails。优先用 debugDetails 匹配 nothing-to-do / too-small。
 * 返回 null 表示「无需提示」：压缩被取消（自动压缩撞车 / 新消息打断挂起的
 * 请求）时 pi 已经或即将自动完成压缩，toast 只会让用户困惑——尤其取消响应
 * 可能延迟到用户正常对话后返回（compact RPC 最长挂起 120s），表现为
 * 「没点压缩却弹压缩提示」（2026-08 用户反馈）。
 */
function friendlyCompactError(error: unknown): string | null {
  const debugDetails =
    error && typeof error === "object" && "debugDetails" in error
      ? String((error as { debugDetails?: unknown }).debugDetails ?? "").trim()
      : "";
  const rawMessage = error instanceof Error ? error.message.trim() : String(error ?? "").trim();
  const raw = debugDetails || rawMessage;
  const detail = raw
    .replace(/^Error invoking remote method ['"][^'"]+['"]:\s*/i, "")
    .replace(/^Error:\s*/i, "")
    .trim();
  const lower = detail.toLowerCase();
  if (/nothing to compact|already compacted/i.test(lower)) return t("app.compactNothingToDo");
  if (/session too small|too small/i.test(lower)) return t("app.compactSessionTooSmall");
  // 压缩被取消：静默。自动压缩在进行/刚结束，或挂起请求被新消息打断——
  // 压缩要么由 pi 自动完成，要么本就不需要，无需打扰用户。
  if (/compaction cancelled|cancelled/i.test(lower)) return null;
  return detail
    ? t("app.compactFailedWithReason", { error: detail })
    : t("app.compactFailed");
}

export type ComposerPickerKind = "model" | "mode" | "thinking" | "template";

export type UseSessionComposerControllerOptions = {
  sessionId: string;
  onOpenFile?: (path: string) => void;
  ensureSessionId?: (sessionId: string) => Promise<string>;
  /** 用户主动发消息时回调（预览 Tab 晋升常驻）；来自 SessionPaneServices 装配。 */
  onPromoteSession?: (sessionId: string) => void;
  /** Passed through to useSessionSend.enqueue. */
  enqueue?: (sessionId: string, snapshot: EnqueuePromptSnapshot) => boolean;
};

export type ComposerDraftGuard = {
  sessionId: string;
  agentId?: string;
  runtimeGeneration: number;
  baselineDraft: string;
  version: number;
  pristine: boolean;
};

export function createComposerDraftGuard(input: {
  sessionId: string;
  agentId?: string;
  runtimeGeneration?: number;
  draft: string;
}): ComposerDraftGuard {
  return {
    sessionId: input.sessionId,
    agentId: input.agentId,
    runtimeGeneration: input.runtimeGeneration ?? 0,
    baselineDraft: input.draft,
    version: 0,
    pristine: input.draft.length === 0,
  };
}

export function markComposerDraftMutation(
  guard: ComposerDraftGuard,
): ComposerDraftGuard {
  return { ...guard, version: guard.version + 1, pristine: false };
}

export function canApplyRuntimeEditorText(
  guard: ComposerDraftGuard,
  input: {
    sessionId: string;
    agentId: string;
    runtimeGeneration: number;
    currentDraft: string;
  },
): boolean {
  return guard.sessionId === input.sessionId &&
    guard.agentId === input.agentId &&
    guard.runtimeGeneration === input.runtimeGeneration &&
    guard.pristine &&
    guard.baselineDraft === input.currentDraft;
}

export type LatestRequestToken = { key: string; sequence: number };

export function createLatestRequestGate() {
  let current = { key: "", sequence: 0 };
  return {
    begin(key: string): LatestRequestToken {
      current = { key, sequence: current.sequence + 1 };
      return current;
    },
    invalidate(key: string) {
      current = { key, sequence: current.sequence + 1 };
    },
    isCurrent(token: LatestRequestToken) {
      return token.key === current.key && token.sequence === current.sequence;
    },
  };
}

type SessionReferenceMessage = {
  role: string;
  content: string;
  timestamp: number;
};

export type SessionReferenceSelection = {
  selectedIndices: number[];
  entries: Array<{ index: number; message: SessionReferenceMessage }>;
};

export function createSessionReferenceSelection(
  selectedIndices: number[],
  selectedMessages: SessionReferenceMessage[],
): SessionReferenceSelection {
  const entries = selectedIndices
    .map((index, position) => ({ index, message: selectedMessages[position] }))
    .filter((entry): entry is { index: number; message: SessionReferenceMessage } =>
      Boolean(entry.message),
    );
  return { selectedIndices: entries.map((entry) => entry.index), entries };
}

export function selectedSessionReferenceMessages(
  selection: SessionReferenceSelection,
): SessionReferenceMessage[] {
  return [...selection.entries]
    .sort((left, right) => left.index - right.index)
    .map((entry) => entry.message);
}

function getBangMode(text: string): "none" | "bang" | "bang-bang" {
  if (text.startsWith("!!")) return "bang-bang";
  if (text.startsWith("!")) return "bang";
  return "none";
}

function composerImageNotice(error: unknown): string {
  if (error instanceof ComposerImageError) {
    if (error.code === "too-large") return t("app.imageTooLarge");
    if (error.code === "unsupported") return t("app.imageUnsupported");
  }
  return error instanceof Error ? error.message : String(error);
}

export function useSessionComposerController(
  options: UseSessionComposerControllerOptions,
) {
  const { sessionId, enqueue, ensureSessionId } = options;
  const store = useStore();
  const record = useAtomValue(sessionRecordByIdAtomFamily(sessionId));
  const runtime = useAtomValue(sessionRuntimeBySessionIdAtomFamily(sessionId));
  const runtimeUi = useAtomValue(sessionRuntimeUiBySessionIdAtomFamily(sessionId));
  const projectSessions = useAtomValue(
    sessionSummariesByProjectIdAtomFamily(record?.projectId ?? ""),
  );
  const drafts = useAtomValue(sessionDraftByIdAtom);
  const attachmentsBySession = useAtomValue(sessionAttachmentsByIdAtom);
  const modes = useAtomValue(sessionComposerModeByIdAtom);
  const sendStates = useAtomValue(sessionSendStateByIdAtom);
  const setDraftAtom = useSetAtom(setSessionDraftAtom);
  const setAttachmentsAtom = useSetAtom(setSessionAttachmentsAtom);
  const setModeAtom = useSetAtom(setSessionComposerModeAtom);
  const setSendStateAtom = useSetAtom(setSessionSendStateAtom);

  const draft = drafts[sessionId] ?? "";
  const attachments = attachmentsBySession[sessionId] ?? [];
  const mode = modes[sessionId] ?? "normal";
  const sendState = sendStates[sessionId] ?? { status: "idle" as const };
  const editorRef = useRef<HTMLDivElement | null>(null);
  // 程序化光标请求（带归属 forValue，见 composer/types.ts 的 ComposerCaretRequest）；
  // 编辑器只在内容同步到 forValue 的同一趟 layout pass 配对消费，过期请求会被丢弃。
  const caretRef = useRef<ComposerCaretRequest | null>(null);
  const liveDomDraftRef = useRef({ sessionId, value: draft });
  const draftGuardRef = useRef(createComposerDraftGuard({
    sessionId,
    agentId: runtime?.agentId,
    runtimeGeneration: runtime?.runtimeGeneration,
    draft,
  }));
  const templateRequestGateRef = useRef(createLatestRequestGate());
  const promptHistoryRef = useRef<Record<string, string[]>>({});
  /**
   * 当前会话可导航的输入历史 = 本次运行发送记录（promptHistoryRef，最新在前）
   * + 会话已有消息里的用户输入（从 sessionMessagesCacheAtom 懒读取，零订阅零重渲染）。
   * 未启动的 Agent 没有发送记录，但 timeline 加载会话时已把 disk 消息写入缓存，
   * 因此激活前后上下键历史行为一致（issue-139）。
   */
  const getPromptHistory = useCallback(() => {
    const runtimeHistory = promptHistoryRef.current[sessionId] ?? [];
    const sessionHistory = extractUserPrompts(
      store.get(sessionMessagesCacheAtom)[sessionId]?.messages ?? [],
    );
    return mergePromptHistory(runtimeHistory, sessionHistory);
  }, [sessionId, store]);
  const sendBehaviorCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastEditorTextEnvelopeRef = useRef("");
  const [cursor, setCursor] = useState(0);
  const [completion, setCompletion] = useState<CompletionSession | null>(null);
  const completionRef = useRef<CompletionSession | null>(null);
  const nextCompletionIdRef = useRef(1);
  const pendingTriggerRef = useRef<CompletionChar | null>(null);
  completionRef.current = completion;
  const [selectedSuggestionIndex, setSelectedSuggestionIndex] = useState(0);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [savedDraft, setSavedDraft] = useState("");
  const [busyDraftLocked, setBusyDraftLocked] = useState(false);
  const [sendBehaviorMenuOpen, setSendBehaviorMenuOpen] = useState(false);
  const [previewImage, setPreviewImage] = useState<ImageContent | null>(null);
  const [picker, setPicker] = useState<ComposerPickerKind | null>(null);
  const [commands, setCommands] = useState<PiCommand[]>([]);
  const [files, setFiles] = useState<FileTreeNode[]>([]);
  const templateKey = `${sessionId}:${record?.projectPath ?? ""}`;
  const [templateState, setTemplateState] = useState<{
    key: string;
    items: PromptTemplateInfo[];
  }>({ key: templateKey, items: [] });
  const templates = templateState.key === templateKey ? templateState.items : [];
  const [sendShortcut, setSendShortcut] = useState<
    "enter-send" | "ctrl-enter-send" | "shift-enter-send"
  >("enter-send");
  const [sessionReference, setSessionReference] = useState<SessionSummary | null>(null);
  const [sessionReferenceSelections, setSessionReferenceSelections] = useState<
    Record<string, SessionReferenceSelection>
  >({});

  const clearCompletion = useCallback(() => {
    pendingTriggerRef.current = null;
    completionRef.current = null;
    setCompletion(null);
  }, []);

  const dismissCompletion = useCallback(() => {
    pendingTriggerRef.current = null;
    const current = completionRef.current;
    const dismissed = current ? { ...current, dismissed: true } : null;
    completionRef.current = dismissed;
    setCompletion(dismissed);
  }, []);

  const markDraftMutation = useCallback((targetSessionId = sessionId) => {
    if (targetSessionId !== sessionId) return;
    draftGuardRef.current = markComposerDraftMutation(draftGuardRef.current);
  }, [sessionId]);

  const setDraft = useCallback((value: string | ((current: string) => string)) => {
    markDraftMutation();
    setDraftAtom({ sessionId, value });
  }, [markDraftMutation, sessionId, setDraftAtom]);

  const setAttachments = useCallback((
    value: ImageContent[] | ((current: ImageContent[]) => ImageContent[]),
  ) => {
    setAttachmentsAtom({ sessionId, value });
  }, [sessionId, setAttachmentsAtom]);

  const setMode = useCallback((nextMode: "normal" | "plan") => {
    setModeAtom({ sessionId, mode: nextMode });
  }, [sessionId, setModeAtom]);

  const loadTemplates = useCallback(async () => {
    const token = templateRequestGateRef.current.begin(templateKey);
    const next: PromptTemplateInfo[] = [];
    try {
      const globalResult = await desktopApi.prompts.list();
      next.push(...globalResult.templates.map((template) => ({
        ...template,
        description: translateBuiltinPromptDescription(template),
        argumentHint: parseArgumentHint(template.content),
      })));
    } catch {
      // Project templates remain usable when the global store is unavailable.
    }
    if (record?.projectPath) {
      try {
        const projectResult = await desktopApi.prompts.listByProject(record.projectPath);
        next.push(...projectResult.templates.map((template) => ({
          ...template,
          argumentHint: parseArgumentHint(template.content),
        })));
      } catch {
        // A project does not have to provide .pi/prompts.
      }
    }
    if (templateRequestGateRef.current.isCurrent(token)) {
      setTemplateState({ key: templateKey, items: next });
    }
    return next;
  }, [record?.projectPath, sessionId, templateKey]);

  useEffect(() => {
    liveDomDraftRef.current = { sessionId, value: draft };
    setCursor(draft.length);
    clearCompletion();
    setSelectedSuggestionIndex(0);
    setHistoryIndex(-1);
    setSavedDraft("");
    setBusyDraftLocked(false);
    setSendBehaviorMenuOpen(false);
    // 注意：这里不再写 caretRef。该写入发生在编辑器 layout effect 之后、且 layout
    // effect 只在 value 变化时重跑，会留下一条过期待消费光标——首次输入（打字/
    // 粘贴/语音）时把选区重置回 0。恢复光标到文末由编辑器在内容同步（setContent）
    // 时兜底完成，见 useTipTapComposerEditor 同步 effect。
    draftGuardRef.current = createComposerDraftGuard({
      sessionId,
      agentId: runtime?.agentId,
      runtimeGeneration: runtime?.runtimeGeneration,
      draft,
    });
    lastEditorTextEnvelopeRef.current = "";
  }, [clearCompletion, sessionId]);

  useEffect(() => {
    const currentDraft = store.get(sessionDraftByIdAtom)[sessionId] ?? "";
    draftGuardRef.current = createComposerDraftGuard({
      sessionId,
      agentId: runtime?.agentId,
      runtimeGeneration: runtime?.runtimeGeneration,
      draft: currentDraft,
    });
    lastEditorTextEnvelopeRef.current = "";
  }, [runtime?.agentId, runtime?.runtimeGeneration, sessionId, store]);

  useEffect(() => {
    if (
      liveDomDraftRef.current.sessionId === sessionId &&
      liveDomDraftRef.current.value !== draft
    ) {
      // 外部 draft 写入（例如并行问询直接清空 atom）没有经过 onChange；
      // 同步时一并结束 completion，防止旧区间映射到新文本。
      clearCompletion();
      liveDomDraftRef.current = { sessionId, value: draft };
      setCursor(draft.length);
    }
  }, [clearCompletion, draft, sessionId]);

  useEffect(() => {
    const editorText = runtimeUi?.editorText;
    if (
      !runtime?.agentId ||
      !editorText ||
      runtimeUi.agentId !== runtime.agentId ||
      runtimeUi.runtimeGeneration !== runtime.runtimeGeneration
    ) {
      return;
    }
    const envelope = `${sessionId}:${runtime.runtimeGeneration}:${editorText.revision}`;
    if (lastEditorTextEnvelopeRef.current === envelope) return;
    lastEditorTextEnvelopeRef.current = envelope;
    const currentDraft = store.get(sessionDraftByIdAtom)[sessionId] ?? "";
    if (!canApplyRuntimeEditorText(draftGuardRef.current, {
      sessionId,
      agentId: runtime.agentId,
      runtimeGeneration: runtime.runtimeGeneration,
      currentDraft,
    })) {
      return;
    }
    clearCompletion();
    liveDomDraftRef.current = { sessionId, value: editorText.text };
    setDraft(editorText.text);
    setCursor(editorText.text.length);
    caretRef.current = { pos: editorText.text.length, forValue: editorText.text };
  }, [clearCompletion, runtime, runtimeUi, sessionId, setDraft, store]);

  useEffect(() => {
    void desktopApi.settings.get().then((settings) => {
      setSendShortcut(settings.sendShortcut);
    }).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!record?.projectId) {
      setFiles([]);
      return;
    }
    let current = true;
    void desktopApi.files.list(record.projectId).then((next) => {
      if (current) setFiles(next);
    }).catch(() => {
      if (current) setFiles([]);
    });
    return () => {
      current = false;
    };
  }, [record?.projectId]);

  useEffect(() => {
    const target = toSessionRuntimeTarget(sessionId, runtime);
    if (!target) {
      setCommands([]);
      return;
    }
    let current = true;
    void desktopApi.sessions.listRuntimeCommands(target).then((result) => {
      if (current) setCommands(requireSessionCommand(result).value);
    }).catch(() => {
      if (current) setCommands([]);
    });
    return () => {
      current = false;
    };
  }, [runtime?.agentId, runtime?.runtimeGeneration, sessionId]);

  useEffect(() => {
    templateRequestGateRef.current.invalidate(templateKey);
    setTemplateState({ key: templateKey, items: [] });
    void loadTemplates();
  }, [loadTemplates, templateKey]);

  useEffect(() => () => {
    if (sendBehaviorCloseTimerRef.current) {
      clearTimeout(sendBehaviorCloseTimerRef.current);
    }
  }, []);

  const flatFiles = useMemo(() => flattenFiles(files), [files]);
  const mergedCommands = useMemo(() => mergeCommands(commands), [commands]);
  const validCommandNames = useMemo(() => new Set([
    ...mergedCommands.map((command) => command.name),
    ...templates.map((template) => template.name),
  ]), [mergedCommands, templates]);
  const validFilePaths = useMemo(
    () => new Set(flatFiles.map((file) => file.relativePath)),
    [flatFiles],
  );
  const validSessionRefs = useMemo(
    () => new Set(projectSessions.map((session) => session.name ?? session.filePath)),
    [projectSessions],
  );
  const suggestionItems = useMemo(() => {
    if (!completion || completion.dismissed) return [];
    return buildCompletionSuggestionItems(
      completion,
      commands,
      flatFiles,
      projectSessions,
    );
  }, [commands, completion, flatFiles, projectSessions]);
  const suggestionsOpen = Boolean(
    completion && !completion.dismissed && suggestionItems.length > 0,
  );

  useEffect(() => {
    setSelectedSuggestionIndex(0);
  }, [completion?.id, completion?.query]);
  const suggestionAnchorStyle = useMemo<CSSProperties | undefined>(() => {
    if (!suggestionsOpen) return undefined;
    const menuWidth = Math.min(520, window.innerWidth - 120);
    const menuHeight = 380;
    const gap = 8;
    // 兜底定位（原 CSS .command-palette 的「默认居中 + 底部 160px」语义收进 JS）：
    // 拿不到编辑器/光标坐标时，面板仍然有确定位置，CSS 不再承载任何定位假设。
    const fallback: CSSProperties = {
      top: "auto",
      bottom: 160,
      left: Math.max(16, (window.innerWidth - menuWidth) / 2),
    };
    const root = editorRef.current;
    if (!root) return fallback;
    const coordinates = getComposerCaretCoords(root, cursor);
    if (!coordinates) return fallback;
    let left = coordinates.left;
    if (left + menuWidth > window.innerWidth - 16) {
      left = Math.max(16, window.innerWidth - menuWidth - 16);
    }
    const below = coordinates.top + gap;
    if (below + menuHeight <= window.innerHeight - 16) {
      return { top: below, left, bottom: "auto" };
    }
    const above = coordinates.top - gap;
    if (above - menuHeight >= 0) {
      return {
        top: "auto",
        bottom: window.innerHeight - above,
        left,
      };
    }
    return { top: "auto", bottom: 16, left };
  }, [cursor, suggestionsOpen]);

  const isBusy = runtime?.status === "running" || Boolean(runtime?.state?.isStreaming);
  // 预热只创建进程，不能把编辑器 setEditable(false)：contenteditable 关掉会失焦，输入一半就断。
  const isStarting = isUserFacingSessionStart(sendState.status);
  const hasContent = Boolean(draft.trim() || attachments.length);

  const resetEphemeralUi = useCallback(() => {
    setHistoryIndex(-1);
    setSavedDraft("");
    clearCompletion();
    setSendBehaviorMenuOpen(false);
    setBusyDraftLocked(false);
    liveDomDraftRef.current = { sessionId, value: "" };
  }, [clearCompletion, sessionId]);

  const resolveSessionReferences = useCallback(async (message: string) => {
    let resolved = message;
    const sessionsByLongestName = [...projectSessions].sort(
      (left, right) =>
        (right.name ?? right.filePath).length - (left.name ?? left.filePath).length,
    );
    for (const referencedSession of sessionsByLongestName) {
      const sessionName = referencedSession.name ?? referencedSession.filePath;
      // Use the shared parser rather than a substring replacement: `cmd&name` and
      // URL/query text are ordinary prose, while only a boundary-valid &name is a
      // session reference. This also keeps case-insensitive completion behavior.
      const sessionChips = parseRichInputChips(
        resolved,
        undefined,
        undefined,
        new Set([sessionName]),
      ).filter((chip) => chip.kind === "session" && chip.label.toLowerCase() === sessionName.toLowerCase());
      if (sessionChips.length === 0) continue;

      const raw = `&${sessionName}`;
      const saved = sessionReferenceSelections[raw];
      const selectedMessages = saved
        ? selectedSessionReferenceMessages(saved)
        : await desktopApi.sessions.readReferenceMessages(referencedSession.id);
      const context = selectedMessages
        .map((item) => `[${item.role === "user" ? "User" : "Assistant"}]: ${item.content}`)
        .join("\n");
      const replacement = context
        ? `<referenced_session name="${sessionName}">\n${context}\n</referenced_session>`
        : "";
      // Replace from right to left so all parser offsets remain valid.
      for (const chip of [...sessionChips].sort((left, right) => right.start - left.start)) {
        resolved = resolved.slice(0, chip.start) + replacement + resolved.slice(chip.end);
      }
    }
    return resolved;
  }, [projectSessions, sessionReferenceSelections]);

  const send = useSessionSend({
    sessionId,
    sendPrompt: (input) => desktopApi.sessions.sendPrompt(input),
    ensureSessionId,
    templates,
    prepareMessage: resolveSessionReferences,
    onDraftMutation: markDraftMutation,
    compact: async (target, prompt) => {
      // /compact 与 chip 共用同一友好错误映射（nothing-to-do / too-small / 静默取消）
      try {
        requireSessionCommand(await desktopApi.sessions.compactRuntime(target, prompt));
      } catch (error) {
        // 压缩失败/被拒是一次性操作提示，限时展示即可；
        // cancelled（自动压缩撞车等）返回 null，静默不打扰（2026-08 用户反馈）。
        const message = friendlyCompactError(error);
        if (message) showNotice(message, 6000);
      }
    },
    resetComposerUi: resetEphemeralUi,
    recordPromptHistory: (targetSessionId, message) => {
      if (!message.trim() || message.startsWith("!")) return;
      const normalized = message.trim();
      const previous = promptHistoryRef.current[targetSessionId] ?? [];
      promptHistoryRef.current[targetSessionId] = [
        normalized,
        ...previous.filter((item) => item !== normalized),
      ].slice(0, 50);
    },
    showError: (message, duration) => showNotice(message, duration),
    showUnknown: () => showNotice(t("app.queuedUnknown"), 6000),
    enqueue,
  });

  // 统一发送入口：先晋升预览 Tab 再投递（幂等，非预览无副作用）。
  // 发送按钮 / 追问按钮 / Enter 键 / 无 Agent 时的 /compact 直发都会走这里，
  // 避免新增发送路径时漏掉 promote 导致预览 Tab 不常驻（曾因此回归）。
  const promoteAndSend = useCallback(
    (behavior?: "steer" | "followUp") => {
      options.onPromoteSession?.(sessionId);
      return send(behavior);
    },
    [options.onPromoteSession, send, sessionId],
  );

  const commitCompletion = useCallback((completionId: number, value: string) => {
    const active = completionRef.current;
    if (!active || active.id !== completionId || active.dismissed) return;

    const liveDraft = liveDomDraftRef.current.sessionId === sessionId
      ? liveDomDraftRef.current.value
      : draft;
    const result = applyCompletion(liveDraft, active, value);
    if (!result) {
      clearCompletion();
      return;
    }

    liveDomDraftRef.current = { sessionId, value: result.text };
    setDraft(result.text);
    setCursor(result.cursor);
    caretRef.current = { pos: result.cursor, forValue: result.text };
    clearCompletion();
    requestAnimationFrame(() => editorRef.current?.focus());
  }, [clearCompletion, draft, sessionId, setDraft]);

  const onTextInput = useCallback((text: string) => {
    if (text !== "@" && text !== "/" && text !== "&") return;
    // 先记录所有真实触发符；onChange 会优先尝试把它作为当前 @/路径或
    // &/会话 query 的一部分，再用边界判断决定是否开启新 session。这样
    // `@C:/foo/` 不会被截成 slash command，同时 `@C:/foo &name` 仍能
    // 在旧 path session 结束后开启新的会话补全。
    pendingTriggerRef.current = text;
  }, []);

  const onChange = useCallback((value: string, nextCursor: number) => {
    liveDomDraftRef.current = { sessionId, value };
    setDraft(value);
    setCursor(nextCursor);

    const triggerChar = pendingTriggerRef.current;
    pendingTriggerRef.current = null;
    const currentCompletion = completionRef.current;
    const continuedCompletion = triggerChar && currentCompletion && !currentCompletion.dismissed
      ? updateCompletion(currentCompletion, value, nextCursor, validSessionRefs)
      : null;
    const startsNewCompletion = triggerChar
      ? canStartCompletion(
          value,
          nextCursor - triggerChar.length,
          triggerChar,
          triggerChar === "&" ? validSessionRefs : undefined,
        )
      : false;
    const nextCompletion = continuedCompletion ?? (
      triggerChar && startsNewCompletion
        ? {
            id: nextCompletionIdRef.current++,
            char: triggerChar,
            start: nextCursor - triggerChar.length,
            end: nextCursor,
            query: "",
            dismissed: false,
          }
        : triggerChar
          ? null
          : updateCompletion(
              currentCompletion,
              value,
              nextCursor,
              validSessionRefs,
            )
    );
    completionRef.current = nextCompletion;
    setCompletion(nextCompletion);
    if (historyIndex >= 0) {
      const history = getPromptHistory();
      if (value !== history[historyIndex]) {
        setHistoryIndex(-1);
        setSavedDraft("");
      }
    }
  }, [getPromptHistory, historyIndex, sessionId, setDraft, validSessionRefs]);

  const onCursorChange = useCallback((nextCursor: number) => {
    setCursor(nextCursor);
    const current = completionRef.current;
    if (!current) return;
    const liveDraft = liveDomDraftRef.current.sessionId === sessionId
      ? liveDomDraftRef.current.value
      : draft;
    const canKeep =
      nextCursor === current.end ||
      canKeepCompletionAtCursor(current, liveDraft, nextCursor);
    const nextCompletion = canKeep ? current : null;
    if (!nextCompletion) pendingTriggerRef.current = null;
    completionRef.current = nextCompletion;
    setCompletion(nextCompletion);
  }, [draft, sessionId]);

  const onKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (completion && !completion.dismissed) {
      if (suggestionsOpen && event.key === "ArrowDown") {
        event.preventDefault();
        setSelectedSuggestionIndex((index) => Math.min(index + 1, suggestionItems.length - 1));
        return;
      }
      if (suggestionsOpen && event.key === "ArrowUp") {
        event.preventDefault();
        setSelectedSuggestionIndex((index) => Math.max(index - 1, 0));
        return;
      }
      if (suggestionsOpen && event.key === "Tab") {
        if (isComposingKeyboardEvent(event)) return;
        const selected = suggestionItems[
          Math.min(selectedSuggestionIndex, suggestionItems.length - 1)
        ];
        if (selected) {
          event.preventDefault();
          commitCompletion(completion.id, selected.value);
        }
        return;
      }
      // Enter 继续交给 composer 原有的发送/换行职责；只有 Tab 提交候选。
      if (event.key === "Escape") {
        event.preventDefault();
        dismissCompletion();
        return;
      }
    }

    const liveDraft = liveDomDraftRef.current.sessionId === sessionId
      ? liveDomDraftRef.current.value
      : draft;
    const liveCursor = editorRef.current
      ? getComposerCaretOffset(editorRef.current)
      : cursor;
    const firstLine = !liveDraft.slice(0, liveCursor).includes("\n");
    const lastLine = !liveDraft.slice(liveCursor).includes("\n");
    const history = getPromptHistory();

    if (event.key === "ArrowUp" && firstLine && history.length > 0) {
      event.preventDefault();
      clearCompletion();
      const nextIndex = historyIndex < 0
        ? 0
        : Math.min(historyIndex + 1, history.length - 1);
      if (historyIndex < 0) setSavedDraft(liveDraft);
      setHistoryIndex(nextIndex);
      liveDomDraftRef.current = { sessionId, value: history[nextIndex] };
      setDraft(history[nextIndex]);
      caretRef.current = { pos: history[nextIndex].length, forValue: history[nextIndex] };
      return;
    }
    if (event.key === "ArrowDown" && lastLine && historyIndex >= 0) {
      event.preventDefault();
      clearCompletion();
      const nextIndex = historyIndex - 1;
      const nextDraft = nextIndex >= 0 ? history[nextIndex] : savedDraft;
      setHistoryIndex(nextIndex);
      if (nextIndex < 0) setSavedDraft("");
      liveDomDraftRef.current = { sessionId, value: nextDraft };
      setDraft(nextDraft);
      caretRef.current = { pos: nextDraft.length, forValue: nextDraft };
      return;
    }
    if (event.key === "Escape" && historyIndex >= 0) {
      clearCompletion();
      liveDomDraftRef.current = { sessionId, value: savedDraft };
      setDraft(savedDraft);
      setHistoryIndex(-1);
      setSavedDraft("");
      return;
    }

    const intent = getComposerEnterIntent(event, sendShortcut);
    if (intent === "send") {
      event.preventDefault();
      // Enter 发送也晋升预览 Tab（promoteAndSend 内部统一处理）
      void promoteAndSend(isBusy ? "steer" : undefined);
    }
  }, [
    clearCompletion,
    commitCompletion,
    completion,
    dismissCompletion,
    draft,
    getPromptHistory,
    historyIndex,
    isBusy,
    promoteAndSend,
    savedDraft,
    selectedSuggestionIndex,
    sendShortcut,
    sessionId,
    setDraft,
    suggestionItems,
    suggestionsOpen,
  ]);

  const addImageFiles = useCallback(async (imageFiles: File[]): Promise<boolean> => {
    let addedAny = false;
    for (const file of imageFiles) {
      try {
        const image = await processComposerImageFile(file);
        setAttachments((current) => [...current, image]);
        addedAny = true;
      } catch (error) {
        showNotice(composerImageNotice(error), 3000);
      }
    }
    return addedAny;
  }, [setAttachments]);

  /**
   * 把已格式化的引用文本（@path、@"a b/" 等）插入输入框当前光标处。
   * 文件树拖拽、OS 文件拖入/粘贴、「加入对话引用」按钮共用同一插入规则：
   * 只引用路径，不上传内容；与前字符之间按需补空格。
   */
  const insertRefTexts = useCallback((refTexts: string[]) => {
    if (refTexts.length === 0) return;
    const liveDraft = liveDomDraftRef.current.sessionId === sessionId
      ? liveDomDraftRef.current.value
      : draft;
    const liveCursor = editorRef.current ? getComposerCaretOffset(editorRef.current) : cursor;
    const refText = refTexts.join(" ");
    const active = completionRef.current;
    // 明确文件来源可以收口一个仍在编辑中的 @ token；与候选提交一样只操作
    // 该 session 的固定区间，Esc dismiss 后则保留原文字并按普通引用插入。
    if (active && active.char === "@") {
      const replaced = applyCompletion(liveDraft, active, refText);
      if (replaced) {
        liveDomDraftRef.current = { sessionId, value: replaced.text };
        setDraft(replaced.text);
        setCursor(replaced.cursor);
        caretRef.current = { pos: replaced.cursor, forValue: replaced.text };
        clearCompletion();
        requestAnimationFrame(() => editorRef.current?.focus());
        return;
      }
    }
    clearCompletion();
    const previous = liveDraft[liveCursor - 1];
    const spacer = liveCursor > 0 && previous !== " " && previous !== "\n" ? " " : "";
    const next = liveDraft.slice(0, liveCursor) + spacer + refText + liveDraft.slice(liveCursor);
    const nextCursor = liveCursor + spacer.length + refText.length;
    liveDomDraftRef.current = { sessionId, value: next };
    setDraft(next);
    setCursor(nextCursor);
    caretRef.current = { pos: nextCursor, forValue: next };
    requestAnimationFrame(() => editorRef.current?.focus());
  }, [clearCompletion, cursor, draft, sessionId, setDraft]);

  /** 本地路径以 @path 引用插入（OS 文件拖入/粘贴/文件选择器共用）；含空格路径自动加引号 */
  const insertFilePathRefs = useCallback((paths: string[]) => {
    insertRefTexts(
      paths.map((path) =>
        formatFilePathRef(path, { isDirectory: /[\\/]$/.test(path) }),
      ),
    );
  }, [insertRefTexts]);

  /** Native 实时快照降级为文本时，按当前编辑器光标插入纯文本。 */
  const insertPlainText = useCallback((text: string) => {
    if (!text) return;
    // 这是普通文本来源，不允许残留的 DOM trigger 记录参与下一次变更。
    pendingTriggerRef.current = null;
    const liveDraft = liveDomDraftRef.current.sessionId === sessionId
      ? liveDomDraftRef.current.value
      : draft;
    const liveCursor = editorRef.current ? getComposerCaretOffset(editorRef.current) : cursor;
    const next = liveDraft.slice(0, liveCursor) + text + liveDraft.slice(liveCursor);
    const nextCursor = liveCursor + text.length;
    const nextCompletion = updateCompletion(
      completionRef.current,
      next,
      nextCursor,
      validSessionRefs,
    );
    completionRef.current = nextCompletion;
    liveDomDraftRef.current = { sessionId, value: next };
    setDraft(next);
    setCursor(nextCursor);
    setCompletion(nextCompletion);
    caretRef.current = { pos: nextCursor, forValue: next };
    requestAnimationFrame(() => editorRef.current?.focus());
  }, [cursor, draft, sessionId, setDraft, validSessionRefs]);

  /** 从 File 列表解析本地路径（Electron 32+ 必须走 webUtils，不能用已移除的 File.path） */
  const resolveLocalPathsFromFiles = useCallback((files: File[]) => {
    const getPath = desktopApi.files.getPathForFile;
    if (!getPath) return [];
    const paths: string[] = [];
    for (const file of files) {
      try {
        const path = getPath(file);
        if (path) paths.push(path);
      } catch {
        // 非本地文件或路径不可用时跳过
      }
    }
    return paths;
  }, []);

  /**
   * 剪贴板里的图片文件 → 附加为图片预览（对齐微信/QQ 粘贴习惯）。
   * 经 files.readBase64 读原文件（比剪贴板位图缩略图清晰），构造 File 走统一附件流程；
   * 任一文件读取失败或超出合成器大小上限（主进程 stat 预检拦截）时：
   * 先兜底剪贴板位图——截图工具/网页复制常同时写路径+位图，而路径文件可能已被删除
   * 或过大，位图仍在（否则粘贴会退化成无用的 @path 引用）；实在没有位图才整体回退
   * @path 引用，保证「复制图片」粘贴始终有可用结果。
   */
  const pasteClipboardImages = useCallback(async (
    paths: string[],
    dataTransfer: DataTransfer | null,
    fallbackImageFiles: File[] = [],
    liveImageDataUrl?: string,
    capabilityId?: string,
  ) => {
    try {
      const files: File[] = [];
      for (const path of paths) {
        const dataUrl = capabilityId
          ? await desktopApi.files.readBase64External(capabilityId, path, COMPOSER_IMAGE_MAX_BYTES)
          : await desktopApi.files.readBase64(path, COMPOSER_IMAGE_MAX_BYTES);
        if (!dataUrl) throw new Error(`Cannot read image: ${path}`);
        const fileName = path.split(/[\\/]/).pop() || path;
        files.push(dataUrlToFile(dataUrl, imageMimeTypeFromPath(path), fileName));
      }
      await addImageFiles(files);
    } catch {
      // 位图兜底：事件粘贴优先取 clipboardData 的 image 项；右键粘贴无事件，走 Electron 剪贴板位图
      const imageFiles = fallbackImageFiles.length > 0
        ? fallbackImageFiles
        : dataTransfer
          ? getClipboardImageFiles(dataTransfer)
          : [];
      if (imageFiles.length && await addImageFiles(imageFiles)) return;
      const imageDataUrl = liveImageDataUrl ?? desktopApi.clipboard.readImage();
      if (imageDataUrl && await addImageFiles([dataUrlToFile(imageDataUrl, "image/png", "clipboard-image.png")])) return;
      insertFilePathRefs(paths);
    }
  }, [addImageFiles, insertFilePathRefs]);

  const pasteNativeSnapshot = useCallback(async (options: {
    fallbackImageFiles?: File[];
    fallbackText?: string;
    fallbackHtml?: string;
  } = {}): Promise<boolean> => {
    const fallbackImageFiles = options.fallbackImageFiles ?? [];
    const fallbackText = options.fallbackText ?? "";
    const fallbackHtml = options.fallbackHtml ?? "";
    let snapshot: NativeClipboardSnapshot;
    try {
      snapshot = await desktopApi.clipboard.readNativeSnapshot();
    } catch (error) {
      // preventDefault already ran for a native file/image paste. If the live Qt
      // snapshot times out or the host is unavailable, preserve every synchronous
      // browser fallback in priority order instead of swallowing the clipboard.
      if (fallbackImageFiles.length > 0 && await addImageFiles(fallbackImageFiles)) return true;
      const text = fallbackText || (fallbackHtml ? htmlToPlainText(fallbackHtml) : "");
      if (text) {
        insertPlainText(text);
        return true;
      }
      throw error;
    }
    if (snapshot.filePaths.length > 0) {
      if (snapshot.filePaths.every(isImageFilePath)) {
        await pasteClipboardImages(
          snapshot.filePaths,
          null,
          fallbackImageFiles,
          snapshot.imageDataUrl,
          snapshot.externalFileCapabilityId,
        );
      } else {
        insertFilePathRefs(snapshot.filePaths);
      }
      return true;
    }
    if (fallbackImageFiles.length > 0 && await addImageFiles(fallbackImageFiles)) return true;
    if (snapshot.imageDataUrl && await addImageFiles([dataUrlToFile(snapshot.imageDataUrl, "image/png", "clipboard-image.png")])) return true;
    if (snapshot.hasImage) {
      // Do not silently fall through to URL/text metadata when Qt could not
      // encode the image (for example, because the native image budget was hit).
      showNotice(t("app.clipboardImageUnavailable"), 3000);
      return true;
    }
    const text = snapshot.text || (snapshot.html ? htmlToPlainText(snapshot.html) : "");
    if (text) {
      insertPlainText(text);
      return true;
    }
    return false;
  }, [addImageFiles, insertFilePathRefs, insertPlainText, pasteClipboardImages]);

  /**
   * 右键「粘贴」（无 ClipboardEvent）：native 实时读取 Qt 快照；Electron
   * 继续使用同步 clipboard API。
   * 优先级同 onPaste：文件路径 → 位图；纯文本返回 false，交给编辑器本地插入。
   */
  const pasteFromClipboard = useCallback(async (): Promise<boolean> => {
    if (isNativeRuntime) {
      try {
        return await pasteNativeSnapshot();
      } catch (error) {
        showNotice(error instanceof Error ? error.message : String(error), 3000);
        return false;
      }
    }
    const clipboardPaths = desktopApi.files.getClipboardPaths?.() ?? [];
    if (clipboardPaths.length > 0) {
      if (clipboardPaths.every(isImageFilePath)) {
        await pasteClipboardImages(
          clipboardPaths,
          null,
          [],
          undefined,
          desktopApi.files.getClipboardCapability?.() || undefined,
        );
      } else {
        insertFilePathRefs(clipboardPaths);
      }
      return true;
    }
    const imageDataUrl = desktopApi.clipboard.readImage();
    if (imageDataUrl) {
      await addImageFiles([dataUrlToFile(imageDataUrl, "image/png", "clipboard-image.png")]);
      return true;
    }
    return false;
  }, [addImageFiles, insertFilePathRefs, pasteClipboardImages, pasteNativeSnapshot]);

  /**
   * 粘贴：明确的系统文件来源以 @path 引用插入，位图/截图附加为图片。
   * 普通 text/plain 未处理、不 preventDefault，交给 TipTap 做纯文本粘贴。
   * preventDefault 必须在任何 await 之前同步调用，否则浏览器会先插入默认内容。
   *
   * 顺序说明：资源管理器复制图片文件时，剪贴板常同时带路径 + 缩略图；
   * 路径为受支持图片时优先附加预览，否则仍按路径引用处理，避免被误当成截图。
   */
  const onPaste = useCallback((event: React.ClipboardEvent<HTMLDivElement>) => {
    if (isNativeRuntime && shouldRequestNativeClipboardSnapshot(event.clipboardData)) {
      // Capture WebView-provided image files synchronously, then ask Qt for the
      // current OS snapshot. Never let the eventually-consistent SSE cache
      // override a newer paste event.
      const fallbackImageFiles = getClipboardImageFiles(event.clipboardData);
      const fallbackText = event.clipboardData.getData("text/plain");
      const fallbackHtml = event.clipboardData.getData("text/html");
      event.preventDefault();
      void pasteNativeSnapshot({ fallbackImageFiles, fallbackText, fallbackHtml }).catch((error) => {
        showNotice(error instanceof Error ? error.message : String(error), 3000);
      });
      return;
    }

    // 1) 资源管理器复制/剪切的文件：浏览器 ClipboardEvent 通常没有 kind=file，
    //    需通过 preload 同步读取 Electron clipboard（FileNameW / CF_HDROP 等）
    const clipboardPaths = isNativeRuntime
      ? []
      : desktopApi.files.getClipboardPaths?.() ?? [];
    if (clipboardPaths.length > 0) {
      event.preventDefault();
      // 复制的全是受支持图片 → 附加预览；混合/其他文件 → 维持 @path 引用
      if (clipboardPaths.every(isImageFilePath)) {
        void pasteClipboardImages(
          clipboardPaths,
          event.clipboardData,
          [],
          undefined,
          desktopApi.files.getClipboardCapability?.() || undefined,
        );
      } else {
        insertFilePathRefs(clipboardPaths);
      }
      return;
    }

    // 2) 兜底：剪贴板里若有 File 对象（部分场景），用 webUtils 解析路径
    const fileItems = Array.from(event.clipboardData.items).filter((item) => item.kind === "file");
    if (fileItems.length > 0) {
      const files = fileItems
        .map((item) => item.getAsFile())
        .filter((file): file is File => Boolean(file));
      const paths = resolveLocalPathsFromFiles(files);
      if (paths.length > 0) {
        event.preventDefault();
        // 与第 1 步同规则：全是图片 → 附加预览（失败位图兜底），混合 → @path
        if (paths.every(isImageFilePath)) {
          void pasteClipboardImages(paths, event.clipboardData);
        } else {
          insertFilePathRefs(paths);
        }
        return;
      }
    }

    // 3) 剪贴板位图（截图/微信QQ/网页复制图片）：必须优先于普通文本处理——
    //    这类复制常同时写位图 + text 槽（微信写图片缓存路径、网页写图片 URL），
    //    位图才是用户要的内容，不能把附带文本当作文件来源；
    //    文件路径场景已在前两步处理，这里只剩纯位图。
    const imageFiles = getClipboardImageFiles(event.clipboardData);
    if (imageFiles.length) {
      event.preventDefault();
      void addImageFiles(imageFiles);
      return;
    }

  }, [addImageFiles, insertFilePathRefs, pasteClipboardImages, pasteNativeSnapshot, resolveLocalPathsFromFiles]);

  /**
   * 拖拽：
   * 1) 文件树节点（含目录）→ 按节点信息生成 @ 引用；
   * 2) OS 本地文件/目录 → 以 @path 引用插入（含图片文件，不上传内容）；
   * 3) 仅当无法解析本地路径且类型为 image/* 时，才退回附加图片（极少见）。
   */
  const onDrop = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    const nodePayload = readFileNodeDragPayload(event.dataTransfer);
    if (nodePayload) {
      insertRefTexts([fileNodeDragPayloadToRef(nodePayload)]);
      return;
    }
    const files = Array.from(event.dataTransfer.files);
    if (files.length === 0) return;
    const paths = resolveLocalPathsFromFiles(files);
    if (paths.length > 0) {
      insertFilePathRefs(paths);
      return;
    }
    void addImageFiles(getDroppedImageFiles(event.dataTransfer));
  }, [addImageFiles, insertFilePathRefs, insertRefTexts, resolveLocalPathsFromFiles]);

  /** 「加入对话引用」按钮：系统选择器选中的文件/目录以 @path 插入 */
  const attachFile = useCallback(async () => {
    try {
      const paths = await desktopApi.dialog.pickFiles({ title: t("menu.attachFile") });
      insertFilePathRefs(paths);
    } catch {
      // 用户取消或出错时不作处理
    }
  }, [insertFilePathRefs]);

  const onChipClick = useCallback((chip: ComposerChip) => {
    if (chip.kind === "file") {
      // 引用可能带引号（@"path with space"），统一解包出真实路径
      const path = unwrapFileChipPath(chip.raw);
      if (options.onOpenFile) options.onOpenFile(path);
      else void desktopApi.files.open(path);
      return;
    }
    if (chip.kind === "session") {
      const selected = projectSessions.find(
        (session) => (session.name ?? session.filePath) === chip.label,
      );
      if (selected) setSessionReference(selected);
    }
  }, [options.onOpenFile, projectSessions]);

  useEffect(() => {
    if (!hasContent) {
      setBusyDraftLocked(false);
    } else if (isBusy) {
      setBusyDraftLocked(true);
    }
  }, [hasContent, isBusy, sessionId]);

  const keepSendBehaviorMenuOpen = useCallback(() => {
    if (sendBehaviorCloseTimerRef.current) {
      clearTimeout(sendBehaviorCloseTimerRef.current);
      sendBehaviorCloseTimerRef.current = null;
    }
    setSendBehaviorMenuOpen(true);
  }, []);

  const scheduleSendBehaviorMenuClose = useCallback(() => {
    if (sendBehaviorCloseTimerRef.current) {
      clearTimeout(sendBehaviorCloseTimerRef.current);
    }
    sendBehaviorCloseTimerRef.current = setTimeout(() => {
      setSendBehaviorMenuOpen(false);
      sendBehaviorCloseTimerRef.current = null;
    }, 160);
  }, []);

  const abort = useCallback(async () => {
    const target = toSessionRuntimeTarget(sessionId, runtime);
    if (!target) {
      // 运行时信息缺失（如 agent 尚未绑定）：停止无意义，但不应静默——
      // 提示用户当前会话没有可停止的 Agent，避免「点了停止没反应」的困惑。
      showNotice(t("sessionCommand.runtimeUnavailable"), 4000);
      return;
    }
    try {
      requireSessionCommand(await desktopApi.sessions.abortRuntime(target));
    } catch (error) {
      // abort 失败必须可见：之前这里直接 throw 变成未处理 rejection，
      // 用户点停止后毫无反馈、agent 继续运行，表现为「停止不了」。
      // 异常常驻提示，直到用户手动关闭。
      showNotice(error instanceof Error ? error.message : String(error), Number.POSITIVE_INFINITY);
    }
  }, [runtime?.agentId, runtime?.runtimeGeneration, sessionId]);

  const acknowledgeUnknownDelivery = useCallback(() => {
    setSendStateAtom({ sessionId, state: { status: "idle" } });
  }, [sessionId, setSendStateAtom]);

  const compact = useCallback(async () => {
    const target = toSessionRuntimeTarget(sessionId, runtime);
    if (!target) {
      // No Agent yet: write /compact to draft and send → starts Agent + compacts
      clearCompletion();
      setDraft("/compact");
      caretRef.current = { pos: "/compact".length, forValue: "/compact" };
      void promoteAndSend();
      return;
    }
    try {
      requireSessionCommand(await desktopApi.sessions.compactRuntime(target));
    } catch (error) {
      // 压缩失败/被拒是一次性操作提示，限时展示（同 /compact 路径语义）；
      // cancelled 返回 null 静默
      const message = friendlyCompactError(error);
      if (message) showNotice(message, 6000);
    }
  }, [clearCompletion, runtime?.agentId, runtime?.runtimeGeneration, sessionId, setDraft, promoteAndSend]);

  const openPicker = useCallback((kind: ComposerPickerKind) => {
    if (kind === "template") void loadTemplates();
    setPicker(kind);
  }, [loadTemplates]);

  const insertTemplate = useCallback((template: PromptTemplateInfo) => {
    const next = draft.trimEnd()
      ? `${draft.trimEnd()} /${template.name} `
      : `/${template.name} `;
    clearCompletion();
    liveDomDraftRef.current = { sessionId, value: next };
    setDraft(next);
    caretRef.current = { pos: next.length, forValue: next };
    setPicker(null);
    requestAnimationFrame(() => editorRef.current?.focus());
  }, [clearCompletion, draft, sessionId, setDraft]);

  return {
    sessionId,
    record,
    runtime,
    draft,
    attachments,
    mode,
    sendState,
    templates,
    picker,
    previewImage,
    sessionReference,
    sessionReferenceSelection: sessionReference
      ? sessionReferenceSelections[`&${sessionReference.name ?? sessionReference.filePath}`]
      : undefined,
    bangMode: getBangMode(draft),
    isBusy,
    isStarting,
    hasContent,
    busyDraftLocked,
    editor: {
      ref: editorRef,
      caretRef,
      cursor,
      validCommandNames,
      validFilePaths,
      validSessionRefs,
      onChange,
      onTextInput,
      onCursorChange,
      onKeyDown,
      onPaste,
      onPasteClipboard: pasteFromClipboard,
      onDrop,
      onNativeFileDrop: (paths: string[]) => insertFilePathRefs(paths),
      onDragOver: (event: React.DragEvent<HTMLDivElement>) => {
        // 会话 Tab / 侧栏分屏拖拽交给 SessionSplitStage（capture），composer 不抢落点
        if (event.dataTransfer.types.includes(SESSION_TAB_DRAG_MIME)) return;
        event.preventDefault();
        // 文件树拖拽的 effectAllowed 含 move（内部移动语义），拖入 composer 时
        // 显式声明 copy，避免光标显示为“移动”，实际行为是插入引用
        if (
          event.dataTransfer.types.includes(PI_FILE_NODE_DRAG_MIME) ||
          event.dataTransfer.types.includes(PI_FILE_PATH_DRAG_MIME)
        ) {
          event.dataTransfer.dropEffect = "copy";
        }
      },
      onFocus: undefined,
      onBlur: dismissCompletion,
      onChipClick,
      attachFile,
    },
    suggestions: {
      open: suggestionsOpen,
      completionId: completion?.id,
      items: suggestionItems,
      selectedIndex: selectedSuggestionIndex,
      anchorStyle: suggestionAnchorStyle,
      setSelectedIndex: setSelectedSuggestionIndex,
      close: dismissCompletion,
      pick: commitCompletion,
    },
    images: {
      preview: setPreviewImage,
      remove: (index: number) => setAttachments((current) => current.filter((_, item) => item !== index)),
      clear: () => setAttachments([]),
    },
    delivery: {
      // 发送/追问都算主动交互：先把预览 Tab 晋升常驻，再投递（幂等，非预览无副作用）
      send: () => {
        void promoteAndSend(isBusy ? "steer" : undefined);
      },
      followUp: () => {
        void promoteAndSend("followUp");
      },
      abort: () => void abort(),
      compact: () => void compact(),
      unknown: sendState.status === "unknown",
      unknownError: sendState.error,
      acknowledgeUnknown: acknowledgeUnknownDelivery,
      canSend: hasContent && !isStarting,
      sendBehaviorMenuOpen,
      toggleSendBehaviorMenu: () => setSendBehaviorMenuOpen((open) => !open),
      keepSendBehaviorMenuOpen,
      scheduleSendBehaviorMenuClose,
    },
    pickers: {
      open: openPicker,
      close: () => setPicker(null),
      setMode,
      insertTemplate,
    },
    modals: {
      closePreview: () => setPreviewImage(null),
      closeSessionReference: () => setSessionReference(null),
      confirmSessionReference: (
        sessionName: string,
        messages: Array<{ role: string; content: string; timestamp: number }>,
        selectedIndices: number[],
      ) => {
        setSessionReferenceSelections((current) => ({
          ...current,
          [`&${sessionName}`]: createSessionReferenceSelection(
            selectedIndices,
            messages,
          ),
        }));
        setSessionReference(null);
      },
    },
  };
}

export type SessionComposerController = ReturnType<typeof useSessionComposerController>;
