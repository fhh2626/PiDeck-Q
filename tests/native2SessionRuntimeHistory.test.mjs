import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import {
	createFakePi,
	resolveBackendExecutable,
	SseClient,
	startBackendSession,
} from "./helpers/native2BackendHarness.mjs";
import { runtimeEnvelopes, waitFor } from "./helpers/native2RuntimeEvents.mjs";

const executable = resolveBackendExecutable();
const PROJECT_ID = "runtime-commands";
const slash = (value) => String(value).replaceAll("\\", "/");

/** Two turns so a delete/resend has descendants to tombstone. */
function sessionEntries(projectPath, name) {
	return [
		{ type: "session", version: 3, id: name, timestamp: "2026-01-01T00:00:00.000Z", cwd: projectPath },
		{ type: "model_change", id: "m1", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", provider: "anthropic", modelId: "claude-sonnet-4" },
		{
			type: "message",
			id: "u1",
			parentId: "m1",
			timestamp: "2026-01-01T00:00:01.000Z",
			message: { role: "user", content: [{ type: "text", text: "first question" }], timestamp: 1_767_225_601_000 },
		},
		{
			type: "message",
			id: "a1",
			parentId: "u1",
			timestamp: "2026-01-01T00:00:02.000Z",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "first answer" }],
				timestamp: 1_767_225_602_000,
				usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			},
		},
		{
			type: "message",
			id: "u2",
			parentId: "a1",
			timestamp: "2026-01-01T00:00:03.000Z",
			message: { role: "user", content: [{ type: "text", text: "second question" }], timestamp: 1_767_225_603_000 },
		},
		{
			type: "message",
			id: "a2",
			parentId: "u2",
			timestamp: "2026-01-01T00:00:04.000Z",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "second answer" }],
				timestamp: 1_767_225_604_000,
				usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			},
		},
	];
}

function writeSessionFile(sessionsDir, projectPath, name) {
	const path = join(sessionsDir, `${name}.jsonl`);
	writeFileSync(path, `${sessionEntries(projectPath, name).map((entry) => JSON.stringify(entry)).join("\n")}\n`);
	return path;
}

const readEntries = (path) => readFileSync(path, "utf8")
	.split("\n")
	.filter(Boolean)
	.map((line) => JSON.parse(line));

if (executable) {
	describe("native2 session runtime history commands", () => {
		let root;
		let projectPath;

		before(() => {
			root = mkdtempSync(join(tmpdir(), "pideck-native2-history-"));
			projectPath = join(root, "project");
			mkdirSync(projectPath, { recursive: true });
		});

		after(() => {
			if (root) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
		});

		const start = async (t, { scenario = {}, env } = {}) => {
			let fake = null;
			const session = await startBackendSession(t, {
				projects: [{ id: PROJECT_ID, path: projectPath }],
				settings: { language: "en-US" },
				env,
				prepare: (fixture) => {
					fake = createFakePi(fixture, scenario);
					return {
						settings: { customPiPath: fake.shim },
						env: { FAKE_PI_SCENARIO: fake.scenarioPath, FAKE_PI_LOG: fake.logPath },
					};
				},
			});
			const filePath = writeSessionFile(session.fixture.sessions, projectPath, `h-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`);
			const list = await session.invoke("sessions:catalog-list", [PROJECT_ID]);
			const record = list.payload.result.find((entry) => slash(entry.filePath) === slash(filePath));
			assert.ok(record, "imported session must appear in the catalog");
			const target = (await session.invoke("sessions:runtime-activate", [record.id])).payload.result.value;
			return { ...session, fake, record, filePath, target };
		};

		const messageId = (invoke, record, text) => {
			void invoke;
			void record;
			return text;
		};
		void messageId;

		test("edit-message rewrites the turn, keeps a backup and reloads pi", async (t) => {
			const { invoke, fake, record, filePath, target } = await start(t);
			const messages = (await invoke("sessions:catalog-read-messages", [record.id])).payload.result;
			const assistant = messages.find((message) => message.role === "assistant" && message.text === "first answer");
			assert.ok(assistant, JSON.stringify(messages.map((message) => message.role)));

			const edited = await invoke("sessions:runtime-edit-message", [
				{ sessionId: record.id, agentId: target.agentId, runtimeGeneration: target.runtimeGeneration },
				assistant.id,
				"edited answer",
			]);
			assert.equal(edited.payload.ok, true, JSON.stringify(edited.payload));
			assert.equal(edited.payload.result.ok, true, JSON.stringify(edited.payload));

			const entries = readEntries(filePath);
			const rewritten = entries.find((entry) => entry.id === "a1");
			assert.equal(rewritten.message.content[0].text, "edited answer");
			const backups = readdirSync(dirname(filePath)).filter((name) => name.endsWith(".edit-backup"));
			assert.equal(backups.length, 1, `an edit must leave a restorable backup, got ${backups}`);
			assert.ok(fake.commands().some((entry) => entry.command === "switch_session"), "pi must reload the edited file");
		});

		test("editing a just-sent user message publishes one replacement and leaves it deletable", async (t) => {
			const prefix = sessionEntries(projectPath, "projection").slice(1);
			const original = "live question";
			const replacement = "edited live question";
			const liveEntry = {
				type: "message", id: "u3", parentId: "a2", timestamp: "2026-01-01T00:00:05.000Z",
				message: { role: "user", content: [{ type: "text", text: original }], timestamp: 1_767_225_605_000 },
			};
			const editedEntry = {
				...liveEntry,
				message: { ...liveEntry.message, content: [{ type: "text", text: replacement }] },
			};
			const projections = [prefix, [...prefix, editedEntry], prefix];
			const { invoke, record, filePath, target, baseUrl, token } = await start(t, {
				scenario: {
					responses: {
						get_messages: projections.map((entries) => ({ data: { messages: entries.flatMap((entry) => entry.message ? [entry.message] : []) } })),
						get_entries: projections.map((entries) => ({ data: { entries, leafId: entries.at(-1).id } })),
					},
					turns: [{ events: [{ event: { type: "agent_start" } }, { event: { type: "agent_settled" } }] }],
				},
			});
			const sse = new SseClient(`${baseUrl}__pideck/events?token=${encodeURIComponent(token)}`);
			await sse.connect();
			t.after(() => sse.close());
			const envelopes = () => runtimeEnvelopes(sse, record.id);
			const rows = (event) => event.sourceChannel === "agents:message" ? event.payload.messages ?? [] : [];
			// Persist the fake prompt in the fixture before the turn settles, just as pi does.
			const entries = [...readEntries(filePath), liveEntry];
			writeFileSync(filePath, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
			const sent = await invoke("sessions:send-prompt", [{ ...target, requestId: "edit-live-user", message: original }]);
			assert.equal(sent.payload.result.accepted, true, JSON.stringify(sent.payload));
			const live = await waitFor(() => envelopes().flatMap(rows).find((row) => row.text === original),
				5_000, "live user row");
			assert.equal(live.meta?.entryId, undefined);
			await waitFor(() => {
				const events = envelopes();
				const sentIndex = events.findIndex((event) => rows(event).some((row) => row.id === live.id));
				return sentIndex >= 0 && events.slice(sentIndex + 1).some((event) =>
					event.sourceChannel === "agents:state" && event.payload.status === "idle");
			}, 5_000, "prompt settlement");

			const edited = await invoke("sessions:runtime-edit-message", [target, live.id, replacement]);
			assert.equal(edited.payload.result.ok, true, JSON.stringify(edited.payload));
			const editFrame = await waitFor(() => envelopes().find((event) => rows(event).some((row) => row.text === replacement)),
				5_000, "edited projection");
			assert.equal(editFrame.payload.preserveHistory, false);
			assert.ok(editFrame.payload.historyMutationRevision > 0);
			assert.equal(edited.payload.result.value.value?.historyMutationRevision, editFrame.payload.historyMutationRevision);
			const editedRows = rows(editFrame).filter((row) => row.text === replacement);
			assert.equal(editedRows.length, 1);
			assert.equal(editedRows[0].meta?.entryId, liveEntry.id);
			assert.notEqual(editedRows[0].id, live.id);
			assert.ok(rows(editFrame).every((row) => row.text !== original));

			const page = (await invoke("sessions:catalog-read-message-page", [record.id, null, 1, { unit: "turn" }])).payload.result;
			assert.deepEqual(page.messages.filter((row) => row.role === "user").map((row) => row.text), [replacement]);
			const deleted = await invoke("sessions:runtime-delete-message", [target, editedRows[0].id]);
			assert.equal(deleted.payload.result.ok, true, JSON.stringify(deleted.payload));
			// The delete frame is an ordered SSE barrier for all edit frames, including any
			// redundant history-preserving publication before the edit RPC returned.
			const editFrames = await waitFor(() => {
				const events = envelopes();
				const start = events.findIndex((event) => rows(event).some((row) => row.text === replacement));
				const end = events.findIndex((event, index) => index > start && event.sourceChannel === "agents:message"
					&& event.payload.preserveHistory === false && rows(event).every((row) => row.text !== replacement));
				return start >= 0 && end > start ? events.slice(start, end).filter((event) => event.sourceChannel === "agents:message") : null;
			}, 5_000, "delete projection");
			assert.deepEqual(editFrames.map((event) => event.payload.preserveHistory), [false]);
			assert.equal(readEntries(filePath).find((entry) => entry.id === liveEntry.id)?.type, "deleted");
		});

		test("an edit's projection still invalidates history when auto-compaction requests a newer read", async (t) => {
			const prefix = sessionEntries(projectPath, "projection").slice(1);
			const edited = prefix.map((entry) => entry.id !== "u2" ? entry : {
				...entry, message: { ...entry.message, content: [{ type: "text", text: "edited during compaction" }] },
			});
			const { invoke, fake, record, target, baseUrl, token, host } = await start(t, {
				scenario: { responses: {
					get_messages: [prefix, edited].map((entries) => ({ data: { messages: entries.flatMap((entry) => entry.message ? [entry.message] : []) } })),
					get_entries: [
						{ data: { entries: prefix, leafId: "a2" } },
						{ data: { entries: edited, leafId: "a2" }, eventsBeforeReply: [{ type: "auto_compaction_end", result: {} }] },
						{ data: { entries: edited, leafId: "a2" } },
					],
				} },
			});
			const eventsUrl = `${baseUrl}__pideck/events?token=${encodeURIComponent(token)}`;
			const sse = new SseClient(eventsUrl);
			await sse.connect();
			t.after(() => sse.close());
			const messages = (await invoke("sessions:catalog-read-messages", [record.id])).payload.result;
			const result = await invoke("sessions:runtime-edit-message", [target,
				messages.find((row) => row.text === "second question").id, "edited during compaction"]);
			assert.equal(result.payload.result.ok, true, JSON.stringify(result.payload));
			const editedPayload = (event) => event.sourceChannel === "agents:message"
				&& event.payload.messages.some((row) => row.text === "edited during compaction") && event.payload;
			const published = await waitFor(() => runtimeEnvelopes(sse, record.id).map(editedPayload).find(Boolean), 5_000, "edit projection");
			assert.ok(fake.commands().filter((entry) => entry.command === "get_entries").length >= 3, "compaction must overlap and restart projection");
			assert.equal(published.preserveHistory, false);
			assert.ok(published.historyMutationRevision > 0);

			// Evict the mutation frame and reconnect from a stale cursor. The live
			// re-push must carry the same revision after the one-shot flag was cleared.
			for (let index = 0; index < 4_200; index += 1) {
				host.emit("native.clipboard", { text: "replay gap", html: "", filePaths: [], hasImage: false, sequence: index });
			}
			await waitFor(() => sse.frames.some((frame) => frame.payload.channel === "native.clipboard"
				&& frame.payload.args[0].sequence === 4_199), 10_000, "SSE replay history eviction");
			const recovered = new SseClient(`${eventsUrl}&lastEventId=0`);
			await recovered.connect();
			t.after(() => recovered.close());
			await recovered.waitFor("native.resyncRequired", 5_000);
			const snapshot = await waitFor(() => runtimeEnvelopes(recovered, record.id).map(editedPayload).find(Boolean),
				5_000, "recovered edit projection");
			assert.equal(snapshot.preserveHistory, true);
			assert.equal(snapshot.historyMutationRevision, published.historyMutationRevision);
		});

		test("a committed edit invalidates history on the next successful projection after a read failure", async (t) => {
			const prefix = sessionEntries(projectPath, "projection").slice(1);
			const edited = prefix.map((entry) => entry.id !== "u2" ? entry : {
				...entry, message: { ...entry.message, content: [{ type: "text", text: "committed edit" }] },
			});
			const messagesData = (entries) => ({ messages: entries.flatMap((entry) => entry.message ? [entry.message] : []) });
			const { invoke, record, filePath, target, baseUrl, token } = await start(t, {
				scenario: {
					responses: {
						get_messages: [{ data: messagesData(prefix) }, { error: "projection unavailable" }, { data: messagesData(edited) }],
						get_entries: [{ data: { entries: prefix, leafId: "a2" } }, { data: { entries: edited, leafId: "a2" } }],
					},
					turns: [{ events: [{ event: { type: "auto_compaction_end", result: {} } }] }],
				},
			});
			const sse = new SseClient(`${baseUrl}__pideck/events?token=${encodeURIComponent(token)}`);
			await sse.connect();
			t.after(() => sse.close());
			const messages = (await invoke("sessions:catalog-read-messages", [record.id])).payload.result;
			const result = await invoke("sessions:runtime-edit-message", [target,
				messages.find((row) => row.text === "second question").id, "committed edit"]);
			assert.equal(result.payload.result.ok, false, "the immediate projection read failed");
			assert.equal(readEntries(filePath).find((entry) => entry.id === "u2").message.content[0].text, "committed edit");
			assert.equal((await invoke("sessions:send-prompt", [{ ...target, requestId: "recovery", message: "next" }])).payload.result.accepted, true);
			const frame = await waitFor(() => runtimeEnvelopes(sse, record.id).find((event) => event.sourceChannel === "agents:message"
				&& event.payload.messages.some((row) => row.text === "committed edit")), 5_000, "retried projection");
			assert.equal(frame.payload.preserveHistory, false);
			assert.ok(frame.payload.historyMutationRevision > 0);
		});

		test("an oversized edited projection publishes its invalidation with the blocked status", async (t) => {
			const prefix = sessionEntries(projectPath, "projection").slice(1);
			const text = "X".repeat(8_000);
			const edited = prefix.map((entry) => entry.id !== "u2" ? entry : {
				...entry, message: { ...entry.message, content: [{ type: "text", text }] },
			});
			const { invoke, record, target, filePath, baseUrl, token } = await start(t, {
				env: { PIDECK_MESSAGE_DELIVERY_BUDGET_BYTES: "4096" },
				scenario: { responses: {
					get_messages: [prefix, edited].map((entries) => ({ data: { messages: entries.flatMap((entry) => entry.message ? [entry.message] : []) } })),
					get_entries: [prefix, edited].map((entries) => ({ data: { entries, leafId: "a2" } })),
				} },
			});
			const sse = new SseClient(`${baseUrl}__pideck/events?token=${encodeURIComponent(token)}`);
			await sse.connect();
			t.after(() => sse.close());
			const messages = (await invoke("sessions:catalog-read-messages", [record.id])).payload.result;
			const result = await invoke("sessions:runtime-edit-message", [target,
				messages.find((row) => row.text === "second question").id, text]);
			assert.equal(result.payload.result.ok, true, "the file edit was committed");
			assert.equal(readEntries(filePath).find((entry) => entry.id === "u2").message.content[0].text, text);
			const status = await waitFor(() => runtimeEnvelopes(sse, record.id).find((event) =>
				event.sourceChannel === "sessions:message-delivery-status"), 5_000, "oversized projection status");
			assert.equal(status.payload.code, "MESSAGE_DELIVERY_TOO_LARGE");
			assert.ok(status.payload.historyMutationRevision > 0);
		});

		test("a failed edit rolls back before a queued delete rewrites the same file", async (t) => {
			const { invoke, fake, filePath, record, target } = await start(t, {
				scenario: { responses: { switch_session: [{ delayMs: 450, error: "switch rejected" }, {}] } },
			});
			const messages = (await invoke("sessions:catalog-read-messages", [record.id])).payload.result;
			const first = messages.find((row) => row.text === "first question");
			const second = messages.find((row) => row.text === "second question");
			const editing = invoke("sessions:runtime-edit-message", [target, first.id, "must roll back"]);
			await waitFor(() => fake.commands().some((entry) => entry.command === "switch_session"), 5_000, "edit reload pending");
			const deleting = invoke("sessions:runtime-delete-message", [target, second.id]);
			const [editResult, deleteResult] = await Promise.all([editing, deleting]);
			assert.equal(editResult.payload.result.ok, false, JSON.stringify(editResult.payload));
			assert.equal(deleteResult.payload.result.ok, true, JSON.stringify(deleteResult.payload));
			const entries = readEntries(filePath);
			assert.equal(entries.find((entry) => entry.id === "u1")?.message.content[0].text, "first question");
			assert.equal(entries.find((entry) => entry.id === "u2")?.type, "deleted");
		});

		test("quitting during an edit projection does not start the queued delete", async (t) => {
			const { invoke, fake, filePath, record, target, host, backend } = await start(t, {
				scenario: { responses: { get_messages: [{}, { replyGate: "quit-projection" }] } },
			});
			const messages = (await invoke("sessions:catalog-read-messages", [record.id])).payload.result;
			const first = messages.find((row) => row.text === "first question");
			const second = messages.find((row) => row.text === "second question");
			const editing = invoke("sessions:runtime-edit-message", [target, first.id, "saved before quit"]).catch(() => undefined);
			await waitFor(() => fake.commands().filter((entry) => entry.command === "get_messages").length >= 2,
				5_000, "committed edit waiting for its projection");
			const deleting = invoke("sessions:runtime-delete-message", [target, second.id]).catch(() => undefined);
			// HTTP closes on quit, so verify persistent state instead of requiring replies.
			host.emit("application.prepareQuit", {});
			await host.waitForEvent("application.readyToExit", 10_000);
			assert.equal((await backend.exited).code, 0);
			await Promise.all([editing, deleting]);
			const entries = readEntries(filePath);
			assert.equal(entries.find((entry) => entry.id === "u1")?.message.content[0].text, "saved before quit");
			assert.equal(entries.find((entry) => entry.id === "u2")?.type, "message");
		});

		test("delete-message tombstones the turn and re-parents its children", async (t) => {
			const { invoke, record, filePath, target } = await start(t);
			const messages = (await invoke("sessions:catalog-read-messages", [record.id])).payload.result;
			const assistant = messages.find((message) => message.role === "assistant" && message.text === "first answer");
			assert.ok(assistant);

			const deleted = await invoke("sessions:runtime-delete-message", [
				{ sessionId: record.id, agentId: target.agentId, runtimeGeneration: target.runtimeGeneration },
				assistant.id,
			]);
			assert.equal(deleted.payload.result.ok, true, JSON.stringify(deleted.payload));

			const entries = readEntries(filePath);
			const tombstone = entries.find((entry) => entry.type === "deleted" && entry.id === "a1");
			assert.ok(tombstone, "the deleted entry must stay on disk as a tombstone");
			assert.equal(tombstone.originalEntryId, "a1");
			// u2 pointed at a1; it must now hang off a1's parent so the branch stays valid.
			const reparented = entries.find((entry) => entry.id === "u2");
			assert.equal(reparented.parentId, "u1");

			const after_ = (await invoke("sessions:catalog-read-messages", [record.id])).payload.result;
			assert.equal(after_.some((message) => message.text === "first answer"), false);
		});

		test("prepare-resend truncates the branch and returns the prompt to resend", async (t) => {
			const { invoke, record, filePath, target } = await start(t);
			const messages = (await invoke("sessions:catalog-read-messages", [record.id])).payload.result;
			const user = messages.find((message) => message.role === "user" && message.text === "first question");
			assert.ok(user);

			const prepared = await invoke("sessions:runtime-prepare-resend", [
				{ sessionId: record.id, agentId: target.agentId, runtimeGeneration: target.runtimeGeneration },
				user.id,
				{ provider: "anthropic", modelId: "claude-sonnet-4" },
				"high",
			]);
			assert.equal(prepared.payload.result.ok, true, JSON.stringify(prepared.payload));
			assert.equal(prepared.payload.result.value.value.text, "first question");

			const entries = readEntries(filePath);
			const tombstoned = entries.filter((entry) => entry.type === "deleted").map((entry) => entry.id);
			assert.ok(tombstoned.includes("a1"), JSON.stringify(tombstoned));
			assert.ok(tombstoned.includes("u2"), JSON.stringify(tombstoned));
			assert.ok(tombstoned.includes("a2"), JSON.stringify(tombstoned));
			// The resend prompt itself is tombstoned too: the renderer re-sends it.
			assert.ok(tombstoned.includes("u1"), JSON.stringify(tombstoned));
		});

		test("abort cancels the pending ask and forwards the abort to pi", async (t) => {
			const { invoke, fake, record, target, baseUrl, token } = await start(t, {
				scenario: {
					turns: [{
						ack: true,
						events: [
							{ event: { type: "agent_start" } },
							{ event: { type: "extension_ui_request", id: "ask-abort", method: "input", title: "Name?" } },
						],
					}],
				},
			});
			const sse = new SseClient(`${baseUrl}__pideck/events?token=${encodeURIComponent(token)}`);
			await sse.connect();
			t.after(() => sse.close());
			await invoke("sessions:send-prompt", [{
				sessionId: record.id,
				requestId: "abort-turn",
				message: "ask then abort",
				agentId: target.agentId,
				runtimeGeneration: target.runtimeGeneration,
			}]);
			// A received prompt is not proof that the backend has processed the ask.
			// Wait for its public pending-request frame before sending the abort.
			await waitFor(() => runtimeEnvelopes(sse, record.id).some((event) =>
				event.sourceChannel === "agents:ui-request"
				&& event.payload.requestId === "ask-abort" && !event.payload.completed),
				5_000, "pending ask before abort");

			const aborted = await invoke("sessions:runtime-abort", [{
				sessionId: record.id,
				agentId: target.agentId,
				runtimeGeneration: target.runtimeGeneration,
			}]);
			assert.equal(aborted.payload.result.ok, true, JSON.stringify(aborted.payload));
			// Abort acknowledges local teardown before pi answers. Its ordered stdin
			// receipt proves both the preceding UI cancellation and abort were delivered.
			await waitFor(() => fake.commands().some((entry) => entry.command === "abort"),
				5_000, "pi received abort");
			const uiResponses = fake.commands().filter((entry) => entry.command === "extension_ui_response");
			assert.equal(uiResponses.length, 1, "the pending ask must be cancelled, not left hanging");
			// Node sends `value:null` without `cancelled`: `cancelled:true` makes pi answer
			// `undefined` and `ask_question` silently picks the first option.
			assert.equal(uiResponses[0].payload.value, null);
			assert.equal("cancelled" in uiResponses[0].payload, false, JSON.stringify(uiResponses[0].payload));
			assert.ok(fake.commands().some((entry) => entry.command === "abort"));
		});

		test("fork replaces the runtime identity and reports the new target", async (t) => {
			const { invoke, fake, record, target } = await start(t, {
				scenario: { forkMessages: [{ entryId: "u1", text: "first question" }] },
			});
			const forkMessages = await invoke("sessions:runtime-get-fork-messages", [{
				sessionId: record.id,
				agentId: target.agentId,
				runtimeGeneration: target.runtimeGeneration,
			}]);
			assert.equal(forkMessages.payload.result.ok, true, JSON.stringify(forkMessages.payload));
			assert.equal(forkMessages.payload.result.value.value[0].entryId, "u1");

			const forked = await invoke("sessions:runtime-fork", [{
				sessionId: record.id,
				agentId: target.agentId,
				runtimeGeneration: target.runtimeGeneration,
			}, "u1"]);
			assert.equal(forked.payload.result.ok, true, JSON.stringify(forked.payload));
			const value = forked.payload.result.value;
			assert.equal(value.agentId, target.agentId, "fork keeps the process, so the agent id is unchanged");
			assert.equal(value.runtimeGeneration, target.runtimeGeneration + 1);
			assert.ok(fake.commands().some((entry) => entry.command === "fork"));
		});

		test("catalog-update renames a live session through pi instead of rewriting the file", async (t) => {
			const { invoke, fake, record, filePath } = await start(t);
			const before_ = readFileSync(filePath, "utf8");
			const updated = await invoke("sessions:catalog-update", [record.id, { title: "Live rename" }]);
			assert.equal(updated.payload.ok, true, JSON.stringify(updated.payload));
			assert.equal(updated.payload.result.title, "Live rename");
			// The runtime owns the file, so pi must be asked; the JSONL stays untouched.
			const renames = fake.commands().filter((entry) => entry.command === "set_session_name");
			assert.equal(renames.length, 1, JSON.stringify(fake.commands().map((entry) => entry.command)));
			assert.equal(renames[0].payload.name, "Live rename");
			assert.equal(readFileSync(filePath, "utf8"), before_);
		});

		test("catalog-delete refuses to trash a session whose runtime is live", async (t) => {
			const { invoke, record, filePath } = await start(t);
			const deleted = await invoke("sessions:catalog-delete", [record.id]);
			assert.equal(deleted.payload.ok, false, JSON.stringify(deleted.payload));
			assert.match(deleted.payload.error.message, /stop/i);
			assert.equal(existsSync(filePath), true, "the session file must survive a refused delete");
		});

		test("send-prompt targets the current runtime after a restart", async (t) => {
			const { invoke, fake, record, target } = await start(t);
			const restarted = await invoke("sessions:runtime-restart", [{
				sessionId: record.id,
				agentId: target.agentId,
				runtimeGeneration: target.runtimeGeneration,
			}]);
			assert.equal(restarted.payload.result.ok, true, JSON.stringify(restarted.payload));
			// SendSessionPromptInput carries no generation (parity with the Node oracle): the
			// coordinator activates/uses the *current* runtime, so a restart never loses a
			// prompt the user already typed.
			const sent = await invoke("sessions:send-prompt", [{
				sessionId: record.id,
				requestId: "after-restart",
				message: "hello again",
				agentId: target.agentId,
				runtimeGeneration: target.runtimeGeneration,
			}]);
			assert.equal(sent.payload.result.accepted, true, JSON.stringify(sent.payload));
			const current = restarted.payload.result.value.runtime;
			assert.equal(sent.payload.result.agentId, current.agentId);
			assert.equal(sent.payload.result.runtimeGeneration, current.runtimeGeneration);
			const prompts = fake.commands().filter((entry) => entry.command === "prompt");
			assert.deepEqual(prompts.map((entry) => entry.payload.message), ["hello again"]);
		});
	});
}
