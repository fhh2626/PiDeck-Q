/**
 * 当会话处于运行中或激活中时尝试删除会话记录所抛出的领域错误。
 * 该错误可安全向 Web 客户端暴露（HTTP 400 业务拒绝），
 * 与文件 IO/回收站故障等内部未知异常（HTTP 500 安全屏蔽）明确区分。
 */
export class SessionDeleteBlockedError extends Error {
	readonly code = "SESSION_DELETE_BLOCKED" as const;

	constructor(message: string) {
		super(message);
		this.name = "SessionDeleteBlockedError";
	}

	static is(error: unknown): error is SessionDeleteBlockedError {
		return (
			error instanceof SessionDeleteBlockedError ||
			(typeof error === "object" &&
				error !== null &&
				(error as { code?: unknown }).code === "SESSION_DELETE_BLOCKED")
		);
	}
}

export type SessionDeleteGuardDeps = {
	getTarget: (sessionId: string) => unknown;
	isActivating: (sessionId: string) => boolean;
	isAnonymousActivating?: (sessionId: string) => boolean;
};

/**
 * 判断会话是否处于运行中、普通激活中或匿名激活中。
 * 若任一为 true，则拒绝删除会话记录。
 */
export function isSessionDeleteBlocked(
	sessionId: string,
	deps: SessionDeleteGuardDeps,
): boolean {
	return Boolean(
		deps.getTarget(sessionId) ||
		deps.isActivating(sessionId) ||
		deps.isAnonymousActivating?.(sessionId),
	);
}
