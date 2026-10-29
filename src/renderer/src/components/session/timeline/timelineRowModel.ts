import type { ChatMessage } from "../../../../../shared/types";
import type { RenderMessage } from "../../app/AppUtils";

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

/**
 * 构建稳定顶层行模型。
 */
export function buildTimelineRowModel(
	items: readonly RenderMessage[],
	options: { sessionId?: string } = {},
): TimelineRowModel {
	const rows: VirtualTimelineRow[] = [];
	const indexByKey = new Map<TimelineRowKey, number>();
	const rowKeyByMessageId = new Map<string, TimelineRowKey>();

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

			for (const sub of item.items) {
				if (sub.kind === "message") {
					messageIds.add(sub.message.id);
				} else if (sub.kind === "tool-group") {
					for (const m of sub.messages) messageIds.add(m.id);
				} else if (sub.kind === "thinking-group") {
					for (const m of sub.messages) messageIds.add(m.id);
				}
			}

			const messageIdsArr = Object.freeze(Array.from(messageIds));
			const row: VirtualTimelineRow = {
				key: rowKey,
				anchorId: item.id,
				item,
				sourceIndex: i,
				messageIds: messageIdsArr,
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
			const rowKey: TimelineRowKey = `message:${message.id}`;
			const messageIdsArr = Object.freeze([message.id]);

			const row: VirtualTimelineRow = {
				key: rowKey,
				anchorId: message.id,
				item,
				sourceIndex: i,
				messageIds: messageIdsArr,
			};

			rows.push(row);
			indexByKey.set(rowKey, rowIndex);
			rowKeyByMessageId.set(message.id, rowKey);

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
