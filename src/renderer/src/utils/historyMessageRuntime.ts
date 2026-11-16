import type {
	SessionCommandResult,
	SessionHistoryMessageTarget,
	SessionRuntimeInfo,
	SessionRuntimeTarget,
} from "../../../shared/types";
import { t } from "../i18n";
import { isSameSessionRuntimeTarget, requireSessionCommand } from "./sessionCommands";

export type HistoryMessageRuntimeContext = {
	filePath: string;
	runtimeGeneration: number;
	agentId?: string;
	status?: string;
};

/** Activates saved-history actions without rebinding a stale activation response. */
export async function activateHistoryMessageRuntime(
	expected: SessionHistoryMessageTarget,
	deps: {
		readContext: (sessionId: string) => HistoryMessageRuntimeContext | undefined;
		activate: (sessionId: string) => Promise<SessionCommandResult<SessionRuntimeInfo>>;
		bind: (runtime: SessionRuntimeInfo) => void;
		readTarget: (sessionId: string) => SessionRuntimeTarget | undefined;
	},
): Promise<SessionRuntimeTarget> {
	const before = deps.readContext(expected.sessionId);
	if (!before || before.filePath !== expected.filePath || before.runtimeGeneration !== expected.runtimeGeneration) {
		throw new Error(t("sessionCommand.runtimeChanged"));
	}
	const activated = requireSessionCommand(await deps.activate(expected.sessionId));
	const current = deps.readContext(expected.sessionId);
	if (!current || current.filePath !== expected.filePath || activated.sessionId !== expected.sessionId
		|| activated.status === "closed" || activated.runtimeGeneration < expected.runtimeGeneration
		|| activated.sessionPath && activated.sessionPath !== expected.filePath) {
		throw new Error(t("sessionCommand.runtimeChanged"));
	}
	const matchesActivated = current.agentId === activated.agentId
		&& current.runtimeGeneration === activated.runtimeGeneration
		&& current.status !== "detached" && current.status !== "closed";
	const stillAwaitingActivation = current.runtimeGeneration === before.runtimeGeneration
		&& current.agentId === before.agentId && current.status === before.status;
	// A detach, restart, or replacement after activation began wins over its
	// late result. Only an unchanged baseline or this exact binding can advance.
	if (!matchesActivated && !stillAwaitingActivation) {
		throw new Error(t("sessionCommand.runtimeChanged"));
	}
	// SSE can report running/error before the activation RPC's idle response.
	// An already established binding owns that newer state and must not be reset.
	if (!matchesActivated) deps.bind(activated);
	const target = deps.readTarget(expected.sessionId);
	if (!target || !isSameSessionRuntimeTarget(activated, target)) {
		throw new Error(t("sessionCommand.runtimeChanged"));
	}
	return target;
}
