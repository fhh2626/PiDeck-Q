/**
 * Child lifecycle projection: when the observed child session events mean
 * the run is settling and the observer may start (or must cancel) its final
 * drain window.
 */
export type ChildLifecycleAction = "start-drain" | "cancel-drain" | "arm-unsettled-end" | "cancel-unsettled-end" | "none";

export interface ChildLifecycleState {
	compactionRetryActive: boolean;
}

export function projectChildLifecycle(event: { type?: string; willRetry?: unknown }, terminalAssistantStop = false, state?: ChildLifecycleState): ChildLifecycleAction {
	if (event.type === "compaction_end") {
		if (state) state.compactionRetryActive = event.willRetry === true;
		return event.willRetry === true ? "cancel-drain" : "none";
	}
	// 压缩进行中：子会话仍在工作，必须取消「已结束但无结果」的短等待。
	if (event.type === "compaction_start") return "cancel-unsettled-end";
	if (event.type === "agent_start" || event.type === "auto_retry_start") {
		if (state) state.compactionRetryActive = false;
		return "cancel-unsettled-end";
	}
	if (event.type === "agent_end" && event.willRetry === true) return "cancel-drain";
	// 这一轮 agent 循环结束但尚无终态：先等 agent_settled / 干净的助手 stop，
	// 超时仍未到就按「停止但没有结果」结束，避免主 agent 一直空等。
	if (event.type === "agent_end") {
		if (state) state.compactionRetryActive = false;
		return "arm-unsettled-end";
	}
	if (event.type === "agent_settled") return state?.compactionRetryActive ? "none" : "start-drain";
	if (terminalAssistantStop) return "start-drain";
	return "none";
}
