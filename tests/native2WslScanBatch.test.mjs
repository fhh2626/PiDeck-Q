import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { startBackendSession } from "./helpers/native2BackendHarness.mjs";

/**
 * WSL scan batching through the native sessions:list contract.
 *
 * Every case drives the real `PiDeckBackend.exe` through `sessions:list` and a real child
 * process: `PIDECK_WSL_EXE` points at `PiDeck-FakeWsl`, a native launcher that forwards the
 * exact argv to `tests/fixtures/native2-fake-wsl-fs.mjs`. A `.cmd` shim cannot be used
 * here — `cmd.exe` re-parses the `sh -c` body script and would hide whether the backend
 * really sent the script and the paths as single positional arguments.
 *
 * Hermeticity: the "distro" is a temporary directory behind `PIDECK_WSL_UNC_ROOT`, the
 * fixture answers only the commands the scanner is allowed to issue, and no real distro or
 * network is involved.
 */

const REPO = process.cwd();
const BUILD_PLATFORM = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macosx" : process.platform;
const LAUNCHER_NAME = process.platform === "win32" ? "PiDeck-FakeWsl.exe" : "PiDeck-FakeWsl";
const LAUNCHER_CANDIDATES = [
	`build/${BUILD_PLATFORM}/${process.arch}/debug/${LAUNCHER_NAME}`,
	`build/${BUILD_PLATFORM}/${process.arch}/release/${LAUNCHER_NAME}`,
];
const LAUNCHER_SOURCE = "native/tests/FakeWslLauncher.cpp";

function resolveLauncher() {
	for (const relative of LAUNCHER_CANDIDATES) {
		const candidate = join(REPO, relative);
		if (!existsSync(candidate)) continue;
		if (existsSync(join(REPO, LAUNCHER_SOURCE)) && statSync(candidate).mtimeMs < statSync(join(REPO, LAUNCHER_SOURCE)).mtimeMs) {
			throw new Error(`${relative} is older than ${LAUNCHER_SOURCE}; rebuild it with "xmake build -y PiDeck-FakeWsl"`);
		}
		return candidate;
	}
	if (process.env.PIDECK_REQUIRE_BACKEND_TESTS === "1") {
		throw new Error(
			`PIDECK_REQUIRE_BACKEND_TESTS=1 but no PiDeck-FakeWsl launcher exists (looked for ${LAUNCHER_CANDIDATES.join(", ")}); ` +
				`build it with "PIDECK_STAGE_DIR=build/native2-validation-unpacked xmake build -y PiDeck-FakeWsl"`,
		);
	}
	return "";
}

const launcher = resolveLauncher();
const FIXTURE = join(REPO, "tests/fixtures/native2-fake-wsl-fs.mjs");
const SLASH = (value) => String(value).replaceAll("\\", "/");

/** The oracle's `READ_FILES_SCRIPT`, byte for byte (paths stay positional arguments). */
const READ_FILES_SCRIPT =
	'for file do printf "%s\\0" "$file"; cat -- "$file"; status=$?; printf "\\0%s\\0" "$status"; done';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check, message, timeoutMs = 20_000) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = await check();
		if (value) return value;
		if (Date.now() > deadline) throw new Error(message);
		await sleep(50);
	}
}

function readJsonLines(path) {
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

/** Structured application log the backend writes under `userData/logs`. */
function appLogText(userData) {
	const directory = join(userData, "logs");
	if (!existsSync(directory)) return "";
	return readdirSync(directory)
		.filter((name) => name.endsWith(".log"))
		.map((name) => readFileSync(join(directory, name), "utf8"))
		.join("\n");
}

/** Drop the `-d <distro> -u <user>` prefix `wsl.exe` receives. */
const innerCommand = (argv) => argv.slice(4);

function writeSession(sessionsDir, directoryToken, id, cwd) {
	const directory = join(sessionsDir, directoryToken);
	mkdirSync(directory, { recursive: true });
	const entries = [
		{ type: "session", version: 3, id, timestamp: "2026-01-01T00:00:00.000Z", cwd },
		{
			type: "message",
			id: "u0",
			parentId: null,
			timestamp: "2026-01-01T00:00:01.000Z",
			message: { role: "user", content: [{ type: "text", text: `hello ${id}` }], timestamp: 1_767_225_601_000 },
		},
	];
	writeFileSync(join(directory, `${id}.jsonl`), `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
}

/** `/mnt/d/work/app`: the cwd pi records inside a distro for a Windows project path. */
function wslRuntimePath(windowsPath) {
	return SLASH(windowsPath).replace(/^([A-Za-z]):\//, (_match, drive) => `/mnt/${drive.toLowerCase()}/`);
}

/**
 * One backend in WSL mode with the fake distro mounted at `PIDECK_WSL_UNC_ROOT`.
 * `files` are written into the distro's `.pi/agent/sessions` tree.
 */
async function wslSession(t, { projectPath = SLASH(join(REPO, "src")), files = [], scenario = {}, env = {} } = {}) {
	const state = {};
	const session = await startBackendSession(t, {
		settings: { wslEnabled: false },
		projects: [{ id: "wsl-scan", path: projectPath }],
		prepare: (fixture) => {
			const uncRoot = join(fixture.root, "wsl-unc");
			const linuxHome = "/home/dev";
			const agentDir = join(uncRoot, "Ubuntu", ...linuxHome.split("/").filter(Boolean), ".pi", "agent");
			for (const name of ["prompts", "skills", "extensions", "sessions"]) mkdirSync(join(agentDir, name), { recursive: true });
			const scenarioPath = join(fixture.root, "fake-wsl-scenario.json");
			const logPath = join(fixture.root, "fake-wsl.log");
			const timingPath = join(fixture.root, "fake-wsl-timing.log");
			for (const file of files) writeSession(join(agentDir, "sessions"), file.directory, file.id, file.cwd ?? wslRuntimePath(projectPath));
			const writeScenario = (next) => writeFileSync(scenarioPath, JSON.stringify(next));
			writeScenario({
				root: join(uncRoot, "Ubuntu", "home", "dev"),
				linuxHome,
				home: linuxHome,
				distros: ["Ubuntu"],
				...scenario,
			});
			Object.assign(state, {
				agentDir,
				logPath,
				timingPath,
				scenarioPath,
				sessionsDir: join(agentDir, "sessions"),
				writeScenario,
				fixtureRoot: fixture.root,
			});
			const prepared = {
				settings: { wslEnabled: true, wslDistro: "Ubuntu", wslUser: "dev" },
				env: {
					PIDECK_WSL_EXE: launcher,
					// Measure the foreground batch, not the independent startup cache prewarm.
					PIDECK_CATALOG_PREWARM_DELAY_MS: "60000",
					PIDECK_WSL_UNC_ROOT: uncRoot,
					PIDECK_HOST_HOME: join(fixture.root, "local-home"),
					PIDECK_HOME: join(fixture.root, "local-home"),
					FAKE_WSL_SCRIPT: FIXTURE,
					FAKE_WSL_NODE: process.execPath,
					FAKE_WSL_SCENARIO: scenarioPath,
					FAKE_WSL_LOG: logPath,
					FAKE_WSL_TIMING_LOG: timingPath,
					...env,
				},
			};
			return prepared;
		},
	});
	// Startup resolves WSL asynchronously; a list that races it would scan the empty local
	// environment and prove nothing about the batch reader.
	await waitFor(
		() => appLogText(session.fixture.userData).includes("WSL environment configured"),
		"the backend never switched the session scanner to WSL",
	);
	return { session, state };
}

/** Commands the fake distro received, with the `-d/-u` prefix removed. */
function commands(state) {
	return readJsonLines(state.logPath)
		.filter((entry) => Array.isArray(entry.argv))
		.map((entry) => innerCommand(entry.argv));
}

function listSessions(session) {
	return session.invoke("sessions:list", ["wsl-scan"]);
}

/** Session file stems of a list result (`id` is the file path in the wire summary). */
function stems(result) {
	return result.map((record) => String(record.filePath).split("/").at(-1).replace(/\.jsonl$/, ""));
}

/** Largest number of simultaneously running fake-wsl children. */
function maxConcurrentSpans(timingPath) {
	const spans = readJsonLines(timingPath).sort((a, b) => a.start - b.start);
	let max = 0;
	for (let index = 0; index < spans.length; index += 1) {
		const running = spans.filter((other) => other.start <= spans[index].end && other.end >= spans[index].start);
		max = Math.max(max, running.length);
	}
	return max;
}

describe("native2 WSL scan batches", { skip: launcher ? false : "PiDeck-FakeWsl launcher not built" }, () => {
	test("the launcher forwards the body script and hostile paths as single positional arguments", () => {
		const echo = join(tmpdir(), `pideck-wsl-echo-${process.pid}.mjs`);
		writeFileSync(echo, "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n");
		try {
			const hostile = '/home/dev/a b"q&x(1);$(touch /tmp/nope).jsonl';
			const argv = ["-d", "Ubuntu", "-u", "dev", "sh", "-c", READ_FILES_SCRIPT, "pideck-scan-read", hostile];
			const result = spawnSync(launcher, argv, {
				env: { ...process.env, FAKE_WSL_SCRIPT: echo, FAKE_WSL_NODE: process.execPath },
				encoding: "utf8",
			});
			assert.equal(result.status, 0, result.stderr);
			// The whole point of the native launcher: cmd.exe would split this argv at the
			// script's spaces and at the quotes/semicolon inside the path.
			assert.deepEqual(JSON.parse(result.stdout), argv);
		} finally {
			writeFileSync(echo, "");
		}
	});

	test("sessions:list reads versions in a stat envelope and bodies in one sh envelope, then skips cached bodies", async (t) => {
		const names = ["plain", "with space", "amp&ersand;dollar$percent%quote'paren(1)#hash", "brackets[0]"];
		const files = [];
		for (let index = 0; index < 20; index += 1) {
			files.push({ directory: `--${names[index % names.length]}--`, id: `sess-${String(index).padStart(2, "0")}` });
		}
		const { session, state } = await wslSession(t, { files });

		const first = await listSessions(session);
		assert.equal(first.payload.ok, true, JSON.stringify(first.payload.error));
		const listed = stems(first.payload.result).sort();
		assert.equal(listed.length, 20, `every session must be listed: ${listed.join(",")}`);
		assert.deepEqual(listed, files.map((file) => file.id).sort());

		const firstCommands = commands(state);
		const statBatches = firstCommands.filter((argv) => argv[0] === "stat" && argv[1] === "--printf");
		assert.equal(statBatches.length, 1, "20 paths fit one metadata batch");
		assert.equal(statBatches[0][2], "%n\\0%Y\\0%s\\0", "NUL-framed stat format");
		assert.equal(statBatches[0][3], "--");
		const statPaths = statBatches[0].slice(4);
		assert.equal(statPaths.length, 20);
		assert.ok(statPaths.some((path) => path.includes("/--with space--/")), "spaces stay inside one argv element");
		assert.ok(
			statPaths.some((path) => path.includes("amp&ersand;dollar$percent%quote'paren(1)#hash")),
			"shell metacharacters stay inside one argv element",
		);
		assert.ok(statPaths.some((path) => path.includes("--brackets[0]--")));

		const bodyBatches = firstCommands.filter((argv) => argv[0] === "sh");
		assert.equal(bodyBatches.length, 2, "20 paths split into 16 + 4 body batches");
		for (const argv of bodyBatches) {
			assert.equal(argv[1], "-c");
			assert.equal(argv[2], READ_FILES_SCRIPT, "the script is one argument, byte for byte");
			assert.equal(argv[3], "pideck-scan-read");
		}
		const bodyPaths = bodyBatches.flatMap((argv) => argv.slice(4));
		assert.equal(bodyPaths.length, 20);
		assert.deepEqual([...bodyPaths].sort(), [...statPaths].sort(), "every path is read exactly once");
		assert.equal(firstCommands.filter((argv) => argv[0] === "cat").length, 0, "a complete envelope needs no per-file cat");

		// Unchanged mtime+size: the summary cache answers, so no body command may run.
		const mark = commands(state).length;
		const second = await listSessions(session);
		assert.equal(second.payload.ok, true);
		assert.equal(second.payload.result.length, 20);
		const delta = commands(state).slice(mark);
		assert.equal(delta.filter((argv) => argv[0] === "sh" || argv[0] === "cat").length, 0, JSON.stringify(delta));
		assert.equal(delta.filter((argv) => argv[0] === "stat" && argv[1] === "--printf").length, 1);
	});

	test("a malformed stat record re-stats every file, and a vanished file only drops itself", async (t) => {
		const files = [];
		for (let index = 0; index < 6; index += 1) files.push({ directory: "--mixed--", id: `mixed-${index}` });
		const { session, state } = await wslSession(t, {
			files,
			scenario: { statCorrupt: true, statSkipSuffix: "mixed-3.jsonl" },
		});

		const listed = await listSessions(session);
		assert.equal(listed.payload.ok, true, JSON.stringify(listed.payload.error));
		assert.deepEqual(stems(listed.payload.result).sort(), ["mixed-0", "mixed-1", "mixed-2", "mixed-4", "mixed-5"]);

		const sent = commands(state);
		assert.equal(sent.filter((argv) => argv[0] === "stat" && argv[1] === "--printf").length, 1);
		const singles = sent.filter((argv) => argv[0] === "stat" && argv[1] === "-c");
		assert.equal(singles.length, 6, "one fallback stat per path, including the vanished one");
		assert.ok(singles.some((argv) => argv.at(-1).endsWith("mixed-3.jsonl")));
		assert.ok(singles.every((argv) => argv[2] === "%Y %s"));
	});

	test("a stalled body read keeps completed siblings, never retries the stalled cat, and stays within four children", async (t) => {
		const files = [];
		for (let index = 0; index < 12; index += 1) files.push({ directory: "--batch--", id: `s${String(index).padStart(2, "0")}` });
		const { session, state } = await wslSession(t, {
			files,
			scenario: { bodyStallFile: "s05.jsonl", bodyStallMs: 4_000, bodyStallPartial: '{"type":"sess', logTiming: true },
			env: { PIDECK_WSL_SCAN_BODY_TIMEOUT_MS: "700", PIDECK_WSL_SCAN_TIMEOUT_MS: "60000" },
		});

		const first = await listSessions(session);
		assert.equal(first.payload.ok, true, JSON.stringify(first.payload.error));
		const listed = stems(first.payload.result).sort();
		assert.equal(listed.length, 11, `the stalled session is failed: ${listed.join(",")}`);
		assert.ok(!listed.includes("s05"));

		const sent = commands(state);
		assert.equal(sent.filter((argv) => argv[0] === "sh").length, 1, "one body envelope, then recovery reads");
		const cats = sent.filter((argv) => argv[0] === "cat").map((argv) => argv[1]);
		// Files after the stalled record are read individually with the remaining budget.
		assert.deepEqual(cats.sort(), ["s06", "s07", "s08", "s09", "s10", "s11"].map((stem) => catPath(stem)));
		assert.ok(!cats.some((path) => path.endsWith("s05.jsonl")), "the stalled cat must not be repeated");
		assert.ok(maxConcurrentSpans(state.timingPath) <= 4, `in-flight children: ${maxConcurrentSpans(state.timingPath)}`);

		// A healthy distro afterwards: only s05 needs a body, and the cache skips the rest.
		state.writeScenario({
			root: join(state.fixtureRoot, "wsl-unc", "Ubuntu", "home", "dev"),
			linuxHome: "/home/dev",
			home: "/home/dev",
			distros: ["Ubuntu"],
		});
		const mark = commands(state).length;
		const second = await listSessions(session);
		assert.equal(second.payload.ok, true);
		assert.deepEqual(stems(second.payload.result).sort(), files.map((file) => file.id).sort());
		const delta = commands(state).slice(mark);
		const shCount = delta.filter((argv) => argv[0] === "sh").length;
		const catCount = delta.filter((argv) => argv[0] === "cat").length;
		assert.equal(shCount, 0, "one wanted body skips the sh envelope");
		assert.equal(catCount, 1, JSON.stringify(delta));
		assert.ok(delta.some((argv) => argv[0] === "cat" && argv[1].endsWith("s05.jsonl")));
	});

	test("an unrepresentable stat mtime is rejected instead of cast into a bogus version", async (t) => {
		const files = [];
		for (let index = 0; index < 4; index += 1) files.push({ directory: "--huge--", id: `huge-${index}` });
		const { session, state } = await wslSession(t, { files, scenario: { statHugeSuffix: "huge-1.jsonl" } });

		const listed = await listSessions(session);
		assert.equal(listed.payload.ok, true, JSON.stringify(listed.payload.error));
		// `qint64(1e308 * 1000)` is UB; the poisoned file is dropped, never served with a
		// fabricated mtime (the summary cache must not persist one either).
		assert.deepEqual(stems(listed.payload.result).sort(), ["huge-0", "huge-2", "huge-3"]);
		const sent = commands(state);
		assert.equal(sent.filter((argv) => argv[0] === "stat" && argv[1] === "--printf").length, 1);
		assert.equal(sent.filter((argv) => argv[0] === "stat" && argv[1] === "-c").length, 4);
	});

	test("the scan deadline fails the list instead of hanging, and the next scan recovers", async (t) => {
		const files = [];
		for (let index = 0; index < 12; index += 1) files.push({ directory: "--deadline--", id: `d${String(index).padStart(2, "0")}` });
		const { session, state } = await wslSession(t, {
			files,
			scenario: { bodyStallFile: ".jsonl", bodyStallMs: 6_000, bodyStallPartial: '{"type":"sess' },
			env: { PIDECK_WSL_SCAN_TIMEOUT_MS: "1200", PIDECK_WSL_SCAN_BODY_TIMEOUT_MS: "10000" },
		});

		const started = Date.now();
		const timedOut = await listSessions(session);
		assert.equal(timedOut.payload.ok, false, JSON.stringify(timedOut.payload.result));
		assert.match(timedOut.payload.error.message, /timed out/i);
		assert.ok(Date.now() - started < 10_000, "the deadline must bound the whole scan");

		state.writeScenario({
			root: join(state.fixtureRoot, "wsl-unc", "Ubuntu", "home", "dev"),
			linuxHome: "/home/dev",
			home: "/home/dev",
			distros: ["Ubuntu"],
		});
		const recovered = await waitFor(async () => {
			const next = await listSessions(session);
			return next.payload.ok && next.payload.result.length === 12 ? next : null;
		}, "the scanner never recovered after an expired scan");
		assert.equal(recovered.payload.result.length, 12);
	});
});

/** Linux path the fake distro sees for a batch session (used to assert per-file cats). */
function catPath(stem) {
	return `/home/dev/.pi/agent/sessions/--batch--/${stem}.jsonl`;
}
