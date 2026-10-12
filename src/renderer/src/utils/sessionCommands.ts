import type {
	SessionCommandError,
	SessionCommandResult,
	SessionRuntimeTarget,
} from "../../../shared/types";
import { t, type TranslationKey } from "../i18n";

const SESSION_COMMAND_ERROR_KEYS: Record<SessionCommandError["code"], TranslationKey> = {
	SESSION_NOT_FOUND: "sessionCommand.sessionNotFound",
	MESSAGE_NOT_FOUND: "sessionCommand.messageNotFound",
	SESSION_RUNTIME_UNAVAILABLE: "sessionCommand.runtimeUnavailable",
	SESSION_RUNTIME_CHANGED: "sessionCommand.runtimeChanged",
	SESSION_RUNTIME_BUSY: "sessionCommand.runtimeBusy",
	SESSION_COMMAND_FAILED: "sessionCommand.commandFailed",
	SESSION_MODEL_NOT_FOUND: "sessionCommand.modelNotFound",
};

export class SessionCommandFailure extends Error {
	readonly code: SessionCommandError["code"];
	readonly params?: SessionCommandError["params"];
	readonly debugDetails?: string;
	/** 模型在本地 models.json 存在但运行中 Agent 未加载：需重启 Agent 生效。 */
	readonly needsRestart?: boolean;

	constructor(error: SessionCommandError) {
		super(t(SESSION_COMMAND_ERROR_KEYS[error.code], error.params));
		this.name = "SessionCommandFailure";
		this.code = error.code;
		this.params = error.params;
		this.debugDetails = error.debugDetails;
		this.needsRestart = error.needsRestart;
	}
}

export function requireSessionCommand<T>(result: SessionCommandResult<T>): T {
	if (result.ok) return result.value;
	throw new SessionCommandFailure(result.error);
}

export function toSessionRuntimeTarget(
	sessionId: string,
	runtime: { agentId?: string; runtimeGeneration?: number } | undefined,
): SessionRuntimeTarget | undefined {
	if (!runtime?.agentId || runtime.runtimeGeneration === undefined) return undefined;
	return {
		sessionId,
		agentId: runtime.agentId,
		runtimeGeneration: runtime.runtimeGeneration,
	};
}

/**
 * abort 命中断代（SESSION_RUNTIME_CHANGED）后是否可以再试一次。
 *
 * 用户点击停止到命令到达主进程之间，runtime 可能已经换绑（重启/懒启动完成）：
 * 旧 target 会被拒绝，而 AgentManager.abort 根本不会执行——按钮保持红色。
 * 只对「代际变了」这一种原因重试一次：其它失败（会话不存在/命令失败）重试无意义，
 * 也可能反复撞同一个错误。
 *
 * @returns 新 target；不需要或不能重试时返回 undefined（调用方按失败处理）。
 */
export function resolveAbortRetry(
	failedCode: SessionCommandError["code"] | undefined,
	first: SessionRuntimeTarget,
	latest: { agentId?: string; runtimeGeneration?: number } | undefined,
	sessionId: string,
): SessionRuntimeTarget | undefined {
	if (failedCode !== "SESSION_RUNTIME_CHANGED") return undefined;
	const next = toSessionRuntimeTarget(sessionId, latest);
	if (!next) return undefined;
	// 代际与 agent 都没变：重试会撞同一结果，不重复请求。
	if (next.agentId === first.agentId && next.runtimeGeneration === first.runtimeGeneration) {
		return undefined;
	}
	return next;
}

export function isSameSessionRuntimeTarget(
	left: SessionRuntimeTarget | undefined,
	right: SessionRuntimeTarget | undefined,
): boolean {
	if (!left || !right) return false;
	return (
		left.sessionId === right.sessionId &&
		left.agentId === right.agentId &&
		left.runtimeGeneration === right.runtimeGeneration
	);
}
