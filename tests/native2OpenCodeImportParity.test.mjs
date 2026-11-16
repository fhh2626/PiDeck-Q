import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, describe, test } from "node:test";

import { resolveBackendExecutable, startBackendSession } from "./helpers/native2BackendHarness.mjs";

/** Native OpenCode import contracts against a disposable, real-schema SQLite database. */

const executable = resolveBackendExecutable();


const PROJECT_ID = "opencode";

/** Build an OpenCode database with two sessions for `projectRoot` and one unrelated. */
function createOpenCodeDatabase(databasePath, projectRoot) {
	mkdirSync(join(databasePath, ".."), { recursive: true });
	const db = new DatabaseSync(databasePath);
	db.exec("create table project (id text primary key, worktree text, name text)");
	db.exec(
		"create table session (id text primary key, project_id text, directory text, title text, model text, time_created integer, time_updated integer)",
	);
	db.exec(
		"create table message (id text primary key, session_id text, time_created integer, time_updated integer, data text)",
	);
	db.exec(
		"create table part (id text primary key, message_id text, session_id text, time_created integer, time_updated integer, data text)",
	);
	db.prepare("insert into project values (?, ?, ?)").run("prj-1", projectRoot, "project");

	const insertSession = db.prepare("insert into session values (?, ?, ?, ?, ?, ?, ?)");
	const insertMessage = db.prepare("insert into message values (?, ?, ?, ?, ?)");
	const insertPart = db.prepare("insert into part values (?, ?, ?, ?, ?, ?)");

	// Session A: one user turn and one assistant turn with thinking, text and a tool call.
	insertSession.run(
		"ses-a",
		"prj-1",
		projectRoot,
		"greeting",
		'{"providerID":"anthropic","modelID":"claude-sonnet-4"}',
		1_767_000_000_000,
		1_767_000_060_000,
	);
	insertMessage.run("msg-a1", "ses-a", 1_767_000_001_000, 1_767_000_002_000, JSON.stringify({ role: "user" }));
	insertPart.run(
		"prt-a1",
		"msg-a1",
		"ses-a",
		1_767_000_001_100,
		1_767_000_001_100,
		JSON.stringify({ type: "text", text: "hello from opencode" }),
	);
	insertMessage.run(
		"msg-a2",
		"ses-a",
		1_767_000_010_000,
		1_767_000_050_000,
		JSON.stringify({ role: "assistant", tokens: { input: 12, output: 7, cache: { read: 3, write: 1 }, total: 23 } }),
	);
	insertPart.run(
		"prt-a2",
		"msg-a2",
		"ses-a",
		1_767_000_010_100,
		1_767_000_010_100,
		JSON.stringify({ type: "reasoning", text: "the user said hello" }),
	);
	insertPart.run(
		"prt-a3",
		"msg-a2",
		"ses-a",
		1_767_000_011_000,
		1_767_000_011_000,
		JSON.stringify({ type: "text", text: "hi, how can I help?" }),
	);
	insertPart.run(
		"prt-a4",
		"msg-a2",
		"ses-a",
		1_767_000_012_000,
		1_767_000_012_000,
		JSON.stringify({
			type: "tool",
			callID: "call-1",
			tool: "read",
			state: { status: "completed", input: { path: "README.md" }, output: "hello" },
		}),
	);

	// Session B: older, matched only by `directory` (a subdirectory of the project).
	insertSession.run("ses-b", "prj-1", join(projectRoot, "src"), "second", null, 1_766_000_000_000, 1_766_000_030_000);
	insertMessage.run("msg-b1", "ses-b", 1_766_000_001_000, 1_766_000_002_000, JSON.stringify({ role: "user" }));
	insertPart.run(
		"prt-b1",
		"msg-b1",
		"ses-b",
		1_766_000_001_100,
		1_766_000_001_100,
		JSON.stringify({ type: "text", text: "a different question" }),
	);

	// Session C: another project — must never show up.
	insertSession.run("ses-c", "prj-2", "/elsewhere", "other", null, 1_765_000_000_000, 1_765_000_030_000);
	insertMessage.run("msg-c1", "ses-c", 1_765_000_001_000, 1_765_000_002_000, JSON.stringify({ role: "user" }));
	insertPart.run(
		"prt-c1",
		"msg-c1",
		"ses-c",
		1_765_000_001_100,
		1_765_000_001_100,
		JSON.stringify({ type: "text", text: "not this project" }),
	);

	db.close();
}

if (!executable) {
	describe("native2 OpenCode import parity", () => {
		test("backend executable is available", () => {
			assert.fail("PiDeckBackend.exe was not built; run xmake build -y PiDeckBackend");
		});
	});
} else {
	describe("native2 OpenCode import parity", () => {
		let root;
		let home;
		let projectPath;
		let databasePath;

		before(() => {
			root = mkdtempSync(join(tmpdir(), "pideck-native2-opencode-"));
			home = join(root, "home");
			projectPath = join(root, "project");
			mkdirSync(join(projectPath, "src"), { recursive: true });
			writeFileSync(join(projectPath, "README.md"), "# opencode\n");

			const seed = join(root, "opencode.db");
			createOpenCodeDatabase(seed, projectPath);
			// Identical copies with identical mtimes: the session estimate and the "current"
			// status both depend on the database file's metadata.
			for (const target of [home]) {
				const path = join(target, ".local", "share", "opencode", "opencode.db");
				mkdirSync(join(path, ".."), { recursive: true });
				copyFileSync(seed, path);
				utimesSync(path, 1_767_000_100, 1_767_000_100);
				databasePath = path;
			}
			databasePath = join(home, ".local", "share", "opencode", "opencode.db");
		});

		after(() => {
			if (root) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
		});

		const envFor = (target) => ({
			// Both the OpenCode database and the pi sessions root come from the host home,
			// so isolating that home is enough to isolate the whole importer.
			PIDECK_HOME: target,
			PIDECK_HOST_HOME: target,
			PIDECK_SESSIONS_DIR: join(target, ".pi", "agent", "sessions"),
		});

		const start = (t, target = home) =>
			startBackendSession(t, {
				projects: [{ id: PROJECT_ID, path: projectPath }],
				settings: { language: "en-US" },
				env: envFor(target),
			});

		test("scan and import preserve model, messages, tools and session identity", async (t) => {
			const session = await start(t);

			// 1. Both matching sessions are listed, newest first, and the other project is
			//    skipped. Every field is compared, so a wrong `cwd`, estimate or `status`
			//    fails here instead of in the import wizard.
			const scanned = await session.invoke("opencode-sessions:scan", [PROJECT_ID]);
			assert.equal(scanned.payload.ok, true, JSON.stringify(scanned.payload));
			assert.deepEqual(
				scanned.payload.result.map((entry) => entry.id),
				["ses-a", "ses-b"],
			);
			assert.equal(scanned.payload.result[0].status, "new");
			assert.equal(scanned.payload.result[0].messageCount, 2);

			// 2. A missing database is "no OpenCode history", not an error.
			const emptyHome = join(root, "empty-home");
			mkdirSync(emptyHome, { recursive: true });
			const empty = await start(t, emptyHome);
			assert.deepEqual((await empty.invoke("opencode-sessions:scan", [PROJECT_ID])).payload, {
				ok: true,
				result: [],
			});

			// 3. Import writes one JSONL session per selected database entry.
			const backendSources = scanned.payload.result.map((entry) => entry.sourcePath);
			const report = await session.invoke("opencode-sessions:import", [PROJECT_ID, backendSources]);
			assert.equal(report.payload.ok, true, JSON.stringify(report.payload));
			assert.equal(report.payload.result.imported, 2);
			assert.equal(report.payload.result.failed, 0);
			for (const result of report.payload.result.results) {
				assert.equal(result.success, true, JSON.stringify(result));
				assert.equal(result.overwritten, false, JSON.stringify(result));
			}

			// The imported file is a pi-readable JSONL session, not a JSON blob.
			const imported = readFileSync(report.payload.result.results[0].targetPath, "utf8");
			const lines = imported.split("\n").filter(Boolean).map((line) => JSON.parse(line));
			assert.equal(lines[0].type, "session");
			assert.equal(lines[0].cwd, projectPath);
			assert.equal(lines[1].type, "opencode_import");
			assert.equal(lines[1].openCodeSessionId, "ses-a");
			assert.equal(lines[2].type, "model_change");
			assert.equal(lines[2].provider, "anthropic");
			assert.equal(lines[2].modelId, "claude-sonnet-4");
			assert.deepEqual(
				lines.filter((line) => line.type === "message").map((line) => line.message.role),
				["user", "assistant"],
			);

			const assistant = lines.find((line) => line.type === "message" && line.message.role === "assistant").message;
			assert.ok(assistant.content.some((block) => block.type === "text" && block.text === "hi, how can I help?"));
			assert.ok(assistant.content.some((block) => block.type === "thinking" && block.thinking === "the user said hello"));
			assert.ok(assistant.content.some((block) => block.type === "toolCall" && block.id === "call-1" && block.name === "read"));
			assert.equal(assistant.usage.input, 12);
			assert.equal(assistant.usage.output, 7);
			assert.equal(assistant.usage.cacheRead, 3);
			assert.equal(assistant.usage.cacheWrite, 1);

			// 4. Re-scanning after the import reports `current`, and importing again is an
			//    overwrite rather than a second copy under a new name.
			const rescanned = await session.invoke("opencode-sessions:scan", [PROJECT_ID]);
			assert.deepEqual(
				rescanned.payload.result.map((entry) => entry.status),
				["current", "current"],
			);
			assert.deepEqual(
				rescanned.payload.result.map((entry) => entry.targetPath),
				report.payload.result.results.map((entry) => entry.targetPath),
			);
			const again = await session.invoke("opencode-sessions:import", [PROJECT_ID, backendSources]);
			assert.equal(again.payload.result.imported, 2);
			for (const result of again.payload.result.results) assert.equal(result.overwritten, true);

			// 5. An unknown source path is a failure row, never a silent success.
			const missing = await session.invoke("opencode-sessions:import", [
				PROJECT_ID,
				[`${databasePath}#ses-missing`],
			]);
			assert.equal(missing.payload.ok, true);
			assert.equal(missing.payload.result.failed, 1);
			assert.equal(missing.payload.result.imported, 0);
			assert.equal(missing.payload.result.results[0].success, false);
			assert.equal(typeof missing.payload.result.results[0].error, "string");
		});
	});
}
