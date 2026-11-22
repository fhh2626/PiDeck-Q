import { useCallback, useLayoutEffect, useRef, type RefObject } from "react";
import type { TimelineRowModel } from "../components/session/timeline/virtualTimelineGeometry";
import type { TimelineSessionContext, RowRegistrationRecord } from "./timelineMeasurementRegistry";

/** Own row measurement leases, observers and width invalidation for one virtual timeline. */
export function useTimelineMeasurements(params: {
	currentContext: TimelineSessionContext;
	contextRef: RefObject<TimelineSessionContext | null>;
	rowModelRef: RefObject<TimelineRowModel>;
	viewportRef: RefObject<HTMLElement | null>;
	listRef?: RefObject<HTMLElement | null>;
	listNode: HTMLElement | null;
	listNodeRef: RefObject<HTMLElement | null>;
	updateRange: () => void;
	onBeforeWidthInvalidation: () => void;
	onHeightChange: () => void;
}) {
	const { currentContext, contextRef, rowModelRef, viewportRef, listRef, listNode, listNodeRef, updateRange, onBeforeWidthInvalidation, onHeightChange } = params;
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

			// A mounted row replaces an estimated spacer in this very commit. Waiting
			// for RO and another rAF lets the next wheel event record that layout shift
			// as reader intent. Commit its actual height before the browser can paint.
			const height = node.getBoundingClientRect().height;
			const previousHeight = currentContext.measuredHeights.get(key);
			if (height > 0 && (previousHeight === undefined || Math.abs(previousHeight - height) >= 0.5)) {
				currentContext.measuredHeights.set(key, height);
				onHeightChange();
			}

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
		[currentContext, onHeightChange],
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
					} else {
						// The latest observation supersedes an earlier change in this batch.
						targetContext.pendingEntries.delete(key);
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
						onHeightChange();
					}
				});
			}
		});

		rowResizeObserverRef.current = ro;
		for (const reg of targetContext.nodeMap.values()) {
			ro.observe(reg.node);
		}
	}, [onHeightChange]);

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

			onBeforeWidthInvalidation();
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
				// These nodes have already reflowed at the new width. Keeping their
				// actual heights prevents the first estimated render from evicting
				// the reader's long row before its new observer can report it.
				const height = reg.node.getBoundingClientRect().height;
				if (height > 0) targetContext.measuredHeights.set(reg.key, height);
			}

			// 重建行观察器并重新观察全部挂载行
			setupRowObserver(targetContext);

			// 触发几何估算重刷
			onHeightChange();
		},
		[setupRowObserver, onBeforeWidthInvalidation, onHeightChange],
	);

	// 容器与行观察器连接 LayoutEffect
	useLayoutEffect(() => {
		if (typeof ResizeObserver === "undefined") return;

		const targetContext = currentContext;
		let active = true;

		// 1. 建立容器观察器：观察视口高度变化与列表宽度基线
		let lastVpHeight: number | null = viewportRef.current?.clientHeight ?? null;
		const containerRo = new ResizeObserver((entries) => {
			// Disconnect does not retract an already queued delivery. A retired
			// container must not rebuild the row observer now owned by another effect.
			if (!active || targetContext !== contextRef.current) return;
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
			active = false;
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

	return registerRowNode;
}
