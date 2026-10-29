import type {
	VirtualTimelineRow,
	TimelineRowKey,
	TimelineRowModel,
} from "./timelineRowModel.ts";
export * from "./timelineRowModel.ts";

/**
 * 虚拟时间线纯几何模型与二分查找算法。
 *
 * 遵循计划设计：
 * - offsets[0] = 0
 * - gapAfter(i) = i < n - 1 ? gap : 0
 * - offsets[i + 1] = offsets[i] + h[i] + gapAfter(i)
 * - totalHeight = offsets[n]
 * - 最后一逻辑行不带间距
 */

export interface VirtualTimelineGeometry {
	rows: readonly VirtualTimelineRow[];
	heights: readonly number[];
	prefixOffsets: readonly number[];
	totalHeight: number;
	gap: number;
	indexByKey: ReadonlyMap<TimelineRowKey, number>;
}

/** 初始估计高度（px） */
export const ESTIMATED_ROW_HEIGHTS = {
	user: 180,
	"agent-run": 320,
	diagnostic: 120,
	compaction: 120,
	default: 160,
} as const;

export function getEstimatedRowHeight(item: VirtualTimelineRow["item"]): number {
	if (item.kind === "agent-run") {
		return ESTIMATED_ROW_HEIGHTS["agent-run"];
	}
	if (item.kind === "message") {
		if (item.message.role === "user") {
			return ESTIMATED_ROW_HEIGHTS.user;
		}
		if (item.message.role === "error") {
			return ESTIMATED_ROW_HEIGHTS.diagnostic;
		}
		const meta = item.message.meta as Record<string, unknown> | undefined;
		if (meta?.type === "compaction") {
			return ESTIMATED_ROW_HEIGHTS.compaction;
		}
		return ESTIMATED_ROW_HEIGHTS.diagnostic;
	}
	return ESTIMATED_ROW_HEIGHTS.default;
}

/** 默认行间距（px），与 foundation.css 中的 --density-turn-gap (12px) 对应 */
export const DEFAULT_TIMELINE_ROW_GAP = 12;

/**
 * 计算/刷新前缀和高度数组。
 */
export function computeTimelineGeometry(
	rows: readonly VirtualTimelineRow[],
	measuredHeights: ReadonlyMap<string, number>,
	gap = DEFAULT_TIMELINE_ROW_GAP,
): VirtualTimelineGeometry {
	const count = rows.length;
	const heights = new Array<number>(count);
	const prefixOffsets = new Array<number>(count + 1);
	const indexByKey = new Map<TimelineRowKey, number>();
	prefixOffsets[0] = 0;

	for (let i = 0; i < count; i += 1) {
		const row = rows[i];
		indexByKey.set(row.key, i);
		const measured = measuredHeights.get(row.key);
		const h = measured !== undefined && measured > 0 ? measured : getEstimatedRowHeight(row.item);
		heights[i] = h;
		const gapAfter = i < count - 1 ? gap : 0;
		prefixOffsets[i + 1] = prefixOffsets[i] + h + gapAfter;
	}

	return {
		rows,
		heights: Object.freeze(heights),
		prefixOffsets: Object.freeze(prefixOffsets),
		totalHeight: count > 0 ? prefixOffsets[count] : 0,
		gap,
		indexByKey,
	};
}

/**
 * 通过二分查找在 [startOffset, endOffset) 区间内定位相交的行索引区间 [startIndex, endIndex)。
 * viewportTop 应传入以 listOrigin 修正后的 list-local 坐标。
 */
export function findVisibleRowRange(
	geometry: VirtualTimelineGeometry,
	viewportTopInList: number,
	viewportHeight: number,
	overscan?: number,
): { startIndex: number; endIndex: number } {
	const count = geometry.rows.length;
	if (count === 0 || viewportHeight <= 0) {
		return { startIndex: 0, endIndex: 0 };
	}

	const buffer = overscan !== undefined ? overscan : Math.max(400, viewportHeight * 0.5);
	const rangeTop = Math.max(0, viewportTopInList - buffer);
	const rangeBottom = viewportTopInList + viewportHeight + buffer;

	// 二分查找第一个 rowEnd > rangeTop 的行
	let low = 0;
	let high = count - 1;
	let startIndex = count;

	while (low <= high) {
		const mid = (low + high) >> 1;
		const rowEnd = geometry.prefixOffsets[mid + 1];
		if (rowEnd > rangeTop) {
			startIndex = mid;
			high = mid - 1;
		} else {
			low = mid + 1;
		}
	}

	if (startIndex >= count) {
		return { startIndex: Math.max(0, count - 1), endIndex: count };
	}

	// 二分查找第一个 rowStart >= rangeBottom 的行作为 exclusive endIndex
	low = startIndex;
	high = count - 1;
	let endIndex = count;

	while (low <= high) {
		const mid = (low + high) >> 1;
		const rowStart = geometry.prefixOffsets[mid];
		if (rowStart >= rangeBottom) {
			endIndex = mid;
			high = mid - 1;
		} else {
			low = mid + 1;
		}
	}

	return {
		startIndex,
		endIndex: Math.max(startIndex + 1, endIndex),
	};
}

export type TimelineRenderEntry =
	| {
			kind: "row";
			key: TimelineRowKey;
			rowIndex: number;
			row: VirtualTimelineRow;
			gapAfter: number;
	  }
	| {
			kind: "spacer";
			key: string;
			startIndex: number;
			endIndex: number;
			height: number;
	  };

/**
 * 离散挂载计划：
 * 输入连续可见区间 [startIndex, endIndex) 与离散 pinned 行 keys 集合，
 * 按照原始逻辑顺序合并挂载，并在所有未挂载区间输出正确高度的 spacer。
 * 保证：所有 spacer 高度 + 所有挂载行高度及其实际 gapAfter === geometry.totalHeight。
 */
export function buildTimelineRenderPlan(
	geometry: VirtualTimelineGeometry,
	visibleRange: { startIndex: number; endIndex: number },
	pinnedKeys: ReadonlySet<TimelineRowKey> = new Set(),
): readonly TimelineRenderEntry[] {
	const count = geometry.rows.length;
	if (count === 0) {
		return Object.freeze([]);
	}

	const mountedIndices = new Set<number>();
	for (let i = visibleRange.startIndex; i < visibleRange.endIndex; i += 1) {
		if (i >= 0 && i < count) {
			mountedIndices.add(i);
		}
	}

	for (const key of pinnedKeys) {
		const idx = geometry.indexByKey.get(key);
		if (idx !== undefined && idx >= 0 && idx < count) {
			mountedIndices.add(idx);
		}
	}

	if (mountedIndices.size === 0) {
		return Object.freeze([
			{
				kind: "spacer",
				key: `spacer:0-${count}`,
				startIndex: 0,
				endIndex: count,
				height: geometry.totalHeight,
			},
		]);
	}

	const sortedIndices = Array.from(mountedIndices).sort((a, b) => a - b);
	const plan: TimelineRenderEntry[] = [];
	let cursor = 0;

	for (const i of sortedIndices) {
		if (cursor < i) {
			const spacerHeight = geometry.prefixOffsets[i] - geometry.prefixOffsets[cursor];
			if (spacerHeight > 0) {
				plan.push({
					kind: "spacer",
					key: `spacer:${cursor}-${i}`,
					startIndex: cursor,
					endIndex: i,
					height: spacerHeight,
				});
			}
		}

		const row = geometry.rows[i];
		const gapAfter = i < count - 1 ? geometry.gap : 0;
		plan.push({
			kind: "row",
			key: row.key,
			rowIndex: i,
			row,
			gapAfter,
		});

		cursor = i + 1;
	}

	if (cursor < count) {
		const spacerHeight = geometry.totalHeight - geometry.prefixOffsets[cursor];
		if (spacerHeight > 0) {
			plan.push({
				kind: "spacer",
				key: `spacer:${cursor}-${count}`,
				startIndex: cursor,
				endIndex: count,
				height: spacerHeight,
			});
		}
	}

	return Object.freeze(plan);
}

/**
 * 坐标计算辅助：统一视口坐标与 list 原点。
 */
export function calculateListOrigin(
	listElement: HTMLElement | null,
	viewportElement: HTMLElement | null,
): number {
	if (!listElement || !viewportElement) return 0;
	const listRect = listElement.getBoundingClientRect();
	const viewportRect = viewportElement.getBoundingClientRect();
	const viewportOriginY = viewportRect.top + viewportElement.clientTop;
	return listRect.top - viewportOriginY + viewportElement.scrollTop;
}

/**
 * 按照 signed offsetTop 恢复目标 scrollTop：
 * restoreScrollTop = listOrigin + prefixOffsets[index] - offsetTop
 */
export function resolveAnchorScrollTop(
	geometry: VirtualTimelineGeometry,
	rowIndex: number,
	offsetTop: number,
	listOrigin = 0,
): number {
	if (rowIndex < 0 || rowIndex >= geometry.rows.length) return 0;
	const rowStart = geometry.prefixOffsets[rowIndex] ?? 0;
	return listOrigin + rowStart - offsetTop;
}
