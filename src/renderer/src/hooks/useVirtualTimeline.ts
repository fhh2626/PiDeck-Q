import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { SessionScrollAnchor } from "../atoms";
import type { TimelineViewportAdapter, AnchorReading } from "../components/session/timeline/TimelineViewportAdapter";
import {
	buildMeasuredHeightAliases,
	buildTimelineRowModel,
	computeTimelineGeometry,
	findVisibleRowRange,
	buildTimelineRenderPlan,
	calculateListOrigin,
	resolveAnchorScrollTop,
	DEFAULT_TIMELINE_ROW_GAP,
	type VirtualTimelineGeometry,
	type TimelineRowKey,
	type TimelineRenderEntry,
	type TimelineRowModel,
} from "../components/session/timeline/virtualTimelineGeometry";
import type { RenderMessage } from "../components/app/AppUtils";
import { captureMountedTimelineAnchor, readMountedTimelineRow, readTimelineSpacerLanding, resolveMountedTimelineAnchorScrollTop } from "./timelineMountedAnchor";
import { useTimelineMeasurements } from "./useTimelineMeasurements";
import {
	createTimelineSessionContext,
	type TimelineSessionContext,
} from "./timelineMeasurementRegistry";

/**
 * 已提交给 DOM 渲染的虚拟列表快照。
 * 遵循计划要求：稳定回调、ResizeObserver 与 Adapter 一律读取该快照，
 * 杜绝闭包引用不同版本的 geometry 与旧 rows。
 */
interface CommittedVirtualTimelineSnapshot {
	sessionId: string | undefined;
	contextId: number;
	widthEpoch: number;
	rowModel: TimelineRowModel;
	geometry: VirtualTimelineGeometry;
	gap: number;
}

/** A browser clamp caused by layout is not pending reader input. */
function wasClampedByLayout(viewport: HTMLElement, observedTop: number): boolean {
	const maxTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
	return observedTop > maxTop + 2 && viewport.scrollTop >= maxTop - 2;
}

/** Find the estimated row containing the viewport top, including its trailing gap. */
function rowAtViewportTop(geometry: VirtualTimelineGeometry, localTop: number): number {
	return findVisibleRowRange(geometry, localTop, 1, 0).startIndex;
}

/** Match the browser's position read back immediately after the correction. */
function matchesProgrammaticScroll(context: TimelineSessionContext, top: number): boolean {
	return context.programmaticScrollTop === top;
}

/**
 * 虚拟列表 Hook：管理几何模型、ResizeObserver 测量、可见区间以及阅读位置唯一纠偏。
 */
export function useVirtualTimeline(params: {
	items: readonly RenderMessage[];
	viewportRef: RefObject<HTMLElement | null>;
	listRef?: RefObject<HTMLElement | null>;
	isFollowing: boolean;
	applyReaderScrollTop: (top: number, reason: "preserve-anchor" | "restore-reading" | "restore-session" | "jump-message") => void;
	sessionId?: string;
	adapterRef?: { current: TimelineViewportAdapter | null };
	pinnedKeys?: ReadonlySet<TimelineRowKey>;
}) {
	const {
		items,
		viewportRef,
		listRef,
		isFollowing,
		applyReaderScrollTop,
		sessionId,
		adapterRef,
		pinnedKeys = new Set<TimelineRowKey>(),
	} = params;

	// 稳定引用持久化 callback，彻底阻断 applyReaderScrollTop 引起的无条件 setGeometry 渲染循环
	const applyReaderScrollTopRef = useRef(applyReaderScrollTop);
	applyReaderScrollTopRef.current = applyReaderScrollTop;

	const isFollowingRef = useRef(isFollowing);
	isFollowingRef.current = isFollowing;

	// 会话级独立 context（由 render 阶段同步确定，杜绝 passive effect 自增导致的初始测量失效）
	// readingAnchorRef 移入 currentContext.readingAnchor，确保多会话与代次隔离
	const contextRef = useRef<TimelineSessionContext | null>(null);
	const nextContextIdRef = useRef(1);

	if (!contextRef.current || contextRef.current.sessionId !== sessionId) {
		if (contextRef.current?.scheduledRaf) {
			cancelAnimationFrame(contextRef.current.scheduledRaf);
		}
		contextRef.current = createTimelineSessionContext(nextContextIdRef.current++, sessionId);
	}
	const currentContext = contextRef.current;

	// Corrections themselves emit scroll events. Keep their actual (clamped /
	// rounded) position so those notifications cannot replace the reader's row.
	const applyReadingScrollTop = useCallback<typeof applyReaderScrollTop>((top, reason) => {
		currentContext.programmaticScrollTop = top;
		applyReaderScrollTopRef.current(top, reason);
		const actualTop = viewportRef.current?.scrollTop ?? null;
		currentContext.programmaticScrollTop = actualTop;
		currentContext.readingAnchorScrollTop = actualTop;
	}, [currentContext, viewportRef]);

	// 当前列表继承的 density gap（默认 12px）
	const gapRef = useRef<number>(DEFAULT_TIMELINE_ROW_GAP);

	// 测量版本号：当测量高度真正更新并导致几何变动时递增
	const [measurementRevision, setMeasurementRevision] = useState(0);
	const refreshMeasurements = useCallback(() => setMeasurementRevision((revision) => revision + 1), []);

	// 列表 DOM 节点（支持 callback ref 延迟挂载与 listRef 兼容）
	const [listNode, setListNode] = useState<HTMLElement | null>(listRef?.current ?? null);
	const listNodeRef = useRef<HTMLElement | null>(listNode);
	listNodeRef.current = listNode;

	const registerListNode = useCallback((node: HTMLElement | null) => {
		if (listRef && "current" in listRef) {
			(listRef as { current: HTMLElement | null }).current = node;
		}
		if (listNodeRef.current !== node) {
			listNodeRef.current = node;
			setListNode(node);
		}
	}, [listRef]);

	// 1. 构建当前最新的行模型
	const rowModel = useMemo(() => buildTimelineRowModel(items, {
		sessionId, previousModel: currentContext.committedRowModel,
	}), [items, sessionId, currentContext]);
	const rowModelRef = useRef(rowModel);
	rowModelRef.current = rowModel;
	const logicalRows = rowModel.rows;

	// 权威消息替换本地乐观气泡时，row key 会从 message:<requestId> 变成主进程 id。
	// 把旧行已测高度别名到新行，替换帧不需要先回退到估算高度再测量。
	const measuredHeightAliases = useMemo(
		() => buildMeasuredHeightAliases(logicalRows),
		[logicalRows],
	);

	// 2. 当前 render 的 geometry 必须直接由当前 rowModel.rows + 当前 context 有效测量缓存 + gap 派生！
	const geometry = useMemo(() => {
		const el = listNode ?? listRef?.current ?? viewportRef.current;
		if (el && typeof window !== "undefined" && typeof window.getComputedStyle === "function") {
			const style = window.getComputedStyle(el);
			const gapVal = parseFloat(style.getPropertyValue("--density-turn-gap"));
			if (!Number.isNaN(gapVal) && gapVal >= 0) {
				gapRef.current = gapVal;
			}
		}
		return computeTimelineGeometry(logicalRows, currentContext.measuredHeights, gapRef.current, measuredHeightAliases);
		// measurementRevision 驱动重新计算
	}, [logicalRows, currentContext, measurementRevision, listNode, listRef, viewportRef, measuredHeightAliases]);

	// 可见挂载区间
	const [visibleRange, setVisibleRange] = useState({
		startIndex: 0,
		endIndex: Math.min(20, Math.max(1, logicalRows.length)),
	});

	// 已提交快照 ref，保存当前最新的权威状态
	const committedSnapshotRef = useRef<CommittedVirtualTimelineSnapshot>({
		sessionId,
		contextId: currentContext.id,
		widthEpoch: currentContext.widthEpoch,
		rowModel,
		geometry,
		gap: gapRef.current,
	});

	// Only actual scroll handling (or first-read initialization) records new intent.
	const recordReadingAnchor = useCallback((movingUp = false, following = isFollowingRef.current): AnchorReading => {
		const snapshot = committedSnapshotRef.current;
		const viewport = viewportRef.current;
		if (!viewport || snapshot.geometry.rows.length === 0) {
			return { status: "unresolved" };
		}

		if (following) {
			currentContext.readingAnchor = null;
			currentContext.readingAnchorScrollTop = null;
			return { status: "at-bottom" };
		}

		const effectiveList = listNodeRef.current ?? listRef?.current ?? null;
		const listOrigin = calculateListOrigin(effectiveList, viewport);
		const viewportTopInList = viewport.scrollTop - listOrigin;

		// The DOM may already contain a newly mounted tall code block while
		// prefixOffsets still await the measurement batch. Anchor what is visible
		// now so committing that batch does not double-correct the user's scroll.
		const mountedRows = { nodes: currentContext.nodeMap, viewport, contextId: snapshot.contextId, widthEpoch: snapshot.widthEpoch };
		const mountedAnchor = captureMountedTimelineAnchor({ ...mountedRows, geometry: snapshot.geometry });
		const prior = currentContext.readingAnchor;
		// A lower DOM hit does not rule out a spacer at the viewport top.
		const spacer = (movingUp || prior?.coordinateSource === "geometry-end") && (!mountedAnchor || mountedAnchor.offsetTop > 1)
			? readTimelineSpacerLanding(snapshot.geometry, effectiveList, viewport) : null;
		const index = spacer?.index ?? rowAtViewportTop(snapshot.geometry, viewportTopInList);
		const estimatedRow = snapshot.geometry.rows[index];
		// A reversal inside the same unresolved row changes the distance, not
		// the edge the reader entered from.
		const fromEnd = !!spacer && (prior?.rowKey === estimatedRow.key
			? prior.coordinateSource === "geometry-end" : movingUp);
		let domAnchor = fromEnd ? null : mountedAnchor;
		const observedTop = currentContext.readingAnchorScrollTop;
		if (!fromEnd && prior?.coordinateSource === "dom" && observedTop !== null) {
			const rect = readMountedTimelineRow(mountedRows, prior.rowKey);
			const offsetTop = prior.offsetTop + observedTop - viewport.scrollTop;
			// A preceding row may have grown before the native scroll event. If
			// the prior passage should still cover the top or border the row gap,
			// apply only the user's delta and compensate the growth separately.
			if (rect && snapshot.geometry.indexByKey.has(prior.rowKey) && offsetTop <= snapshot.geometry.gap && offsetTop + rect.height > 0) {
				const actualTop = rect.top - viewport.getBoundingClientRect().top - viewport.clientTop;
				if (Math.abs(actualTop - offsetTop) >= 1) domAnchor = { rowKey: prior.rowKey, offsetTop };
			}
		}
		const targetIndex = domAnchor ? snapshot.geometry.indexByKey.get(domAnchor.rowKey) ?? index : index;
		const targetRow = snapshot.geometry.rows[targetIndex];
		const offsetTop = domAnchor?.offsetTop ?? snapshot.geometry.prefixOffsets[index] - (spacer?.localTop ?? viewportTopInList);
		// When entering an unmounted row from below, a taller measurement adds
		// content above the approach edge. Keep that edge fixed, not the row top.
		currentContext.readingAnchor = {
			rowKey: targetRow.key,
			offsetTop: fromEnd ? offsetTop + snapshot.geometry.heights[index] : offsetTop,
			coordinateSource: domAnchor ? "dom" : fromEnd ? "geometry-end" : "geometry",
		};
		currentContext.readingAnchorScrollTop = viewport.scrollTop;

		const anchor: SessionScrollAnchor = {
			messageId: targetRow.anchorId,
			offsetTop,
			...(fromEnd ? { offsetBottom: currentContext.readingAnchor.offsetTop } : {}),
			visibleCount: 0,
			savedAt: Date.now(),
		};

		return {
			status: "resolved",
			anchor,
		};
	}, [currentContext, viewportRef, listRef]);

	// Controller persistence reads must not overwrite the pending compensation
	// baseline after DOM growth but before the measurement batch commits.
	const captureReadingAnchor = useCallback((options?: Parameters<TimelineViewportAdapter["captureReadingAnchor"]>[0]): AnchorReading => {
		const viewport = viewportRef.current;
		const snapshot = committedSnapshotRef.current;
		if (!viewport || snapshot.contextId !== currentContext.id || snapshot.geometry.rows.length === 0) return { status: "unresolved" };
		const saved = currentContext.readingAnchor;
		const index = saved ? snapshot.geometry.indexByKey.get(saved.rowKey) : undefined;
		const following = options?.following ?? isFollowingRef.current;
		const priorTop = currentContext.readingAnchorScrollTop ?? viewport.scrollTop;
		const ignoreDelta = wasClampedByLayout(viewport, priorTop) || matchesProgrammaticScroll(currentContext, viewport.scrollTop);
		if (following || !saved || index === undefined || (options?.departing && !ignoreDelta && priorTop !== viewport.scrollTop)) {
			return recordReadingAnchor(priorTop > viewport.scrollTop, following);
		}
		const mountedRow = saved.coordinateSource === "geometry-end" ? readMountedTimelineRow({
			nodes: currentContext.nodeMap, viewport, contextId: currentContext.id, widthEpoch: currentContext.widthEpoch,
		}, saved.rowKey) : null;
		const delta = ignoreDelta ? 0 : priorTop - viewport.scrollTop;
		const offsetTop = saved.offsetTop - (saved.coordinateSource === "geometry-end" ? mountedRow?.height ?? snapshot.geometry.heights[index] : 0);
		return {
			status: "resolved",
			anchor: {
				messageId: snapshot.geometry.rows[index].anchorId,
				// A compositor scroll can precede the native scroll notification.
				// Include only that raw delta, without recapturing post-growth DOM.
				offsetTop: offsetTop + delta,
				...(saved.coordinateSource === "geometry-end" ? { offsetBottom: saved.offsetTop + delta } : {}),
				visibleCount: 0,
				savedAt: Date.now(),
			},
		};
	}, [currentContext, viewportRef, recordReadingAnchor]);

	// Preserve compositor-applied input before dropping measured heights can shrink
	// the spacers and clamp scrollTop. Once that happens the two deltas are inseparable.
	const preservePendingReaderInput = useCallback(() => {
		const viewport = viewportRef.current;
		const anchor = currentContext.readingAnchor;
		const observedTop = currentContext.readingAnchorScrollTop;
		if (!viewport || !anchor || isFollowingRef.current || observedTop === null) return;
		const currentTop = viewport.scrollTop;
		if (currentTop === observedTop || matchesProgrammaticScroll(currentContext, currentTop) || wasClampedByLayout(viewport, observedTop)) return;
		const snapshot = committedSnapshotRef.current;
		// The native scroll event may not have arrived before a layout commit.
		// Only switch anchors if the viewport really crossed into a spacer.
		const spacer = snapshot.contextId === currentContext.id && currentTop < observedTop
			? readTimelineSpacerLanding(snapshot.geometry, listNodeRef.current ?? listRef?.current ?? null, viewport) : null;
		if (spacer && spacer.index < (snapshot.geometry.indexByKey.get(anchor.rowKey) ?? -1)) {
			const { index, localTop } = spacer;
			currentContext.readingAnchor = {
				rowKey: snapshot.geometry.rows[index].key,
				offsetTop: snapshot.geometry.prefixOffsets[index] + snapshot.geometry.heights[index] - localTop,
				coordinateSource: "geometry-end",
			};
		} else {
			currentContext.readingAnchor = { ...anchor, offsetTop: anchor.offsetTop + observedTop - currentTop };
		}
		currentContext.readingAnchorScrollTop = currentTop;
	}, [currentContext, viewportRef, listRef]);

	const beforeWidthInvalidation = useCallback(() => {
		preservePendingReaderInput();
		const anchor = currentContext.readingAnchor;
		if (anchor?.coordinateSource !== "geometry-end" || anchor.settledHeight === undefined) return;
		const row = currentContext.nodeMap.get(anchor.rowKey);
		if (!row || row.node.querySelector("[data-md-plain-stream]")) return;
		// Only convert after a previous correction aligned the settled content.
		// The current DOM can already have expanded before the observer fires.
		currentContext.readingAnchor = { rowKey: anchor.rowKey, coordinateSource: "dom", offsetTop: anchor.offsetTop - anchor.settledHeight };
	}, [currentContext, preservePendingReaderInput]);

	// 更新可见区间（基于已提交快照纯计算）
	const updateRangeWithGeometry = useCallback((geom: VirtualTimelineGeometry) => {
		const viewport = viewportRef.current;
		if (!viewport) return;
		const effectiveList = listNodeRef.current ?? listRef?.current ?? null;
		const listOrigin = calculateListOrigin(effectiveList, viewport);
		const viewportTopInList = viewport.scrollTop - listOrigin;
		const clientHeight = viewport.clientHeight;
		if (clientHeight <= 0) return;

		const nextRange = findVisibleRowRange(geom, viewportTopInList, clientHeight);
		setVisibleRange((prev) => {
			if (prev.startIndex === nextRange.startIndex && prev.endIndex === nextRange.endIndex) {
				return prev;
			}
			return nextRange;
		});
	}, [viewportRef, listRef]);

	const updateRange = useCallback(() => {
		updateRangeWithGeometry(committedSnapshotRef.current.geometry);
	}, [updateRangeWithGeometry]);

	/** Navigate in DOM space once the destination is mounted, with virtual geometry as the fallback. */
	const alignExplicitAnchor = useCallback((geom: VirtualTimelineGeometry, index: number, offsetTop: number,
		reason: "restore-reading" | "restore-session" | "jump-message", offsetBottom?: number) => {
		const anchor: NonNullable<TimelineSessionContext["readingAnchor"]> = {
			rowKey: geom.rows[index].key, offsetTop: offsetBottom ?? offsetTop,
			coordinateSource: offsetBottom === undefined ? "dom" : "geometry-end",
		};
		const viewport = viewportRef.current;
		const mountedRows = viewport ? { viewport, nodes: currentContext.nodeMap, contextId: currentContext.id, widthEpoch: currentContext.widthEpoch } : null;
		const mountedTop = mountedRows ? resolveMountedTimelineAnchorScrollTop({
			...mountedRows, anchor, edge: offsetBottom === undefined ? undefined : "bottom",
		}) : null;
		if (offsetBottom !== undefined && mountedRows && mountedTop !== null) {
			const node = currentContext.nodeMap.get(anchor.rowKey)?.node;
			if (node && !node.querySelector("[data-md-plain-stream]")) {
				anchor.settledHeight = readMountedTimelineRow(mountedRows, anchor.rowKey)?.height;
			}
		}
		const list = listNodeRef.current ?? listRef?.current ?? null;
		const estimatedTopOffset = offsetBottom === undefined ? offsetTop : offsetBottom - geom.heights[index];
		applyReadingScrollTop(mountedTop ?? resolveAnchorScrollTop(geom, index, estimatedTopOffset, calculateListOrigin(list, viewport)), reason);
		currentContext.pendingRestore = null;
		currentContext.readingAnchor = anchor;
	}, [applyReadingScrollTop, currentContext, listRef, viewportRef]);

	// 跟底时不存在需要保留的阅读锚点。若不清掉，用户之后上滚/内容变化时
	// 可能拿一个陈旧的锚点执行 preserve-anchor，造成时间线被拉回旧位置。
	useLayoutEffect(() => {
		if (!isFollowing) return;
		currentContext.readingAnchor = null;
		currentContext.readingAnchorScrollTop = null;
	}, [isFollowing, currentContext]);

	// layout 阶段：更新提交快照，并按照计划优先级执行至多一次纠偏（显式 pending restore > preserve-anchor）
	useLayoutEffect(() => {
		const prevSnapshot = committedSnapshotRef.current;
		const nextSnapshot: CommittedVirtualTimelineSnapshot = {
			sessionId,
			contextId: currentContext.id,
			widthEpoch: currentContext.widthEpoch,
			rowModel,
			geometry,
			gap: gapRef.current,
		};
		preservePendingReaderInput();
		committedSnapshotRef.current = nextSnapshot;
		currentContext.committedRowModel = rowModel;

		const effectiveList = listNodeRef.current ?? listRef?.current ?? null;
		const viewport = viewportRef.current;

		// 优先级 1: 显式 pending restore（会话恢复/跳转未完成项优先）
		if (currentContext.pendingRestore) {
			const { messageId, offsetTop, keepReading, offsetBottom } = currentContext.pendingRestore;
			const rowKey = rowModel.rowKeyByMessageId.get(messageId);
			const index = rowKey === undefined ? undefined : geometry.indexByKey.get(rowKey);
			if (index !== undefined && viewport) alignExplicitAnchor(geometry, index, offsetTop, keepReading ? "restore-reading" : "restore-session", offsetBottom);
		}
		// 优先级 2: 阅读者模式下的阅读锚点保锚（仅当无显式 pending restore 时执行至多一次）
		else if (!isFollowingRef.current && currentContext.readingAnchor && viewport) {
			// A reader can be clamped to the physical bottom. Keep the requested
			// passage; the engine rejects late corrections once following resumes.
			const { rowKey, offsetTop, coordinateSource } = currentContext.readingAnchor;
			const rowIndex = geometry.indexByKey.get(rowKey);
			if (rowIndex !== undefined) {
				// Do not mix a real DOM offset with a still-estimated row prefix.
				const mountedRows = { nodes: currentContext.nodeMap, viewport, contextId: currentContext.id, widthEpoch: currentContext.widthEpoch };
				const fromEnd = coordinateSource === "geometry-end";
				const mountedRow = fromEnd ? readMountedTimelineRow(mountedRows, rowKey) : null;
				const topOffset = fromEnd ? offsetTop - geometry.heights[rowIndex] : offsetTop;
				const mountedTop = mountedRow
					? viewport.scrollTop + mountedRow.bottom - (viewport.getBoundingClientRect().top + viewport.clientTop) - offsetTop
					: coordinateSource === "dom" ? resolveMountedTimelineAnchorScrollTop({ ...mountedRows, anchor: currentContext.readingAnchor }) : null;
				const targetTop = mountedTop ?? resolveAnchorScrollTop(geometry, rowIndex, topOffset, calculateListOrigin(effectiveList, viewport));
				// Initial mount can still be a lazy Markdown shell. Keep the end
				// anchor through its later expansion, until new reader input.
				applyReadingScrollTop(targetTop, "preserve-anchor");
				if (mountedRow) {
					const node = currentContext.nodeMap.get(rowKey)?.node;
					currentContext.readingAnchor.settledHeight = node?.querySelector("[data-md-plain-stream]") ? undefined : mountedRow.height;
				}
			} else {
				// 行被删除或折叠消失：对齐到同位置后继或前驱，并同步更新内部阅读锚点
				const prevIndex = prevSnapshot.geometry.indexByKey.get(rowKey);
				if (prevIndex !== undefined && geometry.rows.length > 0) {
					const fallbackIndex = Math.min(prevIndex, geometry.rows.length - 1);
					const fallbackRow = geometry.rows[fallbackIndex];
					const listOrigin = calculateListOrigin(effectiveList, viewport);
					const targetTop = resolveAnchorScrollTop(geometry, fallbackIndex, 0, listOrigin);
					applyReadingScrollTop(targetTop, "preserve-anchor");
					if (fallbackRow) {
						currentContext.readingAnchor = { rowKey: fallbackRow.key, offsetTop: 0 };
					}
				}
			}
		}

		updateRangeWithGeometry(geometry);
	}, [geometry, rowModel, sessionId, currentContext, updateRangeWithGeometry, viewportRef, listRef, applyReadingScrollTop, preservePendingReaderInput, alignExplicitAnchor]);

	// 监听视口滚动
	useEffect(() => {
		const viewport = viewportRef.current;
		if (!viewport) return;

		let lastScrollTop = viewport.scrollTop;
		const onScroll = () => {
			const priorTop = currentContext.readingAnchorScrollTop ?? lastScrollTop;
			lastScrollTop = viewport.scrollTop;
			if (!matchesProgrammaticScroll(currentContext, viewport.scrollTop)) {
				currentContext.programmaticScrollTop = null;
				if (!isFollowingRef.current && !wasClampedByLayout(viewport, priorTop)) recordReadingAnchor(priorTop > viewport.scrollTop);
			}
			updateRange();
		};

		viewport.addEventListener("scroll", onScroll, { passive: true });
		return () => {
			viewport.removeEventListener("scroll", onScroll);
		};
	}, [currentContext, recordReadingAnchor, updateRange, viewportRef]);

	const registerRowNode = useTimelineMeasurements({
		currentContext, contextRef, rowModelRef, viewportRef, listRef, listNode, listNodeRef,
		updateRange, onBeforeWidthInvalidation: beforeWidthInvalidation, onHeightChange: refreshMeasurements,
	});

	// 暴露稳定 Adapter 给 Controller
	useLayoutEffect(() => {
		if (!adapterRef) return;
		const targetContext = currentContext;
		const adapter: TimelineViewportAdapter = {
			ownerKey: sessionId,
			containsMessage(messageId: string) {
				return committedSnapshotRef.current.rowModel.rowKeyByMessageId.has(messageId);
			},
			captureReadingAnchor(options) {
				return captureReadingAnchor(options);
			},
			restoreMessage(messageId, offsetTop, options): boolean {
				const snapshot = committedSnapshotRef.current;
				const rowKey = snapshot.rowModel.rowKeyByMessageId.get(messageId);
				if (!rowKey) return false;

				const rowIndex = snapshot.geometry.indexByKey.get(rowKey);
				if (rowIndex === undefined) {
					targetContext.pendingRestore = { messageId, offsetTop, keepReading: options?.keepReading, offsetBottom: options?.offsetBottom };
					return true;
				}

				alignExplicitAnchor(snapshot.geometry, rowIndex, offsetTop, options?.keepReading ? "restore-reading" : "restore-session", options?.offsetBottom);
				updateRange();
				return true;
			},
			jumpToMessage(messageId: string): boolean {
				const snapshot = committedSnapshotRef.current;
				const rowKey = snapshot.rowModel.rowKeyByMessageId.get(messageId);
				if (!rowKey) return false;

				const rowIndex = snapshot.geometry.indexByKey.get(rowKey);
				if (rowIndex === undefined) return false;

				alignExplicitAnchor(snapshot.geometry, rowIndex, 0, "jump-message");
				updateRange();
				return true;
			},
		};

		adapterRef.current = adapter;
		return () => {
			if (adapterRef.current === adapter) {
				adapterRef.current = null;
			}
		};
	}, [adapterRef, sessionId, currentContext, captureReadingAnchor, updateRange, alignExplicitAnchor]);

	// 派生离散渲染计划
	const renderPlan: readonly TimelineRenderEntry[] = useMemo(() => {
		return buildTimelineRenderPlan(geometry, visibleRange, pinnedKeys);
	}, [geometry, visibleRange, pinnedKeys]);

	return {
		geometry,
		visibleRange,
		renderPlan,
		registerRowNode,
		registerListNode,
		captureReadingAnchor,
		updateRange,
		rowModel,
	};
}
