/**
 * 实时秒表的单调推进状态（纯函数，供 LiveDuration 使用）。
 *
 * 为什么需要：秒表起点来自主进程消息字段，而 `AgentManager.upsertToolMessage` 在每次
 * `tool_execution_update` 都会把消息的 `timestamp` 重置为 Date.now()。若调用方误用这种
 * 会被刷新的字段作起点（历史 bug：powershell 流式输出 / subagent 进度更新时秒表反复归零），
 * 直接 `now - startedAt` 会来回跳。
 *
 * 关键点：钳制必须按「计时器身份」而不是「起点值」判定——起点被上游刷新时值本身会变，
 * 按值判定会认为换了计时器并重置，等于没有保护。身份稳定（如工具消息 id）时，
 * 同一条消息内读数只增不减；身份真的变化（换消息/换会话）才重新开始。
 */
export type LiveElapsed = {
	/** 计时器身份：同一条消息/同一回合内保持不变 */
	identity: string;
	/** 该身份下已观测到的最大耗时（ms），只增不减 */
	ms: number;
};

/**
 * 推进一次秒表读数。
 * @param previous 上一次的推进状态；null/undefined 表示首次计算
 * @param identity 计时器身份（同一逻辑计时器内保持不变）
 * @param startedAt 当前起点时间戳（ms）；允许被上游刷新，刷新不会让读数回退
 * @param now 当前时间戳（ms），由调用方注入便于单测
 *
 * 非法输入（NaN/Infinity）按 0 处理：Math.max(NaN, x) 恒为 NaN，一旦写入 previous.ms
 * 后续每一步都会被污染成永久 NaN（比归零更难排查），因此在源头就挡住。
 */
export function advanceLiveElapsed(
	previous: LiveElapsed | null | undefined,
	identity: string,
	startedAt: number,
	now: number,
): LiveElapsed {
	const elapsed =
		Number.isFinite(startedAt) && Number.isFinite(now) ? Math.max(0, now - startedAt) : 0;
	if (previous && previous.identity === identity) {
		return { identity, ms: Math.max(previous.ms, elapsed) };
	}
	return { identity, ms: elapsed };
}
