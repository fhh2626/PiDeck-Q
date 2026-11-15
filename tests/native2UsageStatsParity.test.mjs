import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, test } from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { resolveBackendExecutable, startBackendSession } from "./helpers/native2BackendHarness.mjs";

const executable = resolveBackendExecutable();

// The Node aggregator is the oracle: same log bytes must produce the same view.
const { aggregateUsage } = loadTsCommonJs(resolve("src/main/usageStats/usageStatsAggregator.ts"));
const { UsageLogReader } = loadTsCommonJs(resolve("src/main/usageStats/UsageLogReader.ts"));

/** Oracle values come from a `vm` realm; a JSON round-trip compares data, not realms. */
function plain(value) {
	return JSON.parse(JSON.stringify(value ?? null));
}

const DAY = 24 * 3600 * 1000;

/** `[ts, sid, cwd, model, in, out, cacheRead, cacheWrite, total]` — the pi-tracker row. */
function row(ts, sid, cwd, model, input, output, cacheRead, cacheWrite, total, costKnown) {
	const base = [ts, sid, cwd, model, input, output, cacheRead, cacheWrite, total, 0];
	return costKnown === undefined ? base : [...base, costKnown];
}

/** Arrays are serialised, raw strings are kept verbatim (so corrupt lines stay corrupt). */
function serializeLines(lines) {
	return lines.map((line) => (typeof line === "string" ? line : JSON.stringify(line)));
}

function writeLog(agentDir, lines) {
	mkdirSync(join(agentDir, "analytics"), { recursive: true });
	const content = `${serializeLines(lines).join("\n")}\n`;
	writeFileSync(join(agentDir, "analytics", "usage.jsonl"), content);
	return join(agentDir, "analytics", "usage.jsonl");
}

/**
 * The oracle reader defines what a refresh reports: it applies the same in-read dedupe
 * (ts|sid|model) and the same bad-line accounting as the backend.
 */
async function oracleRead(logPath, previous = null) {
	const reader = new UsageLogReader();
	return reader.readIncremental(logPath, previous);
}

if (executable) {
	describe("native2 usage stats parity", () => {
		let root;
		let seq = 0;

		before(() => {
			root = mkdtempSync(join(tmpdir(), "pideck-native2-usage-"));
		});
		after(() => {
			if (root) rmSync(root, { recursive: true, force: true });
		});

		function homeFor() {
			seq += 1;
			const home = join(root, `home-${seq}`);
			mkdirSync(join(home, ".pi", "agent"), { recursive: true });
			return home;
		}

		/** `userData` is overridable so a restart can reuse the same cache directory. */
		const start = (t, home, userData) =>
			startBackendSession(t, {
				settings: { language: "en-US" },
				env: {
					PIDECK_HOME: home,
					PIDECK_HOST_HOME: home,
					PIDECK_PROMPTS_DIR: join(home, ".pi", "agent", "prompts"),
					PIDECK_SKILLS_DIR: join(home, ".pi", "agent", "skills"),
					PIDECK_SESSIONS_DIR: join(home, ".pi", "agent", "sessions"),
					...(userData ? { PIDECK_USER_DATA: userData } : {}),
				},
			});

		test("usage-stats:get matches the oracle aggregator record for record", async (t) => {
			const home = homeFor();
			const agentDir = join(home, ".pi", "agent");
			const now = Date.now();
			const lines = [
				row(now - 3 * DAY, "s-1", "D:/work/alpha", "anthropic/claude-sonnet-4", 100, 40, 10, 5, 155),
				row(now - 3 * DAY, "s-1", "D:/work/alpha", "anthropic/claude-sonnet-4", 50, 20, 0, 0, 70),
				// Same day, different project and provider.
				row(now - 3 * DAY, "s-2", "D:/work/beta", "openai/gpt-5", 900, 300, 0, 0, 1200, 1),
				// A model without a provider prefix stays its own provider.
				row(now - 2 * DAY, "s-2", "D:/work/beta", "local-model", 10, 5, 0, 0, 15),
				row(now - 1 * DAY, "s-3", "D:/work/alpha", "anthropic/claude-opus-4", 2000, 500, 100, 50, 2650),
				// Today, so today/thisWeek/thisMonth all have data.
				row(now - 1000, "s-3", "D:/work/alpha", "anthropic/claude-opus-4", 7, 3, 0, 0, 10),
				// A corrupt line must be skipped, not fatal.
				"{not json",
				// Wrong arity (9 fields) is rejected.
				JSON.stringify([now, "s-4", "D:/work/alpha", "m", 1, 1, 1, 1, 4]),
				// Non-numeric token count is rejected rather than silently zeroed.
				JSON.stringify([now, "s-4", "D:/work/alpha", "m", "x", 1, 1, 1, 4, 0]),
				// Empty session id is rejected.
				row(now, "", "D:/work/alpha", "anthropic/claude-sonnet-4", 1, 1, 0, 0, 2),
				// A U+2028 inside a JSON string must not split the line.
				row(now - 4 * DAY, "s-5", "D:/work/line\u2028sep", "anthropic/claude-sonnet-4", 5, 5, 0, 0, 10),
			];
			const logPath = writeLog(agentDir, lines);
			const oracle = await oracleRead(logPath);
			const session = await start(t, home);

			const refreshed = await session.invoke("usage-stats:refresh");
			assert.equal(refreshed.payload.ok, true, JSON.stringify(refreshed.payload));
			assert.deepEqual(plain(refreshed.payload.result), {
				fullRescan: oracle.fullRescan,
				parsedRecords: oracle.newRecords.length,
				skippedLines: oracle.skippedLines,
			});
			// The duplicate (ts|sid|model) row is collapsed by both sides.
			assert.equal(oracle.newRecords.length, 6);
			assert.equal(oracle.skippedLines, 4);

			const actual = await session.invoke("usage-stats:get");
			assert.equal(actual.payload.ok, true, JSON.stringify(actual.payload));
			const expected = aggregateUsage(oracle.newRecords);
			const view = actual.payload.result;

			// Time-independent parts must match exactly.
			assert.deepEqual(plain(view.totals), plain(expected.totals));
			assert.deepEqual(plain(view.daily), plain(expected.daily));
			assert.deepEqual(plain(view.byModel), plain(expected.byModel));
			assert.deepEqual(plain(view.byProject), plain(expected.byProject));
			assert.deepEqual(plain(view.window), plain(expected.window));
			assert.equal(view.recordCount, expected.recordCount);
			assert.equal(view.activeDays, expected.activeDays);

			// The heatmap is 53 weeks × 7 days and starts on a Monday.
			assert.equal(view.heatmap.length, 371);
			assert.equal(expected.heatmap.length, 371);
			assert.equal(view.heatmapStart, expected.heatmapStart);
			const startDate = new Date(`${view.heatmapStart}T00:00:00`);
			assert.equal(startDate.getDay(), 1, "heatmap starts on a Monday");
			// Every cell carries the documented level thresholds.
			for (const cell of view.heatmap) {
				const expectedLevel =
					cell.tokens <= 0 ? 0
						: cell.tokens < 100 ? 1
							: cell.tokens < 1000 ? 2
								: cell.tokens < 100000 ? 3
									: 4;
				assert.equal(cell.level, expectedLevel, JSON.stringify(cell));
			}
			// The heatmap tail is the current week, so today's tokens are in the last row.
			const todayCell = view.heatmap[view.heatmap.length - 7 + ((new Date().getDay() + 6) % 7)];
			assert.equal(todayCell.tokens, view.today.tokens);
		});

		test("usage-stats:detect reports not-installed without a log and cached counts after refresh", async (t) => {
			const home = homeFor();
			const agentDir = join(home, ".pi", "agent");
			const session = await start(t, home);

			const missing = await session.invoke("usage-stats:detect");
			assert.equal(missing.payload.ok, true, JSON.stringify(missing.payload));
			assert.deepEqual(plain(missing.payload.result), {
				installed: false,
				logPath: null,
				recordCount: null,
				firstRecordAt: null,
				lastRecordAt: null,
			});

			// A missing log is not an error: the view is simply null.
			const emptyView = await session.invoke("usage-stats:get");
			assert.equal(emptyView.payload.ok, true, JSON.stringify(emptyView.payload));
			assert.equal(emptyView.payload.result, null);

			const now = Date.now();
			writeLog(agentDir, [
				row(now - 2 * DAY, "s-1", "D:/work/alpha", "anthropic/claude-sonnet-4", 10, 5, 0, 0, 15),
				row(now - 1 * DAY, "s-1", "D:/work/alpha", "anthropic/claude-sonnet-4", 20, 5, 0, 0, 25),
			]);

			// Before any refresh the count is unknown, exactly like the oracle's cold cache.
			const cold = await session.invoke("usage-stats:detect");
			assert.equal(cold.payload.result.installed, true);
			assert.equal(cold.payload.result.recordCount, null);

			await session.invoke("usage-stats:refresh");
			const warm = await session.invoke("usage-stats:detect");
			assert.equal(warm.payload.result.recordCount, 2);
			assert.equal(warm.payload.result.firstRecordAt, now - 2 * DAY);
			assert.equal(warm.payload.result.lastRecordAt, now - 1 * DAY);
			// The path is the host path of the analytics log.
			assert.equal(
				warm.payload.result.logPath.replaceAll("\\", "/"),
				join(agentDir, "analytics", "usage.jsonl").replaceAll("\\", "/"),
			);
		});

		test("usage-stats:refresh is incremental and detects truncation", async (t) => {
			const home = homeFor();
			const agentDir = join(home, ".pi", "agent");
			const now = Date.now();
			const first = [
				row(now - 2 * DAY, "s-1", "D:/work/alpha", "anthropic/claude-sonnet-4", 10, 5, 0, 0, 15),
				row(now - 1 * DAY, "s-1", "D:/work/alpha", "anthropic/claude-sonnet-4", 20, 5, 0, 0, 25),
			];
			const logPath = writeLog(agentDir, first);
			const initial = await oracleRead(logPath);
			const session = await start(t, home);

			assert.deepEqual(plain((await session.invoke("usage-stats:refresh")).payload.result), {
				fullRescan: initial.fullRescan,
				parsedRecords: initial.newRecords.length,
				skippedLines: initial.skippedLines,
			});
			// No change on disk: zero new records, no rescan.
			assert.deepEqual(plain((await session.invoke("usage-stats:refresh")).payload.result), {
				fullRescan: false,
				parsedRecords: 0,
				skippedLines: 0,
			});

			// Append one record: the incremental path reports exactly one.
			const appended = [...first, row(now, "s-2", "D:/work/beta", "openai/gpt-5", 1, 1, 0, 0, 2)];
			writeFileSync(logPath, `${serializeLines(appended).join("\n")}\n`);
			assert.deepEqual(plain((await session.invoke("usage-stats:refresh")).payload.result), {
				fullRescan: false,
				parsedRecords: 1,
				skippedLines: 0,
			});

			const merged = await session.invoke("usage-stats:get");
			const expected = aggregateUsage((await oracleRead(logPath)).newRecords);
			assert.deepEqual(plain(merged.payload.result.totals), plain(expected.totals));
			assert.deepEqual(plain(merged.payload.result.daily), plain(expected.daily));
			assert.equal(merged.payload.result.recordCount, 3);

			// Truncation (file shrank) forces a full rescan and must not double count.
			writeFileSync(logPath, `${serializeLines([first[0]]).join("\n")}\n`);
			assert.deepEqual(plain((await session.invoke("usage-stats:refresh")).payload.result), {
				fullRescan: true,
				parsedRecords: 1,
				skippedLines: 0,
			});
			const afterTruncate = await session.invoke("usage-stats:get");
			assert.equal(afterTruncate.payload.result.recordCount, 1);
			assert.deepEqual(
				plain(afterTruncate.payload.result.totals),
				plain(aggregateUsage((await oracleRead(logPath)).newRecords).totals),
			);

			// Clearing the file commits an empty state instead of resurrecting old totals.
			writeFileSync(logPath, "");
			await session.invoke("usage-stats:refresh");
			const cleared = await session.invoke("usage-stats:get");
			assert.equal(cleared.payload.result.recordCount, 0);
			assert.equal(cleared.payload.result.totals.tokens, 0);
			assert.equal(cleared.payload.result.activeDays, 0);
		});

		test("the disk cache survives a restart and stays Node-readable", async (t) => {
			const home = homeFor();
			const agentDir = join(home, ".pi", "agent");
			const now = Date.now();
			const lines = [
				row(now - 2 * DAY, "s-1", "D:/work/alpha", "anthropic/claude-sonnet-4", 10, 5, 0, 0, 15),
				row(now - 1 * DAY, "s-2", "D:/work/beta", "openai/gpt-5", 20, 5, 0, 0, 25),
			];
			writeLog(agentDir, lines);

			const first = await start(t, home);
			await first.invoke("usage-stats:refresh");
			const before = await first.invoke("usage-stats:get");
			const userData = first.fixture.userData;
			await first.host.emit("application.prepareQuit");

			// The cache file uses the shared SessionSummaryCache layout so the Node
			// runtime can pick it up after a runtime switch.
			const cachePath = join(userData, "usage-stats-cache.json");
			const cache = JSON.parse(readFileSync(cachePath, "utf8"));
			assert.equal(cache.version, 4);
			const entry = cache.entries[join(agentDir, "analytics", "usage.jsonl").replaceAll("\\", "/")];
			assert.ok(entry, JSON.stringify(Object.keys(cache.entries)));
			assert.equal(entry.value.schemaVersion, 3);
			assert.equal(entry.value.intermediate.recordCount, 2);
			assert.equal(typeof entry.version.mtimeMs, "number");
			assert.equal(typeof entry.version.size, "number");

			// A fresh process detects the cached count without re-parsing. It reuses the
			// same userData directory, which is where the cache lives.
			const second = await start(t, home, userData);
			const detected = await second.invoke("usage-stats:detect");
			assert.equal(detected.payload.result.recordCount, 2);
			assert.equal(detected.payload.result.firstRecordAt, now - 2 * DAY);
			const after = await second.invoke("usage-stats:get");
			assert.deepEqual(plain(after.payload.result.totals), plain(before.payload.result.totals));
			assert.deepEqual(plain(after.payload.result.daily), plain(before.payload.result.daily));
		});
	});
} else {
	describe("native2 usage stats parity", () => {
		test("requires a built backend", (t) => {
			t.skip("PiDeckBackend.exe is not built");
		});
	});
}
