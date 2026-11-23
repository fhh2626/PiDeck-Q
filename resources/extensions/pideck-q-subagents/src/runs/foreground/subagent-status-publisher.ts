/**
 * 子代理状态快照发布器（仅 PiDeck 桌面宿主消费）。
 *
 * 为什么需要单独通道：前台 workflow 在子代理提问时会先把工具调用返回给父会话（交接），
 * 之后 workflow 继续执行，但协议上不能再往那个工具调用发进度帧，侧栏因此看不到
 * 「回答后继续跑」的子代理。这里把最小运行态投影到 pi 的扩展状态槽
 * （ctx.ui.setStatus），主进程按 key 前缀消费；不新增网络通道，也不写会话历史。
 *
 * 只在 PIDECK_DESKTOP=1 时启用：终端 TUI 同样会渲染 setStatus 文本，不能把 JSON
 * 写进状态栏。上报失败只影响侧栏，不能改变子代理执行结果。
 */

/** 与 PiDeck `src/shared/types/subagents.ts` 的 SUBAGENT_STATUS_KEY_PREFIX 必须一致。 */
export const SUBAGENT_STATUS_KEY_PREFIX = "pideck.subagent-status.v1:";

export const SUBAGENT_STATUS_SNAPSHOT_VERSION = 1;

/** 心跳间隔：主进程据此判断「这份任务还活着」，超过 stale 窗口才收灯。 */
const HEARTBEAT_MS = 1_000;

// 与主进程 tracker 的单 agent 上限（64）对齐；载荷上限仍会二次裁剪。
const MAX_CHILDREN = 64;
const MAX_SESSION_PATH_BYTES = 1_024;
const MAX_AGENT_BYTES = 96;
const MAX_ID_BYTES = 128;
/** 单帧载荷上限；超限时从尾部裁剪并标记 truncated，不伪装成完整清单。 */
const MAX_PAYLOAD_BYTES = 16 * 1_024;

export type SubagentStatusChildState =
	| "running"
	| "completed"
	| "failed"
	| "stopped"
	| "paused"
	| "detached";

export interface SubagentStatusChild {
	/** 编排里的任务 key（runs.run 的 key）。 */
	taskKey: string;
	/** 本次实际执行标识（不透明，不按大小排序）；缺省时按 workflow + taskKey 回退。 */
	executionId?: string;
	sessionFile: string;
	agent?: string;
	state: SubagentStatusChildState;
}

export interface SubagentStatusSnapshot {
	version: typeof SUBAGENT_STATUS_SNAPSHOT_VERSION;
	ownerSessionId: string;
	parentToolCallId: string;
	workflowRunId: string;
	sequence: number;
	complete: boolean;
	truncated: boolean;
	observedAt: number;
	children: SubagentStatusChild[];
}

/**
 * 把 workflow 子行投影成状态快照条目。
 *
 * `pending`（排队未启动）不发布：还没开始执行就不该亮灯。
 * 没有会话路径的行也丢弃：侧栏按路径匹配，发出去也无处可显示。
 */
export function workflowChildToStatusChild(row: {
	childId: string;
	runId?: string;
	sessionFile?: string;
	agent?: string;
	state: string;
}): SubagentStatusChild | undefined {
	const state: SubagentStatusChildState | undefined = row.state === "running" ? "running"
		: row.state === "completed" ? "completed"
			: row.state === "failed" || row.state === "rejected" ? "failed"
				: row.state === "stopped" ? "stopped"
					: row.state === "paused" ? "paused"
						: row.state === "detached" ? "detached"
							: undefined;
	const sessionFile = boundedPath(row.sessionFile);
	if (!state || !sessionFile) return undefined;
	const executionId = bounded(row.runId, MAX_ID_BYTES);
	const agent = bounded(row.agent, MAX_AGENT_BYTES);
	return {
		taskKey: row.childId,
		sessionFile,
		state,
		...(executionId ? { executionId } : {}),
		...(agent ? { agent } : {}),
	};
}

export interface SubagentStatusPublisher {
	/** 是否真正启用（宿主标识与 UI 上下文都满足）；false 时调用方可以跳过投影。 */
	readonly enabled: boolean;
	/** 发布当前清单；complete 表示任务结束，主进程据此清掉该任务全部灯。 */
	publish(children: readonly SubagentStatusChild[], complete?: boolean): void;
	/** 停止心跳并清空状态槽（主进程把清空视为任务已消失）。 */
	dispose(): void;
}

export interface SubagentStatusPublisherInput {
	/** 扩展 UI 上下文；没有 UI 时退化为空实现。 */
	ui?: { setStatus(key: string, text: string | undefined): void } | undefined;
	/** 父会话身份，用于主进程校验状态归属。 */
	ownerSessionId: string;
	parentToolCallId: string;
	workflowRunId: string;
	env?: NodeJS.ProcessEnv;
	now?: () => number;
}

const NOOP_PUBLISHER: SubagentStatusPublisher = Object.freeze({
	enabled: false,
	publish: () => {},
	dispose: () => {},
});

function bounded(value: unknown, maxBytes: number): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	if (!trimmed || Buffer.byteLength(trimmed, "utf8") > maxBytes) return undefined;
	return trimmed;
}

function boundedPath(value: unknown): string | undefined {
	return bounded(value, MAX_SESSION_PATH_BYTES);
}

const CHILD_STATES: ReadonlySet<string> = new Set([
	"running",
	"completed",
	"failed",
	"stopped",
	"paused",
	"detached",
]);

/**
 * 归一化子代理清单。
 *
 * 同一会话文件可能被先后多次执行（连续恢复），按出现顺序后行覆盖前行：
 * 最新一次执行说了算。路径/状态非法的条目直接丢弃，不能让它点亮错误的行。
 */
export function normalizeSubagentStatusChildren(
	children: readonly SubagentStatusChild[],
): { children: SubagentStatusChild[]; truncated: boolean } {
	const bySession = new Map<string, SubagentStatusChild>();
	let dropped = false;
	for (const child of children) {
		// 防御性检查：调用方传入稀疏/异常数组时不能整帧崩掉。
		if (!child || typeof child !== "object") {
			dropped = true;
			continue;
		}
		const sessionFile = boundedPath(child.sessionFile);
		const taskKey = bounded(child.taskKey, MAX_ID_BYTES);
		if (!sessionFile || !taskKey || !CHILD_STATES.has(child.state)) {
			// 被丢弃的行让这帧不再是完整清单，主进程不能据此删除其他条目。
			dropped = true;
			continue;
		}
		const agent = bounded(child.agent, MAX_AGENT_BYTES);
		const executionId = bounded(child.executionId, MAX_ID_BYTES);
		bySession.delete(sessionFile);
		bySession.set(sessionFile, {
			taskKey,
			sessionFile,
			state: child.state,
			...(executionId ? { executionId } : {}),
			...(agent ? { agent } : {}),
		});
	}
	let list = [...bySession.values()];
	let truncated = dropped || list.length > MAX_CHILDREN;
	if (truncated) list = list.slice(0, MAX_CHILDREN);
	// 载荷上限：超限时从尾部裁剪。truncated 让主进程只做增量更新，不误删被省略的条目。
	while (list.length > 0 && Buffer.byteLength(JSON.stringify(list), "utf8") > MAX_PAYLOAD_BYTES) {
		list = list.slice(0, -1);
		truncated = true;
	}
	return { children: list, truncated };
}

/**
 * 创建发布器。未启用时返回空实现，调用方不需要分支判断。
 *
 * 心跳只重发最近一次清单：没有子代理时保持静默，避免为「空任务」制造状态槽。
 */
export function createSubagentStatusPublisher(input: SubagentStatusPublisherInput): SubagentStatusPublisher {
	const env = input.env ?? process.env;
	const now = input.now ?? Date.now;
	const ui = input.ui;
	const workflowRunId = bounded(input.workflowRunId, MAX_ID_BYTES);
	const ownerSessionId = bounded(input.ownerSessionId, MAX_SESSION_PATH_BYTES);
	const parentToolCallId = bounded(input.parentToolCallId, MAX_ID_BYTES);
	if (env.PIDECK_DESKTOP !== "1" || !ui || !workflowRunId || !ownerSessionId || !parentToolCallId) {
		return NOOP_PUBLISHER;
	}

	const statusKey = `${SUBAGENT_STATUS_KEY_PREFIX}${workflowRunId}`;
	let sequence = 0;
	let disposed = false;
	let completed = false;
	let lastChildren: SubagentStatusChild[] | undefined;
	let lastTruncated = false;
	let lastSignature: string | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;

	const send = (children: SubagentStatusChild[], complete: boolean, truncated: boolean): void => {
		const payload: SubagentStatusSnapshot = {
			version: SUBAGENT_STATUS_SNAPSHOT_VERSION,
			ownerSessionId,
			parentToolCallId,
			workflowRunId,
			sequence: ++sequence,
			complete,
			truncated,
			observedAt: now(),
			children,
		};
		try {
			ui.setStatus(statusKey, JSON.stringify(payload));
		} catch {
			// 状态上报是旁路：宿主回调抛错不能让子代理或工作流失败。
		}
	};

	// 心跳只在真正发布过清单后启动：工作流未启动（如容量已满提前返回）时
	// 不会创建定时器，也就不需要额外的清理路径。
	const ensureHeartbeat = (): void => {
		if (timer || disposed || completed || typeof setInterval !== "function") return;
		timer = setInterval(() => {
			if (disposed || completed || !lastChildren) return;
			send(lastChildren, false, lastTruncated);
		}, HEARTBEAT_MS);
		timer.unref?.();
	};

	const publish = (children: readonly SubagentStatusChild[], complete = false): void => {
		if (disposed || completed) return;
		const normalized = normalizeSubagentStatusChildren(children);
		const signature = `${normalized.truncated ? "!" : ""}${JSON.stringify(normalized.children)}`;
		// 重复帧不重发：保活由心跳负责，避免子代理高频进度把状态通道刷满。
		if (!complete && signature === lastSignature) return;
		lastSignature = signature;
		lastChildren = normalized.children;
		lastTruncated = normalized.truncated;
		send(normalized.children, complete, normalized.truncated);
		if (complete) {
			completed = true;
			if (timer) clearInterval(timer);
			timer = undefined;
			return;
		}
		ensureHeartbeat();
	};

	return {
		enabled: true,
		publish,
		dispose: () => {
			if (disposed) return;
			disposed = true;
			if (timer) clearInterval(timer);
			timer = undefined;
			try {
				// 清空状态槽：主进程把 undefined 视为「该任务已消失」，立即收灯。
				ui.setStatus(statusKey, undefined);
			} catch {
				// 同上：清理失败不能影响收尾。
			}
		},
	};
}
