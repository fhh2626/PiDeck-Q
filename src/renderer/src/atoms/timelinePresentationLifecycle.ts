/**
 * 时间线展示状态生命周期解耦模块（timelinePresentationLifecycle）。
 * 遵循计划步骤 5 规则：
 * - 该模块不得依赖 session-atoms、presentation、React 或业务服务；
 * - session-atoms.ts 只调用该模块的清理入口 removeSessionPresentationState；
 * - timeline-presentation.ts 初始化时向该模块注册实际清理函数；
 * - 彻底切断 session-atoms 与 timeline-presentation 之间的循环依赖。
 */

type CleanupHandler = (sessionId: string) => void;

let registeredCleanupHandler: CleanupHandler | null = null;

export function registerPresentationStateCleanup(handler: CleanupHandler): void {
	registeredCleanupHandler = handler;
}

export function removeSessionPresentationState(sessionId: string): void {
	if (registeredCleanupHandler) {
		registeredCleanupHandler(sessionId);
	}
}

/** 模块别名导出，确保直接通过 CJS/Node 动态加载时无缝解析 */
export const timelinePresentationLifecycle = {
	registerPresentationStateCleanup,
	removeSessionPresentationState,
};

