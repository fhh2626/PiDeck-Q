import type { ReactNode } from "react";
import { Check, X } from "lucide-react";
import { cn } from "../../lib/utils";

export type TimelineMarkerKind = "thinking" | "tool" | "compaction" | "diagnostic" | "ask";
export type TimelineMarkerTone = "neutral" | "active" | "success" | "warning" | "error";

const TONE_CLASSES: Record<TimelineMarkerTone, string> = {
  neutral: "timeline-marker-node-neutral",
  active: "timeline-marker-node-active",
  success: "timeline-marker-node-success",
  warning: "timeline-marker-node-warning",
  error: "timeline-marker-node-error",
};

/** 借鉴 AI Elements Chain of Thought 的步骤节点：完成/失败不再是同色小圆点，
 *  轨道节点直接承载状态语义（✓/✗），扫一眼即可定位失败步骤。
 *  图标用显式白色 stroke：tone 类同时设置了 color 与 background（供圆点用），
 *  lucide 默认 currentColor 会和底色相同导致图标不可见，必须显式覆盖。 */
const TONE_STATUS_ICONS: Partial<Record<TimelineMarkerTone, ReactNode>> = {
  success: <Check size={9} strokeWidth={3.5} color="#fff" />,
  error: <X size={9} strokeWidth={3.5} color="#fff" />,
};

/** 状态图标是否显示：工具调用（kind="tool"）不放大、不带 ✓/✗——
 *  工具节点统一 8px 空心描边圆（颜色表达状态），与思考的 8px 实心点同级，
 *  避免 14px 大图标节点在工具行上喧宾夺主；诊断等其他事件保留 ✓/✗ 语义节点。 */
function getStatusIcon(
  kind: TimelineMarkerKind,
  tone: TimelineMarkerTone,
): ReactNode | undefined {
  if (kind === "tool") return undefined;
  return TONE_STATUS_ICONS[tone];
}

/**
 * 时间线事件的统一左侧标记轨道。
 *
 * 事件内容本身仍由各业务卡片负责，Marker 只承载类型、状态和归属关系，
 * 这样工具调用、思考、压缩和诊断消息不会因为各自的卡片样式而失去时间线层级。
 */
export function TimelineMarker(props: {
  kind: TimelineMarkerKind;
  tone?: TimelineMarkerTone;
  children: ReactNode;
  className?: string;
  /** 内容区（timeline-marker-content）追加类，供具体卡片覆盖默认底距等间距 */
  contentClassName?: string;
  /** 不渲染左侧轨道（竖线+节点），直接展示内容——用于系统状态/自动重试等
   *  临时提示，它们不是需要轨道归属关系的步骤节点 */
  hideRail?: boolean;
}) {
  const tone = props.tone ?? "neutral";
  const statusIcon = getStatusIcon(props.kind, tone);
  return (
    <div
      className={cn("timeline-marker-row flex min-w-0 items-stretch", !props.hideRail && "gap-2", props.className)}
      data-marker-kind={props.kind}
      data-marker-tone={tone}
    >
      {!props.hideRail && (
      <div className="timeline-marker-rail relative flex w-4 shrink-0 justify-center" aria-hidden="true">
        <span className="timeline-marker-line absolute top-0 bottom-0 w-px bg-border-subtle" />
        {/* 轨道只保留状态节点；工具/思考的语义图标已经在内容卡片里，避免左侧重复一套 Logo。 */}
        <span
          className={cn(
            "timeline-marker-node relative z-[1] grid size-2 place-items-center rounded-full",
            // 思考 trigger 行较高（min-h-8 + p-1.5），节点下移 3 对齐行内容中心；
            // 工具行已收紧（20px）保持基线偏移即可；其他事件维持原偏移
            props.kind === "thinking" ? "mt-2" : "mt-1.5",
            // ✓/✗ 节点放大为 14px 并微调基线，与首行文字视觉对齐
            statusIcon && "mt-1 size-3.5",
            TONE_CLASSES[tone],
          )}
        >
          {statusIcon}
        </span>
      </div>
      )}
      <div className={cn("timeline-marker-content min-w-0 flex-1 pb-0.5", props.contentClassName)}>{props.children}</div>
    </div>
  );
}

/** 状态完成标记，供详情或完成态卡片复用，避免各域自行拼图标和颜色。 */
export function TimelineSuccessMarker() {
  return (
    <span className="grid size-5 place-items-center rounded-full bg-emerald-600 text-white dark:bg-emerald-500" aria-hidden="true">
      <Check size={12} strokeWidth={2.5} />
    </span>
  );
}
