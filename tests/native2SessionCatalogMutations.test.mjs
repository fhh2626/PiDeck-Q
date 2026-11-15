import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { resolveBackendExecutable } from "./helpers/native2BackendHarness.mjs";
import {
	createSuiteProject,
	removeSuiteProject,
	startRuntimeBackend,
	waitFor,
} from "./helpers/native2RuntimeEvents.mjs";

/**
 * Session record mutations against a LIVE runtime (parity with
 * `src/main/sessions/SessionRecordService.ts`).
 *
 * Oracle contract:
 *  - `update()` renames a running session through pi (`AgentManager.rename` →
 *    `set_session_name`, 20 s budget) and **throws** `mainAgent.renameFailed` when pi
 *    refuses; only a successful rename reaches `sessionCatalog.update`. The catalog title
 *    therefore never drifts from what pi actually stored.
 *  - `archive()` / `delete()` call `assertTreeIdle` before touching the file, so a running
 *    session (or a running child in its tree) is refused with the localized copy instead of
 *    having its JSONL moved out from under pi.
 *
 * The C++ backend used to answer `renameRuntime` with "queued" (it returned `true` before
 * pi replied and dropped the failure), so the catalog applied the new title even when pi
 * rejected the rename. It also resolved the tree guard from the serial executor, which is
 * not allowed to touch runtime state at all.
 */

const executable = resolveBackendExecutable();
const PROJECT_ID = "catalog-mutations";

if (!executable) {
	describe("native2 session record mutations", () => {
		test("backend executable is available", () => {
			assert.fail(
				"PiDeckBackend.exe was not built; run xmake build -y PiDeckBackend (PIDECK_STAGE_DIR=build/native2-validation-unpacked)",
			);
		});
	});
} else {
	describe("native2 session record mutations", () => {
		let root;
		let projectPath;

		before(() => {
			({ root, projectPath } = createSuiteProject("pideck-native2-catalogmut-"));
		});

		after(() => {
			removeSuiteProject(root);
		});

		const startSession = async (t, { scenario = {}, label }) => {
			const session = await startRuntimeBackend(t, {
				scenario,
				projectId: PROJECT_ID,
				projectPath,
			});
			const { record } = await session.activate(`${label}-${Date.now()}`);
			return { ...session, record };
		};

		const catalogTitle = async (invoke, sessionId) => {
			const listed = await invoke("sessions:catalog-list", [PROJECT_ID, { scan: false }]);
			assert.equal(listed.payload.ok, true, JSON.stringify(listed.payload));
			const record = listed.payload.result.find((entry) => entry.id === sessionId);
			assert.ok(record, `the catalog must still hold ${sessionId}: ${JSON.stringify(listed.payload.result)}`);
			return record.title;
		};

		/** A live rename goes through pi and the catalog follows the accepted name. */
		test("a live rename is applied only after pi accepted set_session_name", async (t) => {
			const { invoke, fake, record } = await startSession(t, { label: "rename-ok" });
			const renamed = await invoke("sessions:catalog-update", [record.id, { title: "Renamed by pi" }]);
			assert.equal(renamed.payload.ok, true, JSON.stringify(renamed.payload));
			const commands = fake.commands().filter((entry) => entry.command === "set_session_name");
			assert.equal(commands.length, 1, JSON.stringify(fake.commands()));
			assert.equal(commands[0].payload.name, "Renamed by pi");
			assert.equal(await catalogTitle(invoke, record.id), "Renamed by pi");
		});

		/**
		 * pi refuses the rename: the RPC must reject and the catalog must keep the old title.
		 *
		 * This is the user-visible bug: the sidebar showed the new name while the session
		 * file (and therefore pi, and the next launch) still carried the old one.
		 */
		test("a refused live rename rejects and leaves the catalog title unchanged", async (t) => {
			const { invoke, fake, record } = await startSession(t, {
				label: "rename-refused",
				scenario: { responses: { set_session_name: { error: "session is locked" } } },
			});
			const before = await catalogTitle(invoke, record.id);
			const renamed = await invoke("sessions:catalog-update", [record.id, { title: "Should not land" }]);
			assert.equal(renamed.payload.ok, false, JSON.stringify(renamed.payload));
			assert.match(
				String(renamed.payload.error?.message ?? ""),
				/Failed to rename the session/i,
				JSON.stringify(renamed.payload),
			);
			// The rename really was attempted (it is pi that refused it).
			await waitFor(
				() => fake.commands().some((entry) => entry.command === "set_session_name"),
				10_000,
				"set_session_name command",
			);
			assert.equal(await catalogTitle(invoke, record.id), before);
		});

		/** A model/thinking-only patch never renames: pi must not see a rename RPC. */
		test("a non-title patch does not touch the session name", async (t) => {
			const { invoke, fake, record } = await startSession(t, { label: "model-only" });
			const updated = await invoke("sessions:catalog-update", [
				record.id,
				{ model: { provider: "anthropic", modelId: "claude-sonnet-4" } },
			]);
			assert.equal(updated.payload.ok, true, JSON.stringify(updated.payload));
			assert.equal(fake.commands().filter((entry) => entry.command === "set_session_name").length, 0);
			assert.equal(updated.payload.result.model?.provider, "anthropic");
		});

		/**
		 * Archive/delete of a running session is refused on the owner thread.
		 *
		 * The guard must be answered by the runtime owner: it inspects the live agent table
		 * and the catalog tree, which the serial executor may not read.
		 */
		test("archive and delete refuse a session whose runtime is still running", async (t) => {
		const { invoke, record } = await startSession(t, {
				label: "busy-guard",
				scenario: {
					// `sessionId` marks a Rust-family runtime whose turn ends on `agent_settled`;
					// the long delay keeps the session running while the mutation is attempted.
					turns: [{
						ack: true,
						events: [
							{ event: { type: "agent_start", sessionId: "pi-busy" } },
							{ delayMs: 5_000, event: { type: "agent_settled" } },
						],
					}],
				},
			});
			await invoke("sessions:send-prompt", [{ sessionId: record.id, requestId: "busy-1", message: "hold" }]);
			const before = await catalogTitle(invoke, record.id);
			await waitFor(
				() => invoke("sessions:runtime-list").then((listed) => listed.payload.result?.some(
					(runtime) => runtime.sessionId === record.id,
				)),
				10_000,
				"the runtime is listed",
			);

			const archived = await invoke("sessions:catalog-archive", [record.id]);
			assert.equal(archived.payload.ok, false, JSON.stringify(archived.payload));
			assert.match(String(archived.payload.error?.message ?? ""), /Stop the session runtime/i);

			const deleted = await invoke("sessions:catalog-delete", [record.id]);
			assert.equal(deleted.payload.ok, false, JSON.stringify(deleted.payload));
			assert.match(String(deleted.payload.error?.message ?? ""), /Stop the session runtime/i);

			// The guard is a refusal, not a partial mutation: the record and its file survive.
			assert.equal(await catalogTitle(invoke, record.id), before);
			assert.ok(record.filePath, "the catalog record still points at its session file");
		});
	});
}
