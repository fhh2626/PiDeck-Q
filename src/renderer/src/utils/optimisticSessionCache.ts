import type { ChatMessage } from "../../../shared/types";
import type { SessionMessageCacheEntry } from "../atoms";

/**
 * 构造「追加或修改本地乐观 user 气泡」的缓存写入。
 *
 * runtime 全量写入缺省 windowStart/history/cardCount/windowStartFilePos 时会清掉
 * 这些窗口字段；发送不是一次新的窗口快照，必须从当前缓存条目继承，否则长会话
 * 在发送瞬间会丢掉已加载的历史前缀和分页游标。
 *
 * disk 来源必须保持 disk + page：磁盘分页是大历史的展示基底，runtime 启动后的
 * 第一条增量不能按 runtime 下标去切它；让增量继续走“等待全量校准”路径，
 * 全量快照再由 session atom 把 pending 气泡接回。
 */
export function buildOptimisticCacheWrite(
  sessionId: string,
  messages: ChatMessage[],
  current?: SessionMessageCacheEntry,
  options?: { allowPendingRemoval?: boolean },
) {
  const source = current?.source ?? "runtime";
  return {
    sessionId,
    messages,
    source,
    optimistic: source === "disk",
    ...(options?.allowPendingRemoval ? { allowPendingRemoval: true } : {}),
    ...(source === "disk" && current?.page ? { page: current.page } : {}),
    ...(typeof current?.windowStart === "number" ? { windowStart: current.windowStart } : {}),
    ...(current?.history ? { history: current.history } : {}),
    ...(typeof current?.cardCount === "number" ? { cardCount: current.cardCount } : {}),
    ...(typeof current?.windowStartFilePos === "number"
      ? { windowStartFilePos: current.windowStartFilePos }
      : {}),
  };
}
