import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
const { chatMessagesToUiMessages, mergeAuthoritativeUiMessages } = loadTsCommonJs("src/renderer/src/web/webApi.ts");

test("browser intermediate race keeps one read after the sse replay is covered", () => {
	const history = chatMessagesToUiMessages([
		{ id: "session-history-user", agentId: "agent", role: "user", text: "PC prompt", timestamp: 1005, meta: { entryId: "entry-user" } },
		{ id: "session-history-answer", agentId: "agent", role: "assistant", text: "Intermediate response", timestamp: 1105, meta: { entryId: "entry-answer" } },
	]);
	const live = chatMessagesToUiMessages([
		{ id: "pc-live-user", agentId: "agent", role: "user", text: "PC prompt", timestamp: 1000 },
		{ id: "pc-live-answer", agentId: "agent", role: "assistant", text: "Intermediate response", timestamp: 1100 },
		{ id: "pc-live-tool", agentId: "agent", role: "tool", text: "read", timestamp: 1200,
			meta: { toolName: "read", toolCallId: "call-read", args: { path: "file.txt" }, status: "running" } },
	]);
	const sse = { id: "sse-run", role: "assistant", metadata: { chatRole: "assistant", timestamp: 1100, reconciledIds: ["sse-run"] }, parts: [
		{ type: "text", text: "Intermediate response" },
		{ type: "text", text: "Intermediate response" },
		{ type: "tool-read", toolCallId: "call-read", state: "output-available", input: { path: "file.txt" }, output: "read result" },
	] };
	const merged = mergeAuthoritativeUiMessages(
		[...history, live[2], sse],
		live,
		{ dropUnmatchedTrailingPlaceholders: true },
	);
	assert.equal(merged.some((m) => m.id === "sse-run"), false, JSON.stringify(merged.map((m) => m.id)));
	assert.equal(merged.flatMap((m) => m.parts).filter((p) => p.toolCallId === "call-read").length, 1);
});
