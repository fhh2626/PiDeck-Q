import { memo, type ReactNode } from "react";
import type { ChatMessage, ImageContent } from "../../../../../shared/types";
import { TurnRow } from "../turn/TurnRow";
import { UserBubble } from "../SurfaceParts";
import { DiagnosticMessageCard, CompactionCard } from "../TimelineEventCards";
import { isFloatingFailureMessage } from "./timelineRowModel";
import { TimelinePresentationProvider } from "./timelinePresentationContext";
import type { RenderMessage } from "../../app/AppUtils";
import type { DiffFileHandler } from "../ToolCallComponents";

export type TimelineMessageRowProps = {
	item: RenderMessage;
	index: number;
	totalItems: number;
	sessionId?: string;
	fresh: boolean;
	showThinking?: boolean;
	liveThinkingId?: string;
	isAgentBusy: boolean;
	isLastAgentRun: boolean;
	lastUserMessageId?: string;
	resendableMessageIds: ReadonlySet<string>;
	forkingMessageId?: string;
	validCommandNames?: Set<string>;
	validFilePaths?: Set<string>;
	isSliding: boolean;
	onPreviewImage: (image: ImageContent, images?: ImageContent[]) => void;
	onOpenExternal: (url: string) => void;
	onOpenFile?: (path: string) => void;
	onDiffFile?: DiffFileHandler;
	onResendUserMessage?: (message: ChatMessage) => void;
	onEditMessage?: (messageId: string, newText: string) => void;
	onDeleteMessage?: (messageId: string) => void;
	onForkMessage?: (message: ChatMessage) => void;
	onEnterMultiSelect: () => void;
};

export const TimelineMessageRow = memo(function TimelineMessageRow(props: TimelineMessageRowProps) {
	const { item, index, totalItems } = props;
	let node: ReactNode = null;

	if (item.kind === "agent-run") {
		// 忙碌中的末行 run 视为 live（基于全局总列表的绝对位置 index 判断）
		const isLatestRun = index === totalItems - 1;
		const isRunStreaming = Boolean(props.isAgentBusy && isLatestRun);
		node = (
			<TurnRow
				key={item.id}
				run={item}
				sessionId={props.sessionId}
				fresh={props.fresh}
				onPreviewImage={props.onPreviewImage}
				showThinking={props.showThinking}
				isStreaming={isRunStreaming}
				liveThinkingId={props.liveThinkingId}
				agentRunning={isRunStreaming}
				isLatestRun={isLatestRun}
				isLastAgentRun={props.isLastAgentRun}
				onOpenExternal={props.onOpenExternal}
				onOpenFile={props.onOpenFile}
				onDiffFile={props.onDiffFile}
				onEditMessage={props.onEditMessage}
				onDeleteMessage={props.onDeleteMessage}
				onEnterMultiSelect={props.onEnterMultiSelect}
			/>
		);
	} else if (item.kind === "message") {
		const message = item.message;
		if (message.role === "user") {
			node = (
				<UserBubble
					key={message.id}
					message={message}
					fresh={props.fresh}
					onPreviewImage={props.onPreviewImage}
					onOpenFile={props.onOpenFile}
					onResendUserMessage={props.onResendUserMessage}
					onEditMessage={props.onEditMessage}
					onDeleteMessage={props.onDeleteMessage}
					onForkMessage={props.onForkMessage}
					forking={props.forkingMessageId === message.id}
					agentRunning={props.isAgentBusy}
					isLastUserMessage={message.id === props.lastUserMessageId}
					showResendButton={props.resendableMessageIds.has(message.id)}
					validCommandNames={props.validCommandNames}
					validFilePaths={props.validFilePaths}
					onEnterMultiSelect={props.onEnterMultiSelect}
				/>
			);
		} else if (message.role === "error") {
			if (isFloatingFailureMessage(message)) return null;
			node = <DiagnosticMessageCard key={message.id} message={message} />;
		} else if (message.role === "system") {
			const meta = message.meta as Record<string, unknown> | undefined;
			if (meta?.type === "askQuestion") {
				return null;
			}
			if (meta?.type === "compaction" && props.sessionId) {
				node = (
					<CompactionCard
						key={message.id}
						message={message}
						sessionId={props.sessionId}
						onOpenExternal={props.onOpenExternal}
						onOpenFile={props.onOpenFile}
					/>
				);
			} else {
				if (isFloatingFailureMessage(message)) return null;
				node = <DiagnosticMessageCard key={message.id} message={message} />;
			}
		}
	}

	if (!node) return null;

	const rowKey =
		item.kind === "agent-run"
			? `run:${item.id}`
			: item.kind === "message"
				? `message:${item.message.id}`
				: `group:${item.id}`;
	const content = props.sessionId ? (
		<TimelinePresentationProvider sessionId={props.sessionId} rowKey={rowKey}>
			{node}
		</TimelinePresentationProvider>
	) : (
		node
	);

	if (props.isSliding) {
		const itemId = item.kind === "message" ? item.message.id : item.id;
		return (
			<div key={`slideout-${itemId}`} className="timeline-message-slide-out">
				{content}
			</div>
		);
	}
	return content;
});
