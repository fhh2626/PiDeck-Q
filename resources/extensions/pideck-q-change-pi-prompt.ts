// PiDeck-bundled entrypoint for PiDeck-Q-Change-Pi-Prompt.
// Enabled by default in PiDeck; manage it from Settings → Extensions.
// Implementation stays in a sibling directory so relative imports remain intact
// when pi loads the extension from extraResources.
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ensureChildPowerShellTool } from "./pideck-q-change-pi-prompt/childPowerShellBridge.ts";
import { registerPromptExtension } from "./pideck-q-change-pi-prompt/runtime.ts";

export default function pideckQChangePiPrompt(pi: ExtensionAPI): void {
	const agentDir = getAgentDir();

	// Native child allowlists may still contain only the historical `bash` slot. Run this bridge
	// before the main prompt handler so a parent-authorized PowerShell backend exists in the child
	// registry before shell pruning/canonicalization. before_agent_start handlers run in load order.
	pi.on("before_agent_start", (event, ctx) => {
		ensureChildPowerShellTool(pi, agentDir, {
			platform: process.platform,
			systemPrompt: event.systemPrompt,
			cwd: event.systemPromptOptions?.cwd ?? ctx.cwd,
		});
	});

	registerPromptExtension(pi, agentDir);
}
