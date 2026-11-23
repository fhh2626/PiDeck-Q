import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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
 * Turn-end / abort parity for `agent_end`, `auto_retry_*` and manual `compact`.
 *
 * Oracle references (`src/main/pi/AgentManager.ts`):
 *  - `abort()` sends the RPC fire-and-forget (`request(...).catch(() => {})`) and flips the
 *    tab to `idle` locally, so a tool that blocks pi's event loop cannot keep the UI in
 *    `running` (the documented motivation for the `abort_bash` escalation);
 *  - `upsertRetryStatusMessage` keeps ONE retry row per agent, re-written with
 *    `meta.status` + `meta.i18nKey` (`diagnostic.retryScheduled*` / `retrySucceeded` /
 *    `retryFailed`) so the renderer shows it as a toast instead of a permanent card;
 *  - `agent_end` with `stopReason === "error"` and no error text still marks the turn
 *    failed (`markAgentError`) and writes a generic `diagnostic.requestFailed*` row;
 *  - `compact()` refuses while ANY compaction is in flight (`compactingAgents` plus
 *    `rpcCompactingAgents`, which is fed by every `compaction_start`).
 *
 * The refused duplicate has to *report* that compaction too: `getRuntimeState` computes
 * `isCompacting = state.isCompacting || rpcCompactingAgents || compactingAgents`, and the
 * retry row / failed-turn diagnostic rows are covered by
 * `native2RuntimeRetryStatusParity.test.mjs`.
 */

const executable = resolveBackendExecutable();
const PROJECT_ID = "runtime-abort-retry-parity";

if (!executable) {
	describe("native2 runtime abort/retry/compact parity", () => {
		test("backend executable is available", () => {
			assert.fail(
				"PiDeckBackend.exe was not built; run xmake build -y PiDeckBackend (PIDECK_STAGE_DIR=build/native2-validation-unpacked)",
			);
		});
	});
} else {
	describe("native2 runtime abort/retry/compact parity", () => {
		let root;
		let projectPath;

		before(() => {
			({ root, projectPath } = createSuiteProject("pideck-native2-abortretry-"));
		});

		after(() => {
			removeSuiteProject(root);
		});

		// The latest `agents:message` payload is a full window snapshot; concatenating every
		// frame would count the same row once per flush.
		const rowsOf = (sse, sessionId) => channelEvents(sse, sessionId, "agents:message")
			.at(-1)?.messages ?? [];

		const startSession = async (t, { scenario, label }) => {
			const session = await startRuntimeBackend(t, {
				scenario,
				projectId: PROJECT_ID,
				projectPath,
			});
			const { record, target } = await session.activate(`${label}-${Date.now()}`);
			const sse = new SseClient(
				`${session.baseUrl}__pideck/events?token=${encodeURIComponent(session.token)}`,
			);
			await sse.connect().catch(() => undefined);
			t.after(() => sse.close());
			const args = [{
				sessionId: record.id,
				agentId: target.agentId,
				runtimeGeneration: target.runtimeGeneration,
			}];
			return { ...session, record, sse, args };
		};

		/**
		 * RT-1: the user's stop must not depend on pi answering `abort`.
		 *
		 * The fake pi rejects the abort RPC (a wedged pi / blocked event loop never answers
		 * at all, which is why the oracle fire-and-forgets it). Oracle: `abortRuntime`
		 * resolves `{ok:true}` and the tab is `idle` in the same tick.
		 */
		test("abort resolves ok and idles the tab even when pi refuses the abort RPC", async (t) => {
			const { invoke, sse, record, args } = await startSession(t, {
				label: "abort-refused",
				scenario: {
					responses: { abort: { error: "blocked" } },
					turns: [{
						ack: true,
						events: [
							{ event: { type: "agent_start" } },
							{ event: messageStart("msg_abort_refused") },
							{ delayMs: 10, event: textDelta("working") },
							{ delayMs: 900, event: { type: "agent_settled" } },
						],
					}],
				},
			});
			await invoke("sessions:send-prompt", [{ sessionId: record.id, requestId: "abort-1", message: "long task" }]);
			await waitFor(
				() => channelEvents(sse, record.id, "agents:text-stream").length > 0,
				15_000,
				"first live frame",
			);

			const aborted = (await invoke("sessions:runtime-abort", args)).payload.result;
			assert.equal(aborted.ok, true, JSON.stringify(aborted));
			// The status flip is local: it must be observable while pi's abort reply (here a
			// failure, in the motivating case never) is still unanswered.
			await waitFor(
				() => channelPayloads(runtimeEnvelopes(sse, record.id), "agents:state")
					.some((payload) => payload.status === "idle"),
				2_000,
				"idle status after abort",
			);
			// The stop toast still reaches the renderer (it is emitted after the status flip).
			await waitFor(
				() => channelEvents(sse, record.id, "agents:notice")
					.some((payload) => payload.i18nKey === "app.abortRequested"),
				2_000,
				"abort notice",
			);
		});

		/** RT-2: one upserted retry row, localized, with the floating-toast i18n key. */
		test("auto retry keeps one status row and publishes the retry i18n key", async (t) => {
			const { invoke, fake, sse, record } = await startSession(t, {
				label: "retry-status",
				scenario: {
					turns: [{
						ack: true,
						events: [
							{ event: { type: "agent_start" } },
							{ event: messageStart("msg_retry_status") },
							{ delayMs: 10, event: textDelta("working") },
							{
								delayMs: 20,
								event: {
									type: "auto_retry_start",
									attempt: 1,
									maxAttempts: 3,
									delayMs: 100,
									errorMessage: "rate limited",
								},
							},
							{
								delayMs: 20,
								event: {
									type: "auto_retry_start",
									attempt: 2,
									maxAttempts: 3,
									delayMs: 100,
									errorMessage: "rate limited",
								},
							},
							{ delayMs: 20, event: { type: "auto_retry_end", success: true, attempt: 2 } },
							{ delayMs: 20, event: { type: "agent_end", messages: [] } },
							{ delayMs: 20, event: { type: "agent_settled" } },
						],
					}],
				},
			});
			await invoke("sessions:send-prompt", [{ sessionId: record.id, requestId: "retry-1", message: "go" }]);
			await waitFor(
				() => fake.readLog().some((entry) => entry.kind === "event"
					&& entry.event?.type === "agent_settled"),
				15_000,
				"turn settled",
			);
			await sleep(200);
			const retryRows = rowsOf(sse, record.id).filter((row) => isRetryStatusRow(row));
			assert.equal(retryRows.length, 1, `one retry row per agent: ${JSON.stringify(retryRows)}`);
			const [row] = retryRows;
			assert.equal(row.meta?.status, "success", JSON.stringify(row));
			assert.equal(row.meta?.i18nKey, "diagnostic.retrySucceeded", JSON.stringify(row));
			// The raw key is not a locale string in either language; a missing template used
			// to leak it into the transcript (and the row then rendered as a permanent card).
			assert.equal(row.text.includes("agent.retry"), false, `localized text expected: ${row.text}`);
			assert.equal(row.text.includes("{"), false, `params must be substituted: ${row.text}`);
			assert.equal(row.meta?.attempt, 2, JSON.stringify(row.meta));
		});

		/**
		 * RT-3: `agent_end{stopReason:"error"}` without error text is still a failed turn.
		 *
		 * Oracle marks the tab `error` and writes the generic `diagnostic.requestFailed*`
		 * row; otherwise the settle watchdog reports the failed turn as a clean completion.
		 */
		test("agent_end with stopReason error and no text marks the turn failed", async (t) => {
			const { invoke, sse, record } = await startSession(t, {
				label: "stop-reason",
				scenario: {
					version: "1.4.0 (Pi-Bolt 1.0.2, linux-x64-jit, JIT on)",
					turns: [{
						ack: true,
						events: [
							// The detected Pi-Bolt launch uses the 250 ms watchdog window.
							{ event: { type: "agent_start", sessionId: "pi-s1" } },
							{ event: messageStart("msg_stop_reason") },
							{ delayMs: 10, event: textDelta("partial") },
							{ delayMs: 20, event: { type: "agent_end", stopReason: "error", messages: [] } },
						],
					}],
				},
			});
			await invoke("sessions:send-prompt", [{ sessionId: record.id, requestId: "stop-1", message: "go" }]);
			// The watchdog poll (`get_state` → idle) is the wrong outcome; give it room.
			await sleep(1_500);
			const statuses = channelPayloads(runtimeEnvelopes(sse, record.id), "agents:state")
				.map((payload) => payload.status);
			assert.equal(statuses.at(-1), "error", `a failed turn must stay error: ${JSON.stringify(statuses)}`);
			const errorRows = rowsOf(sse, record.id).filter((row) => row.role === "error");
			assert.equal(errorRows.length >= 1, true, `the failure must be written: ${JSON.stringify(rowsOf(sse, record.id))}`);
			assert.match(
				String(errorRows.at(-1)?.meta?.i18nKey ?? ""),
				/^diagnostic\.requestFailed/,
				JSON.stringify(errorRows.at(-1)),
			);
		});

		/**
		 * Full `AgentRuntimeState` projections on `agents:runtime-state`.
		 *
		 * The channel also carries two patch shapes (streaming flag, tool-batch edge), so the
		 * full state is the only one with `isCompacting`.
		 */
		const fullStateProjections = (sse, sessionId) => channelPayloads(runtimeEnvelopes(sse, sessionId), "agents:runtime-state")
			.map((payload) => payload.state)
			.filter((state) => state && typeof state === "object" && "isCompacting" in state);

		/**
		 * RT-4: a manual compact during a pi *auto* compaction is refused locally.
		 *
		 * Oracle `compact()`: `compactingAgents.has || rpcCompactingAgents.has` → return the
		 * current runtime state without dispatching a second `compact` RPC. The returned and
		 * published state must also *report* the compaction (`getRuntimeState` folds both sets
		 * into `isCompacting`), otherwise the renderer's busy badge contradicts the refusal.
		 */
		test("manual compact during an auto compaction dispatches no compact RPC", async (t) => {
			const { invoke, fake, sse, record, args } = await startSession(t, {
				label: "compact-guard",
				scenario: {
					turns: [{
						ack: true,
						events: [
							{ event: { type: "agent_start" } },
							{ event: messageStart("msg_auto_compact") },
							{ delayMs: 10, event: textDelta("working") },
							{ delayMs: 20, event: { type: "agent_end", messages: [] } },
							{ delayMs: 20, event: { type: "auto_compaction_start", reason: "overflow" } },
							// The end arrives late so the command sees pi still compacting. The fake's
							// `get_state` never reports `isCompacting`, exactly like pi: only the events say so.
							{ delayMs: 2_500, event: { type: "auto_compaction_end", reason: "overflow", result: { summary: "s" } } },
						],
					}],
				},
			});
			await invoke("sessions:send-prompt", [{ sessionId: record.id, requestId: "compact-1", message: "go" }]);
			await waitFor(
				() => fake.readLog().some((entry) => entry.kind === "event"
					&& entry.event?.type === "auto_compaction_start"),
				15_000,
				"auto compaction started",
			);
			const result = (await invoke("sessions:runtime-compact", args)).payload.result;
			assert.equal(result.ok, true, JSON.stringify(result));
			// RT-4a: the refused duplicate resolves with the *current* state, and that state has
			// to report the compaction pi is running (oracle `rpcCompactingAgents`).
			assert.equal(
				result.value.value.isCompacting,
				true,
				`the in-flight auto compaction must be reported: ${JSON.stringify(result.value.value)}`,
			);
			const compactCommands = fake.commands().filter((entry) => entry.command === "compact");
			assert.equal(
				compactCommands.length,
				0,
				`a second compact RPC must not be dispatched: ${JSON.stringify(compactCommands)}`,
			);
			// RT-4b: the same projection is published (`compaction_start` re-pushes it), so the
			// renderer's compaction badge agrees with what the command answered.
			await waitFor(
				() => fullStateProjections(sse, record.id).some((state) => state.isCompacting === true),
				5_000,
				"isCompacting:true while pi compacts",
			);
			// RT-4c: `auto_compaction_end` releases the gate again — a state that stayed true
			// would keep the renderer's send button disabled forever.
			await waitFor(
				() => fullStateProjections(sse, record.id).at(-1)?.isCompacting === false,
				15_000,
				"isCompacting:false after auto_compaction_end",
			);
			// Guard rail: the runtime really is mid-compaction from pi's point of view.
			assert.equal(
				channelEvents(sse, record.id, "agents:state").some((payload) => payload.status === "running"),
				true,
			);
		});

		/**
		 * RT-10: the fire-and-forget `abort` RPC uses the oracle's 10 s budget.
		 *
		 * Neither the timeout nor its expiry is renderer-visible (the local teardown and the
		 * toast already happened, and a late `abort` reply is ignored), so the faithful guard is
		 * the constants compared against the oracle source at this HEAD; the escalation windows
		 * belong to the same contract.
		 */
		test("abort RPC budget and escalation windows remain bounded", () => {
			const native = readFileSync(
				join(process.cwd(), "native/backend/domain/runtime/RuntimeCommands.cpp"),
				"utf8",
			);
			const numberOf = (value) => Number(String(value).replaceAll("_", "").replaceAll("'", ""));

			const nativeConstant = (name) => {
				const match = native.match(new RegExp(`constexpr int ${name} = ([\\d']+);`));
				assert.ok(match, `missing native constant ${name}`);
				return numberOf(match[1]);
			};
			assert.equal(nativeConstant("kAbortRequestTimeoutMs"), 10_000);
			assert.equal(nativeConstant("kAbortSettledFallbackMs"), 1_500);
			assert.equal(nativeConstant("kAbortEscalationTimeoutMs"), 5_000);
			assert.equal(nativeConstant("kAbortEscalationVerifyMs"), 4_000);
			// The initial RPC is the fire-and-forget one: it must use the abort budget, never the
			// generic 30 s state budget (a wedged pi would hold the request slot 3x as long).
			assert.match(
				native,
				/session\.request\(QStringLiteral\("abort"\), \{\}, kAbortRequestTimeoutMs,/,
			);
			assert.doesNotMatch(native, /session\.request\(QStringLiteral\("abort"\), \{\}, kStateTimeoutMs,/);
		});
	});
}
