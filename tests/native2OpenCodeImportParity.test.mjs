import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, describe, test } from "node:test";

import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { resolveBackendExecutable, startBackendSession } from "./helpers/native2BackendHarness.mjs";

/**
 * OpenCode import parity (`src/main/sessions/OpenCodeSessionImporter.ts`).
 *
 * OpenCode keeps every project's history in one SQLite database, so this is the only
 * importer whose source is not a file tree. The test builds a throwaway database with the
 * real schema, then compares the backend's `scan`/`import` answers — and the JSONL it
 * writes — against the current Node importer run on an identical copy.
 *
 * Two isolated homes are used on purpose: the Node oracle and the backend must not write
 * the same target file, otherwise `overwritten`/`status` would differ for the wrong reason.
 */

const { OpenCodeSessionImporter } = loadTsCommonJs(resolve("src/main/sessions/OpenCodeSessionImporter.ts"));
const executable = resolveBackendExecutable();
const slash = (value) => String(value).replaceAll("\\", "/");

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
		let oracleHome;
		let projectPath;
		let databasePath;

		before(() => {
			root = mkdtempSync(join(tmpdir(), "pideck-native2-opencode-"));
			home = join(root, "home");
			oracleHome = join(root, "oracle-home");
			projectPath = join(root, "project");
			mkdirSync(join(projectPath, "src"), { recursive: true });
			writeFileSync(join(projectPath, "README.md"), "# opencode\n");

			const seed = join(root, "opencode.db");
			createOpenCodeDatabase(seed, projectPath);
			// Identical copies with identical mtimes: the session estimate and the "current"
			// status both depend on the database file's metadata.
			for (const target of [home, oracleHome]) {
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

		/**
		 * Map the oracle home onto the backend home and unify separators. The backend reports
		 * Qt's `/`-normalised paths; the Node oracle keeps the platform separator. Both open
		 * the same file, so only the separator differs.
		 */
		const normalize = (value) =>
			JSON.parse(
				JSON.stringify(value, (key, entry) =>
					typeof entry === "string" ? slash(entry).split(slash(oracleHome)).join(slash(home)) : entry,
				),
			);

		/**
		 * Read an imported session as comparable entries.
		 *
		 * Two fields are volatile by design in the oracle itself: `importedAt` is the import
		 * wall clock, and the trailing `session_info` card carries `randomUUID().slice(0, 8)`
		 * plus its own timestamp. Everything else — ids, parents, timestamps, usage, tool
		 * calls, the raw OpenCode fields — must be identical.
		 */
		const parseSession = (path) =>
			JSON.parse(
				JSON.stringify(readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line))),
				(key, entry) => {
					if (typeof entry !== "string") return entry;
					return slash(entry).split(slash(oracleHome)).join(slash(home));
				},
			).map((entry) => {
				if (entry.type === "opencode_import") delete entry.importedAt;
				if (entry.type === "session_info") {
					delete entry.id;
					delete entry.timestamp;
				}
				return entry;
			});

		test("scan and import match the current Node importer on the same database", async (t) => {
			const session = await start(t);
			const oracle = new OpenCodeSessionImporter(undefined, oracleHome);

			// 1. Both matching sessions are listed, newest first, and the other project is
			//    skipped. Every field is compared, so a wrong `cwd`, estimate or `status`
			//    fails here instead of in the import wizard.
			const expectedScan = await oracle.scan(projectPath);
			const scanned = await session.invoke("opencode-sessions:scan", [PROJECT_ID]);
			assert.equal(scanned.payload.ok, true, JSON.stringify(scanned.payload));
			assert.deepEqual(normalize(scanned.payload.result), normalize(expectedScan));
			assert.deepEqual(
				scanned.payload.result.map((entry) => entry.id),
				["ses-a", "ses-b"],
			);
			assert.equal(scanned.payload.result[0].status, "new");
			assert.equal(scanned.payload.result[0].messageCount, expectedScan[0].messageCount);

			// 2. A missing database is "no OpenCode history", not an error.
			const emptyHome = join(root, "empty-home");
			mkdirSync(emptyHome, { recursive: true });
			const empty = await start(t, emptyHome);
			assert.deepEqual((await empty.invoke("opencode-sessions:scan", [PROJECT_ID])).payload, {
				ok: true,
				result: [],
			});

			// 3. Import writes the same bytes the Node importer writes and reports the same
			//    per-session results.
			const backendSources = scanned.payload.result.map((entry) => entry.sourcePath);
			const oracleSources = expectedScan.map((entry) => entry.sourcePath);
			const expectedReport = await oracle.import(projectPath, oracleSources);
			const report = await session.invoke("opencode-sessions:import", [PROJECT_ID, backendSources]);
			assert.equal(report.payload.ok, true, JSON.stringify(report.payload));
			assert.deepEqual(normalize(report.payload.result), normalize(expectedReport));
			assert.equal(report.payload.result.imported, 2);
			assert.equal(report.payload.result.failed, 0);
			for (const result of report.payload.result.results) {
				assert.equal(result.success, true, JSON.stringify(result));
				assert.equal(result.overwritten, false, JSON.stringify(result));
			}

			for (let index = 0; index < expectedReport.results.length; index += 1) {
				const expectedPath = expectedReport.results[index].targetPath;
				const actualPath = report.payload.result.results[index].targetPath;
				assert.equal(existsSync(expectedPath), true, expectedPath);
				assert.equal(existsSync(actualPath), true, actualPath);
				assert.deepEqual(parseSession(actualPath), parseSession(expectedPath));
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
