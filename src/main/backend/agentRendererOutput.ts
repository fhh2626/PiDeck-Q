import { ipcChannels } from "../../shared/ipc";
import type { BackendHost } from "./Backend";

/**
 * These AgentManager outputs are consumed only inside sessions:runtime-event envelopes.
 * Keep the list explicit: raw RPC logs and trust prompts still have desktop subscribers,
 * and new channels must retain delivery unless their consumers are audited separately.
 * Web streams subscribe to AgentManager's local Pi events, not this renderer sender.
 */
const ENVELOPED_AGENT_CHANNELS: ReadonlySet<string> = new Set([
	ipcChannels.agentsMessage,
	ipcChannels.agentsTextStream,
	ipcChannels.agentsThinking,
	ipcChannels.agentsState,
	ipcChannels.agentsRuntimeState,
	ipcChannels.agentsUiRequest,
	ipcChannels.agentsNotice,
	ipcChannels.agentsLog,
]);

/** Avoid serializing/replaying an unused raw copy after onOutput delivered the session envelope. */
export function createAgentRendererSender(host: Pick<BackendHost, "sendToRenderer">): BackendHost["sendToRenderer"] {
	return (channel, ...args) => {
		if (!ENVELOPED_AGENT_CHANNELS.has(channel)) host.sendToRenderer(channel, ...args);
	};
}
