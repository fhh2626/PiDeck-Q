import type { FocusTarget } from "../main/utils/focusTarget";

/** Resolve a secondary launch target without turning a focus-only launch into a no-op. */
export function resolveSecondaryFocusSessionId(
	target: FocusTarget | undefined,
	resolveAgentId: (agentId: string) => string | undefined,
): string | undefined {
	if (!target) return undefined;
	return target.sessionId ?? (target.agentId ? resolveAgentId(target.agentId) : undefined);
}
