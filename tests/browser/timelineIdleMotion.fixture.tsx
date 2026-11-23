import { useState } from "react";
import { createRoot } from "react-dom/client";
import { RespondingIndicator } from "../../src/renderer/src/components/session/TimelineEventCards";
import { ToolCard } from "../../src/renderer/src/components/session/ToolCallComponents";
import type { ChatMessage } from "../../src/shared/types";
import "../../src/renderer/src/styles.css";

const tool: ChatMessage = {
	id: "quiet-tool", agentId: "fixture", role: "tool", text: "read notes.txt", timestamp: Date.now(),
	meta: { status: "running", toolName: "read", args: { path: "notes.txt" } },
};

function Fixture() {
	const [running, setRunning] = useState(true);
	return (
		<article className={`turn-row${running ? " turn-row--running" : ""}`}>
			<ToolCard message={tool} stopped={!running} />
			{running && <RespondingIndicator isExecutingTool />}
			<button type="button" onClick={() => setRunning(false)}>Stop fixture</button>
		</article>
	);
}

createRoot(document.getElementById("root")!).render(<Fixture />);
