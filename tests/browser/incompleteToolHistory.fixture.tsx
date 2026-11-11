import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { ChatMessage, ToolOutcomeStatus } from "../../src/shared/types";
import { ToolCard, ToolGroupCard } from "@/components/session/ToolCallComponents";
import { TooltipProvider } from "@/components/ui-shadcn/tooltip";
import { WebTimeline } from "@/web/WebTimeline";
import { chatMessagesToUiMessages } from "@/web/webApi";

/** Build full public rows, keeping the same identity across later observed outcomes. */
function tool(id: string, name: string, status: ToolOutcomeStatus): ChatMessage {
	return { id, agentId: "fixture", role: "tool", text: name, timestamp: 1,
		meta: { toolCallId: id, toolName: name, status, args: '{"task":"fixture"}', detailText: "Recorded input",
			...(status === "done" ? { result: "actual output" } : {}),
			...(status === "error" ? { isError: true, result: "actual failure" } : {}) } };
}

/** Exercise real Desktop and Web views, including mixed groups and incomplete asks. */
function Fixture() {
	const [status, setStatus] = useState<ToolOutcomeStatus>("unknown");
	const group = (prefix: string) => [tool(`${prefix}-sub`, "subagent", status),
		tool(`${prefix}-read`, "read", "done"), tool(`${prefix}-ask`, "ask_question", "unknown")];
	return <TooltipProvider><main className="space-y-4 p-4">
		<div className="flex gap-2">
			{(["unknown", "running", "done", "error"] satisfies ToolOutcomeStatus[]).map((value) =>
				<button key={value} id={`phase-${value}`} type="button" onClick={() => setStatus(value)}>{value}</button>)}
		</div>
		<section id="desktop-single"><ToolCard message={tool("single-sub", "subagent", status)} /></section>
		<section id="desktop-group"><ToolGroupCard group={{ id: "desktop-mixed", kind: "tool-group", messages: group("desktop") }} /></section>
		<section id="web-timeline" className="h-80">
			<WebTimeline messages={chatMessagesToUiMessages([
				{ id: "user", agentId: "fixture", role: "user", text: "Recorded task", timestamp: 0 }, ...group("web"),
			])} sessionId="fixture" hasActiveSession hasMoreHistory={false} loadingMore={false}
				onLoadMore={async () => null} streaming={false} error={null} />
		</section>
	</main></TooltipProvider>;
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<Fixture />);
