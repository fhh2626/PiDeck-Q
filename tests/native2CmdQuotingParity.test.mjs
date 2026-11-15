import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, test } from "node:test";
import {
	createFakePi,
	qtBinDirectory,
	resolveBackendExecutable,
	startBackendSession,
} from "./helpers/native2BackendHarness.mjs";

// `cmd.exe` quoting parity for every place PiDeck launches a batch shim
// (oracle `PiLocator.ts`: `needsCmdQuote` / `quoteCmdArgument` / `createInvocation`).
//
// A `.cmd`/`.bat` shim is started as `cmd.exe /d /s /c <command line>`, so cmd.exe
// re-parses the whole line. Everything that reaches it therefore has to be quoted
// against cmd's metacharacters, not just against whitespace:
//
//  - a project at `...\R&D project` yields `--session ...\--d--...-r&d project--\x.jsonl`
//    (`SessionIdentity` derives the session directory from the project path);
//  - `extensions:install` forwards a renderer-supplied source verbatim;
//  - `extensions:list` forwards an installed package name to `npm view`.
//
// The assertions are public-boundary only: what the child process actually received.
// No test needs an attacker — the literal payload is a harmless marker file that only
// appears if cmd.exe executes the text after `&`.

const executable = resolveBackendExecutable();
const RESOURCES = join(process.cwd(), "resources");
const slash = (value) => String(value).replaceAll("\\", "/");

/** Minimal pi session file: header + one user turn (importable by the catalog). */
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

/**
 * Copy a `.cmd` shim into a directory whose path carries cmd metacharacters.
 *
 * The shim body embeds an absolute script path, so a copy inside `R&D shims` still
 * runs the same fixture — it only changes the *command* part of the command line,
 * which is the branch where the oracle adds one extra outer quote pair.
 */
function shimIn(directory, sourceShim, name = "pi.cmd") {
	mkdirSync(directory, { recursive: true });
	const target = join(directory, name);
	copyFileSync(sourceShim, target);
	return target;
}

/** Write a Node-backed `npm` shim (the fixture records argv into FAKE_NPM_LOG). */
function npmShim(directory, scriptPath) {
	mkdirSync(directory, { recursive: true });
	const shim = join(directory, "npm.cmd");
	writeFileSync(shim, `@echo off\r\nnode "${scriptPath}" %*\r\n`);
	return shim;
}

/**
 * A literal that stays one argument when quoted and splits the command line when not.
 *
 * Deliberately whitespace-free: a space-only quote check would rescue a value with a
 * space in it, and the regression this suite pins is exactly "no whitespace, but a
 * metacharacter". `echo>file` writes an empty file, so the marker proves execution
 * without running anything destructive.
 */
function injectionLiteral(label, markerPath) {
	return `npm:${label}&echo>${markerPath}`;
}

if (executable) {
	describe("native2 cmd quoting parity", () => {
		let root;
		before(() => {
			root = mkdtempSync(join(tmpdir(), "pideck-native2-cmdquote-"));
		});
		after(() => {
			if (root) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
		});

		const directory = (label) => {
			const path = join(root, `${label}-${Math.random().toString(16).slice(2, 8)}`);
			mkdirSync(path, { recursive: true });
			return path;
		};

		test("a session launch through a .cmd shim keeps metacharacter paths as one argv", async (t) => {
			// Both the shim directory and the project/session directory carry `&`, `(`,
			// `)`, `+` and `=`; the project name additionally proves the cwd path does not
			// leak into the command line unquoted.
			const shimDir = join(root, "R&D shims (beta)");
			const projectPath = directory("R&D project (beta)");
			let fake = null;
			const session = await startBackendSession(t, {
				projects: [{ id: "cmdquote", path: projectPath }],
				settings: { language: "en-US" },
				prepare: (fixture) => {
					fake = createFakePi(fixture, {});
					return {
						settings: { customPiPath: shimIn(shimDir, fake.shim), piRuntimePreference: "auto" },
						env: {
							FAKE_PI_SCENARIO: fake.scenarioPath,
							FAKE_PI_LOG: fake.logPath,
							PIDECK_RESOURCES_PATH: RESOURCES,
						},
					};
				},
			});

			// The session file lives in a metacharacter directory too: `--session` is the
			// argument the launch itself synthesises, so it is the one that used to split.
			const sessionDir = join(session.fixture.sessions, "R&D sessions (beta)");
			mkdirSync(sessionDir, { recursive: true });
			const filePath = writeSessionFile(sessionDir, projectPath, `cmd-${Date.now()}`);
			const list = await session.invoke("sessions:catalog-list", ["cmdquote"]);
			assert.equal(list.payload.ok, true, JSON.stringify(list.payload));
			const record = list.payload.result.find((entry) => slash(entry.filePath) === slash(filePath));
			assert.ok(record, JSON.stringify(list.payload.result));
			const activated = await session.invoke("sessions:runtime-activate", [record.id]);
			assert.equal(activated.payload.ok, true, JSON.stringify(activated.payload));

			const spawn = fake.readLog().find((entry) => entry.kind === "spawn" && entry.argv.includes("--mode"));
			assert.ok(spawn, "pi must have been spawned through the .cmd shim");
			// Exact argv, not a substring check: a split at `&` would either truncate the
			// value or hand pi a different number of arguments.
			const sessionIndex = spawn.argv.indexOf("--session");
			assert.ok(sessionIndex > 0, JSON.stringify(spawn.argv));
			assert.equal(sessionIndex > 0, true, JSON.stringify(spawn.argv));
			// The backend normalises session paths to `/`, so compare in that form.
			assert.equal(slash(spawn.argv[sessionIndex + 1]), slash(filePath));
			assert.equal(spawn.argv.filter((argument) => argument.endsWith(".jsonl")).length, 1, JSON.stringify(spawn.argv));
			assert.equal(spawn.argv.filter((argument) => argument === "--mode").length, 1);
			assert.equal(spawn.argv[spawn.argv.indexOf("--mode") + 1], "rpc");
			// Every `--extension` value the launch injected must still be a real file path:
			// a truncated command line would leave a fragment that does not exist.
			const extensionPaths = [];
			for (let index = 0; index < spawn.argv.length; index += 1) {
				if (spawn.argv[index] === "--extension") extensionPaths.push(spawn.argv[index + 1]);
			}
			assert.ok(extensionPaths.length > 0, JSON.stringify(spawn.argv));
			for (const extensionPath of extensionPaths) {
				assert.equal(existsSync(extensionPath), true, `${extensionPath} must be one intact argument`);
			}
		});

		test("extensions:install passes a cmd-metacharacter source through as one argument", async (t) => {
			const home = directory("home");
			mkdirSync(join(home, ".pi", "agent", "extensions"), { recursive: true });
			const script = resolve("tests/fixtures/native2-fake-pi-cli.mjs");
			// The shim itself sits in a metacharacter directory: both the command and the
			// renderer-supplied argument have to be quoted on the same line.
			const shimDir = join(root, "R&D pi bin");
			mkdirSync(shimDir, { recursive: true });
			const shim = join(shimDir, "pi.cmd");
			writeFileSync(shim, `@echo off\r\nnode "${script}" %*\r\n`);
			const statePath = join(home, "fake-pi-state.json");
			writeFileSync(statePath, JSON.stringify({ calls: [], packages: [] }));
			const marker = join(root, "injected-install.txt");
			const payload = injectionLiteral("probe", marker);

			const session = await startBackendSession(t, {
				settings: { language: "en-US" },
				env: {
					PIDECK_HOME: home,
					PIDECK_HOST_HOME: home,
					PIDECK_FAKE_PI_STATE: statePath,
				},
				prepare: () => ({
					settings: { customPiPath: shim, piRuntimePreference: "auto" },
				}),
			});

			const installed = await session.invoke("extensions:install", [payload]);
			assert.equal(installed.payload.ok, true, JSON.stringify(installed.payload));

			const calls = JSON.parse(readFileSync(statePath, "utf8")).calls;
			assert.ok(
				calls.some((call) => call[0] === "install" && call.length === 2 && call[1] === payload),
				`the CLI must receive the source verbatim: ${JSON.stringify(calls)}`,
			);
			assert.equal(
				calls.some((call) => call[0] === "install" && call[1] !== payload),
				false,
				`the source must never be truncated at "&": ${JSON.stringify(calls)}`,
			);
			// The safe marker: cmd.exe only creates it if the text after `&` was executed.
			assert.equal(existsSync(marker), false, "cmd.exe must not execute the tail after `&`");
		});

		test("extensions:list hands a metacharacter npm package to `npm view` as one argument", async (t) => {
			const home = directory("home");
			mkdirSync(join(home, ".pi", "agent", "extensions"), { recursive: true });
			const npmDir = join(root, "R&D npm bin");
			const npmScript = join(npmDir, "fake-npm.mjs");
			mkdirSync(npmDir, { recursive: true });
			copyFileSync(resolve("tests/fixtures/native2-fake-npm.mjs"), npmScript);
			npmShim(npmDir, npmScript);
			const npmLog = join(npmDir, "npm.log");
			const npmScenario = join(npmDir, "npm-scenario.json");
			writeFileSync(npmScenario, JSON.stringify({ installStdout: "9.9.9\n" }));

			const marker = join(root, "injected-npm-view.txt");
			const payload = injectionLiteral("probe", marker);
			const packageName = payload.slice("npm:".length);

			// `pi list` reports the package; a forced list then enriches it through
			// `npm view <pkg> version` (`ExtensionManager::enrichVersion`).
			const cliScript = resolve("tests/fixtures/native2-fake-pi-cli.mjs");
			const piShimDir = join(root, "R&D pi cli");
			mkdirSync(piShimDir, { recursive: true });
			const piShim = join(piShimDir, "pi.cmd");
			writeFileSync(piShim, `@echo off\r\nnode "${cliScript}" %*\r\n`);
			const statePath = join(home, "fake-pi-state.json");
			writeFileSync(
				statePath,
				JSON.stringify({ calls: [], packages: [{ source: payload, scope: "user", path: "" }] }),
			);

			// `npm` is resolved from PATH (the backend's sanitized env), exactly like the
			// production call: only the fixture directory is prepended.
			const pathValue = [qtBinDirectory(), npmDir, process.env.PATH].filter(Boolean).join(";");
			const session = await startBackendSession(t, {
				settings: { language: "en-US" },
				env: {
					PATH: pathValue,
					Path: pathValue,
					PIDECK_HOME: home,
					PIDECK_HOST_HOME: home,
					PIDECK_FAKE_PI_STATE: statePath,
					FAKE_NPM_LOG: npmLog,
					FAKE_NPM_SCENARIO: npmScenario,
				},
				prepare: () => ({
					settings: { customPiPath: piShim, piRuntimePreference: "auto" },
				}),
			});

			const list = await session.invoke("extensions:list", [true]);
			assert.equal(list.payload.ok, true, JSON.stringify(list.payload));
			const entry = list.payload.result.extensions.find((extension) => extension.source === payload);
			assert.ok(entry, JSON.stringify(list.payload.result.extensions));
			assert.equal(entry.latestVersion, "9.9.9");

			const npmCalls = existsSync(npmLog)
				? readFileSync(npmLog, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line))
				: [];
			const view = npmCalls.find((call) => call.argv[0] === "view");
			assert.ok(view, JSON.stringify(npmCalls));
			assert.deepEqual(view.argv, ["view", packageName, "version"]);
			// `npm view` also runs once when the list enriches versions; the payload must
			// never be cut at `&` and must never produce a second command.
			assert.equal(npmCalls.every((call) => call.argv[1] === packageName), true, JSON.stringify(npmCalls));
			assert.equal(existsSync(marker), false, "cmd.exe must not execute the tail after `&`");
		});
	});
} else {
	describe("native2 cmd quoting parity", () => {
		test("requires a built backend", (t) => {
			t.skip("PiDeckBackend.exe is not built");
		});
	});
}
