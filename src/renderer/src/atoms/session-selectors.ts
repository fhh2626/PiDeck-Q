import { atom } from "jotai";
import { atomFamily, selectAtom } from "jotai/utils";
import type { SessionRecord, SessionSummary } from "../../../shared/types";
import {
  sameSessionRuntimeView,
  sessionCacheStatsAtom,
  sessionIdsByProjectAtom,
  sessionRecordsAtom,
  sessionRuntimeByIdAtom,
  sessionRuntimeUiByIdAtom,
} from "./session-atoms";

export function sessionRecordToSummary(
  session: SessionRecord,
): SessionSummary | undefined {
  if (!session.filePath) return undefined;
  return {
    id: session.id,
    filePath: session.filePath,
    projectPath: session.projectPath,
    name: session.title,
    isInternalSubagent: session.isInternalSubagent,
    parentSessionPath: session.parentSessionPath,
    preview: session.preview,
    updatedAt: session.updatedAt,
    messageCount: session.messageCount,
    source: session.source,
    wsl: session.environment === "wsl" || session.wsl || undefined,
    codexSessionId: session.codexSessionId,
    codexThreadSource: session.codexThreadSource,
    codexParentThreadId: session.codexParentThreadId,
    codexAgentRole: session.codexAgentRole,
    codexAgentNickname: session.codexAgentNickname,
  };
}

export const sessionRecordByIdAtomFamily = atomFamily((sessionId: string) =>
  atom((get) => get(sessionRecordsAtom)[sessionId]),
);

export const sessionRecordsByProjectIdAtomFamily = atomFamily((projectId: string) =>
  atom((get) => {
    const records = get(sessionRecordsAtom);
    return (get(sessionIdsByProjectAtom)[projectId] ?? [])
      .map((sessionId) => records[sessionId])
      .filter((session): session is SessionRecord => Boolean(session));
  }),
);

export const sessionSummariesByProjectIdAtomFamily = atomFamily((projectId: string) =>
  atom((get) => get(sessionRecordsByProjectIdAtomFamily(projectId))
    .map(sessionRecordToSummary)
    .filter((session): session is SessionSummary => Boolean(session))
    .sort((left, right) => right.updatedAt - left.updatedAt)),
);

export const sessionRuntimeBySessionIdAtomFamily = atomFamily((sessionId: string) =>
  selectAtom(sessionRuntimeByIdAtom, (map) => map[sessionId], sameSessionRuntimeView),
);

// A moved runtime can leave an older Session projection behind; the newest binding wins.
export const sessionIdByRuntimeAgentIdAtomFamily = atomFamily((agentId: string) =>
  atom((get) => Object.entries(get(sessionRuntimeByIdAtom)).reduce<{
    sessionId?: string;
    updatedAt: number;
  }>((selected, [sessionId, runtime]) => (
    runtime.agentId === agentId && runtime.updatedAt >= selected.updatedAt
      ? { sessionId, updatedAt: runtime.updatedAt }
      : selected
  ), { updatedAt: -1 }).sessionId),
);

/** Cache-rate history is session-local; the caller memoizes this atom for its mount lifetime.
 * Unlike an atomFamily, this does not retain deleted session IDs in a global cache.
 */
export function sessionCacheStatsBySessionIdAtom(sessionId: string) {
  return selectAtom(sessionCacheStatsAtom, (map) => map[sessionId], Object.is);
}

export const sessionRuntimeUiBySessionIdAtomFamily = atomFamily((sessionId: string) =>
  atom((get) => get(sessionRuntimeUiByIdAtom)[sessionId]),
);
