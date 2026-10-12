/**
 * Web 整轮助手内容（对齐桌面 TurnRow 的「执行过程」折叠）：
 * 思考 / 工具 / 中间插入语收进唯一折叠区，最终回答与提问类内容常驻在折叠区之后。
 * 折叠状态复用桌面 useTurnExecution（历史轮默认收起、流式结束后自动收起、手动优先）。
 */
import { memo, useMemo, type ReactNode } from "react";
import { ChevronUp } from "lucide-react";
import type { UIMessage } from "ai";
import { t } from "@/i18n";
import { Collapsible, CollapsibleContent } from "@/components/ui-shadcn/collapsible";
import { ProcessSummaryToggle } from "@/components/session/turn/ProcessSummaryToggle";
import { useTurnExecution } from "@/components/session/turn/useTurnExecution";
import { AskQuestionResultCard } from "@/components/session/AskQuestionResultCard";
import { WebAssistantText } from "./WebAssistantText";
import { WebThinkingBlock, WebToolCard, WebToolGroupCard } from "./WebTimelineCards";
import { getWebAskQuestionResult } from "./webApi";
import { buildWebTurnDisplay, type WebTurnStep } from "./webTurnDisplay";

type WebAssistantTurnProps = {
	messages: UIMessage[];
	/** 本轮是否正在流式（包含 useChat 最后一条消息且 streaming） */
	streaming: boolean;
	/** 是否时间线上最后一轮：只有最新轮在流式结束后自动收起 */
	isLatest: boolean;
};

/** 分组每次都会新建 messages 数组；按元素引用比较，避免流式每帧重算所有历史轮。 */
function areWebAssistantTurnPropsEqual(prev: WebAssistantTurnProps, next: WebAssistantTurnProps): boolean {
	return prev.streaming === next.streaming
		&& prev.isLatest === next.isLatest
		&& prev.messages.length === next.messages.length
		&& prev.messages.every((message, index) => message === next.messages[index]);
}

/** 渲染单个步骤；折叠区与常驻区共用，保证两处卡片外观一致。 */
function renderWebTurnStep(step: WebTurnStep): ReactNode {
	switch (step.kind) {
		case "reasoning":
			return <WebThinkingBlock key={step.key} text={step.text} running={step.running} />;
		case "tools": {
			const [only] = step.parts;
			return only && step.parts.length === 1
				? <WebToolCard key={step.key} part={only} />
				: <WebToolGroupCard key={step.key} groupId={step.key} parts={step.parts} />;
		}
		case "text":
			return (
				<div key={step.key} className="timeline-inline-text">
					<WebAssistantText text={step.text} isStreaming={step.streaming} />
				</div>
			);
		case "ask-result": {
			const result = getWebAskQuestionResult(step.message);
			return result ? <AskQuestionResultCard key={step.key} result={result} messageId={step.message.id} /> : null;
		}
		case "ask-tool":
			return <WebToolCard key={step.key} part={step.part} />;
	}
}

export const WebAssistantTurn = memo(function WebAssistantTurn(props: WebAssistantTurnProps) {
	const display = useMemo(
		() => buildWebTurnDisplay(props.messages, { streaming: props.streaming }),
		[props.messages, props.streaming],
	);
	const { stepsVisible, setStepsVisibleFromUser, toggleSteps } = useTurnExecution({
		agentRunning: props.streaming,
		isComplete: !props.streaming,
		hasFinalAnswer: display.hasFinalAnswer,
		isLatestRun: props.isLatest,
		// Web 没有桌面的流式对话设置：取桌面默认值（流式中不展开、不做新一轮强制收起）。
		expandInterimDuringStream: false,
		collapsePrevRunsOnNewTurn: false,
	});
	if (display.foldSteps.length === 0 && display.persistentSteps.length === 0) return null;
	return (
		<div className="w-full min-w-0">
			{display.foldSteps.length > 0 && (
				<Collapsible className="execution-summary" open={stepsVisible} onOpenChange={setStepsVisibleFromUser}>
					<ProcessSummaryToggle summary={display.summary} expanded={stepsVisible} onToggle={toggleSteps} />
					<CollapsibleContent className="execution-summary-details">
						{display.foldSteps.map(renderWebTurnStep)}
						{stepsVisible && (
							<button type="button" className="execution-summary-collapse" onClick={toggleSteps} title={t("common.collapse")}>
								<ChevronUp size={12} aria-hidden="true" />
								<span>{t("common.collapse")}</span>
							</button>
						)}
					</CollapsibleContent>
				</Collapsible>
			)}
			{display.persistentSteps.map(renderWebTurnStep)}
		</div>
	);
}, areWebAssistantTurnPropsEqual);
