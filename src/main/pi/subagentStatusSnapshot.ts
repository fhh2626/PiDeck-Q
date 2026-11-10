import {
	SUBAGENT_STATUS_SNAPSHOT_VERSION,
	type SubagentStatusChild,
	type SubagentStatusChildState,
	type SubagentStatusSnapshot,
} from "../../shared/types/subagents";

/**
 * 解析扩展经 `ctx.ui.setStatus` 上报的子代理状态快照。
 *
 * 这是跨进程边界：渲染层/扩展来的数据一律不可信，必须逐字段校验并限长。
 * 解析失败返回 undefined 而不是抛错——状态上报是旁路，坏帧不能让主进程事件循环失败。
 */

/** 单帧文本上限；真实载荷远小于此值，超出即视为异常数据。 */
const MAX_STATUS_TEXT_BYTES = 32 * 1_024;
// 与扩展发布器、tracker 的单 agent 上限对齐；超出仍按 truncated 处理。
const MAX_CHILDREN = 64;
const MAX_SESSION_PATH_BYTES = 1_024;
const MAX_AGENT_BYTES = 96;
const MAX_ID_BYTES = 128;

const CHILD_STATES: ReadonlySet<string> = new Set([
	"running",
	"completed",
	"failed",
	"stopped",
	"paused",
	"detached",
]);

function asRecord(value: unknown): Record<string, unknown> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	return value as Record<string, unknown>;
}

function bounded(value: unknown, maxBytes: number): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	if (!trimmed || Buffer.byteLength(trimmed, "utf8") > maxBytes) return undefined;
	return trimmed;
}

export function parseSubagentStatusSnapshot(value: unknown): SubagentStatusSnapshot | undefined {
	if (typeof value !== "string") return undefined;
	if (Buffer.byteLength(value, "utf8") > MAX_STATUS_TEXT_BYTES) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		return undefined;
	}
	const record = asRecord(parsed);
	if (!record) return undefined;
	if (record.version !== SUBAGENT_STATUS_SNAPSHOT_VERSION) return undefined;

	const ownerSessionId = bounded(record.ownerSessionId, MAX_SESSION_PATH_BYTES);
	const parentToolCallId = bounded(record.parentToolCallId, MAX_ID_BYTES);
	const workflowRunId = bounded(record.workflowRunId, MAX_ID_BYTES);
	if (!ownerSessionId || !parentToolCallId || !workflowRunId) return undefined;

	const sequence = record.sequence;
	if (typeof sequence !== "number" || !Number.isSafeInteger(sequence) || sequence < 0) return undefined;
	const complete = record.complete;
	const truncated = record.truncated;
	if (typeof complete !== "boolean" || typeof truncated !== "boolean") return undefined;
	const observedAt = record.observedAt;
	if (typeof observedAt !== "number" || !Number.isFinite(observedAt)) return undefined;
	if (!Array.isArray(record.children)) return undefined;

	const children: SubagentStatusChild[] = [];
	// 被截断或被丢弃的行意味着这帧不再是完整清单：强制标记 truncated，
	// 让 tracker 只做增量更新，不能因为一行坏数据删掉其他子代理的灯。
	let dropped = record.children.length > MAX_CHILDREN;
	for (const item of record.children.slice(0, MAX_CHILDREN)) {
		const child = asRecord(item);
		if (!child) {
			dropped = true;
			continue;
		}
		const taskKey = bounded(child.taskKey, MAX_ID_BYTES);
		const sessionFile = bounded(child.sessionFile, MAX_SESSION_PATH_BYTES);
		const state = typeof child.state === "string" && CHILD_STATES.has(child.state)
			? child.state as SubagentStatusChildState
			: undefined;
		// 单条坏行只丢该行：不能因为一个非法条目把整帧（其他子代理的灯）判废。
		if (!taskKey || !sessionFile || !state) {
			dropped = true;
			continue;
		}
		const agent = bounded(child.agent, MAX_AGENT_BYTES);
		const executionId = bounded(child.executionId, MAX_ID_BYTES);
		children.push({
			taskKey,
			sessionFile,
			state,
			...(executionId ? { executionId } : {}),
			...(agent ? { agent } : {}),
		});
	}

	return {
		version: SUBAGENT_STATUS_SNAPSHOT_VERSION,
		ownerSessionId,
		parentToolCallId,
		workflowRunId,
		sequence,
		complete,
		truncated: truncated || dropped,
		observedAt,
		children,
	};
}

/**
 * 会话路径比较：扩展侧拿到的可能是原始 `getSessionFile()`，主进程侧是规范化路径。
 * Windows 盘符与分隔符大小写不一致不能当成不同会话，否则状态帧会被误判为串会话。
 */
export function sameSessionPath(left: string, right: string): boolean {
	const normalize = (value: string): string => {
		const unified = value.trim().replace(/\\/g, "/").replace(/\/+$/, "");
		return process.platform === "win32" ? unified.toLowerCase() : unified;
	};
	return normalize(left) === normalize(right);
}
