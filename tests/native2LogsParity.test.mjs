import assert from "node:assert/strict";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { gzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import {
	createFakePi,
	resolveBackendExecutable,
	SseClient,
	startBackendSession,
} from "./helpers/native2BackendHarness.mjs";
import {
	createLiveBatchOracle,
	createLogsRpcOracle,
	createRpcLogSummaryOracle,
} from "./helpers/native2LogsOracle.mjs";

const executable = resolveBackendExecutable();
const PROJECT_ID = "logs";
const slash = (value) => String(value).replaceAll("\\", "/");

/** Local calendar day, matching both writers' `app-YYYY-MM-DD.log` naming. */
function formatDate(value) {
	const date = new Date(value);
	return [
		date.getFullYear(),
		String(date.getMonth() + 1).padStart(2, "0"),
		String(date.getDate()).padStart(2, "0"),
	].join("-");
}

function dayStart(offsetDays) {
	const date = new Date();
	date.setHours(0, 0, 0, 0);
	date.setDate(date.getDate() - offsetDays);
	return date.getTime();
}

const plain = (value) => JSON.parse(JSON.stringify(value ?? null));

function writeBoth(directories, relativeName, bytes) {
	for (const directory of directories) {
		mkdirSync(directory, { recursive: true });
		writeFileSync(join(directory, relativeName), bytes);
	}
}

function listFiles(directory) {
	if (!existsSync(directory)) return [];
	return readdirSync(directory)
		.filter((name) => statSync(join(directory, name)).isFile())
		.sort();
}

/** Minimal imported session so a runtime can be activated against the fake pi. */
function writeSessionFile(sessionsDir, projectPath, name) {
	const path = join(sessionsDir, `${name}.jsonl`);
	writeFileSync(
		path,
		`${[
			{ type: "session", version: 3, id: name, timestamp: "2026-01-01T00:00:00.000Z", cwd: projectPath },
			{ type: "model_change", id: "m1", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", provider: "anthropic", modelId: "claude-sonnet-4" },
			{
				type: "message",
				id: "u1",
				parentId: "m1",
				timestamp: "2026-01-01T00:00:01.000Z",
				message: { role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1_767_225_601_000 },
			},
		].map((entry) => JSON.stringify(entry)).join("\n")}\n`,
	);
	return path;
}

const textTurn = (extraEvents = []) => [
	{
		ack: true,
		events: [
			{ event: { type: "agent_start" } },
			{ event: { type: "message_start", message: { role: "assistant", content: [] } } },
			{ event: { type: "message_update", message: { role: "assistant", content: [] }, assistantMessageEvent: { type: "text_delta", delta: "hi" } } },
			...extraEvents,
			{ event: { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "hi" }], stopReason: "stop" } } },
			{ event: { type: "agent_end", messages: [] } },
			{ event: { type: "agent_settled" } },
		],
	},
];

if (executable) {
	describe("native2 logs parity", () => {
		let root;
		let projectPath;

		before(() => {
			root = mkdtempSync(join(tmpdir(), "pideck-native2-logs-"));
			projectPath = join(root, "project");
			mkdirSync(projectPath, { recursive: true });
		});
		after(() => {
			if (root) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
		});

		/** Backend + twin oracle directories; `seed(dirs)` runs before either side reads. */
		const start = async (t, { seed = null, settings = {}, scenario = null, env = {} } = {}) => {
			let dirs = null;
			let fake = null;
			const session = await startBackendSession(t, {
				projects: [{ id: PROJECT_ID, path: projectPath }],
				settings: { language: "en-US", rpcTimeout: 600_000, ...settings },
				env,
				prepare: (fixture) => {
					const oracleRoot = join(fixture.root, "oracle");
					dirs = {
						backendLogs: join(fixture.userData, "logs"),
						backendRpc: join(fixture.userData, "logs", "rpc"),
						oracleLogs: join(oracleRoot, "logs"),
						oracleRpc: join(oracleRoot, "logs", "rpc"),
					};
					mkdirSync(dirs.backendRpc, { recursive: true });
					mkdirSync(dirs.oracleRpc, { recursive: true });
					if (seed) seed(dirs);
					// A fake pi is always present so startup tasks never record "pi version not
					// probed" into today's app log; the seeded read comparison must see only the
					// bytes the test wrote.
					fake = createFakePi(fixture, scenario ?? {});
					return {
						settings: { customPiPath: fake.shim, piRuntimePreference: "auto" },
						env: { FAKE_PI_SCENARIO: fake.scenarioPath, FAKE_PI_LOG: fake.logPath },
					};
				},
			});
			const oracle = createLogsRpcOracle({
				home: session.fixture.root,
				logDir: dirs.oracleLogs,
				rpcLogDir: dirs.oracleRpc,
			});
			return { ...session, dirs, fake, oracle };
		};

		/** Activate the runtime for one imported session and return its target. */
		const activate = async (session, name) => {
			const filePath = writeSessionFile(session.fixture.sessions, projectPath, name);
			const list = await session.invoke("sessions:catalog-list", [PROJECT_ID]);
			assert.equal(list.payload.ok, true, JSON.stringify(list.payload));
			const record = list.payload.result.find((entry) => slash(entry.filePath) === slash(filePath));
			assert.ok(record, "imported session must appear in the catalog");
			const activated = await session.invoke("sessions:runtime-activate", [record.id]);
			assert.equal(activated.payload.ok, true, JSON.stringify(activated.payload));
			return { record, target: activated.payload.result.value };
		};

		const prompt = (session, record, target, requestId, message) =>
			session.invoke("sessions:send-prompt", [{
				sessionId: record.id,
				requestId,
				message,
				agentId: target.agentId,
				runtimeGeneration: target.runtimeGeneration,
			}]);

		// ── app logs ────────────────────────────────────────────────────
		test("app log paging, level, search and date windows match the oracle", async (t) => {
			const session = await start(t, {
				seed: (dirs) => {
					const yesterday = dayStart(1);
					const twoDaysAgo = dayStart(2);
					const fourDaysAgo = dayStart(4);
					const entries = [
						{ id: "a1", time: yesterday + 36_000_000, level: "info", scope: "agent", message: "started pi", detail: { agentId: "ag-1" } },
						{ id: "a2", time: yesterday + 36_060_000, level: "warn", scope: "session", message: "retry", detail: { needle: "only-in-detail" } },
						{ id: "a3", time: twoDaysAgo + 32_400_000, level: "error", scope: "native", message: "event channel", detail: null },
						{ id: "a4", time: fourDaysAgo + 86_340_000, level: "debug", scope: "git", message: "commit", detail: [1, 2, 3] },
						{ id: "a5", time: twoDaysAgo + 32_700_000, level: "info", scope: "SCOPEX", message: "scope match" },
					];
					const byDay = new Map();
					for (const entry of entries) {
						const day = formatDate(entry.time);
						byDay.set(day, [...(byDay.get(day) ?? []), entry]);
					}
					for (const [day, dayEntries] of byDay) {
						const lines = dayEntries.map((entry) => JSON.stringify(entry));
						// A damaged line and a foreign JSON line must both be skipped.
						lines.push("{not json", JSON.stringify({ foo: 1 }));
						writeBoth([dirs.backendLogs, dirs.oracleLogs], `app-${day}.log`, `${lines.join("\n")}\n`);
					}
					// Today's file exists on both sides with no seed rows: the backend's startup
					// tasks legitimately append to it, and every comparison below is bounded to
					// yesterday-or-earlier.
					writeBoth([dirs.backendLogs, dirs.oracleLogs], `app-${formatDate(dayStart(0))}.log`, "");
				},
			});

			const bound = dayStart(0) - 1;
			const queries = [
				{ to: bound },
				{ to: bound, level: "warn" },
				{ to: bound, level: "all" },
				{ to: bound, search: "only-in-detail" },
				{ to: bound, search: "scopex" },
				{ to: bound, search: "ag-1" },
				{ from: dayStart(1), to: dayStart(1) + 86_400_000 - 1 },
				{ from: dayStart(4), to: bound },
				{ to: bound, page: 0, pageSize: 2 },
				{ to: bound, page: 1, pageSize: 2 },
				{ to: bound, page: 2, pageSize: 2 },
				{ to: bound, page: 0, pageSize: 999 },
				{ to: bound, page: 0, pageSize: 0 },
				{ to: bound, limit: 1 },
				{ to: bound, limit: 0 },
			];
			for (const query of queries) {
				const actual = await session.invoke("logs:list", [query]);
				assert.equal(actual.payload.ok, true, `${JSON.stringify(query)}: ${JSON.stringify(actual.payload)}`);
				const expected = await session.oracle.invoke("logs:list", [query]);
				assert.deepEqual(plain(actual.payload.result), plain(expected), `logs:list ${JSON.stringify(query)}`);

				const page = await session.invoke("logs:list-page", [query]);
				assert.equal(page.payload.ok, true, JSON.stringify(page.payload));
				const expectedPage = await session.oracle.invoke("logs:list-page", [query]);
				assert.deepEqual(plain(page.payload.result), plain(expectedPage), `logs:list-page ${JSON.stringify(query)}`);
			}

			// Unbounded read: the backend's own startup rows are production output, so the
			// seeded rows are compared by identity instead of asserting an unrelated total.
			const seedIds = new Set(["a1", "a2", "a3", "a4", "a5"]);
			const unbounded = await session.invoke("logs:list", [{}]);
			assert.equal(unbounded.payload.ok, true, JSON.stringify(unbounded.payload));
			assert.deepEqual(
				plain(unbounded.payload.result).filter((entry) => seedIds.has(entry.id)),
				plain(await session.oracle.invoke("logs:list", [{}])),
			);

			// 14-file read cap: only the newest 14 day files are queried by either side.
			for (let offset = 5; offset <= 20; offset += 1) {
				writeBoth(
					[session.dirs.backendLogs, session.dirs.oracleLogs],
					`app-${formatDate(dayStart(offset))}.log`,
					`${JSON.stringify({ id: `marker-${offset}`, time: dayStart(offset) + 2_000, level: "info", scope: "marker", message: `marker ${offset}` })}\n`,
				);
			}
			const capped = await session.invoke("logs:list-page", [{ to: bound, pageSize: 50 }]);
			const expectedCapped = await session.oracle.invoke("logs:list-page", [{ to: bound, pageSize: 50 }]);
			assert.deepEqual(plain(capped.payload.result), plain(expectedCapped));
			const cappedIds = plain(capped.payload.result.entries).map((entry) => entry.id);
			assert.equal(cappedIds.includes("marker-5"), true, JSON.stringify(cappedIds));
			assert.equal(cappedIds.includes("marker-20"), false, JSON.stringify(cappedIds));
		});

		test("app log write, retention, size, clear and open-folder match the oracle", async (t) => {
			const session = await start(t, {
				seed: (dirs) => {
					for (let offset = 0; offset < 15; offset += 1) {
						writeBoth(
							[dirs.backendLogs, dirs.oracleLogs],
							`app-${formatDate(dayStart(offset))}.log`,
							`${JSON.stringify({ id: `old-${offset}`, time: dayStart(offset) + 1_000, level: "info", scope: "seed", message: `day ${offset}` })}\n`,
						);
					}
				},
			});
			const size = () => session.invoke("logs:get-size");
			const list = (query) => session.invoke("logs:list", [query]);
			const strip = (entries) => plain(entries).map(({ id, time, ...rest }) => rest);

			// The first write prunes both directories down to the newest 14 files.
			await session.invoke("renderer:log", ["warn", "renderer", "composer stalled", { reason: "timeout", attempt: 2 }]);
			await session.oracle.invoke("renderer:log", ["warn", "renderer", "composer stalled", { reason: "timeout", attempt: 2 }]);
			assert.equal(listFiles(session.dirs.backendLogs).length, 14, JSON.stringify(listFiles(session.dirs.backendLogs)));
			assert.deepEqual(listFiles(session.dirs.backendLogs), listFiles(session.dirs.oracleLogs));

			// Clear leaves exactly one audit row on each side; the byte size then matches.
			await session.invoke("logs:clear");
			await session.oracle.invoke("logs:clear");
			assert.deepEqual(listFiles(session.dirs.backendLogs), listFiles(session.dirs.oracleLogs));
			assert.equal(listFiles(session.dirs.backendLogs).length, 1);
			assert.equal((await size()).payload.result, (await session.oracle.invoke("logs:get-size")));
			const cleared = await list({});
			assert.equal(cleared.payload.result.length, 1);
			assert.equal(cleared.payload.result[0].message, "Logs cleared");
			assert.equal(cleared.payload.result[0].detail.files, 14);
			assert.deepEqual(strip(cleared.payload.result), strip(await session.oracle.invoke("logs:list", [{}])));

			// Writes after the clear are compared byte-for-byte in size and semantically in
			// content (ids and timestamps are backend-owned).
			await session.invoke("renderer:log", ["warn", "renderer", "composer stalled", { reason: "timeout", attempt: 2 }]);
			await session.oracle.invoke("renderer:log", ["warn", "renderer", "composer stalled", { reason: "timeout", attempt: 2 }]);
			// An out-of-enum level degrades to `info` on both sides.
			await session.invoke("renderer:log", ["trace", "renderer", "bad level"]);
			await session.oracle.invoke("renderer:log", ["trace", "renderer", "bad level"]);
			const afterWrite = await list({});
			const expectedAfterWrite = await session.oracle.invoke("logs:list", [{}]);
			assert.deepEqual(strip(afterWrite.payload.result), strip(expectedAfterWrite));
			assert.deepEqual(
				afterWrite.payload.result.map((entry) => ({ level: entry.level, message: entry.message })),
				[
					{ level: "info", message: "bad level" },
					{ level: "warn", message: "composer stalled" },
					{ level: "info", message: "Logs cleared" },
				],
			);
			assert.equal((await size()).payload.result, (await session.oracle.invoke("logs:get-size")));

			await session.invoke("logs:open-folder");
			await session.oracle.invoke("logs:open-folder");
			const request = await session.host.waitForRequest("shell.openPath");
			assert.equal(slash(request.params.path), slash(session.dirs.backendLogs));
			assert.equal(slash(session.oracle.opened[0]), slash(session.dirs.oracleLogs));
		});

		// ── rpc logs ────────────────────────────────────────────────────
		test("rpc log history, size and day/limit clamps match the oracle", async (t) => {
			const session = await start(t, {
				seed: (dirs) => {
					const today = dayStart(0);
					const yesterday = dayStart(1);
					const entries = [
						{ id: "r1", agentId: "agent-a", direction: "send", summary: "→ prompt: hi", data: { type: "prompt", message: "hi" }, time: today + 28_800_000 },
						{ id: "r2", agentId: "agent-a", direction: "recv", summary: "← get_state ✓", data: { type: "response", command: "get_state", success: true }, time: today + 28_806_000 },
						{ id: "r3", agentId: "agent-b", direction: "send", summary: "→ set_model: x/y", data: { type: "set_model", provider: "x", modelId: "y" }, time: yesterday + 32_400_000 },
						{ id: "r4", agentId: "agent-a", direction: "recv", summary: "← message_update.text_delta", data: { type: "message_update", assistantMessageEvent: { type: "text_delta" } }, time: yesterday + 32_406_000 },
						{ id: "r5", agentId: "agent-a", direction: "send", summary: "→ prompt: old", data: { type: "prompt", message: "old" }, time: dayStart(10) + 36_000_000 },
					];
					const todayLines = [entries[0], entries[1]].map((entry) => JSON.stringify(entry));
					todayLines.push(JSON.stringify({ id: "broken" }), "not json");
					writeBoth([dirs.backendRpc, dirs.oracleRpc], `rpc-agent-a-${formatDate(entries[0].time)}.jsonl`, `${todayLines.join("\n")}\n`);
					writeBoth(
						[dirs.backendRpc, dirs.oracleRpc],
						`rpc-agent-a-${formatDate(entries[3].time)}.jsonl.gz`,
						gzipSync(`${JSON.stringify(entries[3])}\n`),
					);
					writeBoth(
						[dirs.backendRpc, dirs.oracleRpc],
						`rpc-agent-b-${formatDate(entries[2].time)}.jsonl`,
						`${JSON.stringify(entries[2])}\n`,
					);
					writeBoth(
						[dirs.backendRpc, dirs.oracleRpc],
						`rpc-agent-a-${formatDate(entries[4].time)}.jsonl`,
						`${JSON.stringify(entries[4])}\n`,
					);
					// Foreign files are ignored by the rpc-<agent>-<date> pattern.
					writeBoth([dirs.backendRpc, dirs.oracleRpc], "notes.txt", "ignored\n");
				},
			});

			const cases = [
				{},
				{ days: 1 },
				{ days: 2 },
				{ days: 2, limit: 2 },
				{ days: 1, limit: 1 },
				{ days: 0 },
				{ days: 99 },
				{ limit: 0 },
				{ limit: 100_000 },
			];
			for (const options of cases) {
				const actual = await session.invoke("rpc-logs:get", [options]);
				assert.equal(actual.payload.ok, true, `${JSON.stringify(options)}: ${JSON.stringify(actual.payload)}`);
				const expected = await session.oracle.invoke("rpc-logs:get", [options]);
				assert.deepEqual(plain(actual.payload.result), plain(expected), `rpc-logs:get ${JSON.stringify(options)}`);
			}

			// No target = the global log; the target-scoped read is compared on a real runtime
			// target in the live test (production validates it against the binding table).
			const size = await session.invoke("rpc-logs:get-size", []);
			assert.equal(size.payload.ok, true, JSON.stringify(size.payload));
			assert.equal(size.payload.result, await session.oracle.invoke("rpc-logs:get-size", []));
		});

		test("rpc log save filters renderer junk, de-duplicates and truncates bash commands", async (t) => {
			const session = await start(t);
			const time = Date.now();
			const entry = {
				id: "saved-1",
				agentId: "agent-save",
				direction: "send",
				summary: "→ bash: npm test",
				data: { type: "bash", command: "x".repeat(500) },
				time,
			};
			const payload = {
				entries: [
					entry,
					{ ...entry },
					// Rejected by `isRpcLogEntry`: wrong direction / missing summary.
					{ ...entry, id: "bad-1", direction: "bogus" },
					{ id: "bad-2", agentId: "agent-save", direction: "recv", time },
				],
			};
			const actual = await session.invoke("rpc-logs:save", [payload]);
			assert.equal(actual.payload.ok, true, JSON.stringify(actual.payload));
			const expected = await session.oracle.invoke("rpc-logs:save", [payload]);
			assert.deepEqual(
				plain(actual.payload.result).map(slash),
				plain(expected).map((path) => slash(path).replace(slash(session.dirs.oracleRpc), slash(session.dirs.backendRpc))),
			);
			const fileName = `rpc-agent-save-${formatDate(time)}.jsonl`;
			assert.deepEqual(listFiles(session.dirs.backendRpc), [fileName]);
			assert.deepEqual(listFiles(session.dirs.backendRpc), listFiles(session.dirs.oracleRpc));
			const backendLines = readFileSync(join(session.dirs.backendRpc, fileName), "utf8").trim().split("\n");
			const oracleLines = readFileSync(join(session.dirs.oracleRpc, fileName), "utf8").trim().split("\n");
			// The oracle de-duplicates against the file, not inside one batch: both sides
			// write the two identical ids and nothing for the junk rows.
			assert.equal(backendLines.length, oracleLines.length);
			assert.equal(backendLines.length, 2);
			const parsed = backendLines.map((line) => JSON.parse(line));
			assert.deepEqual(plain(parsed), plain(oracleLines.map((line) => JSON.parse(line))));
			assert.equal(parsed[0].data.command.length, 200, "the bash command is truncated on disk");

			// A second save of the same ids writes nothing.
			const again = await session.invoke("rpc-logs:save", [payload]);
			assert.deepEqual(plain(again.payload.result), []);
			assert.deepEqual(plain(await session.oracle.invoke("rpc-logs:save", [payload])), []);

			// Nothing valid in the batch: an empty array, not an error.
			const junk = await session.invoke("rpc-logs:save", [{ entries: [{ id: 1 }, null, "x"] }]);
			assert.equal(junk.payload.ok, true);
			assert.deepEqual(plain(junk.payload.result), []);
		});

		test("rpc log clear is agent-scoped and clears that agent's live ring", async (t) => {
			const session = await start(t, {
				seed: (dirs) => {
					const today = formatDate(Date.now());
					writeBoth(
						[dirs.backendRpc, dirs.oracleRpc],
						`rpc-agent-a-${today}.jsonl`,
						`${JSON.stringify({ id: "c1", agentId: "agent-a", direction: "send", summary: "→ prompt: a", data: { type: "prompt" }, time: Date.now() })}\n`,
					);
					writeBoth(
						[dirs.backendRpc, dirs.oracleRpc],
						`rpc-agent-b-${today}.jsonl`,
						`${JSON.stringify({ id: "c2", agentId: "agent-b", direction: "send", summary: "→ prompt: b", data: { type: "prompt" }, time: Date.now() })}\n`,
					);
				},
			});
			await session.invoke("rpc-logs:clear", [{ sessionId: "s", agentId: "agent-a", runtimeGeneration: 1 }]);
			await session.oracle.bind("agent-a");
			await session.oracle.invoke("rpc-logs:clear", [{ sessionId: "s", agentId: "agent-a", runtimeGeneration: 1 }]);
			assert.deepEqual(listFiles(session.dirs.backendRpc), listFiles(session.dirs.oracleRpc));
			assert.deepEqual(plain(listFiles(session.dirs.backendRpc)), [`rpc-agent-b-${formatDate(Date.now())}.jsonl`]);
		});

		// ── live producer ───────────────────────────────────────────────
		test("agents:rpc-log is gated by rpc-logs:logging-set and carries oracle summaries", async (t) => {
			const session = await start(t, { scenario: { turns: textTurn() } });
			const sse = new SseClient(`${session.baseUrl}__pideck/events?token=${encodeURIComponent(session.token)}`);
			await sse.connect().catch(() => undefined);
			t.after(() => sse.close());
			const { record, target } = await activate(session, `live-${Date.now()}`);
			const oracle = createRpcLogSummaryOracle();
			t.after(() => oracle.dispose());
			await oracle.start();

			// Off by default: the frame never reaches the panel and nothing is written.
			assert.deepEqual(plain((await session.invoke("rpc-logs:get-live", [target.agentId])).payload.result), []);
			await prompt(session, record, target, "off", "not recorded");
			await assert.rejects(
				sse.waitFor((frame) => frame.payload.channel === "agents:rpc-log", 400),
				/did not arrive/i,
			);
			assert.deepEqual(listFiles(session.dirs.backendRpc), []);

			const enabled = await session.invoke("rpc-logs:logging-set", [target, true]);
			assert.equal(enabled.payload.ok, true, JSON.stringify(enabled.payload));
			assert.equal(enabled.payload.result, true);
			assert.equal((await session.invoke("rpc-logs:logging-get", [target])).payload.result, true);
			session.oracle.bind(target.agentId);

			const promptStarted = Date.now();
			await prompt(session, record, target, "on", "record me");
			const frame = await sse.waitFor((entry) => entry.payload.channel === "agents:rpc-log", 15_000);
			const batch = frame.payload.args[0];
			assert.equal(batch.agentId, target.agentId);
			assert.ok(batch.entries.length > 0, "a batch must carry the prompt traffic");
			assert.ok(Date.now() - promptStarted >= 50, "the batch is deferred, not sent per frame");

			// Every summary is produced by the production AgentManager handler for the same
			// frame; `id`/`time` are the only backend-owned differences.
			const expected = oracle.summarize(batch.entries.map((entry) => ({ direction: entry.direction, data: entry.data })));
			const shape = (entry) => ({ direction: entry.direction, summary: entry.summary, data: plain(entry.data) });
			assert.deepEqual(batch.entries.map(shape), expected.map(shape));
			const summaries = batch.entries.map((entry) => entry.summary);
			assert.ok(summaries.some((summary) => summary.startsWith("→ prompt")), JSON.stringify(summaries));
			assert.ok(summaries.some((summary) => summary.startsWith("← ")), JSON.stringify(summaries));

			// The same records are readable from the ring, and the disk file has them too.
			const live = await session.invoke("rpc-logs:get-live", [target.agentId]);
			assert.deepEqual(
				plain(live.payload.result.map((entry) => entry.id)).sort(),
				plain(batch.entries.map((entry) => entry.id)).sort(),
			);
			const filePath = join(session.dirs.backendRpc, `rpc-${target.agentId}-${formatDate(Date.now())}.jsonl`);
			assert.ok(existsSync(filePath), "recording writes a daily JSONL file");
			const diskEntries = readFileSync(filePath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
			assert.deepEqual(
				plain(diskEntries.map((entry) => entry.id)).sort(),
				plain(batch.entries.map((entry) => entry.id)).sort(),
			);
			// Target-scoped size resolves to this runtime's daily file. (The seeded-file
			// oracle comparison covers the query itself; the oracle directory never saw the
			// live recording.)
			const size = await session.invoke("rpc-logs:get-size", [target]);
			assert.equal(size.payload.ok, true, JSON.stringify(size.payload));
			assert.equal(size.payload.result, statSync(filePath).size);

			// Turning recording off stops both the file and the live channel.
			await session.invoke("rpc-logs:logging-set", [target, false]);
			const before = statSync(filePath).size;
			await prompt(session, record, target, "off-again", "ignored");
			await new Promise((resolvePromise) => setTimeout(resolvePromise, 300));
			assert.equal(statSync(filePath).size, before);
		});

		test("live batches use the oracle's 80 ms / 100-entry batching", async (t) => {
			// The fake pi emits its 200 events synchronously after the prompt ack, so a 300 ms
			// window turns them into the first flush; the remaining chunks follow on the next
			// two windows. Batch sizes are then compared with the production buffer.
			const events = Array.from({ length: 200 }, (_, index) => ({
				event: {
					type: "message_update",
					message: { role: "assistant", content: [] },
					assistantMessageEvent: { type: "text_delta", delta: `${index % 10}` },
				},
			}));
			const session = await start(t, {
				scenario: { turns: textTurn(events) },
				env: { PIDECK_RPC_LOG_FLUSH_MS: "300" },
			});
			const sse = new SseClient(`${session.baseUrl}__pideck/events?token=${encodeURIComponent(session.token)}`);
			await sse.connect().catch(() => undefined);
			t.after(() => sse.close());
			const { record, target } = await activate(session, `burst-${Date.now()}`);
			await session.invoke("rpc-logs:logging-set", [target, true]);
			await prompt(session, record, target, "burst", "burst");
			// Three chunks are expected (100 + 100 + remainder); wait until all arrived.
			const waitForBatches = async (minimum) => {
				const deadline = Date.now() + 30_000;
				while (Date.now() < deadline) {
					const count = sse.frames.filter((frame) => frame.payload.channel === "agents:rpc-log").length;
					if (count >= minimum) return;
					await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
				}
				throw new Error(`expected ${minimum} agents:rpc-log batches`);
			};
			await waitForBatches(3);
			const batches = sse.frames
				.filter((entry) => entry.payload.channel === "agents:rpc-log")
				.map((entry) => entry.payload.args[0])
				.filter((batch) => batch.agentId === target.agentId);
			const total = batches.reduce((sum, batch) => sum + batch.entries.length, 0);
			assert.ok(total > 200, `expected a >200 frame burst, got ${total}`);
			// Every batch but the last is the 100-entry cap, and the size list equals what
			// the production buffer produces for the same total.
			const sizes = batches.map((batch) => batch.entries.length);
			assert.equal(sizes.slice(0, -1).every((size) => size === 100), true, JSON.stringify(sizes));
			assert.deepEqual(sizes, createLiveBatchOracle().sizes(total));
		});

		test("the live queue keeps only the newest 1000 frames per agent", async (t) => {
			// 1200 events plus the prompt/response frames exceed the oracle's pending budget;
			// the oldest frames must be dropped, not the newest.
			const events = Array.from({ length: 1_200 }, (_, index) => ({
				event: {
					type: "message_update",
					message: { role: "assistant", content: [] },
					assistantMessageEvent: { type: "text_delta", delta: `${index}` },
				},
			}));
			const session = await start(t, {
				scenario: { turns: textTurn(events) },
				env: { PIDECK_RPC_LOG_FLUSH_MS: "300" },
			});
			const sse = new SseClient(`${session.baseUrl}__pideck/events?token=${encodeURIComponent(session.token)}`);
			await sse.connect().catch(() => undefined);
			t.after(() => sse.close());
			const { record, target } = await activate(session, `cap-${Date.now()}`);
			await session.invoke("rpc-logs:logging-set", [target, true]);
			await prompt(session, record, target, "cap", "cap");
			const deadline = Date.now() + 30_000;
			let batches = [];
			while (Date.now() < deadline) {
				batches = sse.frames
					.filter((entry) => entry.payload.channel === "agents:rpc-log")
					.map((entry) => entry.payload.args[0])
					.filter((batch) => batch.agentId === target.agentId);
				if (batches.reduce((sum, batch) => sum + batch.entries.length, 0) >= 1_000) break;
				await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
			}
			const total = batches.reduce((sum, batch) => sum + batch.entries.length, 0);
			assert.equal(total, 1_000, JSON.stringify(batches.map((batch) => batch.entries.length)));
			assert.deepEqual(batches.map((batch) => batch.entries.length), Array.from({ length: 10 }, () => 100));
			// The kept frames are the newest ones: the drop window only spans the first ~200
			// events (prompt/response and early deltas), never the tail.
			assert.equal(batches[0].entries.every((entry) => entry.data.type === "message_update"), true);
			const firstDelta = Number(batches[0].entries[0].data.assistantMessageEvent.delta);
			assert.ok(firstDelta >= 190 && firstDelta <= 250, `first kept delta ${firstDelta}`);
			const deltas = batches.flatMap((batch) => batch.entries).map((entry) => Number(entry.data.assistantMessageEvent?.delta)).filter((value) => !Number.isNaN(value));
			assert.equal(Math.max(...deltas), 1_199);
		});

		test("per-agent batching isolates frames and live payloads are summarized at 4 KiB", async (t) => {
			const session = await start(t, { scenario: { turns: textTurn() } });
			const sse = new SseClient(`${session.baseUrl}__pideck/events?token=${encodeURIComponent(session.token)}`);
			await sse.connect().catch(() => undefined);
			t.after(() => sse.close());
			const first = await activate(session, `agent-a-${Date.now()}`);
			const second = await activate(session, `agent-b-${Date.now()}`);
			assert.notEqual(first.target.agentId, second.target.agentId);
			await session.invoke("rpc-logs:logging-set", [first.target, true]);
			await session.invoke("rpc-logs:logging-set", [second.target, true]);

			const longMessage = `L${"m".repeat(6_000)}`;
			await prompt(session, first.record, first.target, "long", longMessage);
			// Give the second agent traffic too, so a merged batch would be visible.
			await prompt(session, second.record, second.target, "short", "short");
			const firstFrame = await sse.waitFor(
				(entry) => entry.payload.channel === "agents:rpc-log" && entry.payload.args[0].agentId === first.target.agentId,
				15_000,
			);
			const secondFrame = await sse.waitFor(
				(entry) => entry.payload.channel === "agents:rpc-log" && entry.payload.args[0].agentId === second.target.agentId,
				15_000,
			);
			const firstEntries = firstFrame.payload.args[0].entries;
			const secondEntries = secondFrame.payload.args[0].entries;
			assert.equal(firstEntries.every((entry) => entry.agentId === first.target.agentId), true);
			assert.equal(secondEntries.every((entry) => entry.agentId === second.target.agentId), true);

			// The live batch carries the full frame (the viewer expands it)...
			const sentPrompt = firstEntries.find((entry) => entry.direction === "send" && entry.data.type === "prompt");
			assert.ok(sentPrompt, JSON.stringify(firstEntries.map((entry) => entry.summary)));
			assert.equal(sentPrompt.data.message.length, longMessage.length);
			// ...while the bounded in-memory ring replaces a >4 KiB payload with the same
			// `{truncated,size,preview}` record the oracle builds from `JSON.stringify(data)`.
			const live = await session.invoke("rpc-logs:get-live", [first.target.agentId]);
			const ringEntry = live.payload.result.find((entry) => entry.id === sentPrompt.id);
			assert.ok(ringEntry, "the record is in the live ring");
			const json = JSON.stringify(sentPrompt.data);
			assert.deepEqual(plain(ringEntry.data), {
				truncated: true,
				size: json.length,
				preview: json.slice(0, 200),
			});
			// The disk copy keeps the full prompt: only the bash command is truncated.
			const filePath = join(session.dirs.backendRpc, `rpc-${first.target.agentId}-${formatDate(Date.now())}.jsonl`);
			const disk = readFileSync(filePath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
			const diskPrompt = disk.find((entry) => entry.id === sentPrompt.id);
			assert.equal(diskPrompt.data.message.length, longMessage.length);
		});
	});
} else {
	describe("native2 logs parity", () => {
		test("requires a built backend", (t) => {
			t.skip("PiDeckBackend.exe is not built");
		});
	});
}
