import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import {
	createFakePi,
	resolveBackendExecutable,
	startBackendSession,
} from "./helpers/native2BackendHarness.mjs";

const executable = resolveBackendExecutable();
const PROJECT_ID = "runtime-commands";
const slash = (value) => String(value).replaceAll("\\", "/");

/** Two turns so a delete/resend has descendants to tombstone. */
function writeSessionFile(sessionsDir, projectPath, name) {
	const entries = [
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
	const path = join(sessionsDir, `${name}.jsonl`);
	writeFileSync(path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
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

		const start = async (t, { scenario = {} } = {}) => {
			let fake = null;
			const session = await startBackendSession(t, {
				projects: [{ id: PROJECT_ID, path: projectPath }],
				settings: { language: "en-US" },
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
			const { invoke, fake, record, target } = await start(t, {
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
			await invoke("sessions:send-prompt", [{
				sessionId: record.id,
				requestId: "abort-turn",
				message: "ask then abort",
				agentId: target.agentId,
				runtimeGeneration: target.runtimeGeneration,
			}]);
			// Wait until the ask reached the backend before aborting it.
			const deadline = Date.now() + 5_000;
			while (Date.now() < deadline) {
				const pending = await invoke("sessions:runtime-list");
				void pending;
				if (fake.commands().some((entry) => entry.command === "prompt")) break;
				await new Promise((resolve) => setTimeout(resolve, 20));
			}
			await new Promise((resolve) => setTimeout(resolve, 150));

			const aborted = await invoke("sessions:runtime-abort", [{
				sessionId: record.id,
				agentId: target.agentId,
				runtimeGeneration: target.runtimeGeneration,
			}]);
			assert.equal(aborted.payload.result.ok, true, JSON.stringify(aborted.payload));
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
