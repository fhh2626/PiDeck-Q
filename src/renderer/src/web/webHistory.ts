import { WEB_TIMELINE_MIN_DISPLAY_ITEMS } from "./webTurnWindow";

/**
 * Web 历史分页是否还能再翻。
 * 游标存在 ref 里、首页失败、或只合并了 runtime 窗口时，
 * 不能把「没有 nextBefore」当成已经到顶——否则长会话滚到底/顶都看不到加载入口。
 */
export type WebHistoryMeta = {
	total: number;
	nextBefore: number | null;
	nextBeforeEntryId?: string;
	indexVersion?: string;
	status?: "ready" | "error";
};

/** 已成功加载的页：tail 首屏/重建，older 向前翻页。 */
export type WebHistoryPageCursors = {
	total?: number;
	nextBefore: number | null;
	nextBeforeEntryId?: string;
	indexVersion?: string;
};

/**
 * 首屏历史页返回后该怎么处置（2026-12）。
 * - skip：用户已切走，不得 setMessages（否则串台）。
 * - defer：仍在该会话但正在流式，不能 setMessages（会与 SSE 写入冲突），
 *   流结束后由 WebChatApp 的补注入 effect 用缓存整体替换。
 * - apply：空闲且仍是当前会话，直接注入。
 */
export function decideHistoryApply(
	isActive: boolean,
	streaming: boolean,
): "apply" | "defer" | "skip" {
	if (!isActive) return "skip";
	return streaming ? "defer" : "apply";
}

/** 首屏自动补页的最大连续次数（超过就停下等用户手动上滚）。 */
export const WEB_HISTORY_TOP_UP_MAX_ATTEMPTS = 3;

/**
 * 首屏历史合并后是否还需要自动补一页更早历史（2026-12 用户要求：至少 100 个显示单元）。
 * 三个条件缺一不可：单元数不足、仍有更早游标、未超过补页次数上限。
 * 限次是为了避免「空页/游标不动」时形成请求循环。
 */
export function needsWebHistoryTopUp(
	itemCount: number,
	meta: WebHistoryMeta | undefined,
	attempts: number,
): boolean {
	if (itemCount >= WEB_TIMELINE_MIN_DISPLAY_ITEMS) return false;
	if (attempts >= WEB_HISTORY_TOP_UP_MAX_ATTEMPTS) return false;
	return meta?.nextBefore != null;
}

export function hasMoreWebHistory(input: {
	meta?: WebHistoryMeta;
	loaded: boolean;
	catalogMessageCount?: number;
}): boolean {
	if (input.meta?.nextBefore != null) return true;
	// 首页已成功且游标到顶：短会话 / 已翻完。
	if (input.loaded && input.meta?.status === "ready") return false;
	// 尚未拉过首页，或首页失败：目录里有消息就仍应露出加载入口。
	const catalogCount = input.catalogMessageCount;
	if (typeof catalogCount === "number") return catalogCount > 0;
	return !input.loaded || input.meta?.status === "error";
}

/**
 * 点「加载更多」时能不能发请求。
 * 流式会先把会话标成 loaded，但不能因此把「还没拿到首页游标」当成到顶。
 */
export function canRequestWebHistoryPage(input: {
	loaded: boolean;
	meta?: WebHistoryMeta;
}): boolean {
	if (input.meta?.nextBefore != null) return true;
	if (input.meta?.status === "error") return true;
	if (!input.loaded) return true;
	// 流式提前标 loaded、首页还没回来：仍应拉尾页，而不是点了没反应。
	return input.meta?.status !== "ready";
}

/**
 * 首屏/重建尾页落地时的游标规则（2026-12 保留已加载历史）：
 * 首次成功初始化向前翻页的边界；已有边界时保留，不得因为一次更新的尾页
 * 把已向前推进的游标拽回尾部，否则已加载的更早页会被重复遍历。
 * 保留以「当前状态已 ready」为界：成功到顶的 null 边界同样是已确立边界，必须保留；
 * 而缺失状态或首屏失败（status=error）仍由新尾页重新初始化/恢复。
 */
export function applyWebHistoryTailPage(
	current: WebHistoryMeta | undefined,
	page: WebHistoryPageCursors,
): WebHistoryMeta {
	const advanced = current?.status === "ready"
		? { nextBefore: current.nextBefore, nextBeforeEntryId: current.nextBeforeEntryId }
		: { nextBefore: page.nextBefore, nextBeforeEntryId: page.nextBeforeEntryId };
	return {
		total: page.total ?? current?.total ?? 0,
		nextBefore: advanced.nextBefore,
		...(advanced.nextBeforeEntryId ? { nextBeforeEntryId: advanced.nextBeforeEntryId } : {}),
		...(page.indexVersion ? { indexVersion: page.indexVersion } : {}),
		status: "ready",
	};
}

/**
 * 更早一页落地：游标只能由服务器返回推进。
 * - page 为 null（请求失败）：保留旧游标，只在 status 上标记可重试。
 * - 游标未前进（历史被外部改写/锚点失效）：标记错误，避免无限重复请求同一页。
 * - 空消息页但游标前进：算成功，因为投影可能跳过整页原始条目。
 */
export function applyWebHistoryOlderPage(
	current: WebHistoryMeta | undefined,
	page: WebHistoryPageCursors | null,
): WebHistoryMeta {
	const base: WebHistoryMeta = {
		total: current?.total ?? 0,
		nextBefore: current?.nextBefore ?? null,
		...(current?.nextBeforeEntryId ? { nextBeforeEntryId: current.nextBeforeEntryId } : {}),
		...(current?.indexVersion ? { indexVersion: current.indexVersion } : {}),
	};
	if (!page) return { ...base, status: "error" };
	const didAdvance = current?.nextBefore == null || page.nextBefore !== current.nextBefore;
	if (!didAdvance) {
		return { ...base, status: "error" };
	}
	return {
		total: page.total ?? base.total,
		nextBefore: page.nextBefore,
		...(page.nextBeforeEntryId ? { nextBeforeEntryId: page.nextBeforeEntryId } : {}),
		...(page.indexVersion ? { indexVersion: page.indexVersion } : {}),
		status: "ready",
	};
}
