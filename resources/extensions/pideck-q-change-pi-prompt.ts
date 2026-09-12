// PiDeck-bundled entrypoint for PiDeck-Q-Change-Pi-Prompt.
// Enabled by default in PiDeck; manage it from Settings → Extensions.
// Implementation stays in a sibling directory so relative imports remain intact
// when pi loads the extension from extraResources.
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ensureChildPowerShellTool } from "./pideck-q-change-pi-prompt/childPowerShellBridge.ts";
import { enforcePowerShellBackedBashSecurity } from "./pideck-q-change-pi-prompt/childPowerShellSecurity.ts";
import { loadSettings } from "./pideck-q-change-pi-prompt/config.ts";
import { registerPromptExtension } from "./pideck-q-change-pi-prompt/runtime.ts";

export default function pideckQChangePiPrompt(pi: ExtensionAPI): void {
	const agentDir = getAgentDir();
	// Fail closed until session_start successfully loads the same persisted config used by runtime.ts.
	// This prevents a stale parent policy snapshot from making disabled subagent adaptation mutate a child registry.
	let bridgeEnabled = false;

	pi.on("session_start", async () => {
		try {
			const { config } = await loadSettings(agentDir);
			bridgeEnabled = config.enabled === true && config.subagent === true;
		} catch {
			bridgeEnabled = false;
		}
	});

	// Native child allowlists may still contain only the historical `bash` slot. Run this bridge
	// before the main prompt handler so a parent-authorized PowerShell backend exists in the child
	// registry before shell pruning/canonicalization. before_agent_start handlers run in load order.
	pi.on("before_agent_start", (event, ctx) => {
		ensureChildPowerShellTool(pi, agentDir, {
			platform: process.platform,
			systemPrompt: event.systemPrompt,
			cwd: event.systemPromptOptions?.cwd ?? ctx.cwd,
			enabled: bridgeEnabled,
		});
	});

	// A PowerShell backend may intentionally occupy the historical `bash` child slot. PiDeck's
	// security gate chooses shell policy by tool name, so supplement it only when PowerShell rules
	// are stricter than the Bash-name rules. The normal security gate still runs afterwards.
	pi.on("tool_call", async (event, ctx) => enforcePowerShellBackedBashSecurity(
		pi,
		event,
		ctx,
		{ enabled: bridgeEnabled },
	));

	registerPromptExtension(pi, agentDir);
}
