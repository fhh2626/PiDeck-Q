import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { AgentManager } = loadTsCommonJs("src/main/pi/AgentManager.ts");
const { stabilizeReloadedMessageIds } = loadTsCommonJs("src/main/pi/historyMessages.ts");

for (const end of ["settled", "process-exit"]) {
	test(`the real desktop ${end} cleanup cannot reapply a stale running tool over unknown history`, () => {
		const manager = new AgentManager(() => ({ id: "project", name: "Fixture", path: "C:/fixture" }),
			() => null, { get: () => ({}) }, {});
		const runtime = { tab: { id: "agent", projectId: "project", cwd: "C:/fixture", title: "Fixture",
			status: "running", sessionSource: "pi", sessionEnvironment: "native", createdAt: 1 },
			process: { client: { request: async () => ({ success: true, data: {} }) }, getDiagnostics: () => null } };
		manager.agents.set("agent", runtime);
		try {
			manager.handlePiEvent("agent", { type: "agent_start" });
			manager.handlePiEvent("agent", { type: "tool_execution_start", toolCallId: "unfinished", toolName: "subagent", args: {} });
			if (end === "settled") manager.handlePiEvent("agent", { type: "agent_settled" });
			else manager.handleCreateProcessExit("agent", runtime.tab, { code: 1, signal: null });
			const current = manager.messages.get("agent");
			const before = new Map(current.map((message) => [message.id, message]));
			const projected = manager.convertAgentMessages("agent", [{ role: "assistant", timestamp: 1,
				content: [{ type: "toolCall", id: "unfinished", name: "subagent", arguments: {} }] }]);
			const next = stabilizeReloadedMessageIds(current, projected,
				{ activeToolCallIds: manager.activeToolCallsByAgent.get("agent") });
			// This is the real commit step after id stabilization, not just the pure merger.
			manager.reapplyMessagesChangedDuringLoad("agent", next, before);
			const tools = next.filter((message) => message.role === "tool");
			assert.equal(tools.length, 1);
			assert.equal(tools[0].meta.status, "unknown");
			assert.equal(tools[0].meta.durationMs, undefined);
		} finally { manager.clearAgentState("agent"); }
	});
}
