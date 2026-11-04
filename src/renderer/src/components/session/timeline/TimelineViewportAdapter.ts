import type { SessionScrollAnchor } from "../../../atoms/session-atoms";

/**
 * 锚点读取结果三态（与 useSessionTimelineController 共用）。
 * - resolved: 成功捕获有效阅读锚点
 * - at-bottom: 视口处于底部跟流状态（切回继续跟底，保存时应清除持久化锚点）
 * - unresolved: 命中测试或测量尚未就绪（保留上一状态，不猜位置）
 */
export type AnchorReading =
	| { status: "resolved"; anchor: SessionScrollAnchor }
	| { status: "at-bottom" }
	| { status: "unresolved" };

/**
 * 时间线虚拟视口适配器（TimelineViewportAdapter）。
 * 连接 SessionTimelineController 与虚拟视口 Hook 的窄契约接口。
 *
 * 职责：
 * - ownerKey / sessionId: 校验当前会话代次
 * - containsMessage: 检查消息是否已在数据模型中
 * - captureReadingAnchor: 捕获当前正在阅读的顶层行与视口偏移（返回三态 AnchorReading）
 * - restoreMessage: 恢复指定消息的阅读位置，返回是否成功受理
 * - jumpToMessage: 导航跳转并高亮指定消息，返回是否成功受理
 */
export interface TimelineViewportAdapter {
	ownerKey?: string;
	containsMessage(messageId: string): boolean;
	captureReadingAnchor(): AnchorReading;
	restoreMessage(messageId: string, offsetTop: number): boolean;
	jumpToMessage(messageId: string): boolean;
}
