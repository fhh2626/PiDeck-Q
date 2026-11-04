import type { VirtualTimelineRow, VirtualTimelineGeometry } from "../components/session/timeline/virtualTimelineGeometry";

/**
 * 针对单个会话生命周期的独立测量上下文。
 * 每次 sessionId 变更或会话重建时实例化独立对象（具有唯一数字 id），
 * 杜绝跨会话的代次错乱与旧通知污染。
 */
export interface TimelineSessionContext {
	readonly id: number;
	readonly sessionId: string | undefined;
	widthEpoch: number;
	lastObservedListWidth: number | null;
	measuredHeights: Map<string, number>;
	nodeMap: Map<string, RowRegistrationRecord>;
	readingAnchor: { rowKey: string; offsetTop: number } | null;
	pendingRestore: { messageId: string; offsetTop: number } | null;
	scheduledRaf: number | null;
	pendingEntries: Map<string, PendingEntryRecord>;
}

export interface RowRegistrationRecord {
	readonly key: string;
	readonly node: HTMLElement;
	readonly lease: number;
	readonly contextId: number;
	widthEpoch: number;
}

export interface PendingEntryRecord {
	readonly key: string;
	readonly node: HTMLElement;
	readonly lease: number;
	readonly contextId: number;
	readonly widthEpoch: number;
	readonly height: number;
}

export function createTimelineSessionContext(
	id: number,
	sessionId: string | undefined,
): TimelineSessionContext {
	return {
		id,
		sessionId,
		widthEpoch: 0,
		lastObservedListWidth: null,
		measuredHeights: new Map(),
		nodeMap: new Map(),
		readingAnchor: null,
		pendingRestore: null,
		scheduledRaf: null,
		pendingEntries: new Map(),
	};
}
