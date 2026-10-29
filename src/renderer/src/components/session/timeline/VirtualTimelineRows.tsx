import { memo, useCallback, type ReactNode } from "react";
import type { TimelineRenderEntry, VirtualTimelineRow } from "./virtualTimelineGeometry";

export type VirtualTimelineRowsProps = {
	renderPlan: readonly TimelineRenderEntry[];
	registerRowNode: (key: string, node: HTMLElement | null) => (() => void) | void;
	renderRow: (row: VirtualTimelineRow) => ReactNode;
};

const VirtualTimelineRowSlot = memo(function VirtualTimelineRowSlot(props: {
	row: VirtualTimelineRow;
	gapAfter: number;
	registerRowNode: (key: string, node: HTMLElement | null) => (() => void) | void;
	renderRow: (row: VirtualTimelineRow) => ReactNode;
}) {
	const { row, gapAfter, registerRowNode, renderRow } = props;
	const rowKey = row.key;

	const contentRef = useCallback(
		(node: HTMLElement | null) => {
			return registerRowNode(rowKey, node);
		},
		[rowKey, registerRowNode],
	);

	return (
		<div
			data-timeline-row-key={rowKey}
			className="min-w-0 w-full"
			style={gapAfter > 0 ? { paddingBottom: `${gapAfter}px` } : undefined}
		>
			<div
				ref={contentRef}
				data-timeline-measure-key={rowKey}
				className="flow-root min-w-0 w-full"
			>
				{renderRow(row)}
			</div>
		</div>
	);
});

/**
 * 虚拟时间线离散挂载容器：
 * 按照计划渲染 renderPlan 中的所有 row 与 spacer，
 * 保持正常文档流，杜绝绝对定位/transform 破坏文本选区与布局。
 */
export const VirtualTimelineRows = memo(function VirtualTimelineRows(props: VirtualTimelineRowsProps) {
	const { renderPlan, registerRowNode, renderRow } = props;

	return (
		<>
			{renderPlan.map((entry) => {
				if (entry.kind === "spacer") {
					return (
						<div
							key={entry.key}
							data-virtual-spacer={entry.key}
							aria-hidden="true"
							className="w-full shrink-0 pointer-events-none select-none"
							style={{ height: `${entry.height}px` }}
						/>
					);
				}

				return (
					<VirtualTimelineRowSlot
						key={entry.key}
						row={entry.row}
						gapAfter={entry.gapAfter}
						registerRowNode={registerRowNode}
						renderRow={renderRow}
					/>
				);
			})}
		</>
	);
});
