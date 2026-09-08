// PiDeck-bundled entrypoint for PiDeck-Q-Change-Pi-Prompt.
// Disabled by default; enable it from Settings → Extensions.
// Implementation stays in a sibling directory so relative imports remain intact
// when pi loads the extension from extraResources.
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerPromptExtension } from "./pideck-q-change-pi-prompt/runtime.ts";

export default function pideckQChangePiPrompt(pi: ExtensionAPI): void {
	registerPromptExtension(pi, getAgentDir());
}
