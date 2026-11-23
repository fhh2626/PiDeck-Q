import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { resolveBackendExecutable, SseClient } from "./helpers/native2BackendHarness.mjs";
import {
	channelEvents,
	createSuiteProject,
	messageEnd,
	messageStart,
	removeSuiteProject,
	runtimeEnvelopes,
	startRuntimeBackend,
	textDelta,
	toolEdgePatches,
	waitFor,
} from "./helpers/native2RuntimeEvents.mjs";

/**
 * Parallel tool batching parity (`src/shared/toolRuntimeState.ts`).
 *
 * pi starts every call of a parallel batch with its own `tool_execution_start` and ends
 * them in completion order. The oracle tracks the open calls by `toolCallId` and only
 * publishes the `isExecutingTool:false` edge when the *last* one ends
 * (`updateActiveToolCalls` + `applyActiveToolCallState`): the first end of a batch must
 * keep the edge true and report the other call's name. A premature false edge re-enables
 * steer/edit mid-batch and releases the manual-compaction completion gate early.
 *
 * The compaction cases pin the `compaction_end` → 300 ms `markIdleIfPiReportsNoWork` arm:
 * it must exist (a TypeScript runtime with no `agent_settled` settles only because of it),
 * and an open tool call must gate it.
 */

const executable = resolveBackendExecutable();
const PROJECT_ID = "tool-batch";

const toolStart = (toolCallId, toolName) => ({
	type: "tool_execution_start",
	toolCallId,
	toolName,
	args: { command: "echo" },
});

const toolEnd = (toolCallId, toolName, text = "ok") => ({
	type: "tool_execution_end",
	toolCallId,
	toolName,
	result: { content: [{ type: "text", text }] },
	isError: false,
});

if (executable) {
	describe("native2 parallel tool batch parity", () => {
		let root;
		let projectPath;

		before(() => {
			({ root, projectPath } = createSuiteProject("pideck-native2-toolbatch-"));
		});

		after(() => {
			removeSuiteProject(root);
		});

		const openSse = async (t, session) => {
			const sse = new SseClient(`${session.baseUrl}__pideck/events?token=${encodeURIComponent(session.token)}`);
			await sse.connect().catch(() => undefined);
			t.after(() => sse.close());
			return sse;
		};

		test("two overlapping calls publish one true edge pair and one aggregated false edge", async (t) => {
			const scenario = {
				turns: [{
					ack: true,
					events: [
						{ event: { type: "agent_start" } },
						{ event: messageStart("msg_tools") },
						{ delayMs: 10, event: toolStart("call-a", "bash") },
						{ delayMs: 10, event: toolStart("call-b", "read") },
						// `call-a` finishes while `call-b` is still running: the batch is NOT over.
						{ delayMs: 60, event: toolEnd("call-a", "bash") },
						{ delayMs: 250, event: toolEnd("call-b", "read") },
						{ delayMs: 10, event: textDelta("both done") },
						{ delayMs: 10, event: messageEnd("both done") },
						{ delayMs: 10, event: { type: "agent_end", messages: [] } },
						{ delayMs: 10, event: { type: "agent_settled" } },
					],
				}],
			};
			const session = await startRuntimeBackend(t, { scenario, projectId: PROJECT_ID, projectPath });
			const { record } = await session.activate(`tools-${Date.now()}`);
			const sse = await openSse(t, session);

			await session.prompt(record, "run two tools", "tools-1");
			// Gate on content, not on status: activation legitimately publishes both `idle` and
			// `running` before the prompt, so a status wait would pass for the wrong reason.
			await waitFor(
				() => channelEvents(sse, record.id, "agents:message")
					.some((payload) => payload.messages.some((row) => row.role === "assistant" && row.text === "both done")),
				15_000,
				"the reply to reach the projection",
			);

			const patches = toolEdgePatches(sse, record.id);
			assert.deepEqual(
				patches.map((state) => state.toolStateSequence),
				[1, 2, 3, 4],
				`one edge per start/end, saw ${JSON.stringify(patches)}`,
			);
			// starts: bash then read (the last inserted open call is the displayed name).
			assert.deepEqual(
				patches.slice(0, 2).map((state) => [state.isExecutingTool, state.executingToolName]),
				[[true, "bash"], [true, "read"]],
			);
			// `call-a` ended, `call-b` still runs: the edge must stay true and keep `read`.
			assert.deepEqual(
				[patches[2].isExecutingTool, patches[2].executingToolName],
				[true, "read"],
				`the first end of a parallel batch must not clear the tool edge: ${JSON.stringify(patches[2])}`,
			);
			// Last end: the only false edge of the batch.
			assert.equal(patches[3].isExecutingTool, false, JSON.stringify(patches[3]));
			assert.equal("executingToolName" in patches[3], false, JSON.stringify(patches[3]));
			assert.equal(
				patches.filter((state) => state.isExecutingTool === false).length,
				1,
				`exactly one false edge per batch, saw ${JSON.stringify(patches)}`,
			);

			// Both tool rows survive in the projection with their terminal status.
			const rows = channelEvents(sse, record.id, "agents:message")
				.at(-1)
				.messages.filter((row) => row.meta?.type === "tool" || row.role === "tool");
			assert.deepEqual(
				rows.map((row) => row.meta?.status ?? row.status),
				["done", "done"],
				JSON.stringify(rows.map((row) => [row.meta?.toolName ?? row.text, row.meta?.status])),
			);
		});

		test("compaction_end alone settles a TypeScript runtime through the 300 ms check", async (t) => {
			// No `sessionId` on agent_start and no `agent_settled`: only the `compaction_end`
			// arm can produce `idle` before the 5 s turn-end watchdog.
			const scenario = {
				turns: [{
					ack: true,
					events: [
						{ event: { type: "agent_start" } },
						{ delayMs: 10, event: messageStart("msg_c") },
						{ delayMs: 10, event: textDelta("compacted") },
						{ delayMs: 10, event: messageEnd("compacted") },
						{ delayMs: 10, event: { type: "auto_compaction_end", result: { summary: "s" } } },
					],
				}],
			};
			const session = await startRuntimeBackend(t, { scenario, projectId: PROJECT_ID, projectPath });
			const { record } = await session.activate(`compact-${Date.now()}`);
			const sse = await openSse(t, session);

			await session.prompt(record, "compact", "compact-1");
			// Wait for a frame that can only come from *this* turn first: activation publishes its
			// own idle state, so a bare idle wait would match a pre-prompt frame.
			await waitFor(
				() => runtimeEnvelopes(sse, record.id).some((event) => event.sourceChannel === "agents:text-stream"),
				15_000,
				"live reply frame",
			);
			const replyIndex = runtimeEnvelopes(sse, record.id).findIndex((event) => event.sourceChannel === "agents:text-stream");
			await waitFor(
				() => runtimeEnvelopes(sse, record.id)
					.slice(replyIndex)
					.some((event) => event.sourceChannel === "agents:state" && event.payload?.status === "idle"),
				1_800,
				"compaction idle check",
			);
			const polls = session.fake.readLog().filter((entry) => entry.kind === "command" && entry.command === "get_state");
			assert.ok(polls.length > 1, "the idle check must poll get_state (activation polled once already)");
		});

		test("the compaction idle check does not settle a runtime that is still executing a tool", async (t) => {
			// The oracle returns early on `toolExecutingByAgent`: a compaction cannot settle a
			// runtime whose tool call is still open.
			const scenario = {
				turns: [{
					ack: true,
					events: [
						{ event: { type: "agent_start" } },
						{ delayMs: 10, event: toolStart("call-long", "bash") },
						{ delayMs: 20, event: { type: "auto_compaction_end", result: { summary: "s" } } },
						// Well past the 300 ms idle check, the tool is still running.
						{ delayMs: 900, event: toolEnd("call-long", "bash") },
						{ delayMs: 10, event: { type: "agent_end", messages: [] } },
						{ delayMs: 10, event: { type: "agent_settled" } },
					],
				}],
			};
			const session = await startRuntimeBackend(t, { scenario, projectId: PROJECT_ID, projectPath });
			const { record } = await session.activate(`compact-tool-${Date.now()}`);
			const sse = await openSse(t, session);

			await session.prompt(record, "compact while running", "compact-tool-1");
			const toolRowsAt = (status) => runtimeEnvelopes(sse, record.id)
				.map((event, index) => ({ event, index }))
				.filter(({ event }) => event.sourceChannel === "agents:message"
					&& event.payload?.messages?.some((row) => (row.meta?.type === "tool" || row.role === "tool")
						&& (row.meta?.status ?? row.status) === status));
			// The executing edge is the reliable start marker: the compaction's history reload
			// replaces the transcript (and the still-running tool row) right after it.
			await waitFor(
				() => toolEdgePatches(sse, record.id).some((state) => state.isExecutingTool === true),
				15_000,
				"tool start edge",
			);
			await waitFor(() => toolRowsAt("done").length > 0, 15_000, "tool end row");
			const events = runtimeEnvelopes(sse, record.id);
			const startIndex = events.findIndex((event) => event.sourceChannel === "agents:runtime-state"
				&& event.payload?.state?.isExecutingTool === true
				&& !("isStreaming" in event.payload.state));
			const endIndex = events.findIndex((event, index) => index > startIndex
				&& event.sourceChannel === "agents:message"
				&& event.payload?.messages?.some((row) => (row.meta?.type === "tool" || row.role === "tool")
					&& (row.meta?.status ?? row.status) === "done"));
			assert.ok(startIndex >= 0, "the tool must publish a true edge");
			assert.ok(endIndex > startIndex, "the tool must have ended after the run started");
			const idleBeforeToolEnd = events
				.slice(startIndex, endIndex)
				.filter((event) => event.sourceChannel === "agents:state" && event.payload?.status === "idle");
			assert.deepEqual(
				idleBeforeToolEnd.map((event) => event.payload.status),
				[],
				"the compaction idle check must not settle a runtime with an open tool call",
			);
			await waitFor(
				() => runtimeEnvelopes(sse, record.id)
					.slice(endIndex)
					.some((event) => event.sourceChannel === "agents:state" && event.payload?.status === "idle"),
				15_000,
				"final idle after the tool ended",
			);
			// The compaction flag does not survive the settle.
			const projections = channelEvents(sse, record.id, "agents:runtime-state")
				.filter((payload) => payload.state && "isCompacting" in payload.state);
			assert.ok(projections.length > 0, "a full runtime state must be published");
			assert.equal(
				projections.at(-1).state.isCompacting,
				false,
				"the finished compaction must not stay flagged",
			);
		});
	});
}
