import { atom } from "jotai";
import { atomFamily, selectAtom } from "jotai/utils";
import type { ComposerAgentMode, ImageContent } from "../../../shared/types";
import type { ModelPending } from "../utils/modelPendingDisplay";
import type { ThinkingLevelPending } from "../utils/thinkingDisplay";
import { currentSessionIdAtom } from "./session-atoms";

export type SessionComposerMode = ComposerAgentMode;
export type { ModelPending };

export type SessionSendState = {
  status: "idle" | "activating" | "sending" | "error" | "unknown";
  requestId?: string;
  error?: string;
  /** Snapshot kept visible when the transport result cannot prove delivery. */
  unknownSnapshot?: {
    message: string;
    images?: ImageContent[];
  };
};

export const sessionDraftByIdAtom = atom<Record<string, string>>({});
export const sessionAttachmentsByIdAtom = atom<Record<string, ImageContent[]>>({});
export const sessionComposerModeByIdAtom = atom<Record<string, SessionComposerMode>>({});
export const sessionSendStateByIdAtom = atom<Record<string, SessionSendState>>({});

/**
 * 稳定默认值：每次返回同一引用，避免依赖它的 useMemo/useEffect 误触发。
 * （写成 `?? []` / `?? { status: "idle" }` 时每次读取都是新对象。）
 */
const EMPTY_ATTACHMENTS: ImageContent[] = [];
const IDLE_SEND_STATE: SessionSendState = { status: "idle" };

/**
 * 按 sessionId 订阅的只读视图。
 *
 * 分屏时同一份“按会话表”被多栏共享：直接订阅整张表会让 A 栏打字触发 B 栏 composer
 * 重渲染（违反「多实例必须按 session 订阅」）。selectAtom 只在本会话切片变化时才通知。
 * atomFamily 缓存不自动回收：会话移除时必须调 removeComposerSessionAtoms。
 */
export const sessionDraftAtomFamily = atomFamily((sessionId: string) =>
  selectAtom(sessionDraftByIdAtom, (map) => map[sessionId] ?? "", Object.is),
);
export const sessionAttachmentsAtomFamily = atomFamily((sessionId: string) =>
  selectAtom(sessionAttachmentsByIdAtom, (map) => map[sessionId] ?? EMPTY_ATTACHMENTS, Object.is),
);
export const sessionComposerModeAtomFamily = atomFamily((sessionId: string) =>
  selectAtom(
    sessionComposerModeByIdAtom,
    (map): SessionComposerMode => map[sessionId] ?? "normal",
    Object.is,
  ),
);
export const sessionSendStateAtomFamily = atomFamily((sessionId: string) =>
  selectAtom(sessionSendStateByIdAtom, (map) => map[sessionId] ?? IDLE_SEND_STATE, Object.is),
);
export const thinkingLevelPendingAtomFamily = atomFamily((sessionId: string) =>
  selectAtom(
    thinkingLevelPendingByIdAtom,
    (map): ThinkingLevelPending | undefined => map[sessionId],
    Object.is,
  ),
);
export const modelPendingAtomFamily = atomFamily((sessionId: string) =>
  selectAtom(modelPendingByIdAtom, (map) => map[sessionId], Object.is),
);

/**
 * 会话移除时清理各 atomFamily 缓存（与 removeSessionComposerStateAtom 内的表清理成对）。
 * jotai 的 atomFamily 不会自动回收，不清理会随会话数持续增长。
 */
export function removeComposerSessionAtoms(sessionId: string): void {
  sessionDraftAtomFamily.remove(sessionId);
  sessionAttachmentsAtomFamily.remove(sessionId);
  sessionComposerModeAtomFamily.remove(sessionId);
  sessionSendStateAtomFamily.remove(sessionId);
  thinkingLevelPendingAtomFamily.remove(sessionId);
  modelPendingAtomFamily.remove(sessionId);
}

/**
 * 流式生成中切换思考强度产生的「待生效」指示（issue #146，xhigh->max）。
 * 只在生成进行中设置；流式结束（没有进行中的生成）时由 ComposerArea 清除。
 */
export const thinkingLevelPendingByIdAtom = atom<
	Record<string, ThinkingLevelPending | undefined>
>({});

/**
 * 生成进行中切换模型：pi 不支持运行中 set_model，只写入会话记录；
 * 本轮结束后再套到 Agent。新加、不在启动快照里的模型不走这里，走重启确认。
 */
export const modelPendingByIdAtom = atom<Record<string, ModelPending | undefined>>({});

export const currentSessionDraftAtom = atom(
  (get) => {
    const sessionId = get(currentSessionIdAtom);
    return sessionId ? (get(sessionDraftByIdAtom)[sessionId] ?? "") : "";
  },
  (get, set, value: string | ((current: string) => string)) => {
    const sessionId = get(currentSessionIdAtom);
    if (!sessionId) return;
    set(setSessionDraftAtom, { sessionId, value });
  },
);

export const currentSessionAttachmentsAtom = atom(
  (get) => {
    const sessionId = get(currentSessionIdAtom);
    return sessionId ? (get(sessionAttachmentsByIdAtom)[sessionId] ?? EMPTY_ATTACHMENTS) : EMPTY_ATTACHMENTS;
  },
  (get, set, value: ImageContent[] | ((current: ImageContent[]) => ImageContent[])) => {
    const sessionId = get(currentSessionIdAtom);
    if (!sessionId) return;
    set(setSessionAttachmentsAtom, { sessionId, value });
  },
);

export const currentSessionComposerModeAtom = atom(
  (get) => {
    const sessionId = get(currentSessionIdAtom);
    return sessionId
      ? (get(sessionComposerModeByIdAtom)[sessionId] ?? "normal")
      : "normal";
  },
  (get, set, mode: SessionComposerMode) => {
    const sessionId = get(currentSessionIdAtom);
    if (!sessionId) return;
    set(setSessionComposerModeAtom, { sessionId, mode });
  },
);

export const currentSessionSendStateAtom = atom((get) => {
  const sessionId = get(currentSessionIdAtom);
  return sessionId
    ? (get(sessionSendStateByIdAtom)[sessionId] ?? IDLE_SEND_STATE)
    : IDLE_SEND_STATE;
});

export const setSessionDraftAtom = atom(
  null,
  (get, set, input: {
    sessionId: string;
    value: string | ((current: string) => string);
  }) => {
    const drafts = get(sessionDraftByIdAtom);
    const current = drafts[input.sessionId] ?? "";
    const nextValue = typeof input.value === "function"
      ? input.value(current)
      : input.value;
    const next = { ...drafts };
    if (nextValue) next[input.sessionId] = nextValue;
    else delete next[input.sessionId];
    set(sessionDraftByIdAtom, next);
  },
);

export const setSessionAttachmentsAtom = atom(
  null,
  (get, set, input: {
    sessionId: string;
    value: ImageContent[] | ((current: ImageContent[]) => ImageContent[]);
  }) => {
    const attachments = get(sessionAttachmentsByIdAtom);
    const current = attachments[input.sessionId] ?? [];
    const nextValue = typeof input.value === "function"
      ? input.value(current)
      : input.value;
    const next = { ...attachments };
    if (nextValue.length) next[input.sessionId] = nextValue;
    else delete next[input.sessionId];
    set(sessionAttachmentsByIdAtom, next);
  },
);

export const setSessionComposerModeAtom = atom(
  null,
  (get, set, input: { sessionId: string; mode: SessionComposerMode }) => {
    const modes = { ...get(sessionComposerModeByIdAtom) };
    if (input.mode === "normal") delete modes[input.sessionId];
    else modes[input.sessionId] = input.mode;
    set(sessionComposerModeByIdAtom, modes);
  },
);

export const setSessionSendStateAtom = atom(
  null,
  (get, set, input: { sessionId: string; state: SessionSendState }) => {
    const states = { ...get(sessionSendStateByIdAtom) };
    if (input.state.status === "idle") delete states[input.sessionId];
    else states[input.sessionId] = input.state;
    set(sessionSendStateByIdAtom, states);
  },
);

export const clearSessionComposerSnapshotAtom = atom(
  null,
  (get, set, input: {
    sessionId: string;
    draft: string;
    attachments: ImageContent[];
  }) => {
    const currentDraft = get(sessionDraftByIdAtom)[input.sessionId] ?? "";
    if (currentDraft === input.draft) {
      set(setSessionDraftAtom, { sessionId: input.sessionId, value: "" });
    }
    const currentAttachments = get(sessionAttachmentsByIdAtom)[input.sessionId] ?? [];
    if (
      currentAttachments.length === input.attachments.length &&
      currentAttachments.every((attachment, index) => attachment === input.attachments[index])
    ) {
      set(setSessionAttachmentsAtom, { sessionId: input.sessionId, value: [] });
    }
  },
);

/**
 * 把 renderer-only 虚拟会话（引导页空白输入框）的 composer 状态整体搬到真实
 * 会话：首次发送时才创建 Catalog 会话，发送后需在同一输入框继续——把草稿/附件/
 * 模式/发送态一起移动可避免切换 sessionId 导致重挂载丢内容。
 */
export const promoteSessionComposerStateAtom = atom(
  null,
  (get, set, input: { fromSessionId: string; toSessionId: string }) => {
    if (input.fromSessionId === input.toSessionId) return;
    const move = <T>(source: Record<string, T>) => {
      if (!(input.fromSessionId in source)) return source;
      const next = { ...source, [input.toSessionId]: source[input.fromSessionId] };
      delete next[input.fromSessionId];
      return next;
    };
    set(sessionDraftByIdAtom, move(get(sessionDraftByIdAtom)));
    set(sessionAttachmentsByIdAtom, move(get(sessionAttachmentsByIdAtom)));
    set(sessionComposerModeByIdAtom, move(get(sessionComposerModeByIdAtom)));
    set(sessionSendStateByIdAtom, move(get(sessionSendStateByIdAtom)));
  },
);

export const removeSessionComposerStateAtom = atom(null, (get, set, sessionId: string) => {
  // 按会话表与 atomFamily 缓存必须成对清理，否则 atomFamily 会随会话数持续增长。
  removeComposerSessionAtoms(sessionId);
  const drafts = { ...get(sessionDraftByIdAtom) };
  delete drafts[sessionId];
  set(sessionDraftByIdAtom, drafts);
  const attachments = { ...get(sessionAttachmentsByIdAtom) };
  delete attachments[sessionId];
  set(sessionAttachmentsByIdAtom, attachments);
  const modes = { ...get(sessionComposerModeByIdAtom) };
  delete modes[sessionId];
  set(sessionComposerModeByIdAtom, modes);
  const sendStates = { ...get(sessionSendStateByIdAtom) };
  delete sendStates[sessionId];
  set(sessionSendStateByIdAtom, sendStates);
  const thinkingPending = { ...get(thinkingLevelPendingByIdAtom) };
  delete thinkingPending[sessionId];
  set(thinkingLevelPendingByIdAtom, thinkingPending);
  const modelPending = { ...get(modelPendingByIdAtom) };
  delete modelPending[sessionId];
  set(modelPendingByIdAtom, modelPending);
});
