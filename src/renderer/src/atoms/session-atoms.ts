import { atom } from "jotai";
import type { Getter, Setter } from "jotai";
import { atomFamily, selectAtom } from "jotai/utils";
import type {
  AgentRuntimeState,
	AgentStatus,
	AgentUiBatchQuestion,
	AgentUiRequest,
	ChatMessage,
	SessionMessagePage,
  SessionRecord,
  SessionRuntimeEvent,
  SessionRuntimeInfo,
} from "../../../shared/types";
import { messageFingerprint } from "../../../shared/messageFingerprint";
import { mergeAgentRuntimeState } from "../utils/agentRuntimeState";
import { sameProjectSessionList } from "../utils/sessionRecordIdentity";

/**
 * 渲染层会话消息缓存上限（LRU）。
 * 6 → 8（2026-12 会话切换闪屏修复）：4 个分屏常驻 + 3 个预览 + 1 个切换缓冲；
 * 切回被淘汰的会话要重新走磁盘读取，大会话（几十 MB）会先闪骨架屏/起始页，
 * 放宽到 8 在内存可接受范围内减少淘汰频次；
 * 淘汰的会话切回时走激活分页（尾部 3 轮）重新拉取，成本可控。
 */
export const SESSION_MESSAGE_CACHE_LIMIT = 8;

export type SessionRuntimeViewState = {
  agentId?: string;
  runtimeGeneration: number;
  status: AgentStatus | "detached";
  state?: AgentRuntimeState;
  updatedAt: number;
  projectId?: string;
  cwd?: string;
  title?: string;
  piSessionId?: string;
  sessionPath?: string;
  createdAt?: number;
  compactionCount?: number;
  noSession?: boolean;
};

/** per-session runtime 比较：updatedAt 不计入，避免同值 patch 只换时间戳就戳醒订阅者。 */
export function sameSessionRuntimeView(
  a: SessionRuntimeViewState | undefined,
  b: SessionRuntimeViewState | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.agentId === b.agentId &&
    a.runtimeGeneration === b.runtimeGeneration &&
    a.status === b.status &&
    a.state === b.state &&
    a.projectId === b.projectId &&
    a.cwd === b.cwd &&
    a.title === b.title &&
    a.piSessionId === b.piSessionId &&
    a.sessionPath === b.sessionPath &&
    a.createdAt === b.createdAt &&
    a.compactionCount === b.compactionCount &&
    a.noSession === b.noSession
  );
}

function sameSidebarRuntimeMap(
  prev: Record<string, { agentId?: string; status: string }>,
  next: Record<string, { agentId?: string; status: string }>,
): boolean {
  if (prev === next) return true;
  const prevKeys = Object.keys(prev);
  const nextKeys = Object.keys(next);
  if (prevKeys.length !== nextKeys.length) return false;
  for (const id of nextKeys) {
    const left = prev[id];
    const right = next[id];
    if (!left || left.agentId !== right.agentId || left.status !== right.status) return false;
  }
  return true;
}

/** Live 思考段（按稳定 id 索引，与 History msg-thinking-* 同一身份）。 */
export type StreamingThinkingEntry = {
  sessionId: string;
  text: string;
  startedAt: number;
  endedAt: number;
  streaming: boolean;
};

export type SessionLoadState = {
  status: "idle" | "loading" | "ready" | "error";
  error?: string;
};

export type SessionMessageCacheEntry = {
	messages: ChatMessage[];
	revision: number;
	source: "disk" | "runtime";
	updatedAt: number;
	agentId?: string;
	/** Present only for paged historical reads; runtime owns an authoritative full snapshot. */
	page?: Pick<SessionMessagePage, "total" | "nextBefore">;
	/** 激活显示窗口起点（runtime 数组下标空间，2026-08 激活分页）；>0 表示窗口前还有历史。 */
	windowStart?: number;
	/**
	 * 窗口段头部的系统摘要卡片数（全量 flush 时推导：本地长度 − (totalLength − windowStart)）。
	 * 增量合并时 upsertFrom 是 runtime 绝对下标，须 +cardCount 才等于本地下标（卡片占据本地头部）。
	 */
	cardCount?: number;
	/** 窗口首条消息的文件消息下标（2026-11）：窗口缺 entryId 时作为首次补历史的数值游标 */
	windowStartFilePos?: number;
	/**
	 * disk 历史前缀（仅 runtime 窗口会话）：prepend-only 轮次页，
	 * 与运行时窗口段的接缝按 meta.entryId/内容指纹去重；普通改写时旧前缀失效，
	 * 压缩改写由主进程显式 preserveHistory 后继续保留。
	 */
	history?: {
		messages: ChatMessage[];
		nextBefore: number | null;
		/** 下一页续页锚点（页最旧条目的 entryId，2026-11 缓存优先路径用） */
		nextBeforeEntryId?: string | null;
		/** 磁盘分页已确认到顶。slideOut 合成的 nextBefore=null 不算到顶。 */
		exhausted?: boolean;
		version?: string;
		/** 压缩刚完成时暂缓自动回底清理，避免用户看到的历史立即消失。 */
		sticky?: boolean;
	};
	/**
	 * mutation 刷新代际（2026-11）：编辑/删除成功后的历史重读用 per-session 序号
	 * 做乱序保护；每次 captureHistoryMutationRefresh 递增。普通 runtime flush
	 * 必须原样继承（见 cacheSessionMessagesAtom），否则刷新响应会被误判为陈旧。
	 */
	mutationSequence?: number;
};

export type SessionRuntimeUiRequestState = {
  request: AgentUiRequest;
  status: "pending" | "responding" | "completed" | "cancelled";
};

export type SessionRuntimeUiState = {
  agentId: string;
  runtimeGeneration: number;
  requests: Record<string, SessionRuntimeUiRequestState>;
  widgets: Record<string, string[]>;
  notification?: {
    requestId: string;
    message: string;
    notifyType?: "info" | "warning" | "error";
    revision: number;
  };
  editorText?: {
    requestId: string;
    text: string;
    revision: number;
  };
  revision: number;
};

export const sessionRecordsAtom = atom<Record<string, SessionRecord>>({});
/** IDs detached from an in-memory runtime; rejects late catalog refreshes for them. */
export const discardedTransientSessionIdsAtom = atom<Set<string>>(new Set<string>());
export const sessionIdsByProjectAtom = atom<Record<string, string[]>>({});
export const currentSessionIdAtom = atom<string | undefined>(undefined);
/** 会话 Tab 栏（浏览器式多 Tab）：按打开顺序排列的会话 id 列表。
 *  关闭 Tab 只从列表移除，不 kill Agent；再次打开同一会话时复用已绑定运行时。 */
export const sessionTabIdsAtom = atom<string[]>([]);
export const sessionRuntimeByIdAtom = atom<Record<string, SessionRuntimeViewState>>({});
export const sidebarRuntimeAtom = selectAtom(
  sessionRuntimeByIdAtom,
  (full) => {
    const slim: Record<string, { agentId?: string; status: string }> = {};
    for (const [id, rt] of Object.entries(full)) {
      slim[id] = { agentId: rt.agentId, status: rt.status ?? "detached" };
    }
    return slim;
  },
  sameSidebarRuntimeMap,
);
export const sessionRuntimeUiByIdAtom = atom<Record<string, SessionRuntimeUiState>>({});
/**
 * 会话级缓存命中率快照历史（仅存数值，最多 50 条）：
 * 用于展示「当前会话平均缓存命中率」，弥补只显示最新一次 assistant 命中率的不足。
 */
export const sessionCacheStatsAtom = atom<Record<string, { cacheHitHistory: number[] }>>({});
export const SESSION_CACHE_STATS_LIMIT = 50;
export const sessionMessagesCacheAtom = atom<Record<string, SessionMessageCacheEntry>>({});

/**
 * 单会话消息缓存条目（selectAtom 隔离）：其它会话的消息到达/分页/失效
 * 都整体重建 cache 对象，但本会话条目引用不变 → Object.is 相等 → 订阅者不重渲染。
 * 2026-10 性能修复：此前 controller 直接订全局缓存，分屏/多开时
 * 任一会话的流式消息或分页都会拖着重渲染所有分屏栏。
 */
export const sessionMessageCacheBySessionIdAtomFamily = atomFamily(
  (sessionId: string) =>
    selectAtom(sessionMessagesCacheAtom, (cache) => cache[sessionId], Object.is),
);


/**
 * 会话切换时的滚动位置锚点（per-session，切走保存、切回恢复）。
 * 只保存「非跟底」状态：用户正在查看历史时切走，回来时停留在原位置；
 * 在底部跟流切走的会话不存锚点，切回继续跟底。
 */
export type SessionScrollAnchor = {
	/** 锚点行 id（timeline 内 [data-message-id] 的值：可能是 run id 或消息 id） */
	messageId: string;
	/** 锚点行顶边相对视口顶部的偏移（px），恢复时按此对齐 */
	offsetTop: number;
	/** 切走时分页窗口大小（visibleCount），恢复历史窗口避免锚点被裁剪 */
	visibleCount: number;
	/** 保存时间戳，防止乱序事件用陈旧状态覆盖新状态 */
	savedAt: number;
};

export const sessionScrollAnchorByIdAtom = atom<Record<string, SessionScrollAnchor>>({});

/** 锚点内容比较：messageId/offsetTop/visibleCount 相同视为未变化（savedAt 不计入）。
 *  滚动节流写入时，内容不变则跳过——引用稳定，订阅者不会因无效写入重渲染。 */
export function sameSessionScrollAnchor(
	a: SessionScrollAnchor | undefined,
	b: SessionScrollAnchor | undefined,
): boolean {
	if (a === b) return true;
	if (!a || !b) return false;
	return (
		a.messageId === b.messageId &&
		a.offsetTop === b.offsetTop &&
		a.visibleCount === b.visibleCount
	);
}

/** 保存/清除某会话的滚动锚点。anchor 为 null 时清除（如回到底部或会话关闭）。
 *  内容未变化时不写（保持引用稳定，避免订阅者无谓重渲染）；savedAt 乱序保护防陈旧覆盖。 */
export const saveSessionScrollAnchorAtom = atom(
	null,
	(get, set, input: { sessionId: string; anchor: SessionScrollAnchor | null }) => {
		const { sessionId, anchor } = input;
		set(sessionScrollAnchorByIdAtom, (prevMap) => {
			if (anchor === null) {
				if (!(sessionId in prevMap)) return prevMap;
				const nextMap = { ...prevMap };
				delete nextMap[sessionId];
				return nextMap;
			}
			const prev = prevMap[sessionId];
			// 内容未变化：跳过写入（引用稳定，订阅者零重渲染）
			if (prev && sameSessionScrollAnchor(prev, anchor)) return prevMap;
			// 乱序写入保护：只有更新（时间戳更新）才覆盖，防止陈旧滚动事件覆盖新保存。
			if (prev && prev.savedAt > anchor.savedAt) return prevMap;
			return { ...prevMap, [sessionId]: anchor };
		});
	},
);
/**
 * 会话级独立流式正文（阶段1：学 Proma 独立存储）。
 * key: sessionId，value: { messageId, content, streaming }。
 * 流式期间 content 由 agents:text-stream 通道实时更新；
 * message_end 后由历史消息（sessionMessagesCacheAtom）接管，此处清空。
 */
export type StreamingTextState = {
  messageId: string;
  content: string;
  streaming: boolean;
};

export const streamingTextByIdAtom = atom<
	Record<string, StreamingTextState>
>({});
/**
 * Live 思考正文通道（镜像 text-stream）：key = msg-thinking-${assistantMessageId}。
 * ThinkingStep 叶子订阅；timeline 只订 liveThinkingIdBySessionAtom，避免 50ms 戳醒整树。
 */
export const streamingThinkingByIdAtom = atom<Record<string, StreamingThinkingEntry>>({});
/** 会话当前 live 思考段 id；仅 id 变化时通知 timeline 挂载点。 */
export const liveThinkingIdBySessionAtom = atom<Record<string, string>>({});

function sameStreamingThinkingEntry(
  a: StreamingThinkingEntry | undefined,
  b: StreamingThinkingEntry | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.sessionId === b.sessionId &&
    a.text === b.text &&
    a.startedAt === b.startedAt &&
    a.endedAt === b.endedAt &&
    a.streaming === b.streaming
  );
}

/** ThinkingStep 叶子按稳定 id 订阅，避免整表 tick 戳醒所有思考卡。
 *  jotai atomFamily 无自动 GC：释放数据条目时必须同步 .remove(id)，否则长跑泄漏。 */
export const streamingThinkingEntryByIdAtomFamily = atomFamily((thinkingId: string) =>
  selectAtom(
    streamingThinkingByIdAtom,
    (map) => map[thinkingId],
    sameStreamingThinkingEntry,
  ),
);

/** Timeline 只订本会话 live id，不订思考正文。 */
export const liveThinkingIdBySessionIdAtomFamily = atomFamily((sessionId: string) =>
  selectAtom(
    liveThinkingIdBySessionAtom,
    (map) => map[sessionId],
    Object.is,
  ),
);

/**
 * 本会话「是否存在活动正文流」（streamingTextByIdAtom 单槽 streaming 位）。
 * 输出稳定 boolean：流式期间 content 每 50ms 变化但 streaming 不变 → 引用不变 →
 * TurnRow 零额外重渲染；仅在流开始/结束时触发订阅者。
 * 用途：liveInterimId 要求活动流才挂 live——中间回复 message_end 后槽删（streaming=false）
 * 立即落回容器内 settled，消除「双失明消失窗口」（live 读空 + 容器内被跳过）。
 */
export const liveTextStreamingBySessionAtom = atomFamily((sessionId: string) =>
  selectAtom(
    streamingTextByIdAtom,
    (map) => map[sessionId]?.streaming === true,
    Object.is,
  ),
);

/**
 * 本会话当前流式正文绑定的 assistant messageId。
 * 流式期间同一条 assistant 消息的 messageId 保持稳定不变，零额外重渲染。
 */
export const liveTextStreamingMessageIdBySessionAtom = atomFamily((sessionId: string) =>
  selectAtom(
    streamingTextByIdAtom,
    (map) => (map[sessionId]?.streaming ? map[sessionId]?.messageId ?? "" : ""),
    Object.is,
  ),
);

/** 正文流条目同值比较：messageId、content 与 streaming 位都相等才算同值。 */
function sameStreamingTextEntry(
  a: StreamingTextState | undefined,
  b: StreamingTextState | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.messageId === b.messageId && a.content === b.content && a.streaming === b.streaming;
}

/**
 * 单会话正文流内容（selectAtom 隔离）：其它会话的 token 更新不触发本订阅者。
 * 2026-10 性能修复：此前 LiveAnswerBody 直接订全局 streamingTextByIdAtom，
 * 分屏/多开时任一会话的流式 token 会拖着重渲染所有会话的正文实例。
 */
export const streamingTextBySessionIdAtomFamily = atomFamily((sessionId: string) =>
  selectAtom(
    streamingTextByIdAtom,
    (map) => map[sessionId],
    sameStreamingTextEntry,
  ),
);

/** 与 streamingThinkingByIdAtom 条目成对释放，避免 atomFamily Map 无限增长。 */
function disposeStreamingThinkingFamily(thinkingId: string) {
  streamingThinkingEntryByIdAtomFamily.remove(thinkingId);
}

/**
 * 「新一轮开始」信号：composer 发送成功后 +1（sessionId 键）。
 * TurnRow 订阅本会话 tick：变化时非最新轮强制收起（设置② collapsePrevRunsOnNewTurn 开启时），
 * 含用户手动展开的轮次。tick 低频（每轮一次），跨会话订阅经 family selectAtom 隔离。
 */
export const newTurnCollapseTickByIdAtom = atom<Record<string, number>>({});

export const bumpNewTurnCollapseTickAtom = atom(null, (_get, set, sessionId: string) => {
  set(newTurnCollapseTickByIdAtom, (prev) => ({
    ...prev,
    [sessionId]: (prev[sessionId] ?? 0) + 1,
  }));
});

/** 单会话 tick 订阅（selectAtom 隔离：其它会话 bump 不触发本订阅者）。 */
export const newTurnCollapseTickBySessionIdAtomFamily = atomFamily((sessionId: string) =>
  selectAtom(
    newTurnCollapseTickByIdAtom,
    (map) => map[sessionId] ?? 0,
    Object.is,
  ),
);

export const sessionMessageLruAtom = atom<string[]>([]);
export const sessionMessageLoadStateAtom = atom<Record<string, SessionLoadState>>({});

/** 只订本会话 loadState，避免其它会话 loading/error 拖着重渲染时间线。 */
export const sessionMessageLoadStateBySessionIdAtomFamily = atomFamily(
  (sessionId: string) =>
    selectAtom(sessionMessageLoadStateAtom, (all) => all[sessionId], Object.is),
);
export const sessionCatalogLoadStateAtom = atom<Record<string, SessionLoadState>>({});

export const currentSessionAtom = atom((get) => {
  const sessionId = get(currentSessionIdAtom);
  return sessionId ? get(sessionRecordsAtom)[sessionId] : undefined;
});

export const currentSessionRuntimeAtom = atom((get) => {
  const sessionId = get(currentSessionIdAtom);
  return sessionId ? get(sessionRuntimeByIdAtom)[sessionId] : undefined;
});

export const currentSessionRuntimeUiAtom = atom((get) => {
  const sessionId = get(currentSessionIdAtom);
  return sessionId ? get(sessionRuntimeUiByIdAtom)[sessionId] : undefined;
});

export const currentSessionMessagesAtom = atom((get) => {
  const sessionId = get(currentSessionIdAtom);
  return sessionId
    ? (get(sessionMessagesCacheAtom)[sessionId]?.messages ?? [])
    : [];
});

export const replaceSessionRuntimesAtom = atom(
  null,
  (get, set, runtimes: SessionRuntimeInfo[]) => {
    const current = get(sessionRuntimeByIdAtom);
    const next = { ...current };
    for (const runtime of runtimes) {
      const existing = current[runtime.sessionId];
      if (existing && existing.runtimeGeneration > runtime.runtimeGeneration) continue;
      const bindingChanged = existing?.agentId !== runtime.agentId ||
        existing.runtimeGeneration !== runtime.runtimeGeneration;
      next[runtime.sessionId] = {
        ...(bindingChanged ? {} : existing),
        agentId: runtime.agentId,
        runtimeGeneration: runtime.runtimeGeneration,
        status: runtime.status,
        state: bindingChanged ? undefined : existing?.state,
        updatedAt: Date.now(),
        projectId: runtime.projectId,
        cwd: runtime.cwd,
        sessionPath: runtime.sessionPath,
        createdAt: runtime.createdAt,
        compactionCount: runtime.compactionCount,
        noSession: runtime.noSession,
      };
    }
    set(sessionRuntimeByIdAtom, next);
  },
);

export const replaceProjectSessionsAtom = atom(
  null,
  (get, set, input: { projectId: string; sessions: SessionRecord[] }) => {
    const discardedTransientIds = get(discardedTransientSessionIdsAtom);
    // A close can race a catalog scan that started before the runtime detached.
    // Do not let that stale response resurrect a no-session row in the sidebar.
    const sessions = input.sessions.filter((session) => (
      !session.noSession || !discardedTransientIds.has(session.id)
    ));
    const previousIds = get(sessionIdsByProjectAtom)[input.projectId] ?? [];
    // 轮询刷新绝大多数轮次内容未变；此时保持 atom 引用稳定，避免整棵侧栏重渲染。
    if (sameProjectSessionList(previousIds, get(sessionRecordsAtom), sessions)) return;
    const nextIds = sessions.map((session) => session.id);
    const nextIdSet = new Set(nextIds);
    const nextRecords = { ...get(sessionRecordsAtom) };
    for (const previousId of previousIds) {
      if (!nextIdSet.has(previousId)) delete nextRecords[previousId];
    }
    for (const session of sessions) nextRecords[session.id] = session;
    set(sessionRecordsAtom, nextRecords);
    set(sessionIdsByProjectAtom, {
      ...get(sessionIdsByProjectAtom),
      [input.projectId]: nextIds,
    });
  },
);

export const upsertSessionAtom = atom(null, (get, set, session: SessionRecord) => {
  if (session.noSession && get(discardedTransientSessionIdsAtom).has(session.id)) {
    const nextDiscarded = new Set(get(discardedTransientSessionIdsAtom));
    nextDiscarded.delete(session.id);
    set(discardedTransientSessionIdsAtom, nextDiscarded);
  }
  set(sessionRecordsAtom, {
    ...get(sessionRecordsAtom),
    [session.id]: session,
  });
  const projectIds = get(sessionIdsByProjectAtom)[session.projectId] ?? [];
  if (!projectIds.includes(session.id)) {
    set(sessionIdsByProjectAtom, {
      ...get(sessionIdsByProjectAtom),
      [session.projectId]: [session.id, ...projectIds],
    });
  }
});

export const setSessionCatalogLoadStateAtom = atom(
  null,
  (get, set, input: { projectId: string; state: SessionLoadState }) => {
    set(sessionCatalogLoadStateAtom, {
      ...get(sessionCatalogLoadStateAtom),
      [input.projectId]: input.state,
    });
  },
);

export const setSessionMessageLoadStateAtom = atom(
  null,
  (get, set, input: { sessionId: string; state: SessionLoadState }) => {
    set(sessionMessageLoadStateAtom, {
      ...get(sessionMessageLoadStateAtom),
      [input.sessionId]: input.state,
    });
  },
);

export const cacheSessionMessagesAtom = atom(
  null,
  (get, set, input: {
    sessionId: string;
		messages: ChatMessage[];
		source: "disk" | "runtime";
		expectedRevision?: number;
		agentId?: string;
		page?: Pick<SessionMessagePage, "total" | "nextBefore">;
		/** runtime 窗口协议字段（2026-08 激活分页） */
		windowStart?: number;
		/** 窗口段头部的系统摘要卡片数（全量 flush 推导，增量合并偏移用） */
		cardCount?: number;
		/** 窗口首条消息的文件消息下标（2026-11）：窗口缺 entryId 时作为首次补历史的数值游标 */
		windowStartFilePos?: number;
		history?: SessionMessageCacheEntry["history"];
		/** mutation 刷新代际：仅 replaceSessionHistoryAfterMutationAtom 落地路径写入新值 */
		mutationSequence?: number;
  }) => {
    const cache = get(sessionMessagesCacheAtom);
    const current = cache[input.sessionId];
    // Revision 守卫仅在「上一次与本次均为 disk 来源」时生效——
    // 防止慢一拍的历史分页响应覆盖后续新快照。
    //
    // 为什么不能把此守卫扩大到 runtime 来源：
    // - runtime 写会递增 revision，disk 写不递增 revision
    // - 匿名会话（无 filePath）runtime 消息只从 runtime 事件进 cache，disk 读取永远返回 []
    // - 切走→切回时 disk 空响应会因 revision 相等直接覆盖掉 runtime 已写入的消息，
    //   导致切回显示空引导页
    if (
      input.expectedRevision !== undefined &&
      input.source === "disk" &&
      current?.source === "disk" &&
      (current.revision ?? 0) !== input.expectedRevision
    ) {
      return false;
    }

    // runtime 窗口是当前会话的权威快照。磁盘首页只用于没有 runtime 的历史会话；
    // 即使磁盘返回更多消息，也不能把 runtime 来源改回 disk，否则后续增量 flush
    // 会因 source 不再是 runtime 而被丢弃，直到下一次终态全量快照才恢复。
    if (
      input.source === "disk" &&
      current?.source === "runtime"
    ) {
      return false;
    }
    const revision = input.source === "runtime"
      ? (current?.revision ?? 0) + 1
      : (current?.revision ?? 0);
    const nextCache = {
      ...cache,
      [input.sessionId]: {
			messages: input.messages,
			revision,
			source: input.source,
			updatedAt: Date.now(),
			...(input.agentId ? { agentId: input.agentId } : (current?.agentId ? { agentId: current.agentId } : {})),
			...(input.source === "disk" && input.page ? { page: input.page } : {}),
			// runtime 窗口语义（2026-08 激活分页）：entry 每次整体重建，
			// 调用方必须显式给出 windowStart/history（undefined = 清除，如版本失效丢前缀）；
			// disk 来源无窗口概念，两字段缺省即不存在
			...(input.source === "runtime" ? {
				windowStart: input.windowStart && input.windowStart > 0 ? input.windowStart : undefined,
				history: input.history,
				// mutation 代际：runtime flush 不改变它，只有显式传入（refresh 落地）才更新。
				// 缺省继承旧值，保证在途 refresh 不因无关 runtime 更新被误判为陈旧。
				mutationSequence: input.mutationSequence ?? current?.mutationSequence,
				// 卡片数只在全量 flush 推导（增量 flush 不携带 → 保留旧值，合并偏移依赖它）
				...(typeof input.cardCount === "number" ? { cardCount: input.cardCount } : {}),
				// 未显式提供时保留旧值（增量 flush 不携带该字段，不应清掉有效游标）
				...(typeof input.windowStartFilePos === "number"
					? { windowStartFilePos: input.windowStartFilePos }
					: {}),
			} : {}),
		},
    };
    const lru = [
      input.sessionId,
      ...get(sessionMessageLruAtom).filter((id) => id !== input.sessionId),
    ];
    const retainedIds = lru.slice(0, SESSION_MESSAGE_CACHE_LIMIT);
    for (const cachedSessionId of Object.keys(nextCache)) {
      if (!retainedIds.includes(cachedSessionId)) delete nextCache[cachedSessionId];
    }
    set(sessionMessagesCacheAtom, nextCache);
    set(sessionMessageLruAtom, retainedIds);
    return true;
  },
);

export const prependSessionMessagePageAtom = atom(
	null,
	(get, set, input: {
		sessionId: string;
		before: number;
		expectedRevision: number;
		page: SessionMessagePage;
	}) => {
		const current = get(sessionMessagesCacheAtom)[input.sessionId];
		if (
			!current ||
			current.source !== "disk" ||
			current.revision !== input.expectedRevision ||
			current.page?.nextBefore !== input.before
		) {
			return false;
		}
		set(sessionMessagesCacheAtom, {
			...get(sessionMessagesCacheAtom),
			[input.sessionId]: {
				...current,
				messages: [...input.page.messages, ...current.messages],
				page: { total: input.page.total, nextBefore: input.page.nextBefore },
				updatedAt: Date.now(),
			},
		});
		return true;
	},
);

export const touchSessionMessagesAtom = atom(null, (get, set, sessionId: string) => {
  if (!get(sessionMessagesCacheAtom)[sessionId]) return;
  set(sessionMessageLruAtom, [
    sessionId,
    ...get(sessionMessageLruAtom).filter((id) => id !== sessionId),
  ].slice(0, SESSION_MESSAGE_CACHE_LIMIT));
});

/** 历史前缀/窗口段的去重键：优先 pi entryId（跨下标空间稳定），缺省回退消息 id。 */
function messageEntryKey(message: ChatMessage): string {
  const entryId = message.meta?.entryId;
  return typeof entryId === "string" && entryId ? `e:${entryId}` : `m:${message.id}`;
}

function isSummaryCard(message: ChatMessage): boolean {
  return message.role === "system" &&
    (message.meta?.type === "compaction" || message.meta?.type === "branchSummary");
}

const COMPACTION_FINGERPRINT_TIME_TOLERANCE_MS = 5_000;

/** 返回旧消息中被新投影覆盖的下标；精确身份优先，指纹按队列一一消耗。 */
function findCoveredMessageIndexes(
  oldMessages: ChatMessage[],
  incomingMessages: ChatMessage[],
  fingerprintTailOnly: boolean,
  allowFingerprint = true,
): Set<number> {
  const covered = new Set<number>();
  const oldByEntryKey = new Map<string, number[]>();
  const oldByFingerprint = new Map<string, number[]>();
  oldMessages.forEach((message, index) => {
    if (isSummaryCard(message)) return;
    const entryKey = messageEntryKey(message);
    const entryIndices = oldByEntryKey.get(entryKey);
    if (entryIndices) entryIndices.push(index);
    else oldByEntryKey.set(entryKey, [index]);

    const fingerprint = messageFingerprint(message);
    const fingerprintIndices = oldByFingerprint.get(fingerprint);
    if (fingerprintIndices) fingerprintIndices.push(index);
    else oldByFingerprint.set(fingerprint, [index]);
  });
  const tailStart = fingerprintTailOnly
    ? Math.max(0, oldMessages.length - 32)
    : 0;

  for (const incoming of incomingMessages) {
    if (isSummaryCard(incoming)) continue;
    let matchedIndex: number | undefined;
    const entryCandidates = oldByEntryKey.get(messageEntryKey(incoming)) ?? [];
    for (let index = entryCandidates.length - 1; index >= 0; index--) {
      const candidate = entryCandidates[index];
      if (!covered.has(candidate)) {
        matchedIndex = candidate;
        break;
      }
    }
    if (matchedIndex === undefined) {
      // 指纹只用于压缩改写：运行期副本没有 entryId，投影后 id 会变。
      // 同一文件版本下的窗口右移不能走指纹——Pi 短回复（「好的」「继续」）
      // 很容易同文同秒，否则中间那条会从历史前缀里被吃掉。
      if (!allowFingerprint) continue;
      const fingerprintCandidates = oldByFingerprint.get(messageFingerprint(incoming)) ?? [];
      for (let index = fingerprintCandidates.length - 1; index >= 0; index--) {
        const candidate = fingerprintCandidates[index];
        if (
          covered.has(candidate) ||
          candidate < tailStart ||
          Math.abs((oldMessages[candidate].timestamp ?? 0) - (incoming.timestamp ?? 0)) >
            COMPACTION_FINGERPRINT_TIME_TOLERANCE_MS
        ) {
          continue;
        }
        matchedIndex = candidate;
        break;
      }
    }
    if (matchedIndex !== undefined) covered.add(matchedIndex);
  }
  return covered;
}

/**
 * 比较当前已展示的运行期消息与新的权威 canonical snapshot：
 * - 权威 canonical 消息之间的相对顺序 100% 保持 canonicalMessages 中的原始顺序不变；
 * - 旧数组中存在但新 canonical 数组中不存在的消息，标记为 meta.slidingOut = true 并保留在数组中；
 * - 相对位置按原有位置锚定（在第一个幸存 canonical 前面的旧消息放在 HEAD；在两个幸存消息之间的旧消息放在其后一个幸存消息之前；在全部幸存消息之后的放在 TAIL）；
 * - 如果某个 message ID 重新出现在新的 canonical 消息中，清除 slidingOut 标记（以 canonical 为准，避免双份）；
 * - 如果第二次 snapshot 到达时已有消息仍在 slide-out，继续保留它们。
 */
export function mergeCanonicalSnapshotWithSlidingOut(
  previousMessages: ChatMessage[],
  canonicalMessages: ChatMessage[],
  slideOut?: ChatMessage[],
): ChatMessage[] {
  if (previousMessages.length === 0) {
    return canonicalMessages;
  }
  if (canonicalMessages.length === 0) {
    return previousMessages.map((m) =>
      m.meta?.slidingOut === true ? m : { ...m, meta: { ...m.meta, slidingOut: true } }
    );
  }

  const canonicalById = new Map<string, ChatMessage>();
  for (const msg of canonicalMessages) {
    canonicalById.set(msg.id, msg);
  }

  // trim 窗口右移滑出轮已被 reconcileHistoryPrefix 并入 history.messages，
  // 不应在 messages 中重复保留为 slidingOut
  const slideOutIds = new Set<string>();
  const slideOutEntryIds = new Set<string>();
  if (Array.isArray(slideOut)) {
    for (const msg of slideOut) {
      slideOutIds.add(msg.id);
      if (typeof msg.meta?.entryId === "string") {
        slideOutEntryIds.add(msg.meta.entryId);
      }
    }
  }

  // 1. 找出 previousMessages 中所有需要保留为 slidingOut 的消息，并为它们确定在 canonical 序列中的相对插槽
  const headSliding: ChatMessage[] = [];
  const slidingBeforeCanonicalId = new Map<string, ChatMessage[]>();
  const tailSliding: ChatMessage[] = [];

  // 预先反向扫描 previousMessages 计算每个位置之后第一个幸存的 canonical id
  const nextSurvivorIdAt = new Array<string | null>(previousMessages.length);
  let nextSurvivor: string | null = null;
  for (let i = previousMessages.length - 1; i >= 0; i--) {
    nextSurvivorIdAt[i] = nextSurvivor;
    const msg = previousMessages[i];
    if (canonicalById.has(msg.id)) {
      nextSurvivor = msg.id;
    }
  }

  let hasSeenAnySurvivor = false;
  for (let i = 0; i < previousMessages.length; i++) {
    const prevMsg = previousMessages[i];
    if (canonicalById.has(prevMsg.id)) {
      hasSeenAnySurvivor = true;
      continue;
    }

    // 已被 slideOut 并入 history 前缀的跳过
    if (
      slideOutIds.has(prevMsg.id) ||
      (typeof prevMsg.meta?.entryId === "string" && slideOutEntryIds.has(prevMsg.meta.entryId))
    ) {
      continue;
    }

    const slidingMsg = prevMsg.meta?.slidingOut === true
      ? prevMsg
      : { ...prevMsg, meta: { ...prevMsg.meta, slidingOut: true } };

    const nextSurvivorId = nextSurvivorIdAt[i];
    if (!hasSeenAnySurvivor) {
      // 位于所有幸存 canonical 消息之前 -> 锚定在 HEAD（summary 等卡片之前）
      headSliding.push(slidingMsg);
    } else if (nextSurvivorId) {
      // 位于已幸存消息之后、下一个幸存消息之前 -> 锚定在下一个幸存消息之前
      const list = slidingBeforeCanonicalId.get(nextSurvivorId);
      if (list) list.push(slidingMsg);
      else slidingBeforeCanonicalId.set(nextSurvivorId, [slidingMsg]);
    } else {
      // 位于所有幸存 canonical 消息之后 -> 锚定在 TAIL
      tailSliding.push(slidingMsg);
    }
  }

  // 2. 按 canonicalMessages 的权威顺序组装结果（保证 canonical 顺序 100% 权威）
  const result: ChatMessage[] = [...headSliding];

  for (const canonicalMsg of canonicalMessages) {
    const beforeList = slidingBeforeCanonicalId.get(canonicalMsg.id);
    if (beforeList && beforeList.length > 0) {
      result.push(...beforeList);
    }

    // 确保 canonical 消息上的 slidingOut 标志被清除（若有旧残留）
    if (canonicalMsg.meta?.slidingOut) {
      const meta = { ...canonicalMsg.meta };
      delete meta.slidingOut;
      result.push({ ...canonicalMsg, meta });
    } else {
      result.push(canonicalMsg);
    }
  }

  result.push(...tailSliding);

  return result;
}

/**
 * 动画结束后按 message ID 清理已滑出的旧消息。
 * 严格守卫：只删除 meta.slidingOut === true 的消息，绝对不修改或删除 canonical 消息。
 */
export function removeSlidingOutMessages(
  messages: ChatMessage[],
  targetIds: Set<string> | string[],
): ChatMessage[] {
  const idSet = targetIds instanceof Set ? targetIds : new Set(targetIds);
  let changed = false;
  const result = messages.filter((msg) => {
    if (idSet.has(msg.id) && msg.meta?.slidingOut === true) {
      changed = true;
      return false;
    }
    return true;
  });
  return changed ? result : messages;
}

export const removeSessionSlidingOutMessagesAtom = atom(
  null,
  (get, set, input: { sessionId: string; messageIds: string[] }) => {
    const cache = get(sessionMessagesCacheAtom);
    const current = cache[input.sessionId];
    if (!current || !current.messages) return false;
    const nextMessages = removeSlidingOutMessages(current.messages, input.messageIds);
    if (nextMessages === current.messages) return false;
    set(sessionMessagesCacheAtom, {
      ...cache,
      [input.sessionId]: {
        ...current,
        messages: nextMessages,
        updatedAt: Date.now(),
      },
    });
    return true;
  },
);

/**
 * 运行时窗口段更新时调和 disk 历史前缀（2026-08 激活分页）：
 * - fileVersion 变化（编辑/删除/压缩改写 JSONL）默认丢弃前缀；
 *   压缩快照显式 preserveHistory 时保留已经展示的对话；
 * - 窗口右移与前缀尾部重叠 → 按 entryId 去重（重叠部分以运行时窗口段为权威）；
 * - slideOut（trim 窗口右移滑出的旧窗口头部轮次）→ 并入前缀尾部，避免锚点轮空洞。
 */
function reconcileHistoryPrefix(
  history: SessionMessageCacheEntry["history"],
  segment: ChatMessage[],
  fileVersion?: string,
  slideOut?: ChatMessage[],
  preserveHistory = false,
  stickyHistory = false,
  historyBefore?: number,
): SessionMessageCacheEntry["history"] {
  if (!history && (!slideOut || slideOut.length === 0)) return undefined;
  const versionChanged = Boolean(fileVersion && (!history?.version || fileVersion !== history.version));
  // 编辑/删除等改写会让旧前缀失效；压缩只改写上下文边界，旧对话仍是用户已经
  // 看到的 transcript，因此由主进程显式标记 preserveHistory 后继续保留。
  if (versionChanged && !preserveHistory) {
    history = undefined;
  }
  const hasCurrentSummaryCard = segment.some(isSummaryCard);
  // 仅压缩改写（文件版本变了但仍要保留已看过的对话）才允许用内容指纹
  // 去重；普通窗口右移只认 entryId / 运行期 id。
  const allowFingerprint = versionChanged && preserveHistory;
  const slideCandidates = (slideOut ?? []).filter(
    (message) => !hasCurrentSummaryCard || !isSummaryCard(message),
  );
  const coveredSlideIndexes = findCoveredMessageIndexes(
    slideCandidates,
    segment,
    false,
    allowFingerprint,
  );
  const slideMessages = slideCandidates.filter((_message, index) => !coveredSlideIndexes.has(index));
  const prefixCandidates = history?.messages ?? [];
  const coveredPrefixIndexes = findCoveredMessageIndexes(
    prefixCandidates,
    [...segment, ...slideMessages],
    true,
    allowFingerprint,
  );
  const prefixMessages = prefixCandidates.filter(
    (message, index) => !coveredPrefixIndexes.has(index) &&
      !(hasCurrentSummaryCard && isSummaryCard(message)),
  );
  const messages = [...prefixMessages, ...slideMessages];
  if (messages.length === 0) return undefined;
  // 无滑出轮且前缀未被触碰：保留原对象引用，避免无谓的 atom 更新
  if (
    slideMessages.length === 0 &&
    !versionChanged &&
    !history?.sticky &&
    !stickyHistory &&
    messages.length === (history?.messages.length ?? 0)
  ) {
    return history;
  }
  const nextBefore = history?.nextBefore ?? (
    typeof historyBefore === "number" &&
    historyBefore > 0
      ? historyBefore
      : null
  );
  return {
    nextBefore,
    ...(history?.nextBeforeEntryId !== undefined
      ? { nextBeforeEntryId: history?.nextBeforeEntryId }
      : {}),
    ...(history?.exhausted ? { exhausted: true } : {}),
    version: fileVersion ?? history?.version,
    ...(stickyHistory ? { sticky: true } : {}),
    messages,
  };
}

/**
 * disk 轮次页 prepend（runtime 窗口会话的「加载更多对话」）。
 * 守卫：来源/revision/游标连续；版本漂移（压缩）时旧前缀整段作废、以新页为最新前缀起点。
 */
export const prependSessionHistoryPageAtom = atom(
  null,
  (get, set, input: {
    sessionId: string;
    expectedRevision: number;
    /** 续页游标（首次加载为 undefined，调用方以 beforeEntryId 锚定） */
    before?: number | null;
    page: SessionMessagePage;
  }) => {
    const current = get(sessionMessagesCacheAtom)[input.sessionId];
    if (
      !current ||
      current.source !== "runtime" ||
      current.revision !== input.expectedRevision
    ) {
      return false;
    }
    // 续页必须游标连续；首次加载（无 history）不要求。
    // slideOut 合成前缀的 nextBefore=null 只表示「游标未知」，不是到顶，
    // 按首次页（before === undefined）接受，避免长会话滚到顶后无法再翻。
    if (current.history && current.history.nextBefore !== input.before) {
      const unknownCursor = current.history.nextBefore === null && !current.history.exhausted;
      // 未知游标既可能走 beforeEntryId 首次页（before === undefined），
      // 也可能用 windowStartFilePos 当数值 before。两者都不是续页错位。
      if (!(unknownCursor && (input.before === undefined || typeof input.before === "number"))) return false;
    }
    // 回底清理后迟到的续页直接拒绝：history 已清空时只接受新的首次页（before === undefined），
    // 否则慢响应会把已释放的历史前缀复活并携带旧滚动锚点。
    if (!current.history && input.before !== undefined) return false;

    const segmentKeys = new Set(current.messages.map(messageEntryKey));
    const pageMessages = input.page.messages.filter((message) => !segmentKeys.has(messageEntryKey(message)));

    const stalePrefix = Boolean(
      current.history?.version &&
      input.page.indexVersion &&
      current.history.version !== input.page.indexVersion,
    );
    // 版本漂移：旧前缀下标空间失效，直接以新页重建前缀（仍然与窗口段去重）
    const baseMessages = stalePrefix ? [] : (current.history?.messages ?? []);
    const baseKeys = new Set(baseMessages.map(messageEntryKey));
    const freshMessages = pageMessages.filter((message) => !baseKeys.has(messageEntryKey(message)));

    const merged = [...freshMessages, ...baseMessages];
    set(sessionMessagesCacheAtom, {
      ...get(sessionMessagesCacheAtom),
      [input.sessionId]: {
        ...current,
        // 空页 + nextBefore=null 也要留下 exhausted 前缀：
        // 否则 history 被清掉后 hasMore 会回退到 windowStart>0，顶部按钮反复出现、空翻死循环。
        history: {
              messages: merged,
              nextBefore: input.page.nextBefore,
              // 续页锚点：本次页最旧条目的 entryId（渲染层续页请求携带，缓存优先路径依赖）
              ...(input.page.nextBeforeEntryId ? { nextBeforeEntryId: input.page.nextBeforeEntryId } : {}),
              ...(input.page.nextBefore === null ? { exhausted: true } : {}),
              version: input.page.indexVersion ?? current.history?.version,
              ...(current.history?.sticky ? { sticky: true } : {}),
            },
        updatedAt: Date.now(),
      },
    });
    return true;
  },
);

/**
 * 编辑/删除成功后的历史前缀原子替换（2026-11 mutation 刷新路径）。
 *
 * 职责边界：只负责把某个 runtime session 的旧 history（用户上翻加载的旧消息）
 * 用重新读取到的新历史一次性替换；runtime 窗口段（current.messages）由后端的
 * 实时全量 flush 负责，本 atom 绝不触碰。
 *
 * 守卫语义（与 prependSessionHistoryPageAtom 同源，但多一层 mutation 序号）：
 * - source !== "runtime" / revision 不匹配 → 拒绝（缓存已被其他路径改写）；
 * - expectedMutationSequence 不匹配 → 拒绝（乱序的旧 refresh 响应不得覆盖新响应）。
 * revision 允许「变大」：等待期间正常的 runtime flush 会递增 revision 并更新
 * 窗口段，这不影响历史前缀替换的正确性；只有 entry 整体缺失/来源变化才拒绝。
 */
export type ReplaceSessionHistoryAfterMutationInput = {
	sessionId: string;
	/** mutation refresh 的会话内序号；由 captureHistoryMutationRefresh 发放并由 runtime flush 继承 */
	expectedMutationSequence: number;
	messages: ChatMessage[];
	nextBefore: number | null;
	nextBeforeEntryId?: string | null;
	exhausted?: boolean;
	version?: string;
};

export const replaceSessionHistoryAfterMutationAtom = atom(
	null,
	(get, set, input: ReplaceSessionHistoryAfterMutationInput): boolean => {
		const current = get(sessionMessagesCacheAtom)[input.sessionId];
		if (!current) return false;
		if (current.source !== "runtime") return false;
		if (current.mutationSequence !== input.expectedMutationSequence) return false;
		set(sessionMessagesCacheAtom, {
			...get(sessionMessagesCacheAtom),
			[input.sessionId]: {
				...current,
				// 只替换历史前缀：messages/windowStart/cardCount 等窗口段字段原引用保留，
				// 后端实时 flush 仍拥有 runtime window 的唯一写权。
				history: {
					messages: input.messages,
					nextBefore: input.nextBefore,
					...(input.nextBeforeEntryId !== undefined ? { nextBeforeEntryId: input.nextBeforeEntryId } : {}),
					...(input.exhausted ? { exhausted: true } : {}),
					...(input.version ? { version: input.version } : {}),
				},
				updatedAt: Date.now(),
			},
		});
		return true;
	},
);

/**
 * 回底清理临时历史（2026-11 轮次模型）：贴底稳定后把 runtime 会话翻过的历史前缀清掉，
 * 只保留运行时窗口段 —— atom 数据回到「最近 3 轮窗口」，渲染层内存最小；
 * 再次上翻走「atom → 主进程缓存 → 文件」三级递进重新拉取。
 * 仅 runtime 来源缓存生效；disk 来源（历史会话浏览）不清，避免打断按条分页游标。
 */
export const clearSessionHistoryAtom = atom(
	null,
	(get, set, sessionId: string) => {
		const current = get(sessionMessagesCacheAtom)[sessionId];
		if (!current || current.source !== "runtime" || !current.history) return false;
		// 压缩刚完成的前缀要先让下一次正常全量 flush 清除 sticky 标记；
		// 否则用户刚看到的旧回复会在 1.5s 回底定时器里立即消失。
		if (current.history.sticky) return false;
		set(sessionMessagesCacheAtom, {
			...get(sessionMessagesCacheAtom),
			[sessionId]: { ...current, history: undefined, updatedAt: Date.now() },
		});
		return true;
	},
);

function toAgentUiRequest(
  payload: Record<string, unknown>,
  agentId: string,
): AgentUiRequest | undefined {
  const requestId = typeof payload.requestId === "string" ? payload.requestId : "";
  if (!requestId) return undefined;
  const batchQuestions: AgentUiBatchQuestion[] | undefined = Array.isArray(payload.batchQuestions)
    ? payload.batchQuestions.reduce<AgentUiBatchQuestion[]>((questions, question) => {
        if (!question || typeof question !== "object") return questions;
        const typed = question as Record<string, unknown>;
        if (
          typeof typed.id !== "string" ||
          typeof typed.question !== "string" ||
          !["select", "confirm", "input", "editor"].includes(String(typed.type))
        ) {
          return questions;
        }
        const options = Array.isArray(typed.options)
          ? typed.options.reduce<NonNullable<AgentUiBatchQuestion["options"]>>((items, option) => {
              if (typeof option === "string") {
                items.push(option);
                return items;
              }
              if (!option || typeof option !== "object") return items;
              const typedOption = option as Record<string, unknown>;
              if (typeof typedOption.label !== "string") return items;
              items.push({
                label: typedOption.label,
                ...(typeof typedOption.value === "string" ? { value: typedOption.value } : {}),
                ...(typeof typedOption.description === "string"
                  ? { description: typedOption.description }
                  : {}),
              });
              return items;
            }, [])
          : undefined;
        questions.push({
          id: typed.id,
          type: typed.type as AgentUiBatchQuestion["type"],
          question: typed.question,
          ...(options?.length ? { options } : {}),
          ...(typeof typed.allowOther === "boolean" ? { allowOther: typed.allowOther } : {}),
          ...(typeof typed.placeholder === "string" ? { placeholder: typed.placeholder } : {}),
          ...(typeof typed.prefill === "string" ? { prefill: typed.prefill } : {}),
        });
        return questions;
      }, [])
    : undefined;
  return {
    agentId,
    requestId,
    method: typeof payload.method === "string" ? payload.method : "",
    title: typeof payload.title === "string" ? payload.title : "",
    options: Array.isArray(payload.options)
      ? payload.options.filter((option): option is string => typeof option === "string")
      : undefined,
    placeholder: typeof payload.placeholder === "string" ? payload.placeholder : undefined,
    prefill: typeof payload.prefill === "string" ? payload.prefill : undefined,
    allowOther: payload.allowOther === true,
    completed: payload.completed === true,
    value: typeof payload.value === "string" || typeof payload.value === "boolean"
      ? payload.value
      : undefined,
    confirmed: typeof payload.confirmed === "boolean" ? payload.confirmed : undefined,
    cancelled: payload.cancelled === true,
    message: typeof payload.message === "string" ? payload.message : undefined,
    notifyType: payload.notifyType === "info" || payload.notifyType === "warning" || payload.notifyType === "error"
      ? payload.notifyType
      : undefined,
    text: typeof payload.text === "string" ? payload.text : undefined,
    widgetKey: typeof payload.widgetKey === "string" ? payload.widgetKey : undefined,
    widgetLines: Array.isArray(payload.widgetLines)
      ? payload.widgetLines.filter((line): line is string => typeof line === "string")
      : undefined,
    widgetPlacement: payload.widgetPlacement === "aboveEditor" || payload.widgetPlacement === "belowEditor"
      ? payload.widgetPlacement
      : undefined,
    batchQuestions: batchQuestions?.length ? batchQuestions : undefined,
    batchReview: payload.batchReview === true,
  };
}

/** 清除某会话的 live 思考通道（换绑 / 卸载 / detach）。 */
function clearSessionLiveThinking(get: Getter, set: Setter, sessionId: string) {
  const liveId = get(liveThinkingIdBySessionAtom)[sessionId];
  const idsToDispose: string[] = [];
  if (liveId) {
    idsToDispose.push(liveId);
    set(streamingThinkingByIdAtom, (prevMap) => {
      if (!(liveId in prevMap)) return prevMap;
      const nextMap = { ...prevMap };
      delete nextMap[liveId];
      return nextMap;
    });
  } else {
    // 兜底：按 sessionId 扫一遍，防止 liveId 映射丢失后残留段。
    const map = get(streamingThinkingByIdAtom);
    const leftoverIds = Object.entries(map)
      .filter(([, entry]) => entry.sessionId === sessionId)
      .map(([id]) => id);
    if (leftoverIds.length > 0) {
      idsToDispose.push(...leftoverIds);
      set(streamingThinkingByIdAtom, (prevMap) => {
        const nextMap = { ...prevMap };
        for (const id of leftoverIds) delete nextMap[id];
        return nextMap;
      });
    }
  }
  set(liveThinkingIdBySessionAtom, (prevMap) => {
    if (!(sessionId in prevMap)) return prevMap;
    const nextMap = { ...prevMap };
    delete nextMap[sessionId];
    return nextMap;
  });
  for (const id of idsToDispose) disposeStreamingThinkingFamily(id);
}

/**
 * History 已写入同段 thinking 后才卸 live 身份。
 * done 与 agents:message 跨通道可能乱序；若 done 先清，会在 message.thinking 仍空时
 * 拆掉 ThinkingStep，等 History 到达再 remount → 整段糊屏。
 */
function tryReleaseLiveThinkingAfterHistory(get: Getter, set: Setter, sessionId: string) {
  const liveId = get(liveThinkingIdBySessionAtom)[sessionId];
  if (!liveId?.startsWith("msg-thinking-")) return;
  const messageId = liveId.slice("msg-thinking-".length);
  if (!messageId) return;
  const messages = get(sessionMessagesCacheAtom)[sessionId]?.messages ?? [];
  const ready = messages.some(
    (message) => message.id === messageId && Boolean(message.thinking?.trim()),
  );
  if (!ready) return;
  set(streamingThinkingByIdAtom, (prevMap) => {
    if (!(liveId in prevMap)) return prevMap;
    const nextMap = { ...prevMap };
    delete nextMap[liveId];
    return nextMap;
  });
  set(liveThinkingIdBySessionAtom, (prevMap) => {
    if (prevMap[sessionId] !== liveId) return prevMap;
    const nextMap = { ...prevMap };
    delete nextMap[sessionId];
    return nextMap;
  });
  // 数据条目与 family 实例成对释放（uuid 段 id 不复用，不 remove 会永久堆在 Map 里）。
  disposeStreamingThinkingFamily(liveId);
}

function applySessionRuntimeUiEvent(
  current: SessionRuntimeUiState | undefined,
  event: SessionRuntimeEvent,
  payload: Record<string, unknown>,
  bindingChanged: boolean,
): SessionRuntimeUiState | undefined {
  const base = !current || bindingChanged || current.agentId !== event.agentId ||
    current.runtimeGeneration !== event.runtimeGeneration
    ? {
        agentId: event.agentId,
        runtimeGeneration: event.runtimeGeneration,
        requests: {},
        widgets: {},
        revision: 0,
      }
    : current;
  if (
    (event.sourceChannel === "agents:state" || event.sourceChannel === "sessions:runtime") &&
    (payload.status === "error" || payload.status === "closed")
  ) {
    return {
      agentId: event.agentId,
      runtimeGeneration: event.runtimeGeneration,
      requests: {},
      widgets: {},
      revision: base.revision + 1,
    };
  }
  if (event.sourceChannel !== "agents:ui-request") return bindingChanged ? base : current;
  const request = toAgentUiRequest(payload, event.agentId);
  if (!request) return base;
  const revision = base.revision + 1;

  if (request.completed) {
    const existing = base.requests[request.requestId];
    if (!existing) return { ...base, revision };
    return {
      ...base,
      revision,
      requests: {
        ...base.requests,
        [request.requestId]: {
          request: { ...existing.request, ...request },
          status: request.cancelled ? "cancelled" : "completed",
        },
      },
    };
  }
  if (request.method === "notify") {
    return request.message
      ? {
          ...base,
          revision,
          notification: {
            requestId: request.requestId,
            message: request.message,
            notifyType: request.notifyType,
            revision,
          },
        }
      : { ...base, revision };
  }
  if (request.method === "set_editor_text") {
    return {
      ...base,
      revision,
      editorText: {
        requestId: request.requestId,
        text: request.text ?? "",
        revision,
      },
    };
  }
  if (request.method === "setWidget") {
    const widgetKey = request.widgetKey || request.requestId;
    const widgets = { ...base.widgets };
    if (request.widgetLines?.length) widgets[widgetKey] = request.widgetLines;
    else delete widgets[widgetKey];
    return { ...base, revision, widgets };
  }
  if (!["select", "confirm", "input", "editor", "batch_ask"].includes(request.method)) {
    return { ...base, revision };
  }
  return {
    ...base,
    revision,
    requests: {
      ...base.requests,
      [request.requestId]: { request, status: "pending" },
    },
  };
}

export const applySessionRuntimeEventAtom = atom(
  null,
  (get, set, event: SessionRuntimeEvent) => {
    const currentRuntime = get(sessionRuntimeByIdAtom)[event.sessionId] ?? {
      runtimeGeneration: 0,
      status: "detached" as const,
      updatedAt: 0,
    };
    if (event.kind === "detach") {
      if (
        event.runtimeGeneration < currentRuntime.runtimeGeneration ||
        (currentRuntime.agentId && currentRuntime.agentId !== event.agentId)
      ) {
        return;
      }
      // Anonymous records only exist while their --no-session runtime exists.
      // Remove every renderer cache at detach so a future catalog refresh cannot
      // leave a closed anonymous row selectable in the sidebar.
      if (get(sessionRecordsAtom)[event.sessionId]?.noSession) {
        set(
          discardedTransientSessionIdsAtom,
          new Set(get(discardedTransientSessionIdsAtom)).add(event.sessionId),
        );
        set(removeSessionStateAtom, event.sessionId);
        return;
      }
      const nextUiById = { ...get(sessionRuntimeUiByIdAtom) };
      delete nextUiById[event.sessionId];
      set(sessionRuntimeUiByIdAtom, nextUiById);
      clearSessionLiveThinking(get, set, event.sessionId);
      set(sessionRuntimeByIdAtom, {
        ...get(sessionRuntimeByIdAtom),
        [event.sessionId]: {
          runtimeGeneration: event.runtimeGeneration,
          status: "detached",
          updatedAt: Date.now(),
        },
      });
      return;
    }
    if (event.runtimeGeneration < currentRuntime.runtimeGeneration) return;
    if (
      event.runtimeGeneration === currentRuntime.runtimeGeneration &&
      currentRuntime.agentId &&
      currentRuntime.agentId !== event.agentId
    ) {
      return;
    }
    const bindingChanged =
      event.runtimeGeneration > currentRuntime.runtimeGeneration ||
      currentRuntime.agentId !== event.agentId;

    // 2026-08 治理：agents:event 是 pi 原始事件流（每 token 100+/s），桌面 UI
    // 无任何消费者（web SSE 走主进程内部订阅）。此前它落入下方兜底路径无条件
    // 写 sessionRuntimeByIdAtom，导致 timeline 等订阅者 100/s 全量重渲染——
    // 主进程侧已停止转发，这里双保险拦截（防其他生产者误发）。
    if (event.sourceChannel === "agents:event") return;

    let nextRuntime: SessionRuntimeViewState = {
      ...(bindingChanged
        ? {
            runtimeGeneration: event.runtimeGeneration,
            status: "detached" as const,
            updatedAt: 0,
            // 新绑定不能继承旧 agent 的运行时状态：清掉残留 state，
            // 否则底栏 state?.modelName 优先于 record 显示旧模型（模型切换后显示旧）。
            // 真实值由后续 agents:runtime-state 事件（含 applyPreferences 后的主动推送）填充。
            state: undefined,
          }
        : currentRuntime),
      agentId: event.agentId,
      runtimeGeneration: event.runtimeGeneration,
      updatedAt: Date.now(),
    };
    if (bindingChanged) {
      clearSessionLiveThinking(get, set, event.sessionId);
    }
    const payload = event.payload && typeof event.payload === "object"
      ? event.payload as Record<string, unknown>
      : undefined;

    if (
      (event.sourceChannel === "agents:state" || event.sourceChannel === "sessions:runtime") &&
      payload
    ) {
      const status = payload.status;
      if (
        status === "starting" ||
        status === "idle" ||
        status === "running" ||
        status === "error" ||
        status === "closed"
      ) {
        nextRuntime = {
          ...nextRuntime,
          status,
          projectId: typeof payload.projectId === "string" ? payload.projectId : nextRuntime.projectId,
          cwd: typeof payload.cwd === "string" ? payload.cwd : nextRuntime.cwd,
          title: typeof payload.title === "string" ? payload.title : nextRuntime.title,
          piSessionId: typeof payload.sessionId === "string" ? payload.sessionId : nextRuntime.piSessionId,
          sessionPath: typeof payload.sessionPath === "string" ? payload.sessionPath : nextRuntime.sessionPath,
          createdAt: typeof payload.createdAt === "number" ? payload.createdAt : nextRuntime.createdAt,
          compactionCount: typeof payload.compactionCount === "number"
            ? payload.compactionCount
            : nextRuntime.compactionCount,
          noSession: payload.noSession === true || nextRuntime.noSession,
        };
      }
    } else if (event.sourceChannel === "agents:runtime-state" && payload?.state) {
      nextRuntime = {
        ...nextRuntime,
        state: mergeAgentRuntimeState(
          nextRuntime.state,
          payload.state as AgentRuntimeState,
        ),
      };
      // 缓存命中率快照入列：供「会话平均命中率」展示。
      // 只记有效百分比，避免把 undefined/瞬时抖动计入平均；
      // 连续相同的快照值跳过（流式期间 get_state 轮询会重复返回同一统计）。
      const hitPercent = (payload.state as AgentRuntimeState).cacheHitPercent;
      if (typeof hitPercent === "number" && Number.isFinite(hitPercent)) {
        const currentStats = get(sessionCacheStatsAtom)[event.sessionId] ?? { cacheHitHistory: [] };
        const history = currentStats.cacheHitHistory;
        if (history[history.length - 1] === hitPercent) {
          // 值未变化：不写 atom，避免 SessionHeader 无谓重渲染
        } else {
          const nextHistory = [...history, hitPercent].slice(-SESSION_CACHE_STATS_LIMIT);
          set(sessionCacheStatsAtom, {
            ...get(sessionCacheStatsAtom),
            [event.sessionId]: { cacheHitHistory: nextHistory },
          });
        }
      }
      // 同值 runtime-state（含仅刷新 updatedAt）不写 map，避免所有 session family 被父对象换新戳醒。
      // cache-hit 统计必须先入列：sameSessionRuntimeView 故意忽略 updatedAt，
      // 若先 return 会把「state 未变、但 cacheHitPercent 首次/变化」一并丢掉。
      if (!bindingChanged && sameSessionRuntimeView(currentRuntime, nextRuntime)) {
        return;
      }
    } else if (event.sourceChannel === "agents:thinking" && payload) {
      // Live 思考：只更新 streamingThinkingByIdAtom / liveThinkingIdBySessionAtom。
      // 绑定未变时不写 sessionRuntimeByIdAtom，避免每帧戳醒 timeline。
      const id = typeof payload.id === "string" ? payload.id : "";
      const fullText =
        typeof payload.text === "string"
          ? payload.text
          : typeof payload.thinking === "string"
            ? payload.thinking
            : "";
      const delta = typeof payload.delta === "string" ? payload.delta : "";
      const done = payload.done === true;
      const startedAt = typeof payload.startedAt === "number" ? payload.startedAt : Date.now();
      const endedAt = typeof payload.endedAt === "number" ? payload.endedAt : 0;
      if (id) {
        if (done) {
          // 只标终态，保留 id/文本；等 History 同段 thinking 可见后再卸身份（防跨通道乱序 remount）。
          const prev = get(streamingThinkingByIdAtom)[id];
          // 终态事件携带全量 text（见 finishThinkingChannel）；缺省时用本地累积
          const text = fullText || (delta && prev ? prev.text + delta : "") || prev?.text || "";
          const nextEntry: StreamingThinkingEntry = {
            sessionId: event.sessionId,
            text,
            startedAt: prev?.startedAt ?? startedAt,
            endedAt: endedAt > 0 ? endedAt : (prev?.endedAt && prev.endedAt > 0 ? prev.endedAt : Date.now()),
            streaming: false,
          };
          if (
            !prev ||
            prev.text !== nextEntry.text ||
            prev.startedAt !== nextEntry.startedAt ||
            prev.endedAt !== nextEntry.endedAt ||
            prev.streaming !== false ||
            prev.sessionId !== event.sessionId
          ) {
            set(streamingThinkingByIdAtom, {
              ...get(streamingThinkingByIdAtom),
              [id]: nextEntry,
            });
          }
          if (get(liveThinkingIdBySessionAtom)[event.sessionId] !== id) {
            set(liveThinkingIdBySessionAtom, {
              ...get(liveThinkingIdBySessionAtom),
              [event.sessionId]: id,
            });
          }
          tryReleaseLiveThinkingAfterHistory(get, set, event.sessionId);
        } else {
          const streaming = endedAt <= 0;
          const prev = get(streamingThinkingByIdAtom)[id];
          // 增量协议（2026-08 治理）：delta 追加到本地累积；text 全量替换
          const text = delta ? (prev?.text ?? "") + delta : fullText;
          if (
            !prev ||
            prev.text !== text ||
            prev.startedAt !== startedAt ||
            prev.endedAt !== endedAt ||
            prev.streaming !== streaming ||
            prev.sessionId !== event.sessionId
          ) {
            set(streamingThinkingByIdAtom, {
              ...get(streamingThinkingByIdAtom),
              [id]: {
                sessionId: event.sessionId,
                text,
                startedAt,
                endedAt,
                streaming,
              },
            });
          }
          if (get(liveThinkingIdBySessionAtom)[event.sessionId] !== id) {
            set(liveThinkingIdBySessionAtom, {
              ...get(liveThinkingIdBySessionAtom),
              [event.sessionId]: id,
            });
          }
        }
      }
      if (bindingChanged) {
        set(sessionRuntimeByIdAtom, {
          ...get(sessionRuntimeByIdAtom),
          [event.sessionId]: nextRuntime,
        });
      }
      return;
    } else if (event.sourceChannel === "agents:text-stream" && payload) {
      // Live 正文：只更新 streamingTextByIdAtom。
      // 绑定未变时不写 sessionRuntimeByIdAtom，避免每帧戳醒 timeline/composer 订阅者。
      const prev = get(streamingTextByIdAtom)[event.sessionId];
      const messageId = typeof payload.messageId === "string" ? payload.messageId : (prev?.messageId ?? "");
      // 增量协议（2026-08 治理）：主进程正常 append 只推 delta，渲染层追加到
      // 本地累积；text 全量快照（非 append 重置 / 2.5s 自愈）整体替换。
      const text = typeof payload.delta === "string"
        ? (prev?.content ?? "") + payload.delta
        : typeof payload.text === "string"
          ? payload.text
          : prev?.content ?? "";
      const done = payload.done === true;
      const streaming = !done && text.length > 0;
      if (!prev || prev.messageId !== messageId || prev.content !== text || prev.streaming !== streaming) {
        set(streamingTextByIdAtom, {
          ...get(streamingTextByIdAtom),
          [event.sessionId]: { messageId, content: text, streaming },
        });
      }
      if (done) {
        set(streamingTextByIdAtom, (prevMap) => {
          if (!(event.sessionId in prevMap)) return prevMap;
          const nextMap = { ...prevMap };
          delete nextMap[event.sessionId];
          return nextMap;
        });
      }
      if (bindingChanged) {
        set(sessionRuntimeByIdAtom, {
          ...get(sessionRuntimeByIdAtom),
          [event.sessionId]: nextRuntime,
        });
      }
      return;
    } else if (
      (event.sourceChannel === "agents:message" || event.sourceChannel === "sessions:messages") &&
      payload
    ) {
      const messages = payload.messages;
      // 增量 flush 协议（2026-08 渲染卡顿优化）：主进程节流 flush 只发尾部增量
      // （upsertFrom + totalLength），终态 immediate flush 永远全量。
      // 激活显示窗口（2026-08 激活分页）：全量快照只含窗口段 [windowStart..]，
      // 窗口前历史由 disk 轮次分页 prepend（history 字段）；下标运算一律换算窗口偏移。
      const upsertFrom = typeof payload.upsertFrom === "number" ? payload.upsertFrom : undefined;
      const totalLength = typeof payload.totalLength === "number" ? payload.totalLength : undefined;
      const payloadWindowStart = typeof payload.windowStart === "number" ? payload.windowStart : undefined;
      const payloadWindowStartFilePos = typeof payload.windowStartFilePos === "number"
        ? payload.windowStartFilePos
        : undefined;
      const fileVersion = typeof payload.fileVersion === "string" ? payload.fileVersion : undefined;
      const preserveHistory = payload.preserveHistory === true;
      const stickyHistory = payload.stickyHistory === true;
      if (Array.isArray(messages)) {
        // Keep the release operation named near the message branch; the actual
        // call remains after the full/incremental cache update below.
        const releaseLiveThinking = () =>
          tryReleaseLiveThinkingAfterHistory(get, set, event.sessionId);
        const current = get(sessionMessagesCacheAtom)[event.sessionId];
        if (upsertFrom !== undefined && totalLength !== undefined) {
          // 增量合并：upsertFrom 为 runtime 数组绝对下标；本地数组 = [系统卡片(c), 窗口段]，
          // 窗口段首条对应 runtime 下标 W（windowStart），因此本地下标 = upsertFrom − W + c。
          // c（卡片数）由上一次全量 flush 推导并缓存（cardCount，见全量分支）；偏移无效
          // （缓存缺失/磁盘来源/漏事件）则丢弃，等终态窗口化全量校准——中间态滞后至多
          // 为本轮回答内的显示延迟，终态到达后完全纠正。
          const W = current?.windowStart ?? 0;
          const cardCount = current?.cardCount ?? 0;
          const slidingCount = current?.messages.filter((m) => m.meta?.slidingOut === true).length ?? 0;
          const offset = upsertFrom - W + cardCount + slidingCount;
          if (current?.source === "runtime" && offset >= 0 && current.messages.length >= offset) {
            const merged = [
              ...current.messages.slice(0, offset),
              ...(messages as ChatMessage[]),
            ];
            // 长度校验：合并后本地长度 = 卡片 + (totalLength − W) + slidingCount；不满足说明增量已失序
            // （漏事件/trim 未校准），丢弃等待全量
            if (merged.length === totalLength - W + cardCount + slidingCount) {
              set(cacheSessionMessagesAtom, {
                sessionId: event.sessionId,
                messages: merged,
                source: "runtime",
                windowStart: W,
                history: current.history,
                cardCount,
              });
            } else {
              console.warn("[messages] incremental update dropped", {
                sessionId: event.sessionId,
                upsertFrom,
                totalLength,
                windowStart: W,
                offset,
                currentLength: current.messages.length,
              });
            }
          } else {
            console.warn("[messages] incremental update dropped", {
              sessionId: event.sessionId,
              upsertFrom,
              totalLength,
              windowStart: W,
              offset,
              currentLength: current?.messages?.length ?? 0,
            });
          }
        } else {
          // 窗口化全量 / 传统全量：替换运行时窗口段；
          // 方案 B：对当前展示的 messages 与新 canonical snapshot 做 diff，
          // 被压缩移出的旧消息标记 slidingOut 并继续保留在 renderer state 中，由 renderer 自行管理退出动画生命周期。
          const segment = messages as ChatMessage[];
          // 卡片数推导：全量载荷 = [卡片(c), 窗口段]，本地长度 = c + (totalLength − W)
          const W = payloadWindowStart ?? 0;
          const cardCount = Math.max(0, segment.length - (totalLength ?? segment.length) + W);
          // trim 窗口右移的滑出轮：主进程把旧窗口头部（不再被新窗口覆盖的轮次）
          // 随全量 flush 下发，并入历史前缀，避免「锚点轮从视口消失且翻不回来」
          const slideOut = Array.isArray(payload.slideOut)
            ? (payload.slideOut as ChatMessage[])
            : undefined;
          // restart / 重开同一会话时，主进程已经丢掉旧 agent 的窗口段。
          // 仅在 bindingChanged 且显式 preserveHistory 时，把旧窗口并入 history 前缀。
          const previousWindow = bindingChanged &&
            preserveHistory &&
            stickyHistory &&
            (!slideOut || slideOut.length === 0) &&
            current?.source === "runtime"
            ? current.messages
            : undefined;
          const combinedSlideOut = previousWindow && previousWindow.length > 0
            ? previousWindow
            : slideOut;
          const mergedMessages = !bindingChanged &&
            current?.source === "runtime" &&
            (!current.agentId || current.agentId === event.agentId)
            ? mergeCanonicalSnapshotWithSlidingOut(current.messages, segment, slideOut)
            : segment;
          set(cacheSessionMessagesAtom, {
            sessionId: event.sessionId,
            messages: mergedMessages,
            source: "runtime",
            agentId: event.agentId,
            windowStart: payloadWindowStart,
            cardCount,
            history: reconcileHistoryPrefix(
              current?.history,
              segment,
              fileVersion,
              combinedSlideOut,
              preserveHistory,
              stickyHistory,
              payloadWindowStartFilePos,
            ),
            ...(typeof payloadWindowStartFilePos === "number"
              ? { windowStartFilePos: payloadWindowStartFilePos }
              : {}),
          });
        }
        // message 到达后若已含同段 thinking，安全卸 live（覆盖 done 先到的情况）。
        releaseLiveThinking();
      }
    }

    const terminalEnvelope = !bindingChanged &&
      (currentRuntime.status === "error" || currentRuntime.status === "closed");
    const nextUi = payload && !(terminalEnvelope && event.sourceChannel === "agents:ui-request")
      ? applySessionRuntimeUiEvent(
          get(sessionRuntimeUiByIdAtom)[event.sessionId],
          event,
          payload,
          bindingChanged,
        )
      : undefined;
    if (nextUi) {
      set(sessionRuntimeUiByIdAtom, {
        ...get(sessionRuntimeUiByIdAtom),
        [event.sessionId]: nextUi,
      });
    }
    // 2026-08 治理：无实质变化的推送跳过 atom 写入（emitStreamingStatePatch 在
    // 流式期间每 50ms 一推且状态相同）。sessionRuntimeByIdAtom 的订阅者含整个
    // timeline，新对象写入 = 100/s 级全量重渲染（O(消息数) + 分配压力），
    // 是渲染进程 CPU 满载与 V8 committed 只涨不缩的根源。updatedAt 不参与比较
    // （始终变化），跳过更新时也不刷新它——真正的状态变化必然伴随上述字段变化。
    const runtimeUnchanged =
      !bindingChanged &&
      currentRuntime.agentId === nextRuntime.agentId &&
      currentRuntime.runtimeGeneration === nextRuntime.runtimeGeneration &&
      currentRuntime.status === nextRuntime.status &&
      currentRuntime.state === nextRuntime.state &&
      currentRuntime.projectId === nextRuntime.projectId &&
      currentRuntime.cwd === nextRuntime.cwd &&
      currentRuntime.title === nextRuntime.title &&
      currentRuntime.piSessionId === nextRuntime.piSessionId &&
      currentRuntime.sessionPath === nextRuntime.sessionPath &&
      currentRuntime.createdAt === nextRuntime.createdAt &&
      currentRuntime.compactionCount === nextRuntime.compactionCount &&
      currentRuntime.noSession === nextRuntime.noSession;
    if (!runtimeUnchanged) {
      set(sessionRuntimeByIdAtom, {
        ...get(sessionRuntimeByIdAtom),
        [event.sessionId]: nextRuntime,
      });
    }
  },
);

export const claimSessionRuntimeUiResponseAtom = atom(
  null,
  (get, set, input: {
    sessionId: string;
    requestId: string;
    agentId: string;
    runtimeGeneration: number;
    request?: AgentUiRequest;
  }) => {
    const current = get(sessionRuntimeUiByIdAtom)[input.sessionId];
    const request = current?.requests[input.requestId];
    if (
      !current ||
      current.agentId !== input.agentId ||
      current.runtimeGeneration !== input.runtimeGeneration ||
      request?.status !== "pending" ||
      (input.request !== undefined && request.request !== input.request)
    ) {
      return false;
    }
    set(sessionRuntimeUiByIdAtom, {
      ...get(sessionRuntimeUiByIdAtom),
      [input.sessionId]: {
        ...current,
        requests: {
          ...current.requests,
          [input.requestId]: { ...request, status: "responding" },
        },
      },
    });
    return true;
  },
);

export const rollbackSessionRuntimeUiResponseAtom = atom(
  null,
  (get, set, input: {
    sessionId: string;
    requestId: string;
    agentId: string;
    runtimeGeneration: number;
    request?: AgentUiRequest;
  }) => {
    const current = get(sessionRuntimeUiByIdAtom)[input.sessionId];
    const request = current?.requests[input.requestId];
    if (
      !current ||
      current.agentId !== input.agentId ||
      current.runtimeGeneration !== input.runtimeGeneration ||
      request?.status !== "responding" ||
      (input.request !== undefined && request.request !== input.request)
    ) {
      return false;
    }
    set(sessionRuntimeUiByIdAtom, {
      ...get(sessionRuntimeUiByIdAtom),
      [input.sessionId]: {
        ...current,
        requests: {
          ...current.requests,
          [input.requestId]: { ...request, status: "pending" },
        },
      },
    });
    return true;
  },
);

export const bindSessionRuntimeAtom = atom(
  null,
  (get, set, input: {
    sessionId: string;
    agentId: string;
    runtimeGeneration?: number;
    status?: AgentStatus;
  }) => {
    const current = get(sessionRuntimeByIdAtom)[input.sessionId];
    const currentGeneration = current?.runtimeGeneration ?? 0;
    if (
      input.runtimeGeneration !== undefined &&
      input.runtimeGeneration < currentGeneration
    ) {
      return;
    }
    const bindingChanged = Boolean(current?.agentId && current.agentId !== input.agentId);
    if (bindingChanged) {
      const ui = { ...get(sessionRuntimeUiByIdAtom) };
      delete ui[input.sessionId];
      set(sessionRuntimeUiByIdAtom, ui);
    }
    set(sessionRuntimeByIdAtom, {
      ...get(sessionRuntimeByIdAtom),
      [input.sessionId]: {
        agentId: input.agentId,
        runtimeGeneration: input.runtimeGeneration ?? currentGeneration,
        status: input.status ?? (bindingChanged ? "idle" : current?.status) ?? "idle",
        state: bindingChanged ? undefined : current?.state,
        updatedAt: Date.now(),
      },
    });
    if (bindingChanged) {
      clearSessionLiveThinking(get, set, input.sessionId);
    }
  },
);

export const removeSessionStateAtom = atom(null, (get, set, sessionId: string) => {
  const records = { ...get(sessionRecordsAtom) };
  const session = records[sessionId];
  delete records[sessionId];
  set(sessionRecordsAtom, records);
  if (session) {
    set(sessionIdsByProjectAtom, {
      ...get(sessionIdsByProjectAtom),
      [session.projectId]: (get(sessionIdsByProjectAtom)[session.projectId] ?? [])
        .filter((id) => id !== sessionId),
    });
  }
  const runtime = { ...get(sessionRuntimeByIdAtom) };
  delete runtime[sessionId];
  set(sessionRuntimeByIdAtom, runtime);
  const runtimeUi = { ...get(sessionRuntimeUiByIdAtom) };
  delete runtimeUi[sessionId];
  set(sessionRuntimeUiByIdAtom, runtimeUi);
  const cacheStats = { ...get(sessionCacheStatsAtom) };
  delete cacheStats[sessionId];
  set(sessionCacheStatsAtom, cacheStats);
  const cache = { ...get(sessionMessagesCacheAtom) };
  delete cache[sessionId];
  set(sessionMessagesCacheAtom, cache);
  clearSessionLiveThinking(get, set, sessionId);
  liveTextStreamingBySessionAtom.remove(sessionId);
  liveTextStreamingMessageIdBySessionAtom.remove(sessionId);
  // atomFamily 无自动 GC：会话删除时必须同步 remove 各 family 实例，否则长期泄漏（2026-10）。
  liveThinkingIdBySessionIdAtomFamily.remove(sessionId);
  newTurnCollapseTickBySessionIdAtomFamily.remove(sessionId);
  streamingTextBySessionIdAtomFamily.remove(sessionId);
  sessionMessageCacheBySessionIdAtomFamily.remove(sessionId);
  sessionMessageLoadStateBySessionIdAtomFamily.remove(sessionId);
  set(streamingTextByIdAtom, (prevMap) => {
    if (!(sessionId in prevMap)) return prevMap;
    const nextMap = { ...prevMap };
    delete nextMap[sessionId];
    return nextMap;
  });
  set(sessionScrollAnchorByIdAtom, (prevMap) => {
    if (!(sessionId in prevMap)) return prevMap;
    const nextMap = { ...prevMap };
    delete nextMap[sessionId];
    return nextMap;
  });
  set(sessionMessageLruAtom, get(sessionMessageLruAtom).filter((id) => id !== sessionId));
  const loadState = { ...get(sessionMessageLoadStateAtom) };
  delete loadState[sessionId];
  set(sessionMessageLoadStateAtom, loadState);
  if (get(currentSessionIdAtom) === sessionId) set(currentSessionIdAtom, undefined);
});
