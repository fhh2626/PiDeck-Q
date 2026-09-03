/**
 * Web 输入框忙碌判定：useChat 流式是实时边沿，runtime 是权威忙碌。
 * 与桌面 isSessionRuntimeBusy 对齐，但不引入桌面 activating/sendState。
 */

export type WebChatStatus = string;

export type WebRuntimeBusyInfo = {
	status?: string;
	isStreaming?: boolean;
	isExecutingTool?: boolean;
};

/** AI SDK useChat 仍在提交或收流。 */
export function isWebChatStreaming(status: WebChatStatus | undefined): boolean {
	return status === "submitted" || status === "streaming";
}

/**
 * 主进程 runtime 是否仍在跑。
 * idle/error/closed/detached 压过滞后的 isStreaming/isExecutingTool。
 */
export function isWebRuntimeBusy(runtime: WebRuntimeBusyInfo | undefined): boolean {
	if (!runtime) return false;
	const status = runtime.status;
	if (status === "idle" || status === "error" || status === "closed" || status === "detached") {
		return false;
	}
	return Boolean(
		status === "running" ||
		status === "starting" ||
		runtime.isStreaming ||
		runtime.isExecutingTool,
	);
}

/** 发送/停止按钮：客户端流式或权威 runtime 任一为忙即显示停止。 */
export function isWebComposerBusy(input: {
	chatStatus?: WebChatStatus;
	runtime?: WebRuntimeBusyInfo;
}): boolean {
	return isWebChatStreaming(input.chatStatus) || isWebRuntimeBusy(input.runtime);
}

/**
 * 无 error 静默重订阅 session stream。停止键看 busy；resume 必须更严：
 * runtime 仍 running 且本地仍在生成，否则 finishIfIdle 会立刻结束并把恢复锁卡住。
 */
export function shouldResumeWebStream(input: {
	chatStatus?: WebChatStatus;
	hasChatError?: boolean;
	runtime?: WebRuntimeBusyInfo;
}): boolean {
	if (isWebChatStreaming(input.chatStatus)) return false;
	if (input.hasChatError === true) return false;
	if (input.runtime?.status !== "running") return false;
	return input.runtime.isStreaming === true || input.runtime.isExecutingTool === true;
}

/**
 * 把运行时快照推进 useChat 必须 SSE 空闲且 runtime 不 busy。
 * 停止键可以更保守地显示忙碌；写时间线不能在思考/工具仍在跑时用拆开的尾部快照盖直播。
 */
export function shouldApplyWebRuntimeSnapshotToChat(input: {
	chatStreaming: boolean;
	runtime?: WebRuntimeBusyInfo;
}): boolean {
	return !input.chatStreaming && !isWebRuntimeBusy(input.runtime);
}
