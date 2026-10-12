import type { AgentCodeTokenLines } from "./agentCodeTokenCache";

/**
 * 代码高亮的共享类型与消息协议（客户端与 Worker 共用，避免两边各写一份形状）。
 *
 * 为什么要有 Worker：shiki 的 `codeToTokensWithThemes` 是**同步** CPU 计算，
 * 放在主线程会阻塞输入帧——长会话里展开一个大 diff 就是这么卡住的。
 * 用 Promise 包一层只是把「开始算」推迟，不等于把「计算」搬走，所以必须真移到 Worker。
 */

export type AgentCodeLanguage =
	| "bash"
	| "diff"
	| "json"
	| "text"
	| "tsx"
	| "typescript";

/** 主线程 → Worker：请求高亮一段代码。 */
export interface HighlightRequest {
	type: "highlight";
	requestId: number;
	code: string;
	language: AgentCodeLanguage;
}

/** Worker → 主线程：高亮结果。 */
export interface HighlightSuccess {
	type: "highlight-result";
	requestId: number;
	lines: AgentCodeTokenLines;
}

/** Worker → 主线程：高亮失败（语言 grammar 缺失、内存不足等）。 */
export interface HighlightFailure {
	type: "highlight-error";
	requestId: number;
	message: string;
}

export type HighlightResponse = HighlightSuccess | HighlightFailure;

/**
 * 客户端实际用到的 Worker 能力子集。
 *
 * 只声明用到的三个方法，而不是复用完整 `Worker` 类型：这样测试与替换实现
 * 不必伪造整个 Worker 接口，工厂也不需要任何类型强转。
 */
export interface HighlightWorkerPort {
	postMessage(message: HighlightRequest): void;
	terminate(): void;
	/** 订阅 Worker 消息；返回退订函数（与项目其它订阅接口保持一致）。 */
	subscribe: (handler: (response: HighlightResponse) => void) => () => void;
}

/** 一次高亮请求的消费者句柄；cancel 只影响本消费者，不影响共享同一任务的其它消费者。 */
export interface AgentCodeHighlightHandle {
	promise: Promise<AgentCodeTokenLines>;
	cancel: () => void;
}

/** 从不可信对象上读一个字段，不用类型断言。 */
function readField(value: object, key: string): unknown {
	return Reflect.get(value, key);
}

/**
 * 验证一个值是否是合法的高亮行数组。
 * Worker 边界上的数据一律不可信（版本错配、旧 Worker 残留消息），
 * 因此做真实逐项校验，而不是用类型断言绕过检查。
 */
function isTokenLines(value: unknown): value is AgentCodeTokenLines {
	if (!Array.isArray(value)) return false;
	for (const line of value) {
		if (!Array.isArray(line)) return false;
		for (const token of line) {
			if (typeof token !== "object" || token === null) return false;
			if (typeof readField(token, "content") !== "string") return false;
			if (typeof readField(token, "offset") !== "number") return false;
		}
	}
	return true;
}

/** 把 Worker 消息收窄成协议类型；无法识别时返回 null。 */
export function parseHighlightResponse(value: unknown): HighlightResponse | null {
	if (typeof value !== "object" || value === null) return null;
	const requestId = readField(value, "requestId");
	if (typeof requestId !== "number" || !Number.isFinite(requestId)) return null;
	const type = readField(value, "type");
	if (type === "highlight-result") {
		const lines = readField(value, "lines");
		if (!isTokenLines(lines)) return null;
		return { type: "highlight-result", requestId, lines };
	}
	if (type === "highlight-error") {
		const message = readField(value, "message");
		return {
			type: "highlight-error",
			requestId,
			message: typeof message === "string" ? message : "highlight failed",
		};
	}
	return null;
}
