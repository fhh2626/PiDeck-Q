/**
 * 已完成 ask_question 的常驻问答卡（桌面时间线 / Web 时间线共用）。
 *
 * 与 pending 提问卡（SessionRuntimeUiOverlay）不同，本卡是「结果展示」：
 * 问题与用户回答始终可见、永不折叠，不受「执行过程」run 级折叠影响。
 * 单题渲染根对象；questions 数组存在时逐题渲染（批量）。
 *
 * 样式遵循「新改动只写 Tailwind + shadcn」：不新增手写 CSS class，
 * 复用现有 token（text-control / text-text-tertiary / border-border-subtle 等）。
 */
import { memo } from "react";
import { Check, MessageCircle } from "lucide-react";
import type { AskQuestionResultSummary } from "../../../../shared/types";
import { t } from "../../i18n";
import { Badge } from "../ui-shadcn/badge";
import { TimelineMarker } from "./TimelineMarker";

/** 把 answer 值转成用户可见文案：优先 answerLabel，boolean 本地化，其余原样。 */
function answerDisplayText(answer: unknown, label?: string): string {
	if (label?.trim()) return label;
	if (typeof answer === "string") return answer;
	if (typeof answer === "boolean") return answer ? t("common.true") : t("common.false");
	if (typeof answer === "number" && Number.isFinite(answer)) return String(answer);
	return t("ask.unanswered");
}

type AskQuestionResultCardProps = {
	result: AskQuestionResultSummary;
	messageId?: string;
};

export const AskQuestionResultCard = memo(function AskQuestionResultCard(
	props: AskQuestionResultCardProps,
) {
	const { result, messageId } = props;
	// 单题 = 根对象；批量 = questions 数组（normalizer 保证批量时 questions 一定存在）。
	const items =
		result.questions && result.questions.length > 0
			? result.questions
			: [result];
	const allAnswered = items.every((item) => item.answered);
	const statusLabel = result.cancelled
		? t("ask.cancelled")
		: allAnswered
			? t("ask.answered")
			: t("ask.unanswered");
	const badgeClass = result.cancelled
		? "ml-auto gap-1 border-border-subtle px-1.5 py-0 text-micro text-text-tertiary"
		: "ml-auto gap-1 px-1.5 py-0 text-micro text-text-secondary";

	return (
		<TimelineMarker kind="ask" tone="success">
			<section
				className="w-full min-w-0 rounded-md border border-border-subtle bg-bg-panel px-3 py-2"
				data-ask-question-result=""
				{...(messageId ? { "data-message-id": messageId } : {})}
			>
				<div className="mb-1.5 flex min-h-6 items-center gap-2 text-caption leading-5 text-text-secondary">
					<MessageCircle size={15} className="shrink-0 text-text-tertiary" aria-hidden="true" />
					<span className="font-medium text-text-primary">{t("ask.toolName")}</span>
					<Badge
						variant={result.cancelled ? "outline" : "secondary"}
						className={badgeClass}
					>
						{result.cancelled ? null : <Check size={9} aria-hidden="true" />}
						{statusLabel}
					</Badge>
				</div>
				<div className="flex flex-col gap-1.5">
					{items.map((item, index) => (
						<div
							key={item.question + ":" + index}
							className="grid grid-cols-[16px_minmax(0,1fr)] items-start gap-2"
						>
							<span className="font-mono text-micro leading-[1.6] text-text-tertiary">
								{items.length > 1 ? index + 1 : "?"}
							</span>
							<div className="min-w-0 [overflow-wrap:anywhere]">
								<div className="text-caption leading-[1.6] text-text-primary">
									{item.question || t("ask.defaultTitle")}
								</div>
								<div
									className={
										"mt-0.5 flex items-center gap-1 text-caption leading-[1.6] [overflow-wrap:anywhere] " +
										(item.answered ? "text-text-primary" : "text-text-tertiary")
									}
								>
									{item.answered ? (
										<Check size={12} className="shrink-0 text-success" aria-hidden="true" />
									) : null}
									<span>
										{item.answered
											? answerDisplayText(item.answer, item.answerLabel)
											: t("ask.unanswered")}
									</span>
								</div>
							</div>
						</div>
					))}
				</div>
			</section>
		</TimelineMarker>
	);
});
