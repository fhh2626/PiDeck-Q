import { useEffect, useState } from "react";
import { formatDuration } from "./TimelineFormat";
import { advanceLiveElapsed, type LiveElapsed } from "./liveElapsed";

/**
 * 实时耗时（公共组件）：run 头部 / 思考卡片 / 工具卡片共用。
 *
 * 语义：
 * - isStreaming（执行中）：每 100ms tick 一次，显示 now - startedAt（实时增长，秒表感）；
 * - 结束（endedAt > 0）：显示固定值 endedAt - startedAt（截止计数），不再 tick；
 * - 无 startedAt（或缺失/0/NaN 等非法值）：不渲染。
 *
 * 单调性（防御）：同一 identity 下显示值只增不减（见 advanceLiveElapsed）；
 * 已结束（endedAt > 0）是例外：终值直接取 endedAt - startedAt，作为对帐真值。
 * 上游存在会把起点刷新为当前时间的字段（ChatMessage.timestamp 会在每次工具进度更新时重置），
 * 按键值判定的钳制挡不住这种刷新，因此工具卡用 message.id 作为 identity；
 * 只有 identity 真正变化（换消息）才重新计时。
 *
 * 性能：tick 只在本组件内 setState，React 只重渲染 LiveDuration 子树，
 * 不会拖累 TurnRow/卡片主体；isStreaming 为 false 时不启动定时器。
 * 100ms 粒度：formatDuration 显示到十分位（如 3.4s），若 1s 才跳一次会像坏秒表；
 * 每实例 10 次/秒的小 span 渲染开销可忽略（对比流式正文 ~50ms 一帧的重量级更新）。
 */
export function LiveDuration(props: {
	/** 开始时间戳；无则不渲染 */
	startedAt?: number;
	/** 结束时间戳；执行中（流式）传 0/undefined，由 isStreaming 驱动实时刷新 */
	endedAt?: number;
	/** 是否仍在执行：true 时启动 100ms tick */
	isStreaming?: boolean;
	/**
	 * 计时器身份，同一条消息内必须稳定（如 ChatMessage.id）。
	 * 缺省回退到 startedAt：起点被上游刷新时无法与「换了计时器」区分，钳制退化为仅防时钟回拨。
	 */
	identity?: string;
}) {
	const started = props.startedAt;
	const isStreaming = props.isStreaming === true;
	const identity = props.identity ?? (started == null ? "" : `start:${started}`);
	const [now, setNow] = useState(() => Date.now());
	const [tracked, setTracked] = useState<LiveElapsed | null>(null);

	useEffect(() => {
		// 起点非法（缺失/0/NaN/Infinity）时不计时：不能拿脏值退化成 NaNms 或永久 0ms。
		if (!isStreaming || started == null || !Number.isFinite(started) || started <= 0) return;
		const timer = window.setInterval(() => {
			const nextNow = Date.now();
			setNow(nextNow);
			// 只有 tick 发生副作用：渲染期只读 tracked，保持组件纯净。
			setTracked((previous) => advanceLiveElapsed(previous, identity, started, nextNow));
		}, 100);
		return () => window.clearInterval(timer);
	}, [isStreaming, identity, started]);

	if (started == null || !Number.isFinite(started) || started <= 0) return null;
	const ended =
		props.endedAt != null && Number.isFinite(props.endedAt) && props.endedAt > 0
			? props.endedAt
			: null;
	if (ended) return <>{formatDuration(Math.max(0, ended - started))}</>;

	// 首次渲染（尚未 tick）用本次渲染的原始差值；之后取推进后的单调值。
	// tracked 属于别的计时器（换消息）时直接忽略，下一 tick 会重建。
	const rawMs = Math.max(0, now - started);
	const ms = tracked && tracked.identity === identity ? Math.max(tracked.ms, rawMs) : rawMs;
	return <>{formatDuration(ms)}</>;
}
