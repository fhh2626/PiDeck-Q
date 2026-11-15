import assert from "node:assert/strict";
import { resolve } from "node:path";
import { after, before, describe, test } from "node:test";

import { resolveBackendExecutable, SseClient } from "./helpers/native2BackendHarness.mjs";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import {
	channelEvents,
	createSuiteProject,
	isRetryStatusRow,
	messageStart,
	removeSuiteProject,
	startRuntimeBackend,
	textDelta,
	waitFor,
	sleep,
} from "./helpers/native2RuntimeEvents.mjs";

/**
 * Auto-retry status row + failed-turn diagnostic parity (`auto_retry_*`, `agent_end`).
 *
 * Oracle references (`src/main/pi/AgentManager.ts`):
 *  - `upsertRetryStatusMessage` keeps ONE row per agent and rewrites it for every retry
 *    event, with `meta.status` + `meta.i18nKey` + `meta.i18nParams` and the attempt
 *    counters inherited from the row it rewrites (`event.attempt ?? message.meta?.attempt`,
 *    same for `maxAttempts`/`errorMessage`) so `count`/`text` and the meta agree;
 *  - the raw reason is kept in `meta.debugDetails` for every status except `success`;
 *  - `agent_end{willRetry:true}` writes that same running row itself when the turn has no
 *    retry row yet, and never writes a failure row;
 *  - `auto_retry_end{success:false}` additionally writes the plain
 *    `请求失败：<reason>` row (no `i18nKey`, so it stays a permanent card);
 *  - `addDetailedErrorMessage` writes the localized `diagnostic.requestFailed[AfterRetries]`
 *    row with `{attempt,maxAttempts}` params and pi's raw text in `debugDetails`.
 *
 * The `mainProcessCopy` tables are the canonical templates, so every sentence is compared
 * with the shared copy module instead of being restated in the test.
 */

/** Canonical main-process copy (`src/shared/i18n/mainProcessCopy.ts`). */
const { mainProcessT } = loadTsCommonJs(resolve("src/shared/i18n/mainProcessCopy.ts"));

/** The reason pi reports for a throttled provider (`auto_retry_*` / `agent_end`). */
const RETRY_ERROR = "rate limited";

const executable = resolveBackendExecutable();
const PROJECT_ID = "runtime-retry-status";

if (!executable) {
	describe("native2 retry status / failed-turn diagnostic parity", () => {
		test("backend executable is available", () => {
			assert.fail(
				"PiDeckBackend.exe was not built; run xmake build -y PiDeckBackend (PIDECK_STAGE_DIR=build/native2-validation-unpacked)",
			);
		});
	});
} else {
	describe("native2 retry status / failed-turn diagnostic parity", () => {
		let root;
		let projectPath;

		before(() => {
			({ root, projectPath } = createSuiteProject("pideck-native2-retrystatus-"));
		});

		after(() => {
			removeSuiteProject(root);
		});

		// The latest `agents:message` payload is a full window snapshot; concatenating every
		// frame would count the same row once per flush.
		const rowsOf = (sse, sessionId) => channelEvents(sse, sessionId, "agents:message")
			.at(-1)?.messages ?? [];

		const lastStatus = (sse, sessionId) => channelEvents(sse, sessionId, "agents:state")
			.at(-1)?.status;

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
			return { ...session, record, target, sse };
		};

		/** Run one scripted turn to `agent_settled` and give the final flush room to land. */
		const runTurn = async (t, { label, events, requestId }) => {
			const session = await startSession(t, { label, scenario: { turns: [{ ack: true, events }] } });
			await session.invoke("sessions:send-prompt", [{
				sessionId: session.record.id,
				requestId,
				message: "go",
			}]);
			await waitFor(
				() => session.fake.readLog().some((entry) => entry.kind === "event"
					&& entry.event?.type === "agent_settled"),
				15_000,
				"turn settled",
			);
			await sleep(200);
			return session;
		};

		/**
		 * RT-5: `agent_end{willRetry:true}` writes the running retry row itself.
		 *
		 * Oracle branch: `if (errorMsg && !retryStatusMessageIds.has(agentId))` →
		 * `upsertRetryStatusMessage(agentId, {attempt:0,maxAttempts:0,delayMs:0,errorMessage},
		 * "running")`. The row is a *floating* status card: localized `i18nKey`, `count`
		 * params, and the raw reason kept in `debugDetails`.
		 */
		test("agent_end willRetry writes one running retry row with its i18n params", async (t) => {
			const { invoke, fake, sse, record } = await startSession(t, {
				label: "retry-willretry",
				scenario: {
					turns: [{
						ack: true,
						events: [
							{ event: { type: "agent_start" } },
							{ event: messageStart("msg_will_retry") },
							{ delayMs: 10, event: textDelta("working") },
							// pi already decided this finish retries; no `auto_retry_start` was sent yet.
							{ delayMs: 20, event: { type: "agent_end", willRetry: true, errorMessage: RETRY_ERROR, messages: [] } },
						],
					}],
				},
			});
			await invoke("sessions:send-prompt", [{ sessionId: record.id, requestId: "willretry-1", message: "go" }]);
			await waitFor(
				() => fake.readLog().some((entry) => entry.kind === "event" && entry.event?.type === "agent_end"),
				15_000,
				"agent_end with willRetry",
			);
			await sleep(300);

			const retryRows = rowsOf(sse, record.id).filter((row) => isRetryStatusRow(row));
			assert.equal(retryRows.length, 1, `one retry row per agent: ${JSON.stringify(retryRows)}`);
			const [row] = retryRows;
			assert.equal(row.meta?.status, "running", JSON.stringify(row.meta));
			assert.equal(row.meta?.i18nKey, "diagnostic.retryScheduled", JSON.stringify(row.meta));
			// The meta is exactly the oracle's field set. A native-only marker (`meta.type`) was
			// an unknown extra field on a system row the Node path never produces.
			assert.deepEqual(
				Object.keys(row.meta ?? {}).sort(),
				["attempt", "debugDetails", "delayMs", "errorMessage", "i18nKey", "i18nParams", "maxAttempts", "status"],
				JSON.stringify(row.meta),
			);
			assert.equal(row.meta?.attempt, 0, JSON.stringify(row.meta));
			assert.equal(row.meta?.maxAttempts, 0, JSON.stringify(row.meta));
			assert.equal(row.meta?.delayMs, 0, JSON.stringify(row.meta));
			assert.equal(row.meta?.errorMessage, RETRY_ERROR, JSON.stringify(row.meta));
			// Oracle keeps the raw reason on the row (`...(reason && status !== "success" ?
			// { debugDetails: reason } : {})`), which is where the renderer's detail view reads it.
			assert.equal(row.meta?.debugDetails, RETRY_ERROR, JSON.stringify(row.meta));
			assert.deepEqual(row.meta?.i18nParams, { attempt: 0, count: "1", delaySeconds: 0 }, JSON.stringify(row.meta));
			// Canonical template from the shared main-process copy, never invented text.
			assert.equal(row.text, mainProcessT("en-US", "diagnostic.retryScheduled", { count: "1" }));
			// `willRetry` is not a failure: no error row, and the sidebar keeps running.
			assert.equal(
				rowsOf(sse, record.id).some((candidate) => candidate.role === "error"),
				false,
				`a retrying turn must not be painted as failed: ${JSON.stringify(rowsOf(sse, record.id))}`,
			);
			assert.equal(lastStatus(sse, record.id), "running");
		});

		/**
		 * RT-6: a final retry failure rewrites the SAME row and inherits the counters.
		 *
		 * Oracle `auto_retry_end{success:false}`: `upsertRetryStatusMessage(..., "error")` with
		 * `attempt`/`maxAttempts`/`errorMessage` inherited from the row it rewrites, then
		 * `markAgentError` plus the plain `请求失败：<reason>` row.
		 */
		test("auto retry final failure keeps one row and inherits the failed attempt", async (t) => {
			const { invoke, fake, sse, record } = await startSession(t, {
				label: "retry-failure",
				scenario: {
					turns: [{
						ack: true,
						events: [
							{ event: { type: "agent_start" } },
							{ event: messageStart("msg_retry_failure") },
							{ delayMs: 10, event: textDelta("working") },
							{ delayMs: 20, event: { type: "auto_retry_start", attempt: 2, maxAttempts: 3, delayMs: 1_000, errorMessage: RETRY_ERROR } },
							// `auto_retry_end` may omit the counters; they come from the row being rewritten.
							{ delayMs: 20, event: { type: "auto_retry_end", success: false } },
							{ delayMs: 20, event: { type: "agent_end", messages: [] } },
							{ delayMs: 20, event: { type: "agent_settled" } },
						],
					}],
				},
			});
			await invoke("sessions:send-prompt", [{ sessionId: record.id, requestId: "retry-failure-1", message: "go" }]);
			await waitFor(
				() => fake.readLog().some((entry) => entry.kind === "event" && entry.event?.type === "agent_settled"),
				15_000,
				"turn settled",
			);
			await sleep(200);

			const retryRows = rowsOf(sse, record.id).filter((row) => isRetryStatusRow(row));
			assert.equal(retryRows.length, 1, `one retry row across both events: ${JSON.stringify(retryRows)}`);
			const [row] = retryRows;
			assert.equal(row.meta?.status, "error", JSON.stringify(row.meta));
			assert.equal(row.meta?.i18nKey, "diagnostic.retryFailed", JSON.stringify(row.meta));
			assert.equal(row.meta?.attempt, 2, JSON.stringify(row.meta));
			assert.equal(row.meta?.maxAttempts, 3, JSON.stringify(row.meta));
			assert.equal(row.meta?.delayMs, 0, JSON.stringify(row.meta));
			assert.equal(row.meta?.errorMessage, RETRY_ERROR, JSON.stringify(row.meta));
			assert.equal(row.meta?.debugDetails, RETRY_ERROR, JSON.stringify(row.meta));
			assert.deepEqual(row.meta?.i18nParams, { attempt: 2, count: "2/3", delaySeconds: 0 }, JSON.stringify(row.meta));
			assert.equal(row.text, mainProcessT("en-US", "diagnostic.retryFailed", { count: "2/3" }));

			// Unlike the status row, the plain card uses the end event's fields alone. This
			// event omitted both reasons, so AgentManager.ts uses its generic fallback.
			const errorRows = rowsOf(sse, record.id).filter((candidate) => candidate.role === "error");
			assert.equal(errorRows.length, 1, JSON.stringify(errorRows));
			assert.equal(errorRows[0].text, "请求失败：API 请求失败", JSON.stringify(errorRows[0]));
			assert.equal("i18nKey" in (errorRows[0].meta ?? {}), false, JSON.stringify(errorRows[0].meta));
			// The failed turn keeps `error` (sidebar marker, no completion toast).
			assert.equal(lastStatus(sse, record.id), "error");
		});

		/**
		 * RT-7: a successful retry rewrites the same row and drops the stored detail.
		 *
		 * Oracle: `reason` is inherited for `meta.errorMessage`, but `debugDetails` is only
		 * written while `status !== "success"`; `i18nKey` switches to `retrySucceeded`.
		 */
		test("auto retry success keeps one row, inherits the attempt and drops the details", async (t) => {
			const { invoke, fake, sse, record } = await startSession(t, {
				label: "retry-success",
				scenario: {
					turns: [{
						ack: true,
						events: [
							{ event: { type: "agent_start" } },
							{ event: messageStart("msg_retry_success") },
							{ delayMs: 10, event: textDelta("working") },
							{ delayMs: 20, event: { type: "auto_retry_start", attempt: 2, maxAttempts: 3, delayMs: 1_000, errorMessage: RETRY_ERROR } },
							{ delayMs: 20, event: { type: "auto_retry_end", success: true } },
							{ delayMs: 20, event: { type: "agent_end", messages: [] } },
							{ delayMs: 20, event: { type: "agent_settled" } },
						],
					}],
				},
			});
			await invoke("sessions:send-prompt", [{ sessionId: record.id, requestId: "retry-success-1", message: "go" }]);
			await waitFor(
				() => fake.readLog().some((entry) => entry.kind === "event" && entry.event?.type === "agent_settled"),
				15_000,
				"turn settled",
			);
			await sleep(200);

			const retryRows = rowsOf(sse, record.id).filter((row) => isRetryStatusRow(row));
			assert.equal(retryRows.length, 1, `one retry row across both events: ${JSON.stringify(retryRows)}`);
			const [row] = retryRows;
			assert.equal(row.meta?.status, "success", JSON.stringify(row.meta));
			assert.equal(row.meta?.i18nKey, "diagnostic.retrySucceeded", JSON.stringify(row.meta));
			assert.equal(row.meta?.attempt, 2, JSON.stringify(row.meta));
			assert.equal(row.meta?.maxAttempts, 3, JSON.stringify(row.meta));
			// The reason that was retried stays readable, the raw detail does not.
			assert.equal(row.meta?.errorMessage, RETRY_ERROR, JSON.stringify(row.meta));
			assert.equal("debugDetails" in (row.meta ?? {}), false, JSON.stringify(row.meta));
			assert.deepEqual(row.meta?.i18nParams, { attempt: 2, count: "2/3", delaySeconds: 0 }, JSON.stringify(row.meta));
			assert.equal(row.text, mainProcessT("en-US", "diagnostic.retrySucceeded", { attempt: 2 }));
			assert.equal(rowsOf(sse, record.id).some((candidate) => candidate.role === "error"), false);
			assert.equal(lastStatus(sse, record.id), "idle");
		});

		/**
		 * RT-8: `agent_end` with a real error text writes the detailed failure row.
		 *
		 * Oracle `addDetailedErrorMessage(agentId, errorMsg)`: `diagnostic.requestFailed` (or the
		 * `…AfterRetries` variant) with `{attempt, maxAttempts}` params and pi's raw text in
		 * `debugDetails`. Writing the raw text alone left a permanent card with no
		 * `meta.i18nKey`, so the renderer never showed its floating failure toast.
		 */
		test("agent_end with a real error text writes the detailed localized failure row", async (t) => {
			const API_ERROR = "API error: 429 Too Many Requests";
			const { sse, record } = await runTurn(t, {
				label: "detailed-error",
				requestId: "detailed-1",
				events: [
					{ event: { type: "agent_start" } },
					{ event: messageStart("msg_detailed_error") },
					{ delayMs: 10, event: textDelta("working") },
					{ delayMs: 20, event: { type: "agent_end", errorMessage: API_ERROR, messages: [] } },
					{ delayMs: 20, event: { type: "agent_settled" } },
				],
			});

			const errorRows = rowsOf(sse, record.id).filter((candidate) => candidate.role === "error");
			assert.equal(errorRows.length, 1, `one failure row per failed turn: ${JSON.stringify(errorRows)}`);
			const [row] = errorRows;
			assert.equal(row.meta?.i18nKey, "diagnostic.requestFailed", JSON.stringify(row.meta));
			assert.deepEqual(row.meta?.i18nParams, { attempt: 0, maxAttempts: 0 }, JSON.stringify(row.meta));
			// pi's raw diagnostic survives as the detail the renderer discloses.
			assert.equal(row.meta?.debugDetails, API_ERROR, JSON.stringify(row.meta));
			assert.equal(
				row.text,
				mainProcessT("en-US", "diagnostic.requestFailed", { attempt: 0, maxAttempts: 0 }),
			);
			assert.equal(rowsOf(sse, record.id).some((candidate) => isRetryStatusRow(candidate)), false);
			// `status:error` is the completion-notification gate (`hooks.settled` needs idle), so a
			// failed turn can never raise the "completed its response" toast.
			assert.equal(lastStatus(sse, record.id), "error");
		});

		/** RT-10: an explicit empty reason is a value, not a missing field. */
		test("an explicit empty retry reason clears the inherited one instead of re-showing it", async (t) => {
			const { sse, record } = await runTurn(t, {
				label: "retry-empty-reason",
				requestId: "empty-reason-1",
				events: [
					{ event: { type: "agent_start" } },
					{ event: messageStart("msg_empty_reason") },
					{ delayMs: 10, event: textDelta("working") },
					{ delayMs: 20, event: { type: "auto_retry_start", attempt: 2, maxAttempts: 3, delayMs: 1_000, errorMessage: RETRY_ERROR } },
					// pi redacted the reason to `""`. Oracle `event.errorMessage ?? event.finalError ??
					// message.meta?.errorMessage` keeps `""`: `??` only falls through when the field is
					// absent or null, so the previous reason must be dropped rather than re-published.
					{ delayMs: 20, event: { type: "auto_retry_end", success: false, errorMessage: "" } },
					{ delayMs: 20, event: { type: "agent_end", messages: [] } },
					{ delayMs: 20, event: { type: "agent_settled" } },
				],
			});

			const rows = rowsOf(sse, record.id);
			const retryRows = rows.filter((row) => isRetryStatusRow(row));
			assert.equal(retryRows.length, 1, `one retry row across both events: ${JSON.stringify(retryRows)}`);
			const [row] = retryRows;
			assert.equal(row.meta?.status, "error", JSON.stringify(row.meta));
			assert.equal(row.meta?.errorMessage, "", `the redacted reason must clear the previous one: ${JSON.stringify(row.meta)}`);
			// Oracle keeps `debugDetails` only for a non-empty reason.
			assert.equal("debugDetails" in (row.meta ?? {}), false, JSON.stringify(row.meta));
			// The counters still come from the row that is being rewritten.
			assert.deepEqual(row.meta?.i18nParams, { attempt: 2, count: "2/3", delaySeconds: 0 }, JSON.stringify(row.meta));
			assert.equal(row.text, mainProcessT("en-US", "diagnostic.retryFailed", { count: "2/3" }));
			// The plain failure card has its own nullish chain. An explicit empty event reason
			// remains empty there too, rather than being replaced by generic or inherited text.
			assert.deepEqual(rows.filter((candidate) => candidate.role === "error").map((candidate) => candidate.text), ["请求失败："]);
			assert.equal(
				JSON.stringify(rows).includes(RETRY_ERROR),
				false,
				`a redacted reason must not be revealed by another row: ${JSON.stringify(rows)}`,
			);
		});

		/** RT-11: `null` is not an explicit empty string - the row's reason is inherited. */
		test("a null retry reason inherits the row reason, unlike an explicit empty string", async (t) => {
			const { sse, record } = await runTurn(t, {
				label: "retry-null-reason",
				requestId: "null-reason-1",
				events: [
					{ event: { type: "agent_start" } },
					{ event: messageStart("msg_null_reason") },
					{ delayMs: 10, event: textDelta("working") },
					{ delayMs: 20, event: { type: "auto_retry_start", attempt: 2, maxAttempts: 3, delayMs: 1_000, errorMessage: RETRY_ERROR } },
					// `null` falls through in the oracle's `??` chain exactly like an absent field.
					{ delayMs: 20, event: { type: "auto_retry_end", success: true, errorMessage: null } },
					{ delayMs: 20, event: { type: "agent_end", messages: [] } },
					{ delayMs: 20, event: { type: "agent_settled" } },
				],
			});

			const retryRows = rowsOf(sse, record.id).filter((row) => isRetryStatusRow(row));
			assert.equal(retryRows.length, 1, `one retry row across both events: ${JSON.stringify(retryRows)}`);
			const [row] = retryRows;
			assert.equal(row.meta?.status, "success", JSON.stringify(row.meta));
			assert.equal(row.meta?.errorMessage, RETRY_ERROR, JSON.stringify(row.meta));
			assert.equal("debugDetails" in (row.meta ?? {}), false, JSON.stringify(row.meta));
			assert.equal(row.text, mainProcessT("en-US", "diagnostic.retrySucceeded", { attempt: 2 }));
		});

		for (const example of [
			{
				label: "final-error-wins",
				fields: { finalError: "final failure", errorMessage: "event failure" },
				card: "请求失败：final failure",
				metaReason: "event failure",
			},
			{
				label: "missing-final-reason",
				fields: {},
				card: "请求失败：API 请求失败",
				metaReason: RETRY_ERROR,
			},
		]) {
			// AgentManager's failure card uses the end event alone, unlike the upserted status
			// row, whose errorMessage-first chain may inherit the previous attempt's reason.
			test(`retry failure card uses its own event fields (${example.label})`, async (t) => {
				const { sse, record } = await runTurn(t, {
					label: example.label,
					requestId: example.label,
					events: [
						{ event: { type: "agent_start" } },
						{ event: messageStart(`msg_${example.label}`) },
						{ delayMs: 10, event: { type: "auto_retry_start", attempt: 1, maxAttempts: 2, errorMessage: RETRY_ERROR } },
						{ delayMs: 10, event: { type: "auto_retry_end", success: false, ...example.fields } },
						{ delayMs: 10, event: { type: "agent_end", messages: [] } },
						{ delayMs: 10, event: { type: "agent_settled" } },
					],
				});
				const rows = rowsOf(sse, record.id);
				assert.deepEqual(rows.filter((row) => row.role === "error").map((row) => row.text), [example.card]);
				const retryRows = rows.filter(isRetryStatusRow);
				assert.equal(retryRows.length, 1);
				assert.equal(retryRows[0].meta.errorMessage, example.metaReason);
			});
		}

		/** RT-9: the same `agent_end` error after retries carries the retry counters. */
		test("agent_end after retries uses the after-retries failure copy", async (t) => {
			const { sse, record } = await runTurn(t, {
				label: "detailed-after-retries",
				requestId: "after-retries-1",
				events: [
					{ event: { type: "agent_start" } },
					{ event: messageStart("msg_after_retries") },
					{ delayMs: 10, event: textDelta("working") },
					{ delayMs: 20, event: { type: "auto_retry_start", attempt: 2, maxAttempts: 3, delayMs: 1_000, errorMessage: RETRY_ERROR } },
					{ delayMs: 20, event: { type: "auto_retry_end", success: false, attempt: 2, maxAttempts: 3, finalError: "provider exploded" } },
					{ delayMs: 20, event: { type: "agent_end", errorMessage: "provider exploded", messages: [] } },
					{ delayMs: 20, event: { type: "agent_settled" } },
				],
			});

			const errorRows = rowsOf(sse, record.id).filter((candidate) => candidate.role === "error");
			// Oracle writes both: the plain retry-failure row and the detailed one from `agent_end`.
			const detailed = errorRows.find((row) => row.meta?.i18nKey === "diagnostic.requestFailedAfterRetries");
			assert.ok(detailed, `the detailed row must carry the after-retries key: ${JSON.stringify(errorRows)}`);
			assert.deepEqual(detailed.meta?.i18nParams, { attempt: 2, maxAttempts: 3 }, JSON.stringify(detailed.meta));
			assert.equal(detailed.meta?.debugDetails, "provider exploded", JSON.stringify(detailed.meta));
			assert.equal(
				detailed.text,
				mainProcessT("en-US", "diagnostic.requestFailedAfterRetries", { attempt: 2, maxAttempts: 3 }),
			);
			assert.equal(
				errorRows.some((row) => row.text === "请求失败：provider exploded"),
				true,
				JSON.stringify(errorRows.map((row) => row.text)),
			);
			assert.equal(lastStatus(sse, record.id), "error");
		});
	});
}
