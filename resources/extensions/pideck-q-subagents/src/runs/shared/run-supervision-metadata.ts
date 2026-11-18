/** Host review routing is independent of the optional child conversation bridge. */
import { resolveSupervisorChannelDir } from "../../intercom/native-supervisor-channel.ts";
import { childSupervisorMetadata, type ChildRuntimeConfig, type ChildSupervisorMetadata } from "./child-runtime-config.ts";

/** Resolve the parent-owned review channel without granting the child supervisor capabilities. */
export function resolveRunSupervisionMetadata(config: ChildRuntimeConfig): ChildSupervisorMetadata | undefined {
	const { orchestratorSessionId, runId, agent, childIndex } = config;
	if (typeof orchestratorSessionId !== "string" || !orchestratorSessionId.trim()
		|| typeof runId !== "string" || !runId.trim() || typeof agent !== "string" || !agent.trim()
		|| typeof childIndex !== "number" || !Number.isInteger(childIndex) || childIndex < 0) return undefined;
	const existing = childSupervisorMetadata(config);
	if (existing && typeof existing.channelDir === "string" && existing.channelDir.trim()) return existing;
	// Keep this derived metadata outside the captured child config. Populating its channel
	// would register contact_supervisor even when the caller explicitly disabled the bridge.
	return {
		channelDir: resolveSupervisorChannelDir(runId, agent, childIndex),
		orchestratorSessionId, runId, agent, childIndex,
		...(config.orchestratorTarget ? { orchestratorTarget: config.orchestratorTarget } : {}),
		...(config.intercomSessionName ? { childTarget: config.intercomSessionName } : {}),
	};
}
