import { useEffect, useRef, type ReactNode } from "react";
import type { PanelImperativeHandle } from "react-resizable-panels";
import {
	ResizableHandle,
	ResizablePanel,
	ResizablePanelGroup,
} from "../ui-shadcn/resizable";
import type { WorkspaceContentOpenMode } from "../../../../shared/types";

export type WorkbenchStageProps = {
	/** 无内容时只渲染 session；有内容时按 layout 分屏或占满中间栏 */
	layout: WorkspaceContentOpenMode;
	hasContent: boolean;
	/**
	 * 工作区工具栏放在分屏外，文件占满时仍可打开侧栏与抽屉。
	 */
	chrome?: ReactNode;
	session: ReactNode;
	content: ReactNode | null;
};

/**
 * 中间栏工作台：会话与文件/Diff 内容宿主。
 *
 * - 工作区工具栏始终在分屏外
 * - 无内容：会话独占（与改版前一致）
 * - split：可拖拽分屏（固定左右，不做上下分屏）
 * - maximize：内容占满中间栏；会话面板 collapse(0) 但保持挂载，避免丢滚动/流式状态
 *
 * 浏览器仍在右侧抽屉，不进入本宿主。
 */
export function WorkbenchStage(props: WorkbenchStageProps) {
	const sessionPanelRef = useRef<PanelImperativeHandle>(null);

	useEffect(() => {
		if (!props.hasContent) return;
		const panel = sessionPanelRef.current;
		if (!panel) return;
		try {
			if (props.layout === "maximize") panel.collapse();
			else panel.expand();
		} catch {
			// 面板尚未注册到 Group 时 resize API 可能抛错，下一帧布局会自愈
		}
	}, [props.hasContent, props.layout]);

	const body =
		!props.hasContent || !props.content ? (
			props.session
		) : (
			<ResizablePanelGroup
				orientation="horizontal"
				className="workbench-stage-split"
			>
				{/* 尺寸统一用字符串百分比（"48%"）而非数字：react-resizable-panels v4 的
				   约束派生把数字按 px 解析（minSize={20} → 20px → 占 2%），而初始化布局
				   把数字当 %（defaultSize={48} → 48%），同值两处解析不一致；
				   maximize↔split 切换后 expand() 恢复宽度依赖该约束，数字会缩成一条窄缝。
				   defaultSize 固定不变（挂载时生效一次），避免 Panel 重注册丢失 expandToSize
				   （折叠前宽度），后续展开/收起全由下方 effect 的 collapse()/expand() 驱动。 */}
				<ResizablePanel
					id="workbench-session"
					panelRef={sessionPanelRef}
					collapsible
					collapsedSize="0%"
					minSize="20%"
					defaultSize="48%"
					className="workbench-session-pane"
				>
					{props.session}
				</ResizablePanel>
				<ResizableHandle withHandle className="workbench-stage-sash" />
				<ResizablePanel
					id="workbench-content"
					minSize="25%"
					defaultSize="52%"
					className="workbench-content-pane"
				>
					<div className="workbench-content-frame">
						{props.content}
					</div>
				</ResizablePanel>
			</ResizablePanelGroup>
		);

	return (
		<div
			className={
				!props.hasContent || !props.content
					? "workbench-stage workbench-stage-solo"
					: "workbench-stage workbench-stage-with-content"
			}
		>
			{props.chrome}
			<div className="workbench-stage-body">{body}</div>
		</div>
	);
}
