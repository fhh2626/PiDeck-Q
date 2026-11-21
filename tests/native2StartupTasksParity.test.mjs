import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import {
	SseClient,
	createFakePi,
	resolveBackendExecutable,
	startBackendSession,
} from "./helpers/native2BackendHarness.mjs";

/**
 * Native backend startup tasks and persisted migration contracts.
 *
 * Every test drives the real `PiDeckBackend.exe` through the real host bridge and the
 * loopback RPC/SSE endpoints, so a pass is behavioural evidence rather than a structural
 * assertion.
 *
 * Hermeticity: `PIDECK_HOME` / `PIDECK_HOST_HOME` point inside the fixture, pi is always
 * the scripted fake, and WSL is a fake `wsl` shim backed by a real temporary directory
 * (`PIDECK_WSL_EXE` + `PIDECK_WSL_UNC_ROOT`). No real distro and no user profile is read.
 */

const executable = resolveBackendExecutable();
const slash = (value) => String(value).replaceAll("\\", "/");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check, message, timeoutMs = 15_000) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = await check();
		if (value) return value;
		if (Date.now() > deadline) throw new Error(message);
		await sleep(100);
	}
}

/** A fake `wsl` (`.cmd` shim over the node fixture) plus its scenario/log files. */
function writeFakeWsl(fixture) {
	const directory = join(fixture.root, "fake-wsl");
	mkdirSync(directory, { recursive: true });
	const script = join(process.cwd(), "tests/fixtures/native2-fake-wsl-fs.mjs");
	const shim = join(directory, process.platform === "win32" ? "wsl.cmd" : "wsl.sh");
	writeFileSync(
		shim,
		process.platform === "win32"
			? `@echo off\r\nnode "${script}" %*\r\n`
			: `#!/bin/sh\nexec node "${script}" "$@"\n`,
	);
	if (process.platform !== "win32") chmodSync(shim, 0o755);
	const scenarioPath = join(directory, "scenario.json");
	return {
		shim,
		scenarioPath,
		logPath: join(directory, "wsl.log"),
		writeScenario: (scenario) => writeFileSync(scenarioPath, JSON.stringify(scenario)),
	};
}

/** `<uncRoot>/<distro>/home/<user>/.pi/agent` plus the directories startup touches. */
function prepareWslHome(uncRoot, { distro = "Ubuntu", linuxHome = "/home/dev" } = {}) {
	const agentDir = join(uncRoot, distro, ...linuxHome.split("/").filter(Boolean), ".pi", "agent");
	for (const name of ["prompts", "skills", "extensions", "sessions"]) {
		mkdirSync(join(agentDir, name), { recursive: true });
	}
	return { agentDir, distro, linuxHome, windowsHome: slash(join(uncRoot, distro, ...linuxHome.split("/").filter(Boolean))) };
}

function writeMarkdownTemplate(directory, name, description) {
	mkdirSync(directory, { recursive: true });
	writeFileSync(join(directory, `${name}.md`), `---\ndescription: ${description}\n---\n\nBody for ${name}\n`);
}

function writeSkill(directory, name, description) {
	mkdirSync(join(directory, name), { recursive: true });
	writeFileSync(
		join(directory, name, "SKILL.md"),
		`---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`,
	);
}

/** Minimal pi session (header + one turn); the scanner only needs the header to summarize. */
function writeSessionFile(sessionsDir, directoryToken, { id, cwd, text }) {
	const directory = join(sessionsDir, directoryToken);
	mkdirSync(directory, { recursive: true });
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
	writeFileSync(join(directory, `${id}.jsonl`), `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
}

/** Concatenated application log lines (structured JSONL written by the backend). */
function appLogText(userData) {
	const directory = join(userData, "logs");
	if (!existsSync(directory)) return "";
	return readdirSync(directory)
		.filter((name) => name.endsWith(".log"))
		.map((name) => readFileSync(join(directory, name), "utf8"))
		.join("\n");
}

/** `C:\work\app` -> `/mnt/c/work/app`, the cwd pi records inside a distro. */
function wslRuntimePath(windowsPath) {
	return slash(windowsPath).replace(/^([A-Za-z]):\//, (_match, drive) => `/mnt/${drive.toLowerCase()}/`);
}

async function replayClient(t, baseUrl, token) {
	const client = new SseClient(`${baseUrl}__pideck/events?token=${encodeURIComponent(token)}&lastEventId=0`);
	await client.connect();
	t.after(() => client.close());
	return client;
}

describe("native2 backend startup tasks", () => {
	test("publishes the environment-filtered project snapshot", async (t) => {
		const session = await startBackendSession(t, {
			settings: { wslEnabled: false },
			projects: [],
			prepare: (fixture) => {
				const localHome = join(fixture.root, "local-home");
				const fakePi = createFakePi(fixture, { version: "0.79.0" });
				// The shared fixture helper always writes "windows", so the mixed-environment
				// catalog is written here instead of widening the read-only helper.
				writeFileSync(
					join(fixture.userData, "projects.json"),
					JSON.stringify([
						{ id: "win-project", name: "windows", path: slash(join(process.cwd(), "native")), lastOpenedAt: 1_700_000_000_000, sortOrder: 0, environment: "windows" },
						{ id: "wsl-project", name: "wsl-only", path: slash(join(process.cwd(), "src")), lastOpenedAt: 1_700_000_000_001, sortOrder: 1, environment: "wsl" },
					]),
				);
				return {
					settings: { customPiPath: fakePi.shim },
					env: { PIDECK_HOME: localHome, PIDECK_HOST_HOME: localHome },
				};
			},
		});

		const sse = await replayClient(t, session.baseUrl, session.token);
		const frame = await sse.waitFor(
			(candidate) =>
				candidate.payload.channel === "projects:changed" && Array.isArray(candidate.payload.args?.[0]),
		);
		const ids = frame.payload.args[0].map((project) => project.id);
		assert.ok(ids.includes("win-project"), "a Windows project stays visible");
		assert.ok(!ids.includes("wsl-project"), "a WSL project is hidden while WSL is off");
		assert.ok(ids.includes("builtin-chat"), "the chat project is always visible");
	});

	test("ignores the retired RPC timeout when loading and saving desktop settings", async (t) => {
		const session = await startBackendSession(t, {
			settings: { rpcTimeout: 900_000, maxEditorFileSizeMB: 11 },
		});
		const read = await session.invoke("settings:get");
		assert.equal(read.payload.ok, true);
		assert.equal(Object.hasOwn(read.payload.result, "rpcTimeout"), false);
		assert.equal(read.payload.result.maxEditorFileSizeMB, 11);

		const saved = await session.invoke("settings:update", [{ rpcTimeout: 1_200_000, maxEditorFileSizeMB: 12 }]);
		assert.equal(saved.payload.ok, true);
		const settings = JSON.parse(readFileSync(join(session.fixture.userData, "settings.json"), "utf8"));
		assert.equal(Object.hasOwn(settings, "rpcTimeout"), false);
		assert.equal(settings.maxEditorFileSizeMB, 12);
	});

	test("resolves WSL once and switches prompts, skills, pi config and the session scanner", async (t) => {
		const state = { wsl: null };
		const session = await startBackendSession(t, {
			settings: { wslEnabled: false },
			projects: [{ id: "native-project", path: slash(process.cwd()) }],
			hostHandlers: {
				"dialog.open": () => ({ result: { canceled: false, filePaths: [state.projectPath] } }),
			},
			prepare: (fixture) => {
				const fakePi = createFakePi(fixture, { version: "0.79.0" });
				const fakeWsl = writeFakeWsl(fixture);
				const localHome = join(fixture.root, "local-home");
				const uncRoot = join(fixture.root, "wsl-unc");
				const wsl = prepareWslHome(uncRoot);
				state.wsl = wsl;
				// The host file picker returns a host absolute path. Windows retains its
				// drive-to-/mnt assertion, while POSIX needs a real absolute project root.
				state.projectPath = process.platform === "win32" ? "C:\\work\\app" : join(fixture.root, "wsl-project");
				if (process.platform !== "win32") mkdirSync(state.projectPath, { recursive: true });
				writeMarkdownTemplate(join(localHome, ".pi/agent/prompts"), "local-only", "local template");
				writeSkill(join(localHome, ".pi/agent/skills"), "local-skill", "local skill");
				mkdirSync(join(localHome, ".pi/agent"), { recursive: true });
				writeMarkdownTemplate(join(wsl.agentDir, "prompts"), "wsl-only", "wsl template");
				writeSkill(join(wsl.agentDir, "skills"), "wsl-skill", "wsl skill");
				writeFileSync(
					join(wsl.agentDir, "models.json"),
					JSON.stringify({ providers: { "wsl-provider": { models: [{ id: "wsl-model" }] } } }),
				);
				writeSessionFile(join(wsl.agentDir, "sessions"), "--mnt-c-work-app--", {
					id: "wsl-session",
					cwd: wslRuntimePath(state.projectPath),
					text: "hello from wsl",
				});
				fakeWsl.writeScenario({
					root: join(uncRoot, "Ubuntu", "home", "dev"),
					linuxHome: "/home/dev",
					home: "/home/dev",
					distros: ["Ubuntu"],
					piVersion: "0.79.0",
				});
				return {
					settings: { customPiPath: fakePi.shim, wslEnabled: true, wslDistro: "Ubuntu", wslUser: "dev" },
					env: {
						PIDECK_WSL_EXE: fakeWsl.shim,
						PIDECK_WSL_UNC_ROOT: uncRoot,
						PIDECK_HOST_HOME: localHome,
						PIDECK_HOME: localHome,
						FAKE_WSL_SCENARIO: fakeWsl.scenarioPath,
						FAKE_WSL_LOG: fakeWsl.logPath,
					},
				};
			},
		});
		const wsl = state.wsl;
		const wslAgent = `${wsl.windowsHome}/.pi/agent`;

		// Prompt templates follow the resolved WSL home; the local ones stop being served.
		const prompts = await waitFor(async () => {
			const result = await session.invoke("prompts:list");
			return slash(result.payload.result?.globalDir) === `${wslAgent}/prompts` ? result.payload.result : null;
		}, "prompts:list never switched to the WSL home");
		const templateNames = prompts.templates.map((template) => template.name);
		assert.ok(templateNames.includes("wsl-only"), `expected the WSL template, got ${templateNames.join(",")}`);
		assert.ok(!templateNames.includes("local-only"), "the local template must not be served in WSL mode");

		// Both skill locations follow the same home.
		const skills = (await session.invoke("skills:list")).payload.result;
		assert.deepEqual(
			skills.locations.map((location) => slash(location.path)),
			[`${wslAgent}/skills`, `${wsl.windowsHome}/.agents/skills`],
		);
		const skillNames = skills.skills.map((skill) => skill.name);
		assert.ok(skillNames.includes("wsl-skill"));
		assert.ok(!skillNames.includes("local-skill"));

		// pi config (models.json → thinking levels) is read through the WSL agent directory.
		const models = (await session.invoke("config:get-models")).payload.result;
		assert.deepEqual(models.parsed, { providers: { "wsl-provider": { models: [{ id: "wsl-model" }] } } });

		// The scanner reads the distro through wsl.exe, and the project path is compared in
		// its /mnt form, so a WSL session matches a Windows project record.
		const added = await session.invoke("projects:add");
		assert.equal(slash(added.payload.result?.path), slash(state.projectPath));
		const records = await waitFor(async () => {
			const result = await session.invoke("sessions:catalog-list", [added.payload.result.id]);
			return result.payload.result?.length ? result.payload.result : null;
		}, "the WSL session was never scanned");
		assert.match(slash(records[0].filePath), /wsl-session\.jsonl$/);
		assert.match(records[0].id, /^[0-9a-f-]{36}$/);
		assert.match(appLogText(session.fixture.userData), /WSL environment configured/);
	});

	test("falls back to the compatibility home when printenv HOME fails, and still switches", async (t) => {
		const state = { wsl: null };
		const session = await startBackendSession(t, {
			settings: { wslEnabled: false },
			projects: [{ id: "native-project", path: slash(process.cwd()) }],
			prepare: (fixture) => {
				const fakePi = createFakePi(fixture, { version: "0.79.0" });
				const fakeWsl = writeFakeWsl(fixture);
				const localHome = join(fixture.root, "local-home");
				const uncRoot = join(fixture.root, "wsl-unc");
				const wsl = prepareWslHome(uncRoot);
				state.wsl = wsl;
				writeMarkdownTemplate(join(wsl.agentDir, "prompts"), "wsl-only", "wsl template");
				fakeWsl.writeScenario({
					root: join(uncRoot, "Ubuntu", "home", "dev"),
					linuxHome: "/home/dev",
					homeExit: 1,
					distros: ["Ubuntu"],
				});
				return {
					settings: { customPiPath: fakePi.shim, wslEnabled: true, wslDistro: "Ubuntu", wslUser: "dev" },
					env: {
						PIDECK_WSL_EXE: fakeWsl.shim,
						PIDECK_WSL_UNC_ROOT: uncRoot,
						PIDECK_HOST_HOME: localHome,
						PIDECK_HOME: localHome,
						FAKE_WSL_SCENARIO: fakeWsl.scenarioPath,
						FAKE_WSL_LOG: fakeWsl.logPath,
					},
				};
			},
		});
		await waitFor(async () => {
			const result = await session.invoke("prompts:list");
			return slash(result.payload.result?.globalDir) === `${state.wsl.windowsHome}/.pi/agent/prompts`;
		}, "the fallback home was not applied to the prompt root");
		await waitFor(
			() => Promise.resolve(appLogText(session.fixture.userData).includes("using the compatibility fallback")),
			"the compatibility fallback was not logged",
		);
	});

	test("removes PiDeck-owned legacy copies, backs up fingerprinted entries and preserves unknown files", async (t) => {
		const state = {};
		const session = await startBackendSession(t, {
			settings: { wslEnabled: false },
			projects: [{ id: "native-project", path: slash(process.cwd()) }],
			prepare: (fixture) => {
				const fakePi = createFakePi(fixture, { version: "0.79.0" });
				const fakeWsl = writeFakeWsl(fixture);
				const localHome = join(fixture.root, "local-home");
				const localAgent = join(localHome, ".pi/agent");
				mkdirSync(join(localAgent, "extensions"), { recursive: true });
				// PiDeck-owned names are removed by name; a same-named user file is not.
				writeFileSync(join(localAgent, "extensions", "pideck-q-ask-question.ts"), "// stale built-in\n");
				writeFileSync(join(localAgent, "extensions", "pi-deck-file-capture.ts"), "// long gone\n");
				writeFileSync(join(localAgent, "extensions", "pideck-q-context-controller.ts"), "// retired\n");
				writeFileSync(
					join(localAgent, "extensions", "change-pi-prompt.ts"),
					"import { spawnSync } from 'node:child_process';\n// user-owned implementation\n",
				);
				const uncRoot = join(fixture.root, "wsl-unc");
				const wsl = prepareWslHome(uncRoot);
				// The self-use shim PiDeck used to write: fingerprinted, so it is backed up and
				// removed. A same-named backup already exists, which forces a suffixed name.
				writeFileSync(
					join(wsl.agentDir, "extensions", "change-pi-prompt.ts"),
					[
						"import { registerPromptExtension } from './change-pi-prompt/runtime.ts';",
						"// Pi prompt replacement extension",
						"export default registerPromptExtension;",
					].join("\n"),
				);
				mkdirSync(join(wsl.agentDir, "pideck-backups", "0.4.3"), { recursive: true });
				writeFileSync(join(wsl.agentDir, "pideck-backups", "0.4.3", "change-pi-prompt.ts"), "// older backup\n");
				state.localAgent = localAgent;
				state.wslAgent = wsl.agentDir;
				fakeWsl.writeScenario({
					root: join(uncRoot, "Ubuntu", "home", "dev"),
					linuxHome: "/home/dev",
					home: "/home/dev",
					distros: ["Ubuntu"],
				});
				return {
					settings: { customPiPath: fakePi.shim, wslEnabled: true, wslDistro: "Ubuntu", wslUser: "dev" },
					env: {
						PIDECK_WSL_EXE: fakeWsl.shim,
						PIDECK_WSL_UNC_ROOT: uncRoot,
						PIDECK_HOST_HOME: localHome,
						PIDECK_HOME: localHome,
						FAKE_WSL_SCENARIO: fakeWsl.scenarioPath,
						FAKE_WSL_LOG: fakeWsl.logPath,
					},
				};
			},
		});
		const { localAgent, wslAgent } = state;
		await waitFor(
			() => Promise.resolve(!existsSync(join(localAgent, "extensions", "pideck-q-ask-question.ts"))),
			"the stale built-in copy was not removed",
		);
		assert.ok(!existsSync(join(localAgent, "extensions", "pi-deck-file-capture.ts")));
		assert.ok(!existsSync(join(localAgent, "extensions", "pideck-q-context-controller.ts")));
		assert.ok(existsSync(join(localAgent, "extensions", "change-pi-prompt.ts")), "an unknown file must stay");

		await waitFor(
			() => Promise.resolve(!existsSync(join(wslAgent, "extensions", "change-pi-prompt.ts"))),
			"the fingerprinted legacy entry was not migrated",
		);
		const backupDir = join(wslAgent, "pideck-backups", "0.4.3");
		const backups = readdirSync(backupDir);
		assert.ok(backups.includes("change-pi-prompt.ts"), "the previous backup is kept");
		const migrated = backups.filter((name) => /^change-pi-prompt\.\d+(-\d+)?\.ts$/.test(name));
		assert.equal(migrated.length, 1, `expected exactly one suffixed backup, got ${backups.join(",")}`);
		assert.match(readFileSync(join(backupDir, migrated[0]), "utf8"), /registerPromptExtension/);

		// Files are migrated on the domain worker before its completion is delivered
		// to the owner thread. Wait for that notification rather than reading a
		// partial diagnostic snapshot as soon as the source file disappears.
		const log = await waitFor(() => {
			const text = appLogText(session.fixture.userData);
			return /Removed legacy\/stale extension/.test(text)
				&& /Backed up legacy built-in extension entry/.test(text)
				&& /Legacy extension entry left in place/.test(text) ? text : false;
		}, "the migration completion was not delivered");
		assert.match(log, /Removed legacy\/stale extension/);
		assert.match(log, /Backed up legacy built-in extension entry/);
		assert.match(log, /Legacy extension entry left in place/);
	});

	test("fills pi settings.json defaults and keeps user values", async (t) => {
		const state = {};
		const session = await startBackendSession(t, {
			settings: { wslEnabled: false },
			projects: [{ id: "native-project", path: slash(process.cwd()) }],
			prepare: (fixture) => {
				const fakePi = createFakePi(fixture, { version: "0.79.0" });
				const localHome = join(fixture.root, "local-home");
				const localAgent = join(localHome, ".pi/agent");
				mkdirSync(localAgent, { recursive: true });
				writeFileSync(
					join(localAgent, "settings.json"),
					JSON.stringify({
						theme: "light",
						hideThinkingBlock: true,
						lastChangelogVersion: "0.70.0",
					}),
				);
				state.localAgent = localAgent;
				return {
					settings: { customPiPath: fakePi.shim },
					env: { PIDECK_HOME: localHome, PIDECK_HOST_HOME: localHome },
				};
			},
		});
		const settingsPath = join(state.localAgent, "settings.json");
		await waitFor(
			() => Promise.resolve(appLogText(session.fixture.userData).includes("Pi settings defaults check completed")),
			"startup never completed the pi settings defaults pass",
		);
		const piSettings = JSON.parse(readFileSync(settingsPath, "utf8"));
		assert.equal(piSettings.theme, "light", "an existing user value wins");
		assert.equal(piSettings.hideThinkingBlock, true);
		// Startup must not fork pi for a version hint, so an already stored value survives
		// untouched instead of being rewritten from a probe.
		assert.equal(piSettings.lastChangelogVersion, "0.70.0");
		assert.equal(Object.hasOwn(piSettings, "defaultProjectTrust"), false);
		assert.deepEqual(piSettings.compaction, { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 });
		assert.deepEqual(piSettings.retry, { enabled: true, maxRetries: 3 });

		// The configured command still answers `pi --version` for the installer UI.
		const check = await session.invoke("pi:check");
		assert.equal(check.payload.result?.version, "0.79.0");

		// A home that never ran pi has no settings.json. Startup must not create one: pi seeds
		// its own defaults on first launch, and "the file was never written" has to stay
		// observable for `config:get-settings`.
		const bareHome = join(session.fixture.root, "bare-home");
		mkdirSync(join(bareHome, ".pi/agent"), { recursive: true });
		const bare = await startBackendSession(t, {
			settings: { wslEnabled: false },
			projects: [{ id: "bare-project", path: slash(process.cwd()) }],
			env: { PIDECK_HOME: bareHome, PIDECK_HOST_HOME: bareHome },
		});
		const bareSettings = join(bareHome, ".pi/agent/settings.json");
		await waitFor(
			() => Promise.resolve(appLogText(bare.fixture.userData).includes("Pi settings defaults check completed")),
			"startup never completed the pi settings defaults pass",
		);
		assert.equal(existsSync(bareSettings), false, "startup must not create pi's settings.json");
	});

	test("prewarms every project catalog in the background and keeps scan:false read-only", async (t) => {
		const state = {};
		const session = await startBackendSession(t, {
			settings: { wslEnabled: false },
			projects: [{ id: "warm", path: slash(process.cwd()) }],
			prepare: (fixture) => {
				const fakePi = createFakePi(fixture, { version: "0.79.0" });
				const localHome = join(fixture.root, "local-home");
				state.sessionsDir = fixture.sessions;
				state.projectPath = slash(process.cwd());
				writeSessionFile(fixture.sessions, "--first--", {
					id: "first-session",
					cwd: state.projectPath,
					text: "one",
				});
				return {
					settings: { customPiPath: fakePi.shim },
					env: { PIDECK_HOME: localHome, PIDECK_HOST_HOME: localHome },
				};
			},
		});
		const sse = new SseClient(`${session.baseUrl}__pideck/events?token=${encodeURIComponent(session.token)}`);
		await sse.connect();
		t.after(() => sse.close());
		const refreshProjectIds = () =>
			sse.frames
				.filter((frame) => frame.payload.channel === "sessions:catalog-refreshed")
				.map((frame) => frame.payload.args?.[0]?.projectId);

		// Nobody asked for a list: the startup prewarm scans the project by itself and pushes
		// the refresh, so the sidebar's first paint never waits for a cold scan.
		await waitFor(
			() => Promise.resolve(refreshProjectIds().includes("warm")),
			"the startup prewarm never pushed sessions:catalog-refreshed",
			20_000,
		);
		const pushes = refreshProjectIds().length;

		// The merge is in the catalog, so a `scan:false` pull serves it without touching disk.
		const cached = await session.invoke("sessions:catalog-list", ["warm", { scan: false }]);
		assert.equal(cached.payload.ok, true, JSON.stringify(cached.payload));
		assert.deepEqual(cached.payload.result.map((record) => record.id).length, 1);
		assert.equal(slash(cached.payload.result[0].filePath).endsWith("first-session.jsonl"), true);

		// A file written after the merge must be invisible to the read-only pull...
		writeSessionFile(state.sessionsDir, "--second--", {
			id: "second-session",
			cwd: state.projectPath,
			text: "two",
		});
		const still = await session.invoke("sessions:catalog-list", ["warm", { scan: false }]);
		assert.equal(still.payload.result.length, 1, "scan:false must not scan on demand");
		// ...while a scanning request picks it up, so the poll cannot hide a new session.
		const scanned = await session.invoke("sessions:catalog-list", ["warm"]);
		assert.equal(scanned.payload.result.length, 2, "a list request must scan");

		// `scan:false` is the renderer's answer to the push: it must never start a scan loop.
		await sleep(1_200);
		assert.equal(refreshProjectIds().length, pushes, "a scan:false pull must not schedule a scan");
	});
});
