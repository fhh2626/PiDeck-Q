import type { AgentTab } from "../../../shared/types";
import type { SessionPaneState } from "../components/session/SessionPaneServices";

/** AgentTab fields are scalar: inventory remapping must not turn equal data into a pane update.
 * Compare both key sets so added/removed optional runtime identity fields remain observable. */
function equalAgentTab(left: AgentTab | undefined, right: AgentTab | undefined): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return [...Object.keys(left), ...Object.keys(right)].every((key) =>
    Object.hasOwn(left, key) === Object.hasOwn(right, key) &&
    Object.is(Reflect.get(left, key), Reflect.get(right, key)));
}

/** Reuse a one-session projection without retaining unrelated sessions in the visible pane. */
function singleton<T>(key: string | undefined, value: T | undefined, previous?: Record<string, T>): Record<string, T> {
  const count = key !== undefined && value !== undefined ? 1 : 0;
  if (previous && Object.keys(previous).length === count && (count === 0 || Object.is(previous[key ?? ""], value))) return previous;
  return key !== undefined && value !== undefined ? { [key]: value } : {};
}

/**
 * Project runtime/queue/duration fields at the chrome boundary. Global chrome stays shared;
 * another agent's updates must not invalidate this session's Context value.
 */
export function projectSessionPaneState(
  source: SessionPaneState,
  sessionId: string,
  agentId: string | undefined,
  previous?: SessionPaneState,
): SessionPaneState {
  const agent = source.agents.find((candidate) => candidate.id === agentId);
  const agents = previous && previous.agents.length === (agent ? 1 : 0) && equalAgentTab(previous.agents[0], agent)
    ? previous.agents : agent ? [agent] : [];
  const candidate: SessionPaneState = {
    ...source,
    agents,
    queuedPromptsBySession: singleton(sessionId, source.queuedPromptsBySession[sessionId], previous?.queuedPromptsBySession),
    sessionDurationByAgent: singleton(agentId, agentId ? source.sessionDurationByAgent[agentId] : undefined, previous?.sessionDurationByAgent),
    restartingAgentId: source.restartingAgentId === agentId ? source.restartingAgentId : null,
  };
  if (previous && Object.keys(candidate).every((key) => Object.is(Reflect.get(candidate, key), Reflect.get(previous, key)))) return previous;
  return candidate;
}
