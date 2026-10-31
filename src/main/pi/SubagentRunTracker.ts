import type { SubagentLiveRun, SubagentLiveRunStatus } from "../../shared/types/subagents";

/**
 * 从父会话 `subagent` 工具事件里截取子代理运行态。
 *
 * 为什么需要这一层：pi 内建子代理（pi-subagents 扩展）的会话不是 PiDeck 的 Agent，
 * 没有 agentId / runtimeGeneration，`sessionRuntimeByIdAtom` 永远不会有它们的快照，
 * 侧栏子会话行因此永远不亮状态点。pi 的 tool_execution_update 里 partialResult 是完整
 * AgentToolResult，`details.results[]` 带 `sessionFile` 与 `progress.status`，这里是唯一
 * 不新增通道就能拿到的权威来源；整包 details 体积不可控（含 messages），所以只截取
 * sessionFile + 状态，绝不透传原始 payload。
 */

/**
 * 会带子会话 details 的工具名：
 * - `subagent`：起子代理（results[] 带 sessionFile + progress.status）；
 * - `bg_wait`：收后台/分离运行终态（completions[] 带 sessionFile）。
 * 旧文档提到的 `subagent-wait` 在当前内置扩展里并不存在（wait-tool.ts 注册的是 bg_wait），
 * 不要再当作别名依赖。
 */
const SUBAGENT_TOOL_NAMES: ReadonlySet<string> = new Set(["subagent", "bg_wait"]);

/** 单 agent 最多记住多少条子会话状态：扩展侧并发已限流，这里只是兜底防无界增长。 */
const MAX_RUNS_PER_AGENT = 64;

/** 运行中条目存活时间：父会话异常退出/崩溃后不留永久黄灯。 */
const RUNNING_TTL_MS = 10 * 60_000;

/** 失败条目保留更久，便于回看哪个子代理报错（重开侧栏仍在）。 */
const ERROR_TTL_MS = 30 * 60_000;

/**
 * 会话文件路径长度上限：真实路径远小于此值，超出即视为异常数据。
 * 上限同时是载荷边界：64 条 × 1 KiB 远小于事件帧预算。
 */
const MAX_SESSION_PATH_LENGTH = 1024;

/** 观察到的状态：比下发状态多一个 completed（终态帧到达后不保留，避免结束后仍亮灯）。 */
type ObservedStatus = SubagentLiveRunStatus | "completed";

/** 内部条目：对外快照会剥掉 toolCallId，只用于工具级失败时精准清理。 */
type TrackedRun = SubagentLiveRun & { toolCallId?: string };

type ObservedRun = {
	sessionFile: string;
	status: ObservedStatus;
	agent?: string;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	return value as Record<string, unknown>;
}

/** 工具结束时 details 在 result，流式更新时在 partialResult。 */
function pickDetails(event: Record<string, unknown>): Record<string, unknown> | undefined {
	const fromResult = asRecord(asRecord(event.result)?.details);
	if (fromResult) return fromResult;
	return asRecord(asRecord(event.partialResult)?.details);
}

function readSessionFile(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	if (!trimmed || trimmed.length > MAX_SESSION_PATH_LENGTH) return undefined;
	return trimmed;
}

/**
 * 单条子结果的终态判定。
 *
 * 顺序即优先级：`progress.status` 是扩展自己的状态机（pending/running/completed/failed/
 * detached），比 flags 更早可用；detached 表示子代理脱离了父回合（后续由 bg_wait 投递），
 * 不能据此点灯，按已完成处理（移除条目）。
 */
function resolveObservedStatus(item: Record<string, unknown>): ObservedStatus | undefined {
	const progressStatus = asRecord(item.progress)?.status;
	if (typeof progressStatus === "string") {
		switch (progressStatus) {
			case "running":
			case "pending":
				return "running";
			case "failed":
				return "error";
			case "completed":
			case "detached":
				return "completed";
		}
	}
	// 兼容形状：部分嵌套/旧版结果会同时带 success 与残留 error 字段，成功优先。
	if (item.success === true) return "completed";
	if (
		item.stopped === true ||
		item.timedOut === true ||
		item.interrupted === true ||
		item.turnBudgetExceeded === true
	) {
		return "error";
	}
	if (typeof item.error === "string" && item.error.trim()) return "error";
	if (typeof item.exitCode === "number") return item.exitCode === 0 ? "completed" : "error";
	return "running";
}

/** 从 details 抽出本轮可用的状态更新。 */
export function extractSubagentRunUpdates(details: unknown): ObservedRun[] {
	const record = asRecord(details);
	if (!record) return [];
	const observed: ObservedRun[] = [];

	// management 动作（list/status/interrupt）的 results 不是运行态，跳过。
	// 注意：bg_wait 的 details.mode 也是 "management"（subagent-wait.ts 的 result()），
	// 它的 completions 必须独立于这个过滤，否则后台子代理的失败永远不会亮红灯。
	if (record.mode !== "management") {
		const results = Array.isArray(record.results) ? record.results : [];
		for (const item of results.slice(0, MAX_RUNS_PER_AGENT)) {
			const result = asRecord(item);
			if (!result) continue;
			const sessionFile = readSessionFile(result.sessionFile);
			if (!sessionFile) continue;
			const status = resolveObservedStatus(result);
			if (!status) continue;
			const agent = typeof result.agent === "string" && result.agent.trim()
				? result.agent
				: undefined;
			observed.push({ sessionFile, status, ...(agent ? { agent } : {}) });
		}
	}

	// bg_wait 的完成投递：后台子代理在 detached 时不点灯，等终态到达再清残留条目。
	const completions = Array.isArray(record.completions) ? record.completions : [];
	for (const item of completions.slice(0, MAX_RUNS_PER_AGENT)) {
		const children = Array.isArray(asRecord(item)?.results) ? (asRecord(item)?.results as unknown[]) : [];
		for (const child of children.slice(0, MAX_RUNS_PER_AGENT)) {
			const childRecord = asRecord(child);
			const sessionFile = readSessionFile(childRecord?.sessionFile);
			if (!sessionFile) continue;
			observed.push({
				sessionFile,
				status: childRecord?.success === false ? "error" : "completed",
			});
		}
	}

	return observed;
}

/**
 * 每个 agent 的子代理运行状态表（有界 + TTL）。
 *
 * `observe` 返回侧栏可见状态是否真的变化：updatedAt 刷新、重复同样的 running 帧都返回
 * false，避免流式期间把事件通道刷满（与 runtime-state 的同值跳过策略一致）。
 */
export class SubagentRunTracker {
	private readonly runsByAgent = new Map<string, Map<string, TrackedRun>>();

	observe(agentId: string, event: unknown, now = Date.now()): boolean {
		const record = asRecord(event);
		if (!record) return false;
		const toolName = typeof record.toolName === "string" ? record.toolName.toLowerCase() : "";
		if (!SUBAGENT_TOOL_NAMES.has(toolName)) return false;
		const details = pickDetails(record);
		if (!details) return false;
		const updates = extractSubagentRunUpdates(details);
		if (updates.length === 0) return false;
		const toolCallId = typeof record.toolCallId === "string" && record.toolCallId
			? record.toolCallId
			: undefined;

		let changed = this.prune(agentId, now);
		const runs = this.runsByAgent.get(agentId) ?? new Map<string, TrackedRun>();
		for (const update of updates) {
			// completed 不保留：侧栏黄点的语义是「正在运行」（见 sessionStatusDotClass），
			// 保留完成条目会让刚跑完的子代理继续亮灯，读起来像「已经停了还在跑」。
			if (update.status === "completed") {
				if (runs.delete(update.sessionFile)) changed = true;
				continue;
			}
			const previous = runs.get(update.sessionFile);
			if (!previous || previous.status !== update.status || previous.agent !== update.agent) {
				changed = true;
			}
			// 先删后设，保持「最近更新在末尾」的插入序，超出上限时淘汰最久未更新的条目。
			runs.delete(update.sessionFile);
			runs.set(update.sessionFile, {
				sessionFile: update.sessionFile,
				status: update.status,
				...(update.agent ? { agent: update.agent } : {}),
				updatedAt: now,
				// 记住所属工具调用：工具级失败（details 里没有 results）时才能精准清掉它的残留行。
				...(toolCallId ? { toolCallId } : previous?.toolCallId ? { toolCallId: previous.toolCallId } : {}),
			});
		}
		if (runs.size === 0) {
			this.runsByAgent.delete(agentId);
			return changed;
		}
		this.runsByAgent.set(agentId, runs);
		if (this.enforceLimit(runs)) changed = true;
		return changed;
	}

	/**
	 * 当前可见快照。TTL 只在主进程内存侧保底，不会主动推送：UI 的清理靠
	 * completed 终态帧（observe 内直接删除）/ agent_end（running）/ detach /
	 * 下一次工具事件，避免为此新增定时器。
	 */
	snapshot(agentId: string, now = Date.now()): SubagentLiveRun[] {
		this.prune(agentId, now);
		const runs = this.runsByAgent.get(agentId);
		if (!runs || runs.size === 0) return [];
		// 显式投影：toolCallId 是内部记账，不能随载荷下发给渲染层。
		return [...runs.values()].map((run) => ({
			sessionFile: run.sessionFile,
			status: run.status,
			...(run.agent ? { agent: run.agent } : {}),
			updatedAt: run.updatedAt,
		}));
	}

	/**
	 * 工具级失败：subagent 工具可能在 details 里根本不带 results（参数错误/启动失败），
	 * 此时该次调用登记的 running 行再也收不到终态，必须在同回合内清掉。
	 *
	 * 只清 running：工具调用带 isError 是常态（任一子代理失败就会置 true），
	 * 此时 observe 已经写入的 error 行必须保留，否则红灯会被立刻抹掉。
	 */
	clearToolCall(agentId: string, toolCallId: string): boolean {
		if (!toolCallId) return false;
		const runs = this.runsByAgent.get(agentId);
		if (!runs) return false;
		let changed = false;
		for (const [sessionFile, run] of runs) {
			if (run.toolCallId !== toolCallId || run.status !== "running") continue;
			runs.delete(sessionFile);
			changed = true;
		}
		if (changed && runs.size === 0) this.runsByAgent.delete(agentId);
		return changed;
	}

	/**
	 * 回合结束：仍处于 running 的条目不可能再收到更新（子代理随回合销毁），
	 * 立刻移除避免黄灯卡在侧栏；error 条目保留供用户回看。
	 */
	clearRunning(agentId: string): boolean {
		const runs = this.runsByAgent.get(agentId);
		if (!runs) return false;
		let changed = false;
		for (const [sessionFile, run] of runs) {
			if (run.status !== "running") continue;
			runs.delete(sessionFile);
			changed = true;
		}
		if (runs.size === 0) this.runsByAgent.delete(agentId);
		return changed;
	}

	clearAgent(agentId: string): boolean {
		return this.runsByAgent.delete(agentId);
	}

	private prune(agentId: string, now: number): boolean {
		const runs = this.runsByAgent.get(agentId);
		if (!runs) return false;
		let changed = false;
		for (const [sessionFile, run] of runs) {
			const ttl = run.status === "error" ? ERROR_TTL_MS : RUNNING_TTL_MS;
			if (now - run.updatedAt <= ttl) continue;
			runs.delete(sessionFile);
			changed = true;
		}
		if (runs.size === 0) {
			this.runsByAgent.delete(agentId);
			changed = true;
		}
		return changed;
	}

	private enforceLimit(runs: Map<string, TrackedRun>): boolean {
		let changed = false;
		while (runs.size > MAX_RUNS_PER_AGENT) {
			const oldest = runs.keys().next().value;
			if (oldest === undefined) break;
			runs.delete(oldest);
			changed = true;
		}
		return changed;
	}
}

export const SUBAGENT_RUN_TRACKER_LIMITS = Object.freeze({
	maxRunsPerAgent: MAX_RUNS_PER_AGENT,
	runningTtlMs: RUNNING_TTL_MS,
	errorTtlMs: ERROR_TTL_MS,
});
