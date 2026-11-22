import type { TimelineRowModel } from "../components/session/timeline/virtualTimelineGeometry";

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
	/** Only committed identities may carry an optimistic row into its accepted message. */
	committedRowModel: TimelineRowModel | null;
	measuredHeights: Map<string, number>;
	nodeMap: Map<string, RowRegistrationRecord>;
	/** DOM captures stay in DOM space. An upward landing in a spacer temporarily
	 * measures its offset from the row end through lazy expansion. */
	readingAnchor: {
		rowKey: string;
		offsetTop: number;
		coordinateSource?: "dom" | "geometry" | "geometry-end";
		/** Height when the end was last aligned with settled content. */
		settledHeight?: number;
	} | null;
	/** Raw position last included in intent; catches input whose scroll event is still queued. */
	readingAnchorScrollTop: number | null;
	/** Last applied correction; its native notifications are not new reader intent. */
	programmaticScrollTop: number | null;
	pendingRestore: { messageId: string; offsetTop: number; keepReading?: boolean; offsetBottom?: number } | null;
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
		committedRowModel: null,
		measuredHeights: new Map(),
		nodeMap: new Map(),
		readingAnchor: null,
		readingAnchorScrollTop: null,
		programmaticScrollTop: null,
		pendingRestore: null,
		scheduledRaf: null,
		pendingEntries: new Map(),
	};
}
