import type { ChatMessage } from "../../../shared/types";

/**
 * 乐观用户消息与权威快照的配对窗口：
 * - 权威消息通常晚于本地气泡（主进程收到 prompt 后才投影）；
 * - 同一台机器上只留 1s 兼容秒级精度/时钟微调，避免把“几秒前的同文消息”误配；
 * - 超过 10 分钟的旧消息不参与配对，避免重放/历史消息误配。
 */
const OPTIMISTIC_MATCH_CLOCK_SKEW_MS = 1_000;
const OPTIMISTIC_MATCH_MAX_AGE_MS = 10 * 60_000;

function sameOptimisticImages(
  left: ChatMessage,
  right: ChatMessage,
): boolean {
  const leftImages = left.images ?? [];
  const rightImages = right.images ?? [];
  if (leftImages.length !== rightImages.length) return false;
  if (leftImages.length === 0) return true;
  return leftImages.every((image, index) => {
    const other = rightImages[index];
    if (!other || image.type !== other.type || image.mimeType !== other.mimeType) return false;
    if (image.data.length !== other.data.length) return false;
    // 只比对首尾，避免对整段 base64 做 O(n) 比较；长度 + 首尾足以区分真实图片。
    return image.data.slice(0, 64) === other.data.slice(0, 64)
      && image.data.slice(-64) === other.data.slice(-64);
  });
}

/**
 * 本地气泡用于比对的正文。
 *
 * 模板/技能展开后，renderer 发出的正文与本地初始气泡可能不同；发送前会把
 * 真正提交的正文写到 meta.optimisticMatchText。优先用它，避免“用户看到的是
 * /template，主进程收到的是展开正文”时只能靠时间窗口误配。
 */
function optimisticMatchText(message: ChatMessage): string {
  const matchText = message.meta?.optimisticMatchText;
  return normalizeBashPromptText(
    typeof matchText === "string" ? matchText : message.text,
  );
}

/** pi 的 !/!! 命令会规范化前缀后的空白，内容兜底必须同口径。 */
function normalizeBashPromptText(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("!!")) return `!!${trimmed.slice(2).trim()}`;
  if (trimmed.startsWith("!")) return `!${trimmed.slice(1).trim()}`;
  return trimmed;
}

/** 用户消息内容是否代表同一次提交（正文允许首尾空白差异）。 */
function sameOptimisticContent(optimistic: ChatMessage, canonical: ChatMessage): boolean {
  if (optimistic.role !== "user" || canonical.role !== "user") return false;
  const localText = optimisticMatchText(optimistic);
  if (localText !== normalizeBashPromptText(canonical.text)) {
    // 纯图片 prompt 经主进程投影后会补本地化占位文案，正文不再相等；
    // 此时只有本地没有正文、图片完全一致才视为同一次提交。
    return localText === "" && sameOptimisticImages(optimistic, canonical)
      && (canonical.images?.length ?? 0) > 0;
  }
  if ((optimistic.thinking ?? "").trim() !== (canonical.thinking ?? "").trim()) return false;
  return sameOptimisticImages(optimistic, canonical);
}

/** 同一次发送的请求 id；主进程乐观 user 消息会原样带上它。 */
export function optimisticRequestId(message: ChatMessage): string | undefined {
  const requestId = message.meta?.optimisticRequestId;
  return typeof requestId === "string" && requestId ? requestId : undefined;
}

/**
 * 本地气泡是否仍在等待发送结果。
 *
 * `optimisticPending` 由 useSessionSend 在插入本地气泡时写入，明确失败/取消时
 * 由 settleOptimisticMessage 清除；accepted/unknown 保留到 host 权威行出现。
 * 等待期间收到的全量快照可能只是上一轮的
 * 终态数据，还不包含本次权威 user；此时不能把本地气泡滑出，否则移除行会让
 * 底部 scrollTop 被向上夹取，表现为发送瞬间信息流回滚。
 */
export function isPendingOptimisticMessage(message: ChatMessage): boolean {
  return message.meta?.optimisticPending === true;
}

/**
 * 发送结果落定：清掉 pending 标记，让后续快照可以按常规处理未确认气泡。
 * 只匹配 requestId，避免误清其他并行发送的本地气泡。
 */
export function settleOptimisticMessage(
  messages: ChatMessage[],
  requestId: string,
): { messages: ChatMessage[]; changed: boolean } {
  let changed = false;
  const next = messages.map((message) => {
    if (message.id !== requestId || !isPendingOptimisticMessage(message)) return message;
    changed = true;
    const meta = { ...message.meta };
    delete meta.optimisticPending;
    return { ...message, meta };
  });
  return { messages: changed ? next : messages, changed };
}

/** 权威用户消息必须落在本地乐观气泡之后（允许少量时钟回拨）。 */
function sameOptimisticTime(optimistic: ChatMessage, canonical: ChatMessage): boolean {
  const optimisticTime = timestampMs(optimistic.timestamp);
  const canonicalTime = timestampMs(canonical.timestamp);
  if (optimisticTime <= 0 || canonicalTime <= 0) return false;
  const delta = canonicalTime - optimisticTime;
  return delta >= -OPTIMISTIC_MATCH_CLOCK_SKEW_MS && delta <= OPTIMISTIC_MATCH_MAX_AGE_MS;
}

/** 兼容旧投影/测试里的 ISO 字符串时间戳，统一按毫秒比较。 */
function timestampMs(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

export type OptimisticUserReconciliation = {
  messages: ChatMessage[];
  droppedIds: string[];
};

/**
 * 把本地先显示的用户气泡与 Pi 的权威 user 消息配对。
 *
 * 发送时 renderer 立即插入带 meta.optimistic 的消息；主进程随后在同一轮快照
 * 带回同一条用户消息（主进程乐观消息或 Pi 投影），id 不同。主进程会原样
 * 保留 renderer 的 requestId，因此优先按 requestId 精确配对；旧版本或
 * requestId 缺失时再按「实际提交正文 + 时间」兜底。若不配对，
 * mergeCanonicalSnapshotWithSlidingOut 会把本地气泡标记为 slidingOut 并在
 * 280ms 后移除，底部因此少一行并被向上夹取，表现为发送后信息流回滚。
 * 未确认的本地气泡在 `optimisticPending` 为 true 时由 merge 入口保留，
 * 明确失败后由 useSessionSend 清除标记，再走原滑出路径；accepted 则由权威行替换。
 */
export function reconcileOptimisticUserMessages(
  previousMessages: ChatMessage[],
  canonicalMessages: ChatMessage[],
): OptimisticUserReconciliation {
  if (previousMessages.length === 0 || canonicalMessages.length === 0) {
    return { messages: previousMessages, droppedIds: [] };
  }
  const previousIds = new Set(previousMessages.map((message) => message.id));
  const canonicalUsers = canonicalMessages.filter((message) => message.role === "user");
  const optimisticUsers = previousMessages
    .map((message, index) => ({ message, index }))
    .filter(({ message }) => message.role === "user" && message.meta?.optimistic === true);
  if (canonicalUsers.length === 0 || optimisticUsers.length === 0) {
    return { messages: previousMessages, droppedIds: [] };
  }

  // 先按 requestId 精确配对：同一次发送的本地气泡与主进程乐观消息共用该 id，
  // 不受正文展开、占位文案或时间精度影响。即使权威消息已在上一帧出现，也允许
  // 用它确认并移除本地副本。
  const matchedLocalIndexes = new Set<number>();
  const matchedAuthoritativeIndexes = new Set<number>();
  canonicalUsers.forEach((authoritative, authoritativeIndex) => {
    const requestId = optimisticRequestId(authoritative);
    if (!requestId) return;
    const exact = optimisticUsers.find(
      (candidate) =>
        !matchedLocalIndexes.has(candidate.index)
        && optimisticRequestId(candidate.message) === requestId,
    );
    if (!exact) return;
    matchedLocalIndexes.add(exact.index);
    matchedAuthoritativeIndexes.add(authoritativeIndex);
  });

  // 内容配对只允许使用快照里新出现、且不带发送身份的 user：已在上一帧出现
  // 过的同 id 消息不能吞掉本地气泡（例如发送失败后再次收到旧快照）；带
  // requestId 的权威消息只能走精确配对，不能再用正文消费第二个本地气泡。
  // 相同文本可能连续出现，每个权威 user 只认时间最近的一条本地气泡，避免
  // 误删更早的失败气泡。
  const contentCandidates = canonicalUsers.filter(
    (message, index) =>
      !matchedAuthoritativeIndexes.has(index)
      && !optimisticRequestId(message)
      && !previousIds.has(message.id),
  );
  for (const authoritative of contentCandidates) {
    let bestIndex = -1;
    let bestTimestamp = Number.NEGATIVE_INFINITY;
    for (const candidate of optimisticUsers) {
      if (matchedLocalIndexes.has(candidate.index)) continue;
      if (!sameOptimisticContent(candidate.message, authoritative)) continue;
      if (!sameOptimisticTime(candidate.message, authoritative)) continue;
      const candidateTime = timestampMs(candidate.message.timestamp);
      if (candidateTime > bestTimestamp) {
        bestTimestamp = candidateTime;
        bestIndex = candidate.index;
      }
    }
    if (bestIndex >= 0) matchedLocalIndexes.add(bestIndex);
  }

  if (matchedLocalIndexes.size === 0) {
    return { messages: previousMessages, droppedIds: [] };
  }
  return {
    messages: previousMessages.filter((_, index) => !matchedLocalIndexes.has(index)),
    droppedIds: [...matchedLocalIndexes].map((index) => previousMessages[index].id),
  };
}

/**
 * 把仍在等待确认的本地 user 气泡插到「它之后产生的权威消息」之前。
 *
 * 典型场景：本地 [u1, pending]，旧快照带回 [u1, assistant]；assistant 是
 * pending 触发的回复，时间晚于本地气泡，不能把 user 排到 assistant 后面。
 * 只把 candidateIds 中、不在 previousIds 里的新消息当作候选；更新已有的
 * assistant 时不移动 pending，避免流式更新时间戳造成错位。
 */
export function insertOptimisticMessagesBeforeNewer(
  target: ChatMessage[],
  pending: readonly ChatMessage[],
  candidateIds: ReadonlySet<string>,
  previousIds: ReadonlySet<string>,
  candidateStart = 0,
): ChatMessage[] {
  if (pending.length === 0) return target;
  const result = [...target];
  for (const message of pending) {
    let insertAt = -1;
    for (let index = Math.max(0, candidateStart); index < result.length; index += 1) {
      const candidate = result[index];
      if (!candidateIds.has(candidate.id) || previousIds.has(candidate.id)) continue;
      if (timestampMs(candidate.timestamp) >= timestampMs(message.timestamp)) {
        insertAt = index;
        break;
      }
    }
    if (insertAt >= 0) result.splice(insertAt, 0, message);
    else result.push(message);
  }
  return result;
}
