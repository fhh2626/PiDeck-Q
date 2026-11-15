// Catalog mutation pushes `sessions:catalog-refreshed` (regression, public SSE).
//
// The defect: `sessions:catalog-update` / `-archive` / `-delete` mutated
// `session-catalog.json` without telling anyone, while the oracle
// (`src/main/sessions/SessionRecordService.ts` `update` / `archive` / `delete`) calls
// `notifyCatalogRefreshed(projectId)` after every successful mutation. The renderer keeps
// its per-project record list from that push, so a renamed/archived/deleted record stayed
// visible (or kept its old title) until the next manual refresh.
//
// Every case below is asserted through the real SSE stream: the event must arrive once per
// successful mutation, must carry the record's own project id, and must NOT arrive for a
// rejected mutation or for a no-op (`archive` of a file-less record returns false).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import { createFakePi, resolveBackendExecutable, SseClient, startBackendSession } from "./helpers/native2BackendHarness.mjs";

const executable = resolveBackendExecutable();
const PROJECT_ID = "catalog-events";
const CHANNEL = "sessions:catalog-refreshed";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const slash = (value) => String(value).replaceAll("\\", "/");

/** Minimal session file pi would have written for this project. */
function writeSessionFile(sessionsDir, projectPath, name) {
	const entries = [
		{ type: "session", version: 3, id: name, timestamp: "2026-01-01T00:00:00.000Z", cwd: projectPath },
		{
			type: "message",
			id: "u1",
			parentId: null,
			timestamp: "2026-01-01T00:00:01.000Z",
			message: { role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1_767_225_601_000 },
		},
	];
	const path = join(sessionsDir, `${name}.jsonl`);
	writeFileSync(path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
	return path;
}

if (!executable) {
	describe("native2 catalog refresh events", () => {
		test("backend executable is available", () => {
			assert.fail(
				"PiDeckBackend.exe was not built; run \"PIDECK_STAGE_DIR=build/native2-validation-unpacked xmake build -y PiDeckBackend\"",
			);
		});
	});
} else {
	describe("native2 catalog refresh events", () => {
		let root;
		let projectPath;

		before(() => {
			root = mkdtempSync(join(tmpdir(), "pideck-native2-catalogevents-"));
			projectPath = join(root, "project");
			mkdirSync(projectPath, { recursive: true });
		});

		after(() => {
			if (root) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
		});

		/**
		 * Backend + imported records + a connected SSE stream whose baseline is taken after
		 * the startup prewarm scan, so only the mutations below can produce a refresh.
		 */
		const start = async (t) => {
			const session = await startBackendSession(t, {
				projects: [{ id: PROJECT_ID, path: projectPath }],
				settings: { language: "en-US" },
			});
			const archivedPath = writeSessionFile(session.fixture.sessions, projectPath, "archived");
			const deletedPath = writeSessionFile(session.fixture.sessions, projectPath, "deleted");
			const listed = await session.invoke("sessions:catalog-list", [PROJECT_ID]);
			assert.equal(listed.payload.ok, true, JSON.stringify(listed.payload));
			const records = listed.payload.result;
			const byPath = (path) => {
				const record = records.find((entry) => slash(entry.filePath) === slash(path));
				assert.ok(record, `the scanned file must be in the catalog: ${JSON.stringify(records)}`);
				return record;
			};
			const archived = byPath(archivedPath);
			const deleted = byPath(deletedPath);

			const sse = new SseClient(`${session.baseUrl}__pideck/events?token=${encodeURIComponent(session.token)}`);
			await sse.connect();
			// The startup prewarm scans every project once (3 s after start) and pushes the same
			// channel; let it land before the mutation, so neither a positive nor a negative
			// assertion can be satisfied by that frame.
			await sleep(4_500);
			return { ...session, sse, archived, deleted };
		};

		const refreshes = (sse, from = 0) =>
			sse.frames.slice(from).filter((frame) => frame.payload.channel === CHANNEL);

		/**
		 * Wait for a refresh frame that arrived after `from`.
		 *
		 * `sse.waitFor(channel)` matches *any* buffered frame, which would let a startup-prewarm
		 * push stand in for the mutation's own event; this only looks at the tail.
		 */
		const waitRefreshAfter = async (sse, from, label) => {
			const deadline = Date.now() + 10_000;
			for (;;) {
				const [frame] = refreshes(sse, from);
				if (frame) return frame;
				if (Date.now() > deadline) {
					throw new Error(`no ${CHANNEL} frame after ${label}: ${JSON.stringify(sse.frames.slice(from))}`);
				}
				await sleep(50);
			}
		};

		/** A successful update must push exactly one event for the record's project. */
		test("a catalog update pushes one refresh event for its project", async (t) => {
			const { invoke, sse, archived } = await start(t);
			const mark = sse.frames.length;
			const updated = await invoke("sessions:catalog-update", [archived.id, { title: "Renamed" }]);
			assert.equal(updated.payload.ok, true, JSON.stringify(updated.payload));
			const frame = await waitRefreshAfter(sse, mark, "the title update");
			assert.ok(frame.id !== null, "the push must be a sequenced frame");
			await sleep(300);
			assert.equal(refreshes(sse, mark).length, 1, JSON.stringify(refreshes(sse, mark)));
			assert.deepEqual(frame.payload.args[0], { projectId: PROJECT_ID });
		});

		/** A successful archive must push the same event (the record disappeared). */
		test("a catalog archive pushes one refresh event", async (t) => {
			const { invoke, sse, archived } = await start(t);
			const mark = sse.frames.length;
			const result = await invoke("sessions:catalog-archive", [archived.id]);
			assert.equal(result.payload.ok, true, JSON.stringify(result.payload));
			assert.equal(result.payload.result, true);
			await waitRefreshAfter(sse, mark, "the archive");
			await sleep(300);
			assert.equal(refreshes(sse, mark).length, 1, JSON.stringify(refreshes(sse, mark)));
		});

		/** A successful delete must push it too. */
		test("a catalog delete pushes one refresh event", async (t) => {
			const { invoke, sse, deleted, trashCalls } = await start(t);
			const mark = sse.frames.length;
			const result = await invoke("sessions:catalog-delete", [deleted.id]);
			assert.equal(result.payload.ok, true, JSON.stringify(result.payload));
			assert.equal(result.payload.result, true);
			assert.ok(trashCalls.length > 0, "the session file was moved through the host");
			await waitRefreshAfter(sse, mark, "the delete");
			await sleep(300);
			assert.equal(refreshes(sse, mark).length, 1, JSON.stringify(refreshes(sse, mark)));
		});

		/**
		 * A rejected mutation is not a success: an unknown id must reject and push nothing.
		 */
		test("a failed update pushes no refresh event", async (t) => {
			const { invoke, sse } = await start(t);
			const mark = sse.frames.length;
			const updated = await invoke("sessions:catalog-update", [
				"00000000-0000-4000-8000-000000000000",
				{ title: "ghost" },
			]);
			assert.equal(updated.payload.ok, false, JSON.stringify(updated.payload));
			await sleep(700);
			assert.equal(refreshes(sse, mark).length, 0, JSON.stringify(refreshes(sse, mark)));
		});

		/**
		 * `archive` of a file-less record is a no-op (`return false` before the tree guard in
		 * the oracle), so it must not claim a refresh either.
		 */
		test("archiving a file-less record answers false and pushes nothing", async (t) => {
			const { invoke, sse } = await start(t);
			const draft = await invoke("sessions:catalog-create-draft", [{ projectId: PROJECT_ID }]);
			assert.equal(draft.payload.ok, true, JSON.stringify(draft.payload));
			const mark = sse.frames.length;
			const result = await invoke("sessions:catalog-archive", [draft.payload.result.id]);
			assert.equal(result.payload.ok, true, JSON.stringify(result.payload));
			assert.equal(result.payload.result, false, JSON.stringify(result.payload));
			await sleep(700);
			assert.equal(refreshes(sse, mark).length, 0, JSON.stringify(refreshes(sse, mark)));
		});

		/**
		 * `failAnonymousActivation`: a `--no-session` record whose runtime never came up must
		 * leave neither a record nor a silent sidebar.
		 *
		 * The renderer opens the composer tab optimistically and swallows the activation failure
		 * (`ComposerArea` `.catch(() => undefined)`), so the backend is the only place that can
		 * undo it. Without the removal the transient record stays in the store's transient list,
		 * which `listRecords()` returns first, so every later `catalog-list {scan:false}` re-adds
		 * the ghost row; without the push no client ever learns that it disappeared.
		 */
		test("a failed anonymous activation drops the transient record and pushes one refresh", async (t) => {
			const session = await startBackendSession(t, {
				projects: [{ id: PROJECT_ID, path: projectPath }],
				settings: { language: "en-US" },
				prepare: (fixture) => {
					const fake = createFakePi(fixture, { responses: { get_state: { error: "get_state exploded" } } });
					return {
						settings: { customPiPath: fake.shim },
						env: { FAKE_PI_SCENARIO: fake.scenarioPath, FAKE_PI_LOG: fake.logPath },
					};
				},
			});
			const created = await session.invoke("sessions:create-anonymous", [{ projectId: PROJECT_ID }]);
			assert.equal(created.payload.ok, true, JSON.stringify(created.payload));
			const record = created.payload.result.session;
			assert.equal(typeof record?.id, "string", JSON.stringify(created.payload.result));
			const before = await session.invoke("sessions:catalog-list", [PROJECT_ID, { scan: false }]);
			assert.equal(before.payload.ok, true, JSON.stringify(before.payload));
			assert.equal(
				before.payload.result.some((entry) => entry.id === record.id),
				true,
				"the anonymous record exists before its runtime starts",
			);

			const sse = new SseClient(
				`${session.baseUrl}__pideck/events?token=${encodeURIComponent(session.token)}`,
			);
			await sse.connect();
			t.after(() => sse.close());
			// Let the startup prewarm scan land first: it pushes the same channel, so the
			// assertions below must be about the activation and nothing else.
			await sleep(4_500);
			const mark = sse.frames.length;

			const activated = await session.invoke("sessions:runtime-activate", [record.id]);
			assert.equal(
				activated.payload.result?.ok,
				false,
				`the activation must fail: ${JSON.stringify(activated.payload)}`,
			);

			// The pull path the renderer uses after a push must no longer return the ghost.
			const after = await session.invoke("sessions:catalog-list", [PROJECT_ID, { scan: false }]);
			assert.equal(after.payload.ok, true, JSON.stringify(after.payload));
			assert.equal(
				after.payload.result.some((entry) => entry.id === record.id),
				false,
				`the failed activation must not leave a ghost record: ${JSON.stringify(after.payload.result)}`,
			);

			const frame = await waitRefreshAfter(sse, mark, "the failed anonymous activation");
			assert.deepEqual(frame.payload.args[0], { projectId: PROJECT_ID });
			await sleep(300);
			assert.equal(refreshes(sse, mark).length, 1, JSON.stringify(refreshes(sse, mark)));
		});
	});
}
