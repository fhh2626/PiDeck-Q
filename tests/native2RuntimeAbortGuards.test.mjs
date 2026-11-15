import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { resolveBackendExecutable, SseClient } from "./helpers/native2BackendHarness.mjs";
import {
	channelEvents,
	channelPayloads,
	createSuiteProject,
	isRetryStatusRow,
	messageStart,
	removeSuiteProject,
	runtimeEnvelopes,
	startRuntimeBackend,
	textDelta,
	waitFor,
	sleep,
} from "./helpers/native2RuntimeEvents.mjs";

/**
 * Abort guards on the late retry / compaction events (`AgentManager.handlePiEvent`).
 *
 * The user stopped the turn; pi keeps writing frames into the pipe. The oracle keeps the
 * aborted status and suppresses the failure:
 *  - `auto_retry_start`: `runtime.tab.status = "running"` only when
 *    `!recentlyAborted.has(agentId)`;
 *  - `auto_retry_end` failure: no `markAgentError` and no error row when the user aborted;
 *  - `compaction_start` / `compaction_end`: the `running` re-activation is guarded by
 *    `!recentlyAborted` *and* `status !== "error"`.
 *
 * Without the guards a "stop" can visibly flip back to a running spinner or paint the
 * turn as failed after the user already stopped it.
 */

const executable = resolveBackendExecutable();
const PROJECT_ID = "abort-guards";

if (executable) {
	describe("native2 late retry/compaction abort guards", () => {
		let root;
		let projectPath;

		before(() => {
			({ root, projectPath } = createSuiteProject("pideck-native2-abortguards-"));
		});

		after(() => {
			removeSuiteProject(root);
		});

		/**
		 * Run one turn, abort it mid-stream and return the envelopes plus the abort position.
		 *
		 * The abort lands ~150 ms after the prompt, well before the scripted late events, so
		 * every assertion below is about frames that arrive *after* the user's stop.
		 */
		const abortMidTurn = async (t, events, label) => {
			const session = await startRuntimeBackend(t, {
				scenario: { turns: [{ ack: true, events }] },
				projectId: PROJECT_ID,
				projectPath,
			});
			const { record, target } = await session.activate(`${label}-${Date.now()}`);
			const sse = new SseClient(`${session.baseUrl}__pideck/events?token=${encodeURIComponent(session.token)}`);
			await sse.connect().catch(() => undefined);
			t.after(() => sse.close());
			await session.prompt(record, "long task", `${label}-1`);
			await waitFor(
				() => channelEvents(sse, record.id, "agents:text-stream").length > 0,
				15_000,
				"first live frame",
			);
			const aborted = await session.invoke("sessions:runtime-abort", [target]);
			assert.equal(aborted.payload.ok, true, JSON.stringify(aborted.payload));
			// The late frames arrive after this point; give them room to (wrongly) take effect.
			await sleep(1_400);
			return { session, record, sse, events: runtimeEnvelopes(sse, record.id) };
		};

		/** Index of the abort toast: the user's stop, as the renderer sees it. */
		const abortIndex = (envelopes) => envelopes.findIndex((event) => event.sourceChannel === "agents:notice"
			&& event.payload?.i18nKey === "app.abortRequested");

		test("a late auto-retry neither re-lights running nor paints the aborted turn as failed", async (t) => {
			const events = [
				{ event: { type: "agent_start" } },
				{ event: messageStart("msg_retry") },
				{ delayMs: 10, event: textDelta("working") },
				{ delayMs: 600, event: { type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 100, errorMessage: "rate limited" } },
				{ delayMs: 20, event: { type: "auto_retry_end", success: false, errorMessage: "boom" } },
				{ delayMs: 20, event: { type: "agent_end", messages: [] } },
				{ delayMs: 20, event: { type: "agent_settled" } },
			];
			const { record, sse, events: envelopes } = await abortMidTurn(t, events, "retry");

			const stop = abortIndex(envelopes);
			assert.ok(stop >= 0, "the abort must publish its notice");
			const afterStop = envelopes.slice(stop);
			const statuses = afterStop
				.filter((event) => event.sourceChannel === "agents:state")
				.map((event) => event.payload.status);
			assert.equal(
				statuses.includes("running"),
				false,
				`a late auto-retry must not re-light running after a stop: ${JSON.stringify(statuses)}`,
			);
			assert.equal(
				statuses.includes("error"),
				false,
				`an aborted turn must not be marked failed: ${JSON.stringify(statuses)}`,
			);
			const rows = channelEvents(sse, record.id, "agents:message")
				.flatMap((payload) => payload.messages);
			assert.equal(
				rows.some((row) => String(row.text ?? "").includes("boom")),
				false,
				`the aborted failure must not be written into the transcript: ${JSON.stringify(rows.map((row) => row.text))}`,
			);
			// The branch really ran: the retry status row is still written (oracle writes it
			// before the status guard), so this case is not vacuously green.
			assert.equal(
				rows.some((row) => isRetryStatusRow(row)),
				true,
				`the retry card must still be projected: ${JSON.stringify(rows.map((row) => row.meta ?? row.text))}`,
			);
		});

		test("a late compaction_start/end keeps the aborted status", async (t) => {
			const events = [
				{ event: { type: "agent_start" } },
				{ event: messageStart("msg_compact_abort") },
				{ delayMs: 10, event: textDelta("working") },
				{ delayMs: 600, event: { type: "compaction_start", reason: "overflow" } },
				{ delayMs: 20, event: { type: "compaction_end", reason: "overflow", result: { summary: "s" } } },
				{ delayMs: 20, event: { type: "agent_end", messages: [] } },
				{ delayMs: 20, event: { type: "agent_settled" } },
			];
			const { record, events: envelopes } = await abortMidTurn(t, events, "compact");

			const stop = abortIndex(envelopes);
			assert.ok(stop >= 0, "the abort must publish its notice");
			const statuses = envelopes
				.slice(stop)
				.filter((event) => event.sourceChannel === "agents:state")
				.map((event) => event.payload.status);
			assert.equal(
				statuses.includes("running"),
				false,
				`a late compaction must not re-light running after a stop: ${JSON.stringify(statuses)}`,
			);
			assert.equal(
				statuses.includes("error"),
				false,
				`an aborted compaction must not fail the turn: ${JSON.stringify(statuses)}`,
			);
			// The turn is still usable: the final status of the aborted runtime is idle, so the
			// next prompt can be sent without a restart.
			const lastStatus = channelPayloads(envelopes, "agents:state").at(-1)?.status;
			assert.equal(lastStatus, "idle", `the aborted runtime must end idle, saw ${lastStatus}`);
		});
	});
}
