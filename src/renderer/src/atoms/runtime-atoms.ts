import { atom } from "jotai";
import { atomFamily, selectAtom } from "jotai/utils";
import type { AgentRuntimeState, AgentStatus, AgentTab } from "../../../shared/types";
import { sessionRecordsAtom, sessionRuntimeByIdAtom } from "./session-atoms";
import { sessionIdByRuntimeAgentIdAtomFamily } from "./session-selectors";

export const agentInventoryAtom = atom((get) => {
  const records = get(sessionRecordsAtom);
  return Object.entries(get(sessionRuntimeByIdAtom))
    .filter((entry): entry is [string, typeof entry[1] & {
      agentId: string;
      projectId: string;
      cwd: string;
      createdAt: number;
      status: AgentStatus;
    }] => Boolean(
      entry[1].agentId &&
      entry[1].projectId &&
      entry[1].cwd &&
      entry[1].createdAt != null &&
      entry[1].status !== "detached",
    ))
    .sort((left, right) => left[1].createdAt - right[1].createdAt)
    .map(([sessionId, runtime]): AgentTab => {
      const record = records[sessionId];
      return {
        id: runtime.agentId,
        projectId: runtime.projectId,
        cwd: runtime.cwd,
        title: record?.title ?? runtime.title ?? "Session",
        status: runtime.status,
        sessionId: runtime.piSessionId,
        sessionPath: runtime.sessionPath,
        sessionEnvironment: record?.environment,
        sessionSource: record?.source,
        wslDistro: record?.wslDistro,
        wslUser: record?.wslUser,
        importedSourceId: record?.importedSourceId,
        noSession: runtime.noSession ?? record?.noSession,
        runtimeGeneration: runtime.runtimeGeneration,
        createdAt: runtime.createdAt,
        compactionCount: runtime.compactionCount,
      };
    });
});

/**
 * 全局是否存在「正在工作」的 runtime：任意项目任意 Agent starting/running、流式输出或执行工具都算。
 * 全局门控（如 Skills 快捷修改）必须以权威 sessionRuntimeByIdAtom 为准，
 * 不能用 activeProjectRuntimeCapabilities（只覆盖当前项目）或 activeAgentId（只看聚焦 Agent）判断。
 * detached/closed 不命中 working 条件；有 Agent 打开但全部 idle 时为 false（允许进入 Skills 修改）。
 */
export const anyAgentRuntimeWorkingAtom = atom((get) =>
  Object.values(get(sessionRuntimeByIdAtom)).some((runtime) =>
    runtime.status === "starting" ||
    runtime.status === "running" ||
    Boolean(runtime.state?.isStreaming) ||
    Boolean(runtime.state?.isExecutingTool),
  ),
);

export const agentByIdAtomFamily = atomFamily((agentId: string) =>
  atom((get) => get(agentInventoryAtom).find((agent) => agent.id === agentId)),
);

export const agentsByProjectIdAtomFamily = atomFamily((projectId: string) =>
  atom((get) => get(agentInventoryAtom).filter((agent) => agent.projectId === projectId)),
);

export const runtimeCapabilityByAgentIdAtomFamily = atomFamily((agentId: string) =>
  atom((get) => Object.values(get(sessionRuntimeByIdAtom))
    .find((runtime) => runtime.agentId === agentId)?.state),
);

/**
 * agent 退出（closed）时释放 agentId 维度 atomFamily 缓存：
 * agentId 每次都是新 UUID，不复用则 family 内部 Map 只增不清（2026-10 泄漏修复）。
 * 由 useSessionRuntimeBridge 在 agents:state 全量推送中检测 closed 后触发；
 * atomFamily 惰性重建，后续同 id 重新出现时无副作用。
 */
export const agentExitedAtom = atom(null, (_get, _set, agentId: string) => {
  agentByIdAtomFamily.remove(agentId);
  runtimeCapabilityByAgentIdAtomFamily.remove(agentId);
  sessionIdByRuntimeAgentIdAtomFamily.remove(agentId);
});

function areRuntimeCapabilityRecordsEqual(
  left: Record<string, AgentRuntimeState>,
  right: Record<string, AgentRuntimeState>,
): boolean {
  const leftIds = Object.keys(left);
  const rightIds = Object.keys(right);
  return leftIds.length === rightIds.length &&
    leftIds.every((agentId) => left[agentId] === right[agentId]);
}

export const runtimeCapabilitiesByProjectIdAtomFamily = atomFamily((projectId: string) => {
  const projectCapabilitiesAtom = atom((get) => Object.fromEntries(
    get(agentsByProjectIdAtomFamily(projectId))
      .map((agent) => {
        const runtime = Object.values(get(sessionRuntimeByIdAtom))
          .find((candidate) => candidate.agentId === agent.id);
        return [agent.id, runtime?.state] as const;
      })
      .filter((entry): entry is readonly [string, AgentRuntimeState] => Boolean(entry[1])),
  ));
  return selectAtom(
    projectCapabilitiesAtom,
    (capabilities) => capabilities,
    areRuntimeCapabilityRecordsEqual,
  );
});
