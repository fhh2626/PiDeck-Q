import type { ChatMessage } from "../../../../../shared/types";
import type { RenderMessage } from "../../app/AppUtils";
import { timelineAnchorIdentity } from "../../../hooks/timelineScrollAnchor.ts";

export const FLOATING_FAILURE_KEYS = new Set([
	"diagnostic.requestFailed",
	"diagnostic.requestFailedAfterRetries",
	"diagnostic.requestFailedUnknown",
	"diagnostic.requestFailedUnknownAfterRetries",
	"diagnostic.agentStopped",
	"diagnostic.promptRejected",
	"diagnostic.promptDeliveryUnknown",
	"diagnostic.commandFailed",
	"diagnostic.commandDeliveryUnknown",
	"diagnostic.commandCancelled",
	"diagnostic.processReconnectFailed",
	"diagnostic.historyLoadFailed",
	"diagnostic.extensionError",
	"diagnostic.retryScheduled",
	"diagnostic.retryScheduledAfterDelay",
	"diagnostic.retrySucceeded",
	"diagnostic.retryFailed",
]);

/** 判断消息是否为「失败/重试类」提示（时间线不渲染、改 toast）。 */
export function isFloatingFailureMessage(message: ChatMessage): boolean {
	const key = (message.meta as Record<string, unknown> | undefined)?.i18nKey;
	return typeof key === "string" && FLOATING_FAILURE_KEYS.has(key);
}

export type TimelineRowKey = string;

export type TimelineRowItem = Extract<
	RenderMessage,
	{ kind: "message" | "agent-run" }
>;

export interface VirtualTimelineRow {
	key: TimelineRowKey;
	anchorId: string;
	item: TimelineRowItem;
	sourceIndex: number;
	messageIds: readonly string[];
	anchorIdentity?: ReturnType<typeof timelineAnchorIdentity>;
	/** Internal continuity evidence; replaced request IDs are never public message aliases. */
	optimisticRequestId?: string;
}

export interface TimelineRowModel {
	rows: readonly VirtualTimelineRow[];
	indexByKey: ReadonlyMap<TimelineRowKey, number>;
	rowKeyByMessageId: ReadonlyMap<string, TimelineRowKey>;
	lastAgentRunKey: TimelineRowKey | null;
	latestItemKey: TimelineRowKey | null;
}

/**
 * 判断 RenderMessage 是否属于真实需要在时间线中渲染的顶层行。
 * 排除 floating failure、askQuestion 等不占 DOM 顶层行的条目。
 */
export function isRenderableTimelineItem(item: RenderMessage, sessionId?: string): boolean {
	if (item.kind === "agent-run") {
		return true;
	}
	if (item.kind === "message") {
		const message = item.message;
		if (message.role === "user") {
			return true;
		}
		if (message.role === "error") {
			return !isFloatingFailureMessage(message);
		}
		if (message.role === "system") {
			const meta = message.meta as Record<string, unknown> | undefined;
			if (meta?.type === "askQuestion") {
				return false;
			}
			if (meta?.type === "compaction") {
				return Boolean(sessionId);
			}
			return !isFloatingFailureMessage(message);
		}
	}
	return false;
}

/** Keep an existing user row only when its exact ID or unique request identity continues. */
function continuedUserRows(
	items: readonly RenderMessage[],
	previousModel?: TimelineRowModel | null,
): ReadonlyMap<string, VirtualTimelineRow> {
	const previousById = new Map<string, VirtualTimelineRow>();
	const previousByRequest = new Map<string, Set<VirtualTimelineRow>>();
	for (const row of previousModel?.rows ?? []) {
		if (row.item.kind !== "message" || row.item.message.role !== "user") continue;
		previousById.set(row.item.message.id, row);
		const requestId = row.optimisticRequestId ?? row.item.message.meta?.optimisticRequestId;
		const identities = new Set(row.messageIds);
		if (typeof requestId === "string" && requestId) identities.add(requestId);
		for (const id of identities) {
			const candidates = previousByRequest.get(id) ?? new Set<VirtualTimelineRow>();
			candidates.add(row);
			previousByRequest.set(id, candidates);
		}
	}
	const currentIds = new Set<string>();
	const reservedKeys = new Set<string>();
	const requestCounts = new Map<string, number>();
	for (const item of items) {
		if (item.kind !== "message") continue;
		currentIds.add(item.message.id);
		reservedKeys.add(`message:${item.message.id}`);
		const requestId = item.message.role === "user" ? item.message.meta?.optimisticRequestId : undefined;
		if (typeof requestId === "string" && requestId) requestCounts.set(requestId, (requestCounts.get(requestId) ?? 0) + 1);
	}
	const continued = new Map<string, VirtualTimelineRow>();
	// Reserve every surviving exact identity before considering request-based replacements.
	for (const item of items) {
		if (item.kind !== "message" || item.message.role !== "user") continue;
		const previous = previousById.get(item.message.id);
		if (previous && (previous.key === `message:${item.message.id}` || !reservedKeys.has(previous.key))) {
			continued.set(item.message.id, previous);
			reservedKeys.add(previous.key);
		}
	}
	for (const item of items) {
		if (item.kind !== "message" || item.message.role !== "user" || continued.has(item.message.id)) continue;
		const requestId = item.message.meta?.optimisticRequestId;
		if (typeof requestId !== "string" || requestCounts.get(requestId) !== 1) continue;
		const candidates = [...(previousByRequest.get(requestId) ?? [])].filter((row) => !currentIds.has(row.anchorId));
		if (candidates.length !== 1) continue;
		const previous = candidates[0];
		if (reservedKeys.has(previous.key) && previous.key !== `message:${item.message.id}`) continue;
		continued.set(item.message.id, previous);
		reservedKeys.add(previous.key);
	}
	return continued;
}

/**
 * 构建稳定顶层行模型。
 */
export function buildTimelineRowModel(
	items: readonly RenderMessage[],
	options: { sessionId?: string; previousModel?: TimelineRowModel | null } = {},
): TimelineRowModel {
	const rows: VirtualTimelineRow[] = [];
	const indexByKey = new Map<TimelineRowKey, number>();
	const rowKeyByMessageId = new Map<string, TimelineRowKey>();
	const continuedUsers = continuedUserRows(items, options.previousModel);

	let lastAgentRunKey: TimelineRowKey | null = null;
	let latestItemKey: TimelineRowKey | null = null;

	let rowIndex = 0;
	for (let i = 0; i < items.length; i += 1) {
		const item = items[i];
		if (!isRenderableTimelineItem(item, options.sessionId)) {
			continue;
		}

		if (item.kind === "agent-run") {
			const rowKey: TimelineRowKey = `run:${item.id}`;
			const messageIds = new Set<string>();
			messageIds.add(item.id);
			let anchorIdentity: VirtualTimelineRow["anchorIdentity"];
			const addMessageId = (message: ChatMessage) => {
				messageIds.add(message.id);
				if (message.id === item.id) anchorIdentity = timelineAnchorIdentity(message);
			};
			for (const sub of item.items) {
				if (sub.kind === "message") {
					addMessageId(sub.message);
				} else if (sub.kind === "tool-group" || sub.kind === "thinking-group") {
					for (const m of sub.messages) addMessageId(m);
				}
			}

			const messageIdsArr = Object.freeze(Array.from(messageIds));
			const row: VirtualTimelineRow = {
				key: rowKey,
				anchorId: item.id,
				item,
				sourceIndex: i,
				messageIds: messageIdsArr,
				anchorIdentity,
			};

			rows.push(row);
			indexByKey.set(rowKey, rowIndex);
			for (const id of messageIdsArr) {
				rowKeyByMessageId.set(id, rowKey);
			}

			lastAgentRunKey = rowKey;
			latestItemKey = rowKey;
			rowIndex += 1;
		} else if (item.kind === "message") {
			const message = item.message;
			const previous = continuedUsers.get(message.id);
			const rowKey: TimelineRowKey = previous?.key ?? `message:${message.id}`;
			const messageIdsArr = Object.freeze([message.id]);
			const requestId = message.meta?.optimisticRequestId ?? previous?.optimisticRequestId;

			const row: VirtualTimelineRow = {
				key: rowKey,
				anchorId: message.id,
				item,
				sourceIndex: i,
				messageIds: messageIdsArr,
				anchorIdentity: timelineAnchorIdentity(message),
				...(message.role === "user" && typeof requestId === "string" && requestId
					? { optimisticRequestId: requestId } : {}),
			};

			rows.push(row);
			indexByKey.set(rowKey, rowIndex);
			for (const id of messageIdsArr) rowKeyByMessageId.set(id, rowKey);

			latestItemKey = rowKey;
			rowIndex += 1;
		}
	}

	return {
		rows: Object.freeze(rows),
		indexByKey,
		rowKeyByMessageId,
		lastAgentRunKey,
		latestItemKey,
	};
}
