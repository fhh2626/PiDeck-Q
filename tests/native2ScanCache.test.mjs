import assert from "node:assert/strict";
import { existsSync, mkdirSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { describe, test } from "node:test";
import {
	createSharedFixture,
	readSummaryCache,
	startBackend,
	stopBackend,
	summaryCachePath,
	waitFor,
} from "./helpers/native2RestartableBackend.mjs";

/**
 * Session summary cache behaviour, observed only through the public RPC and the cache
 * file the backend persists in userData.
 *
 * The oracle (src/main/sessions/sessionSummaryCache.ts) keys entries by path + mtimeMs +
 * size, keeps negative entries for files that are not sessions, prunes only the current
 * environment, loads from disk on start and treats corrupt/old files as a cold start.
 * Rewriting a JSONL with a different body but the *same* mtime and size is therefore the
 * only observable proof that a scan reused the cache instead of re-reading the file.
 */

const slash = (value) => String(value).replaceAll("\\", "/");
const PROJECT = "scan-project";

/** One fixture whose only project points at the fixture's own project directory. */
function createProjectFixture(settings = {}) {
	const fixture = createSharedFixture({ settings });
	writeFileSync(
		join(fixture.userData, "projects.json"),
		JSON.stringify([
			{
				id: PROJECT,
				name: "scan-project",
				path: fixture.project,
				lastOpenedAt: 1_700_000_000_000,
				sortOrder: 0,
				environment: "windows",
			},
		]),
	);
	return fixture;
}

/** One pi session: header + one user turn, named by `session_info`. */
function sessionJsonl({ id, cwd, text, name }) {
	const entries = [
		{ type: "session", version: 3, id, timestamp: "2026-01-01T00:00:00.000Z", cwd },
		{
			type: "message",
			id: "u0",
			parentId: null,
			timestamp: "2026-01-01T00:00:01.000Z",
			message: { role: "user", content: [{ type: "text", text }], timestamp: 1_767_225_601_000 },
		},
	];
	if (name) entries.push({ type: "session_info", id: "si1", parentId: "u0", timestamp: "2026-01-01T00:00:02.000Z", name });
	return `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

function writeSession(sessionsDir, token, id, options) {
	const directory = join(sessionsDir, token);
	mkdirSync(directory, { recursive: true });
	const filePath = join(directory, `${id}.jsonl`);
	writeFileSync(filePath, sessionJsonl({ id, ...options }));
	return filePath;
}

/** Pin a file's mtime so "same version, different bytes" is expressible on every FS. */
function pinMtime(filePath, date) {
	utimesSync(filePath, date, date);
	return statSync(filePath);
}

function cachedEntry(cache, filePath) {
	if (!cache || typeof cache.entries !== "object" || cache.entries === null) return undefined;
	const key = Object.keys(cache.entries).find((entry) => slash(entry).endsWith(`/${basename(filePath)}`));
	return key === undefined ? undefined : cache.entries[key];
}

async function listSessions(session) {
	const response = await session.invoke("sessions:list", [PROJECT]);
	assert.equal(response.status, 200, JSON.stringify(response.payload));
	assert.equal(response.payload.ok, true, JSON.stringify(response.payload));
	return response.payload.result;
}

describe("session summary cache (native)", () => {
	test("reuses a persisted summary after restart and invalidates on mtime+size", async (t) => {
		const fixture = createProjectFixture();
		const fixed = new Date(1_700_000_000_000);
		const sessionFile = writeSession(fixture.sessions, "--C--work--app--", "s1", {
			cwd: slash(fixture.project),
			text: "first question",
			name: "alpha",
		});
		const pinned = pinMtime(sessionFile, fixed);

		const first = await startBackend(t, fixture, { settings: { language: "en-US" } });
		const firstList = await listSessions(first);
		assert.equal(firstList.length, 1);
		assert.equal(firstList[0].name, "alpha");

		// The debounced write must land in userData with schema 6 and the observed version.
		const cache = await waitFor(() => {
			const parsed = readSummaryCache(fixture);
			return parsed && cachedEntry(parsed, sessionFile) ? parsed : null;
		}, "the summary cache was never written");
		assert.equal(cache.version, 6);
		const entry = cachedEntry(cache, sessionFile);
		assert.equal(Math.floor(entry.version.mtimeMs), Math.floor(pinned.mtimeMs));
		assert.equal(entry.version.size, pinned.size);
		assert.equal(entry.value.name, "alpha");
		assert.equal(entry.value.filePath, slash(sessionFile));
		await stopBackend(first);

		// Same byte count, different content: only the cache can still answer "alpha".
		writeFileSync(sessionFile, sessionJsonl({ id: "s1", cwd: slash(fixture.project), text: "first question", name: "bravo" }));
		utimesSync(sessionFile, fixed, fixed);
		assert.equal(statSync(sessionFile).size, pinned.size);

		const second = await startBackend(t, fixture, { settings: { language: "en-US" } });
		const restored = await listSessions(second);
		assert.equal(restored.length, 1);
		assert.equal(restored[0].name, "alpha", "the scan must reuse the persisted summary for an unchanged version");

		// A real write changes the size, so the next scan re-reads the transcript.
		writeFileSync(
			sessionFile,
			sessionJsonl({ id: "s1", cwd: slash(fixture.project), text: "first question", name: "charlie-longer" }),
		);
		const refreshed = await listSessions(second);
		assert.equal(refreshed.length, 1);
		assert.equal(refreshed[0].name, "charlie-longer", "a changed size must invalidate the cached summary");
		await stopBackend(second);
	});

	test("a corrupt or version-mismatched cache is a silent cold start", async (t) => {
		const fixture = createProjectFixture();
		const sessionFile = writeSession(fixture.sessions, "--C--work--app--", "s1", {
			cwd: slash(fixture.project),
			text: "hello",
			name: "real",
		});
		const pinned = pinMtime(sessionFile, new Date(1_700_000_100_000));
		const cachePath = summaryCachePath(fixture);
		// Truncated JSON: the backend must neither log a fatal error nor drop the session.
		writeFileSync(cachePath, '{"version":6,"entries":{"broken":');

		const first = await startBackend(t, fixture, { settings: { language: "en-US" } });
		const cold = await listSessions(first);
		assert.equal(cold.length, 1);
		assert.equal(cold[0].name, "real");
		const rewritten = await waitFor(() => {
			const parsed = readSummaryCache(fixture);
			const entry = parsed && cachedEntry(parsed, sessionFile);
			return entry && entry.value?.name === "real" ? parsed : null;
		}, "the corrupt cache was never rebuilt");
		assert.equal(rewritten.version, 6);
		await stopBackend(first);

		// Schema 3 (the version that could persist wrong parents) must be discarded whole,
		// even when an entry otherwise looks valid for this exact file version.
		writeFileSync(
			cachePath,
			JSON.stringify({
				version: 3,
				entries: {
					[sessionFile]: {
						version: { mtimeMs: Math.floor(pinned.mtimeMs), size: pinned.size },
						value: { id: sessionFile, filePath: sessionFile, preview: "", updatedAt: pinned.mtimeMs, messageCount: 1, name: "poison" },
					},
				},
			}),
		);
		const second = await startBackend(t, fixture, { settings: { language: "en-US" } });
		const afterOldSchema = await listSessions(second);
		assert.equal(afterOldSchema[0].name, "real", "a schema-3 cache must not be trusted");
		await stopBackend(second);

		// A schema-6 file with a malformed entry drops only that entry.
		writeFileSync(
			cachePath,
			JSON.stringify({
				version: 6,
				entries: {
					[sessionFile]: {
						version: { mtimeMs: Math.floor(pinned.mtimeMs), size: pinned.size },
						value: { name: "no-file-path" },
					},
				},
			}),
		);
		const third = await startBackend(t, fixture, { settings: { language: "en-US" } });
		const afterBadEntry = await listSessions(third);
		assert.equal(afterBadEntry[0].name, "real", "an unparsable entry must be dropped, not served");
		await stopBackend(third);
	});

	test("prune drops vanished local entries and keeps explicit WSL cache identities", async (t) => {
		const fixture = createProjectFixture();
		const kept = writeSession(fixture.sessions, "--C--work--app--", "kept", {
			cwd: slash(fixture.project),
			text: "kept",
			name: "kept",
		});
		const removed = writeSession(fixture.sessions, "--C--work--app--", "removed", {
			cwd: slash(fixture.project),
			text: "removed",
			name: "removed",
		});
		// An empty file is not a displayable session: it must be cached as a negative entry
		// so the next scan does not read it again.
		const empty = join(fixture.sessions, "--C--work--app--", "empty.jsonl");
		writeFileSync(empty, "");

		const first = await startBackend(t, fixture, { settings: { language: "en-US" } });
		assert.equal((await listSessions(first)).length, 2);
		const cache = await waitFor(() => {
			const parsed = readSummaryCache(fixture);
			return parsed && cachedEntry(parsed, kept) && cachedEntry(parsed, empty) ? parsed : null;
		}, "the first scan did not populate the cache");
		assert.equal(cachedEntry(cache, empty).value, null);
		await stopBackend(first);

		// A slash-only key identifies legacy WSL data only on a Windows host. Explicit
		// WSL UNC paths and the existing summary flag identify that environment everywhere.
		unlinkSync(removed);
		const wslKey = "/home/dev/.pi/agent/sessions/--mnt-c-work-app--/wsl.jsonl";
		const wslUncKey = "\\\\wsl.localhost\\Ubuntu\\home\\dev\\sessions\\unc.jsonl";
		const taggedWslKey = "/home/dev/.pi/agent/sessions/--mnt-c-work-app--/tagged.jsonl";
		const bogusKey = join(fixture.sessions, "--C--work--app--", "gone.jsonl");
		const edited = readSummaryCache(fixture);
		edited.entries[wslKey] = {
			version: { mtimeMs: 1_700_000_000_000, size: 12 },
			value: null,
		};
		edited.entries[wslUncKey] = { version: { mtimeMs: 1_700_000_000_000, size: 12 }, value: null };
		edited.entries[taggedWslKey] = {
			version: { mtimeMs: 1_700_000_000_000, size: 12 },
			value: { ...cachedEntry(edited, kept).value, filePath: taggedWslKey, wsl: true },
		};
		edited.entries[bogusKey] = { version: { mtimeMs: 1_700_000_000_000, size: 12 }, value: null };
		writeFileSync(summaryCachePath(fixture), JSON.stringify(edited));

		const second = await startBackend(t, fixture, { settings: { language: "en-US" } });
		const afterPrune = await listSessions(second);
		assert.deepEqual(
			afterPrune.map((summary) => summary.name).sort(),
			["kept"],
			"the deleted session must be gone from the list",
		);
		const pruned = await waitFor(() => {
			const parsed = readSummaryCache(fixture);
			return parsed && parsed.entries[bogusKey] === undefined ? parsed : null;
		}, "local mode must prune entries whose file disappeared");
		if (process.platform === "win32") {
			assert.ok(pruned.entries[wslKey], "Windows local scans must preserve legacy WSL paths");
		} else {
			assert.equal(pruned.entries[wslKey], undefined, "a POSIX path alone is native on this host");
		}
		assert.ok(pruned.entries[wslUncKey], "an explicit WSL UNC entry must survive a native scan");
		assert.ok(pruned.entries[taggedWslKey], "an existing WSL summary flag must survive a native scan");
		assert.ok(cachedEntry(pruned, kept), "an unchanged session must keep its cached entry");
		await stopBackend(second);
	});

	test("archive moves the session out of the scan and archived-list still summarises it", async (t) => {
		const fixture = createProjectFixture();
		writeSession(fixture.sessions, "--C--work--app--", "archivable", {
			cwd: slash(fixture.project),
			text: "archive me",
			name: "archivable",
		});
		const session = await startBackend(t, fixture, { settings: { language: "en-US" } });

		const records = await session.invoke("sessions:catalog-list", [PROJECT]);
		assert.equal(records.payload.ok, true, JSON.stringify(records.payload));
		const record = records.payload.result.find((entry) => entry.filePath?.endsWith("archivable.jsonl"));
		assert.ok(record, "the scanned session must appear in the catalog");

		const archived = await session.invoke("sessions:catalog-archive", [record.id]);
		assert.equal(archived.payload.result, true, JSON.stringify(archived.payload));
		assert.equal((await listSessions(session)).length, 0, "an archived session must leave the regular list");

		const archivedList = await session.invoke("sessions:catalog-list-archived");
		assert.equal(archivedList.payload.ok, true, JSON.stringify(archivedList.payload));
		assert.deepEqual(archivedList.payload.result.map((entry) => entry.name), ["archivable"]);

		const restored = await session.invoke("sessions:catalog-unarchive", [archivedList.payload.result[0].filePath]);
		assert.equal(restored.payload.result, true, JSON.stringify(restored.payload));
		assert.deepEqual((await listSessions(session)).map((entry) => entry.name), ["archivable"]);
		await stopBackend(session);
	});

	test("the first empty scan prunes persisted entries for vanished local sessions", async (t) => {
		const fixture = createProjectFixture();
		const vanished = join(fixture.sessions, "vanished.jsonl");
		const otherEnvironment = "\\\\wsl.localhost\\Ubuntu\\home\\dev\\kept.jsonl";
		writeFileSync(summaryCachePath(fixture), JSON.stringify({
			version: 6,
			entries: {
				[vanished]: { version: { mtimeMs: 1, size: 1 }, value: null },
				[otherEnvironment]: { version: { mtimeMs: 1, size: 1 }, value: null },
			},
		}));
		const session = await startBackend(t, fixture, { settings: { language: "en-US" } });
		assert.deepEqual(await listSessions(session), []);
		// Shutdown flushes dirty cache state, so no timer polling can hide a skipped prune.
		await stopBackend(session);
		assert.deepEqual(Object.keys(readSummaryCache(fixture).entries), [otherEnvironment]);
	});

	test("a version or updatedAt outside qint64 is dropped instead of overflowing", async (t) => {
		const fixture = createProjectFixture();
		const sessionFile = writeSession(fixture.sessions, "--C--work--app--", "s1", {
			cwd: slash(fixture.project),
			text: "hello",
			name: "real",
		});
		const pinned = pinMtime(sessionFile, new Date(1_700_000_200_000));
		const cachePath = summaryCachePath(fixture);
		// JSON has no integer type, so a truncated or hand-edited cache can carry numbers no
		// stat() can produce. `1e308` used to reach a `qint64(double)` cast (undefined
		// behaviour); the oracle keeps the value and never matches it, so dropping the record
		// at load must produce the same answer as a rescan, never a served garbage value
		// (`updatedAt: 1e308` would keep the poisoned name alive for an unchanged file).
		const hugeWslKey = "/home/dev/.pi/agent/sessions/--mnt-c-work-app--/huge.jsonl";
		writeFileSync(
			cachePath,
			JSON.stringify({
				version: 6,
				entries: {
					[slash(sessionFile)]: {
						version: { mtimeMs: Math.floor(pinned.mtimeMs), size: pinned.size },
						value: {
							id: slash(sessionFile),
							filePath: slash(sessionFile),
							preview: "",
							updatedAt: 1e308,
							messageCount: 1,
							name: "poisoned",
						},
					},
					[hugeWslKey]: { version: { mtimeMs: 1e308, size: 1e308 }, value: null },
				},
			}),
		);

		const session = await startBackend(t, fixture, { settings: { language: "en-US" } });
		const listed = await listSessions(session);
		assert.deepEqual(
			listed.map((summary) => summary.name),
			["real"],
			"an unrepresentable updatedAt must invalidate the entry, not be served",
		);
		assert.ok(Number.isSafeInteger(listed[0].updatedAt), `updatedAt must stay an integer, got ${listed[0].updatedAt}`);

		// The scan itself dirties the cache, so the next write rewrites the whole map: a
		// carried-over entry would re-persist its overflowed version numbers here.
		const rewritten = await waitFor(() => {
			const parsed = readSummaryCache(fixture);
			const entry = parsed && cachedEntry(parsed, sessionFile);
			return entry && entry.value?.name === "real" ? parsed : null;
		}, "the scan did not rewrite the poisoned cache entry");
		assert.equal(rewritten.entries[hugeWslKey], undefined, "an out-of-range version must be dropped at load");
		assert.ok(cachedEntry(rewritten, sessionFile), "the dropped entry must be rebuilt from the transcript");
		for (const [key, entry] of Object.entries(rewritten.entries)) {
			assert.ok(
				Number.isSafeInteger(Math.floor(entry.version.mtimeMs)) && Number.isSafeInteger(Math.floor(entry.version.size)),
				`every persisted version must be a whole number: ${key}`,
			);
		}
		await stopBackend(session);
	});

	test("a new transcript appears and a removed one disappears on the next scan", async (t) => {
		const fixture = createProjectFixture();
		const firstFile = writeSession(fixture.sessions, "--C--work--app--", "first", {
			cwd: slash(fixture.project),
			text: "one",
			name: "first",
		});
		const session = await startBackend(t, fixture, { settings: { language: "en-US" } });
		assert.deepEqual((await listSessions(session)).map((entry) => entry.name), ["first"]);

		// Import/create writes a brand new JSONL; the next scan must not answer from the
		// previous file-set's cache.
		writeSession(fixture.sessions, "--C--work--app--", "imported", {
			cwd: slash(fixture.project),
			text: "two",
			name: "imported",
		});
		assert.deepEqual((await listSessions(session)).map((entry) => entry.name).sort(), ["first", "imported"]);

		unlinkSync(firstFile);
		assert.deepEqual((await listSessions(session)).map((entry) => entry.name), ["imported"]);
		const cache = await waitFor(() => {
			const parsed = readSummaryCache(fixture);
			return parsed && cachedEntry(parsed, firstFile) === undefined ? parsed : null;
		}, "the removed session must be pruned from the cache");
		assert.ok(existsSync(summaryCachePath(fixture)));
		assert.equal(cache.version, 6);
		await stopBackend(session);
	});
});

