/**
 * 会话面板是否还能停止当前 Agent。
 * error 不是终态：prompt 中断后进程常还在，只是状态打成 error。
 * 若把 error 排除，顶栏停止会灰掉，只剩侧栏「关闭 Agent」。
 */
export function canStopBoundAgent(status: string | undefined): boolean {
	return status === "running" || status === "idle" || status === "error";
}
