import { atom } from "jotai";
import type {
	SubagentLiveRun,
	SubagentLiveRunStatus,
} from "../../../shared/types";

/**
 * pi 内建子代理的实时运行态（按 agent 分组）。
 *
 * 子会话不是 PiDeck 的 Agent，`sessionRuntimeByIdAtom` 里不会有它们的条目；
 * 侧栏子会话行的状态点只能从这里取。主进程整表推送，渲染层按会话文件路径匹配。
 */
export const subagentLiveRunsByAgentAtom = atom<Record<string, SubagentLiveRun[]>>({});

const EMPTY_LIVE_RUNS: readonly SubagentLiveRun[] = Object.freeze([]);

/** 侧栏用的扁平视图：一次取全部 agent 的子代理状态，交给纯函数按路径匹配。 */
export const subagentLiveRunsAtom = atom<readonly SubagentLiveRun[]>((get) => {
	const byAgent = get(subagentLiveRunsByAgentAtom);
	const agentIds = Object.keys(byAgent);
	if (agentIds.length === 0) return EMPTY_LIVE_RUNS;
	const runs: SubagentLiveRun[] = [];
	for (const agentId of agentIds) runs.push(...byAgent[agentId]);
	return runs;
});

function isLiveStatus(value: unknown): value is SubagentLiveRunStatus {
	return value === "running" || value === "error" || value === "completed";
}

const MAX_LIVE_RUNS = 128;

/** 单帧最多扫描的条目数：防重复路径刷爆循环（主进程已限 64，这是防御层）。 */
const MAX_SCANNED_ENTRIES = 512;

/**
 * 跨进程数据一律收窄：只接受 sessionFile/status 合法的条目，其余丢弃；
 * 同路径只留最新一条（主进程已去重，这里防多 agent 重发叠加）；总量与扫描量设硬上限。
 */
function sanitizeRuns(value: unknown): SubagentLiveRun[] {
	if (!Array.isArray(value)) return [];
	const byPath = new Map<string, SubagentLiveRun>();
	const scanned = Math.min(value.length, MAX_SCANNED_ENTRIES);
	for (let index = 0; index < scanned; index += 1) {
		if (byPath.size >= MAX_LIVE_RUNS) break;
		const item = value[index];
		if (!item || typeof item !== "object") continue;
		const record = item as Record<string, unknown>;
		if (typeof record.sessionFile !== "string" || !record.sessionFile) continue;
		if (!isLiveStatus(record.status)) continue;
		const run: SubagentLiveRun = {
			sessionFile: record.sessionFile,
			status: record.status,
			...(typeof record.agent === "string" && record.agent ? { agent: record.agent } : {}),
			// NaN/Infinity 会让「最新优先」永远失真，统一归零。
			updatedAt: typeof record.updatedAt === "number" && Number.isFinite(record.updatedAt)
				? record.updatedAt
				: 0,
		};
		const previous = byPath.get(run.sessionFile);
		if (!previous || run.updatedAt >= previous.updatedAt) byPath.set(run.sessionFile, run);
	}
	return [...byPath.values()];
}

function sameRuns(left: readonly SubagentLiveRun[], right: readonly SubagentLiveRun[]): boolean {
	if (left.length !== right.length) return false;
	for (let index = 0; index < left.length; index += 1) {
		const a = left[index];
		const b = right[index];
		// updatedAt 不参与比较：同一状态的重复帧不应唤醒侧栏。
		if (a.sessionFile !== b.sessionFile || a.status !== b.status || a.agent !== b.agent) return false;
	}
	return true;
}

/** 应用主进程推来的整表快照（同值跳过写入，避免无意义重渲染）。 */
export const applySubagentLiveSnapshotAtom = atom(
	null,
	(get, set, snapshot: { agentId: string; runs: unknown }) => {
		const runs = sanitizeRuns(snapshot.runs);
		const current = get(subagentLiveRunsByAgentAtom);
		const previous = current[snapshot.agentId] ?? [];
		if (sameRuns(previous, runs)) return;
		const next = { ...current };
		if (runs.length > 0) next[snapshot.agentId] = runs;
		else delete next[snapshot.agentId];
		set(subagentLiveRunsByAgentAtom, next);
	},
);

/** runtime detach / agent 清理：成对清掉该 agent 的子代理状态，避免残留黄灯。 */
export const clearSubagentLiveRunsAtom = atom(null, (get, set, agentId: string) => {
	const current = get(subagentLiveRunsByAgentAtom);
	if (!(agentId in current)) return;
	const next = { ...current };
	delete next[agentId];
	set(subagentLiveRunsByAgentAtom, next);
});
