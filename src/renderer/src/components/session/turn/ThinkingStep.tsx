import { memo } from "react";
import { useAtomValue } from "jotai";
import { streamingThinkingEntryByIdAtomFamily } from "../../../atoms/session-atoms";
import { ThinkingBlock } from "../TimelineEventCards";
import type { ThinkingGroupItem } from "../timeline/types";

/**
 * 思考步骤（单步形态，原位穿插）。
 *
 * 身份与 History 共用 msg-thinking-*：id 命中 live 通道时用 atom 文本/endedAt，
 * 否则回退 group（终态落盘后）。hidden 用 CSS display:none 而非卸载，保留打字机状态。
 *
 * 打字机只认 live.streaming：禁止用「整轮 isStreaming」回退，否则上一则已落盘的
 * 思考会在下一则 live 思考期间被当成仍在流式，出现「两段一起打字」。
 */
export const ThinkingStep = memo(function ThinkingStep(props: {
	group: ThinkingGroupItem;
	hidden: boolean;
	showThinking?: boolean;
	onOpenExternal: (url: string) => void;
	onOpenFile?: (path: string) => void;
}) {
	const live = useAtomValue(streamingThinkingEntryByIdAtomFamily(props.group.id));
	const text = live?.text ?? props.group.text;
	const startedAt = live?.startedAt ?? props.group.startedAt;
	const endedAt = live ? live.endedAt : props.group.endedAt;
	const isStreaming = Boolean(live?.streaming && live.endedAt <= 0);

	return (
		<div style={{ display: props.hidden ? "none" : undefined }}>
			<ThinkingBlock
				thinkingGroupId={props.group.id}
				text={text}
				startedAt={startedAt}
				endedAt={endedAt}
				showThinking={props.showThinking}
				isStreaming={isStreaming}
				// 执行过程折叠详情里思考以「单步」呈现（标题+折叠预览），
				// 与工具卡片同为 Chain of Thought 步骤，不默认摊开 markdown。
				defaultExpanded={false}
				onOpenExternal={props.onOpenExternal}
				onOpenFile={props.onOpenFile}
			/>
		</div>
	);
});
