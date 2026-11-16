import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import { resolveBackendExecutable, startBackendSession } from "./helpers/native2BackendHarness.mjs";
import { createSuiteProject, removeSuiteProject, sleep } from "./helpers/native2RuntimeEvents.mjs";

/**
 * WSL environment ownership: catalog identity + the `settings:update` switch.
 *
 * Oracle contract (`src/main/ipc/systemIpc.ts:667-695` + `backendStartupTasks`):
 *  - startup resolves the WSL environment once and points the scanner, the skill/prompt/
 *    extension managers and the pi config directory at it;
 *  - `settings:update` with `wslEnabled|wslDistro|wslUser` pushes the new identity into
 *    the session catalog (`setSessionCatalogIdentityContext`) *and* re-resolves the
 *    environment, reconfiguring those managers — or clearing them when WSL is turned off;
 *  - the identity is taken from the settings, so a record created while WSL is active
 *    carries `wslDistro`/`wslUser`. Without it the origin key falls back to
 *    `pi:wsl:unknown:unknown:…`, which no scan ever produces, so the same session file
 *    both keeps a stale record and gains a second one.
 *
 * The C++ backend only applied the startup half: `setIdentityContext` had no caller at
 * all and `settings:update` had no WSL branch, so switching distro left the skill library
 * and the catalog identity on the previous environment until a restart.
 *
 * Hermeticity: no real distribution. `PIDECK_WSL_EXE` is the native fake launcher, the
 * "distro" is a temporary directory behind `PIDECK_WSL_UNC_ROOT`, and the backing
 * filesystem answers only the commands the backend really issues.
 */

const REPO = process.cwd();
const BUILD_PLATFORM = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macosx" : process.platform;
const LAUNCHER_NAME = process.platform === "win32" ? "PiDeck-FakeWsl.exe" : "PiDeck-FakeWsl";
const LAUNCHER_CANDIDATES = [
	`build/${BUILD_PLATFORM}/${process.arch}/debug/${LAUNCHER_NAME}`,
	`build/${BUILD_PLATFORM}/${process.arch}/release/${LAUNCHER_NAME}`,
];
const LAUNCHER_SOURCE = "native/tests/FakeWslLauncher.cpp";
const FIXTURE = join(REPO, "tests/fixtures/native2-fake-wsl-fs.mjs");

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
const executable = resolveBackendExecutable();
const SLASH = (value) => String(value).replaceAll("\\", "/");
const PROJECT_ID = "wsl-settings";
const LINUX_HOME = "/home/dev";

const sleepUntil = async (predicate, timeoutMs, label) => {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = await predicate();
		if (value) return value;
		if (Date.now() > deadline) throw new Error(`${label} did not happen`);
		await sleep(50);
	}
};

/** `/mnt/d/work/app`: the cwd pi records inside a distro for a Windows project path. */
const wslRuntimePath = (windowsPath) => SLASH(windowsPath).replace(/^([A-Za-z]):\//, (_match, drive) => `/mnt/${drive.toLowerCase()}/`);

function writeSessionFile(path, cwd, id) {
	mkdirSync(path, { recursive: true });
	const entries = [
		{ type: "session", version: 3, id, timestamp: "2026-01-01T00:00:00.000Z", cwd },
		{
			type: "message",
			id: "u1",
			parentId: null,
			timestamp: "2026-01-01T00:00:01.000Z",
			message: { role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1_767_225_601_000 },
		},
	];
	writeFileSync(join(path, `${id}.jsonl`), `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
}

function writeSkill(home, name) {
	const directory = join(home, ".pi", "agent", "skills", name);
	mkdirSync(directory, { recursive: true });
	writeFileSync(
		join(directory, "SKILL.md"),
		`---\nname: ${name}\ndescription: ${name} skill\n---\n\nbody\n`,
	);
}

function appLogText(userData) {
	const directory = join(userData, "logs");
	if (!existsSync(directory)) return "";
	return readdirSync(directory)
		.filter((name) => name.endsWith(".log"))
		.map((name) => readFileSync(join(directory, name), "utf8"))
		.join("\n");
}

if (!executable || !launcher) {
	describe("native2 WSL settings ownership", () => {
		test("backend and fake wsl launcher are available", () => {
			assert.fail(
				`missing prerequisites (backend=${executable || "none"}, fakeWsl=${launcher || "none"}); ` +
					`run "PIDECK_STAGE_DIR=build/native2-validation-unpacked xmake build -y PiDeckBackend PiDeck-FakeWsl"`,
			);
		});
	});
} else {
	describe("native2 WSL settings ownership", () => {
		let root;
		let projectPath;

		before(() => {
			({ root, projectPath } = createSuiteProject("pideck-native2-wslsettings-"));
		});

		after(() => {
			removeSuiteProject(root);
		});

		/**
		 * Backend + fake distro. `settings` is what the fixture's settings.json starts
		 * with; a test flips WSL on with `settings:update` afterwards.
		 */
		const startWslBackend = async (t, { settings = {} } = {}) => {
			const state = {};
			const session = await startBackendSession(t, {
				projects: [{ id: PROJECT_ID, path: projectPath }],
				settings: { language: "en-US", ...settings },
				prepare: (fixture) => {
					const uncRoot = join(fixture.root, "wsl-unc");
					const distroHome = (distro) => join(uncRoot, distro, ...LINUX_HOME.split("/").filter(Boolean));
					for (const distro of ["Ubuntu", "Debian"]) {
						for (const name of ["", "sessions", "prompts", "skills", "extensions"]) {
							mkdirSync(join(distroHome(distro), ".pi", "agent", name), { recursive: true });
						}
						writeSkill(distroHome(distro), `${distro.toLowerCase()}-only`);
					}
					// One WSL session file whose cwd matches what pi records inside a distro.
					writeSessionFile(
						join(distroHome("Ubuntu"), ".pi", "agent", "sessions", "--wsl-proj--"),
						wslRuntimePath(projectPath),
						"wsl-session",
					);
					// The local environment keeps its own skill and session so a switch off is
					// observable in the same list channels.
					const localHome = join(fixture.root, "local-home");
					writeSkill(localHome, "local-only");
					writeSessionFile(join(fixture.sessions, "--local-proj--"), projectPath, "local-session");

					const scenarioPath = join(fixture.root, "fake-wsl-scenario.json");
					const logPath = join(fixture.root, "fake-wsl.log");
					writeFileSync(
						scenarioPath,
						JSON.stringify({
							root: distroHome("Ubuntu"),
							linuxHome: LINUX_HOME,
							home: LINUX_HOME,
							distros: ["Ubuntu", "Debian"],
						}),
					);
					Object.assign(state, { uncRoot, distroHome, scenarioPath, logPath, fixtureRoot: fixture.root });
					return {
						env: {
							PIDECK_WSL_EXE: launcher,
							PIDECK_WSL_UNC_ROOT: uncRoot,
							PIDECK_HOST_HOME: localHome,
							PIDECK_HOME: localHome,
							FAKE_WSL_SCRIPT: FIXTURE,
							FAKE_WSL_NODE: process.execPath,
							FAKE_WSL_SCENARIO: scenarioPath,
							FAKE_WSL_LOG: logPath,
						},
					};
				},
			});
			return { session, state };
		};

		const skillNames = async (invoke) => {
			const listed = await invoke("skills:list");
			assert.equal(listed.payload.ok, true, JSON.stringify(listed.payload));
			return (listed.payload.result?.skills ?? []).map((skill) => skill.name).sort();
		};

		const sessionStems = async (invoke) => {
			const listed = await invoke("sessions:list", [PROJECT_ID]);
			assert.equal(listed.payload.ok, true, JSON.stringify(listed.payload));
			return (listed.payload.result ?? [])
				.map((record) => String(record.filePath).split(/[\\/]/).at(-1).replace(/\.jsonl$/, ""))
				.sort();
		};

		const draft = async (invoke) => {
			const created = await invoke("sessions:catalog-create-draft", [{ projectId: PROJECT_ID }]);
			assert.equal(created.payload.ok, true, JSON.stringify(created.payload));
			return created.payload.result;
		};

		/**
		 * CAT-3: a draft created while WSL is active carries the distro/user identity.
		 *
		 * That pair is what the origin key is built from; an empty identity produces
		 * `pi:wsl:unknown:unknown:…`, which no scan can ever match.
		 */
		test("startup publishes the WSL identity to the session catalog", async (t) => {
			const { session } = await startWslBackend(t, {
				settings: { wslEnabled: true, wslDistro: "Ubuntu", wslUser: "dev" },
			});
			await sleepUntil(
				() => appLogText(session.fixture.userData).includes("WSL environment configured"),
				20_000,
				"the startup WSL resolution",
			);
			const record = await draft(session.invoke);
			assert.equal(record.environment, "wsl", JSON.stringify(record));
			assert.equal(record.wslDistro, "Ubuntu", JSON.stringify(record));
			assert.equal(record.wslUser, "dev", JSON.stringify(record));
		});

		test("an explicit local WSL root maps the resolved home to the host directory", async (t) => {
			const { session, state } = await startWslBackend(t, {
				settings: { wslEnabled: true, wslDistro: "Ubuntu", wslUser: "dev" },
			});
			await sleepUntil(() => appLogText(session.fixture.userData).includes("WSL environment configured"),
				20_000, "the startup WSL resolution");
			const listed = await session.invoke("prompts:list");
			assert.equal(listed.payload.ok, true, JSON.stringify(listed.payload));
			const expected = join(state.distroHome("Ubuntu"), ".pi", "agent", "prompts");
			const actual = listed.payload.result.globalDir;
			// POSIX backslashes are literal filename bytes, so normalizing them in this
			// assertion would hide a mapper that points the managers at another directory.
			assert.equal(process.platform === "win32" ? SLASH(actual) : actual,
				process.platform === "win32" ? SLASH(expected) : expected);
		});

		/**
		 * S2: `settings:update` must re-publish the environment immediately.
		 *
		 * Before the fix the RPC returned ok while the scanner and the skill library kept
		 * the startup environment, so the UI showed the new distro and the old distro's
		 * skills at the same time (until a restart).
		 */
		test("settings:update switches the scanner and the skill library to the new distro", async (t) => {
			const { session } = await startWslBackend(t, { settings: { wslEnabled: false } });
			const { invoke } = session;

			assert.deepEqual(await skillNames(invoke), ["local-only"]);
			assert.deepEqual(await sessionStems(invoke), ["local-session"]);

			const enabled = await invoke("settings:update", [
				{ wslEnabled: true, wslDistro: "Ubuntu", wslUser: "dev" },
			]);
			assert.equal(enabled.payload.ok, true, JSON.stringify(enabled.payload));
			assert.equal(enabled.payload.result.wslDistro, "Ubuntu");
			// The RPC only answers after the environment was published, so these reads are
			// the authoritative post-switch state.
			assert.deepEqual(await skillNames(invoke), ["ubuntu-only"]);
			assert.deepEqual(await sessionStems(invoke), ["wsl-session"]);
			const record = await draft(invoke);
			assert.equal(record.wslDistro, "Ubuntu", JSON.stringify(record));

			// A distro change re-resolves: the Debian home has its own skill library.
			const switched = await invoke("settings:update", [{ wslDistro: "Debian" }]);
			assert.equal(switched.payload.ok, true, JSON.stringify(switched.payload));
			assert.deepEqual(await skillNames(invoke), ["debian-only"]);
			const afterSwitch = await draft(invoke);
			assert.equal(afterSwitch.wslDistro, "Debian", JSON.stringify(afterSwitch));

			// Turning WSL off restores the local roots (oracle: the else-branch clears every
			// manager instead of keeping the previous distro's directories).
			const disabled = await invoke("settings:update", [{ wslEnabled: false }]);
			assert.equal(disabled.payload.ok, true, JSON.stringify(disabled.payload));
			assert.deepEqual(await skillNames(invoke), ["local-only"]);
			assert.deepEqual(await sessionStems(invoke), ["local-session"]);
			const localDraft = await draft(invoke);
			assert.equal(localDraft.environment, "native", JSON.stringify(localDraft));
			assert.equal(localDraft.wslDistro ?? null, null, JSON.stringify(localDraft));
		});

		/**
		 * The switch is owner-thread state publication, not a queued domain body.
		 *
		 * The WSL environment writes plain `QString`/`QVector` state (the pi config directory
		 * and the skill/prompt/extension locations) that every synchronous channel handler
		 * reads on the Qt owner thread. Applying it from the serial domain executor therefore
		 * raced those reads *and* put the switch behind unrelated blocking work: with a
		 * `wsl -l -q` still running on the executor, turning WSL off waited for it before the
		 * local roots were restored and the RPC was answered.
		 *
		 * The fixture holds the listing for 2.5 s, so a switch that queues behind it can be
		 * told apart from one that is published immediately.
		 */
		test("a WSL switch does not queue behind unrelated domain work", async (t) => {
			const { session, state } = await startWslBackend(t, {
				settings: { wslEnabled: true, wslDistro: "Ubuntu", wslUser: "dev" },
			});
			const { invoke } = session;
			await sleepUntil(
				() => appLogText(session.fixture.userData).includes("WSL environment configured"),
				20_000,
				"the startup WSL resolution",
			);
			assert.deepEqual(await skillNames(invoke), ["ubuntu-only"]);

			writeFileSync(
				state.scenarioPath,
				JSON.stringify({
					root: state.distroHome("Ubuntu"),
					linuxHome: LINUX_HOME,
					home: LINUX_HOME,
					distros: ["Ubuntu", "Debian"],
					listDelayMs: 2_500,
				}),
			);
			// Occupies the serial domain executor for the next 2.5 s.
			const busyListing = invoke("wsl:list-distros");
			await sleep(150);

			const startedAt = Date.now();
			const disabled = await invoke("settings:update", [{ wslEnabled: false }]);
			const elapsedMs = Date.now() - startedAt;
			assert.equal(disabled.payload.ok, true, JSON.stringify(disabled.payload));
			assert.ok(
				elapsedMs < 1_200,
				`the WSL switch queued behind unrelated domain work (${elapsedMs} ms)`,
			);
			// Published before the RPC answered: the local roots are already active.
			assert.deepEqual(await skillNames(invoke), ["local-only"]);
			await busyListing;
		});

		/**
		 * The newest request wins: two updates in flight must leave the second one applied,
		 * and the superseded environment must never be published.
		 *
		 * The old distro probe is slow (its `printenv HOME` sleeps), so a controller that
		 * applied results in completion order would end on the first distro. A controller
		 * that publishes before it notices the queued request would flash the replaced
		 * distro's skill library (one extra `wsl` app-log entry) while the user is looking
		 * at the new one.
		 */
		test("a slow older distro resolution cannot overwrite the newer settings", async (t) => {
			const { session, state } = await startWslBackend(t, { settings: { wslEnabled: false } });
			const { invoke } = session;
			writeFileSync(
				state.scenarioPath,
				JSON.stringify({
					root: state.distroHome("Ubuntu"),
					linuxHome: LINUX_HOME,
					home: LINUX_HOME,
					distros: ["Ubuntu", "Debian"],
					homeDelayMs: 900,
				}),
			);
			const first = invoke("settings:update", [{ wslEnabled: true, wslDistro: "Ubuntu", wslUser: "dev" }]);
			// Long enough for the Ubuntu probe to be running (and sleeping) when Debian is
			// requested, i.e. for the newer request to be queued behind it.
			await sleep(200);
			// The Debian probe is fast (the fixture only delays the answer it may already be
			// sleeping on, and the Ubuntu process is the one that took the delay).
			writeFileSync(
				state.scenarioPath,
				JSON.stringify({
					root: state.distroHome("Debian"),
					linuxHome: LINUX_HOME,
					home: LINUX_HOME,
					distros: ["Ubuntu", "Debian"],
				}),
			);
			const second = invoke("settings:update", [{ wslDistro: "Debian" }]);
			const [firstResult, secondResult] = await Promise.all([first, second]);
			assert.equal(firstResult.payload.ok, true, JSON.stringify(firstResult.payload));
			assert.equal(secondResult.payload.ok, true, JSON.stringify(secondResult.payload));
			// Both callers are answered, and the environment follows the newest settings.
			assert.deepEqual(await skillNames(invoke), ["debian-only"]);
			const record = await draft(invoke);
			assert.equal(record.wslDistro, "Debian", JSON.stringify(record));
			// Only the newest environment was published: the superseded Ubuntu probe was
			// dropped instead of being applied (and then overwritten) on the way.
			const published = appLogText(session.fixture.userData)
				.split("\n")
				.filter((line) => line.includes("WSL environment configured"))
				.map((line) => JSON.parse(line).detail.distro);
			assert.deepEqual(published, ["Debian"], `published environments: ${JSON.stringify(published)}`);
		});
	});
}
