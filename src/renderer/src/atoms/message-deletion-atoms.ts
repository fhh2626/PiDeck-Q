import { atom, type createStore } from "jotai";
import { atomFamily, selectAtom } from "jotai/utils";
import type { ChatMessage } from "../../../shared/types";
import {
	isOptimisticDeletionSettled,
	resolveOptimisticDeletionIds,
} from "../utils/optimisticMessageDeletion";
import {
	removeSessionSlidingOutMessagesAtom,
	sessionMessagesCacheAtom,
	type SessionMessageCacheEntry,
} from "./session-atoms";

// 视图过滤函数经 atoms 入口转出：时间线控制器只从 "../atoms" 取状态相关依赖
export { filterOptimisticallyDeletedMessages } from "../utils/optimisticMessageDeletion";

type JotaiStore = ReturnType<typeof createStore>;

/**
 * 乐观删除隐藏表：sessionId → 删除令牌 → 被隐藏的消息 id。
 * 按令牌分组是因为同一会话可以连续发起多次删除（主进程按会话串行执行），
 * 每次删除成功/失败只撤销自己那一组，互不影响。
 */
export const optimisticDeletionsAtom = atom<Record<string, Record<string, string[]>>>({});

const EMPTY_HIDDEN_IDS: ReadonlySet<string> = new Set<string>();

/** 按会话订阅隐藏集合：其它会话删除不会让本栏时间线重算（分屏多实例隔离）。 */
export const optimisticDeletedIdsBySessionIdAtomFamily = atomFamily((sessionId: string) => {
	const sessionSlice = selectAtom(optimisticDeletionsAtom, (all) => all[sessionId], Object.is);
	return atom((get): ReadonlySet<string> => {
		const tokens = get(sessionSlice);
		if (!tokens) return EMPTY_HIDDEN_IDS;
		const ids = Object.values(tokens).flat();
		return ids.length > 0 ? new Set(ids) : EMPTY_HIDDEN_IDS;
	});
});

/** 成功后最长等待权威快照的时间；超时也撤销隐藏，避免残留隐藏把后续复用的 id 误藏。 */
const SETTLE_TIMEOUT_MS = 10_000;

let nextDeletionToken = 0;

/** 会话当前展示的全部消息（历史前缀 + 运行时窗口段），与时间线拼接顺序一致。 */
function cachedTimelineMessages(entry: SessionMessageCacheEntry | undefined): ChatMessage[] {
	if (!entry) return [];
	return entry.history ? [...entry.history.messages, ...entry.messages] : entry.messages;
}

function removeDeletionToken(store: JotaiStore, sessionId: string, token: string): void {
	const all = store.get(optimisticDeletionsAtom);
	const tokens = all[sessionId];
	if (!tokens || !(token in tokens)) return;
	const rest = Object.fromEntries(Object.entries(tokens).filter(([key]) => key !== token));
	const next = { ...all };
	if (Object.keys(rest).length > 0) next[sessionId] = rest;
	else delete next[sessionId];
	store.set(optimisticDeletionsAtom, next);
}

export type OptimisticDeletionOutcome = "committed" | "failed";

/**
 * 确认删除后立即隐藏将被删除的消息段，返回结算函数：
 * - failed：立即撤销隐藏（消息原样回来，由调用方提示失败）；
 * - committed：等权威快照里这些 id 消失（或只剩滑出副本）后再撤销，并顺手清掉滑出副本——
 *   被隐藏的消息不会进入时间线，滑出动画计时器也就不会为它们排队，不清理会残留在缓存里。
 * 订阅与超时计时器在同一函数内成对释放。
 */
export function beginOptimisticMessageDeletion(
	store: JotaiStore,
	sessionId: string,
	messageId: string,
): (outcome: OptimisticDeletionOutcome) => void {
	const entry = store.get(sessionMessagesCacheAtom)[sessionId];
	const hiddenIds = resolveOptimisticDeletionIds(cachedTimelineMessages(entry), messageId);
	if (hiddenIds.length === 0) return () => {};

	nextDeletionToken += 1;
	const token = String(nextDeletionToken);
	const all = store.get(optimisticDeletionsAtom);
	store.set(optimisticDeletionsAtom, {
		...all,
		[sessionId]: { ...all[sessionId], [token]: hiddenIds },
	});

	let settled = false;
	return (outcome) => {
		if (settled) return;
		settled = true;
		if (outcome === "failed") {
			removeDeletionToken(store, sessionId, token);
			return;
		}

		let unsubscribe: (() => void) | undefined;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let finished = false;
		const finish = () => {
			if (finished) return;
			finished = true;
			unsubscribe?.();
			if (timer !== undefined) clearTimeout(timer);
			store.set(removeSessionSlidingOutMessagesAtom, { sessionId, messageIds: hiddenIds });
			removeDeletionToken(store, sessionId, token);
		};
		const trySettle = () => {
			const current = store.get(sessionMessagesCacheAtom)[sessionId];
			// 会话缓存已被回收：没有可闪回的数据，直接结算
			if (!current || isOptimisticDeletionSettled(cachedTimelineMessages(current), hiddenIds)) {
				finish();
			}
		};
		trySettle();
		if (finished) return;
		unsubscribe = store.sub(sessionMessagesCacheAtom, trySettle);
		timer = setTimeout(finish, SETTLE_TIMEOUT_MS);
	};
}
