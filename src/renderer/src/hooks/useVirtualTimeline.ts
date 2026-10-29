import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { SessionScrollAnchor } from "../atoms";
import type { TimelineViewportAdapter, AnchorReading } from "../components/session/timeline/TimelineViewportAdapter";
import {
	buildTimelineRowModel,
	computeTimelineGeometry,
	findVisibleRowRange,
	buildTimelineRenderPlan,
	calculateListOrigin,
	resolveAnchorScrollTop,
	DEFAULT_TIMELINE_ROW_GAP,
	type VirtualTimelineGeometry,
	type VirtualTimelineRow,
	type TimelineRowKey,
	type TimelineRenderEntry,
	type TimelineRowModel,
} from "../components/session/timeline/virtualTimelineGeometry";
import type { RenderMessage } from "../components/app/AppUtils";
import {
	createTimelineSessionContext,
	type TimelineSessionContext,
	type RowRegistrationRecord,
	type PendingEntryRecord,
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

/**
 * 虚拟列表 Hook：管理几何模型、ResizeObserver 测量、可见区间以及阅读位置唯一纠偏。
 */
export function useVirtualTimeline(params: {
	items: readonly RenderMessage[];
	viewportRef: RefObject<HTMLElement | null>;
	listRef?: RefObject<HTMLElement | null>;
	isFollowing: boolean;
	applyReaderScrollTop: (top: number, reason: "preserve-anchor" | "restore-session" | "jump-message") => void;
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

	// 当前列表继承的 density gap（默认 12px）
	const gapRef = useRef<number>(DEFAULT_TIMELINE_ROW_GAP);

	// 测量版本号：当测量高度真正更新并导致几何变动时递增
	const [measurementRevision, setMeasurementRevision] = useState(0);

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
	const rowModel = useMemo(() => buildTimelineRowModel(items, { sessionId }), [items, sessionId]);
	const rowModelRef = useRef(rowModel);
	rowModelRef.current = rowModel;
	const logicalRows = rowModel.rows;

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
		return computeTimelineGeometry(logicalRows, currentContext.measuredHeights, gapRef.current);
		// measurementRevision 驱动重新计算
	}, [logicalRows, currentContext, measurementRevision, listNode, listRef, viewportRef]);

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

	// 捕获阅读锚点：返回统一的 AnchorReading 三态
	const captureReadingAnchor = useCallback((): AnchorReading => {
		const snapshot = committedSnapshotRef.current;
		const viewport = viewportRef.current;
		if (!viewport || snapshot.geometry.rows.length === 0) {
			return { status: "unresolved" };
		}

		if (isFollowingRef.current) {
			currentContext.readingAnchor = null;
			return { status: "at-bottom" };
		}

		const effectiveList = listNodeRef.current ?? listRef?.current ?? null;
		const listOrigin = calculateListOrigin(effectiveList, viewport);
		const viewportTopInList = viewport.scrollTop - listOrigin;

		let targetRow: VirtualTimelineRow | undefined;
		let rowStart = 0;
		for (let i = 0; i < snapshot.geometry.rows.length; i += 1) {
			const end = snapshot.geometry.prefixOffsets[i + 1];
			if (end > viewportTopInList) {
				targetRow = snapshot.geometry.rows[i];
				rowStart = snapshot.geometry.prefixOffsets[i];
				break;
			}
		}

		if (!targetRow) {
			targetRow = snapshot.geometry.rows[snapshot.geometry.rows.length - 1];
			rowStart = snapshot.geometry.prefixOffsets[snapshot.geometry.rows.length - 1] ?? 0;
		}

		if (!targetRow) {
			return { status: "unresolved" };
		}

		const offsetTop = -(viewportTopInList - rowStart);
		currentContext.readingAnchor = { rowKey: targetRow.key, offsetTop };

		const anchor: SessionScrollAnchor = {
			messageId: targetRow.anchorId,
			offsetTop,
			visibleCount: 0,
			savedAt: Date.now(),
		};

		return {
			status: "resolved",
			anchor,
		};
	}, [currentContext, viewportRef, listRef]);

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
		committedSnapshotRef.current = nextSnapshot;

		const effectiveList = listNodeRef.current ?? listRef?.current ?? null;
		const viewport = viewportRef.current;

		// 优先级 1: 显式 pending restore（会话恢复/跳转未完成项优先）
		if (currentContext.pendingRestore) {
			const { messageId, offsetTop } = currentContext.pendingRestore;
			const rowKey = rowModel.rowKeyByMessageId.get(messageId);
			if (rowKey) {
				const idx = geometry.rows.findIndex((r) => r.key === rowKey);
				if (idx !== -1 && viewport) {
					const listOrigin = calculateListOrigin(effectiveList, viewport);
					const targetTop = resolveAnchorScrollTop(geometry, idx, offsetTop, listOrigin);
					applyReaderScrollTopRef.current(targetTop, "restore-session");
					currentContext.pendingRestore = null;
					currentContext.readingAnchor = { rowKey, offsetTop };
				}
			}
		}
		// 优先级 2: 阅读者模式下的阅读锚点保锚（仅当无显式 pending restore 时执行至多一次）
		else if (!isFollowingRef.current && currentContext.readingAnchor && viewport) {
			const { rowKey, offsetTop } = currentContext.readingAnchor;
			const rowIndex = geometry.rows.findIndex((r) => r.key === rowKey);
			if (rowIndex !== -1) {
				const listOrigin = calculateListOrigin(effectiveList, viewport);
				const targetTop = resolveAnchorScrollTop(geometry, rowIndex, offsetTop, listOrigin);
				applyReaderScrollTopRef.current(targetTop, "preserve-anchor");
			} else {
				// 行被删除或折叠消失：对齐到同位置后继或前驱，并同步更新内部阅读锚点
				const prevIndex = prevSnapshot.geometry.rows.findIndex((r) => r.key === rowKey);
				if (prevIndex !== -1 && geometry.rows.length > 0) {
					const fallbackIndex = Math.min(prevIndex, geometry.rows.length - 1);
					const fallbackRow = geometry.rows[fallbackIndex];
					const listOrigin = calculateListOrigin(effectiveList, viewport);
					const targetTop = resolveAnchorScrollTop(geometry, fallbackIndex, 0, listOrigin);
					applyReaderScrollTopRef.current(targetTop, "preserve-anchor");
					if (fallbackRow) {
						currentContext.readingAnchor = { rowKey: fallbackRow.key, offsetTop: 0 };
					}
				}
			}
		}

		updateRangeWithGeometry(geometry);
	}, [geometry, logicalRows, rowModel, sessionId, currentContext, updateRangeWithGeometry, viewportRef, listRef]);

	// 监听视口滚动
	useEffect(() => {
		const viewport = viewportRef.current;
		if (!viewport) return;

		const onScroll = () => {
			if (!isFollowingRef.current) {
				captureReadingAnchor();
			}
			updateRange();
		};

		viewport.addEventListener("scroll", onScroll, { passive: true });
		return () => {
			viewport.removeEventListener("scroll", onScroll);
		};
	}, [captureReadingAnchor, updateRange, viewportRef]);

	// 观察器实例与 token 管理
	const rowResizeObserverRef = useRef<ResizeObserver | null>(null);
	const rowObserverTokenRef = useRef(1);
	const nextLeaseRef = useRef(1);

	// 注册行节点（带 lease 与 cleanup 契约）
	const registerRowNode = useCallback(
		(key: string, node: HTMLElement | null): (() => void) | void => {
			const ro = rowResizeObserverRef.current;
			const prev = currentContext.nodeMap.get(key);

			if (!node) {
				if (prev && ro) {
					ro.unobserve(prev.node);
				}
				currentContext.nodeMap.delete(key);
				currentContext.pendingEntries.delete(key);
				return;
			}

			if (prev && prev.node !== node && ro) {
				ro.unobserve(prev.node);
				currentContext.pendingEntries.delete(key);
			}

			const lease = nextLeaseRef.current++;
			const reg: RowRegistrationRecord = {
				key,
				node,
				lease,
				contextId: currentContext.id,
				widthEpoch: currentContext.widthEpoch,
			};
			currentContext.nodeMap.set(key, reg);

			if (ro) {
				ro.observe(node);
			}

			return () => {
				const current = currentContext.nodeMap.get(key);
				if (current && current.lease === lease) {
					if (rowResizeObserverRef.current) {
						rowResizeObserverRef.current.unobserve(node);
					}
					currentContext.nodeMap.delete(key);
					currentContext.pendingEntries.delete(key);
				}
			};
		},
		[currentContext],
	);

	const updateRangeRef = useRef(updateRange);
	updateRangeRef.current = updateRange;

	// 创建行观察器 Helper
	const setupRowObserver = useCallback((targetContext: TimelineSessionContext) => {
		if (typeof ResizeObserver === "undefined") return;

		const token = ++rowObserverTokenRef.current;

		const ro = new ResizeObserver((entries) => {
			if (token !== rowObserverTokenRef.current || targetContext.id !== contextRef.current?.id) {
				return;
			}

			for (const entry of entries) {
				const target = entry.target as HTMLElement;
				const key = target.getAttribute("data-timeline-measure-key") || target.getAttribute("data-timeline-row-key");
				if (!key) continue;

				const reg = targetContext.nodeMap.get(key);
				if (
					!reg ||
					reg.node !== target ||
					reg.contextId !== targetContext.id ||
					reg.widthEpoch !== targetContext.widthEpoch
				) {
					continue;
				}

				if (!rowModelRef.current.rowKeyByMessageId.has(reg.key) && !rowModelRef.current.indexByKey.has(reg.key)) {
					continue;
				}

				const h = entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height;
				if (h > 0) {
					const oldH = targetContext.measuredHeights.get(key);
					if (oldH === undefined || Math.abs(oldH - h) >= 0.5) {
						targetContext.pendingEntries.set(key, {
							key,
							node: target,
							lease: reg.lease,
							contextId: reg.contextId,
							widthEpoch: reg.widthEpoch,
							height: h,
						});
					}
				}
			}

			if (targetContext.pendingEntries.size > 0 && !targetContext.scheduledRaf) {
				targetContext.scheduledRaf = requestAnimationFrame(() => {
					targetContext.scheduledRaf = null;
					if (token !== rowObserverTokenRef.current || targetContext.id !== contextRef.current?.id) {
						targetContext.pendingEntries.clear();
						return;
					}

					let anyChange = false;
					for (const pending of targetContext.pendingEntries.values()) {
						const currentReg = targetContext.nodeMap.get(pending.key);
						if (
							currentReg &&
							currentReg.node === pending.node &&
							currentReg.lease === pending.lease &&
							currentReg.contextId === pending.contextId &&
							currentReg.widthEpoch === pending.widthEpoch
						) {
							const prevH = targetContext.measuredHeights.get(pending.key);
							if (prevH === undefined || Math.abs(prevH - pending.height) >= 0.5) {
								targetContext.measuredHeights.set(pending.key, pending.height);
								anyChange = true;
							}
						}
					}
					targetContext.pendingEntries.clear();

					if (anyChange) {
						setMeasurementRevision((v) => v + 1);
					}
				});
			}
		});

		rowResizeObserverRef.current = ro;
		for (const reg of targetContext.nodeMap.values()) {
			ro.observe(reg.node);
		}
	}, []);

	// 宽度变化处理（步骤 3.1 严格规范）
	const handleListWidthChange = useCallback(
		(newWidth: number, targetContext: TimelineSessionContext) => {
			if (newWidth <= 0) return;

			if (targetContext.lastObservedListWidth === null) {
				targetContext.lastObservedListWidth = newWidth;
				return;
			}

			if (Math.abs(newWidth - targetContext.lastObservedListWidth) < 0.5) {
				return;
			}

			targetContext.lastObservedListWidth = newWidth;
			targetContext.widthEpoch += 1;

			if (targetContext.scheduledRaf) {
				cancelAnimationFrame(targetContext.scheduledRaf);
				targetContext.scheduledRaf = null;
			}
			targetContext.pendingEntries.clear();
			targetContext.measuredHeights.clear();

			if (rowResizeObserverRef.current) {
				rowResizeObserverRef.current.disconnect();
				rowResizeObserverRef.current = null;
			}

			// 保留当前已挂载行节点及其 lease，更新其有效 widthEpoch
			for (const reg of targetContext.nodeMap.values()) {
				reg.widthEpoch = targetContext.widthEpoch;
			}

			// 重建行观察器并重新观察全部挂载行
			setupRowObserver(targetContext);

			// 触发几何估算重刷
			setMeasurementRevision((v) => v + 1);
		},
		[setupRowObserver],
	);

	// 容器与行观察器连接 LayoutEffect
	useLayoutEffect(() => {
		if (typeof ResizeObserver === "undefined") return;

		const targetContext = currentContext;

		// 1. 建立容器观察器：观察视口高度变化与列表宽度基线
		let lastVpHeight: number | null = viewportRef.current?.clientHeight ?? null;
		const containerRo = new ResizeObserver((entries) => {
			let vpChanged = false;
			for (const entry of entries) {
				const target = entry.target as HTMLElement;
				if (target === viewportRef.current) {
					const h = entry.contentRect.height;
					if (lastVpHeight === null || Math.abs(h - lastVpHeight) >= 0.5) {
						vpChanged = true;
					}
					lastVpHeight = h;
				} else if (target === listNodeRef.current || target === listRef?.current) {
					const w = entry.contentRect.width;
					handleListWidthChange(w, targetContext);
				}
			}

			if (vpChanged) {
				updateRangeRef.current();
			}
		});

		if (viewportRef.current) {
			containerRo.observe(viewportRef.current);
		}
		const effectiveList = listNode ?? listRef?.current;
		if (effectiveList) {
			containerRo.observe(effectiveList);
		}

		// 2. 建立行高观察器
		setupRowObserver(targetContext);

		return () => {
			containerRo.disconnect();
			rowObserverTokenRef.current += 1;
			if (targetContext.scheduledRaf) {
				cancelAnimationFrame(targetContext.scheduledRaf);
				targetContext.scheduledRaf = null;
			}
			targetContext.pendingEntries.clear();
			if (rowResizeObserverRef.current) {
				rowResizeObserverRef.current.disconnect();
				rowResizeObserverRef.current = null;
			}
		};
	}, [currentContext, listNode, listRef, viewportRef, handleListWidthChange, setupRowObserver]);

	// 暴露稳定 Adapter 给 Controller
	useLayoutEffect(() => {
		if (!adapterRef) return;
		const targetContext = currentContext;
		const adapter: TimelineViewportAdapter = {
			ownerKey: sessionId,
			containsMessage(messageId: string) {
				return committedSnapshotRef.current.rowModel.rowKeyByMessageId.has(messageId);
			},
			captureReadingAnchor() {
				return captureReadingAnchor();
			},
			restoreMessage(messageId: string, offsetTop: number): boolean {
				const snapshot = committedSnapshotRef.current;
				const rowKey = snapshot.rowModel.rowKeyByMessageId.get(messageId);
				if (!rowKey) return false;

				const rowIndex = snapshot.geometry.rows.findIndex((r) => r.key === rowKey);
				if (rowIndex === -1) {
					targetContext.pendingRestore = { messageId, offsetTop };
					return true;
				}

				const viewport = viewportRef.current;
				const effectiveList = listNodeRef.current ?? listRef?.current ?? null;
				const listOrigin = calculateListOrigin(effectiveList, viewport);
				const targetTop = resolveAnchorScrollTop(snapshot.geometry, rowIndex, offsetTop, listOrigin);
				applyReaderScrollTopRef.current(targetTop, "restore-session");
				targetContext.pendingRestore = null;
				targetContext.readingAnchor = { rowKey, offsetTop };
				updateRange();
				return true;
			},
			jumpToMessage(messageId: string): boolean {
				const snapshot = committedSnapshotRef.current;
				const rowKey = snapshot.rowModel.rowKeyByMessageId.get(messageId);
				if (!rowKey) return false;

				const rowIndex = snapshot.geometry.rows.findIndex((r) => r.key === rowKey);
				if (rowIndex === -1) return false;

				const viewport = viewportRef.current;
				const effectiveList = listNodeRef.current ?? listRef?.current ?? null;
				const listOrigin = calculateListOrigin(effectiveList, viewport);
				const targetTop = resolveAnchorScrollTop(snapshot.geometry, rowIndex, 0, listOrigin);
				applyReaderScrollTopRef.current(targetTop, "jump-message");
				targetContext.pendingRestore = null;
				targetContext.readingAnchor = { rowKey, offsetTop: 0 };
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
	}, [adapterRef, sessionId, currentContext, captureReadingAnchor, updateRange, viewportRef, listRef]);

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
