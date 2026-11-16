import assert from "node:assert/strict";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, test } from "node:test";
import { joinPathParts, writeNodeShim } from "./helpers/native2FakeProcess.mjs";
import {
	qtBinDirectory,
	resolveBackendExecutable,
	startBackendSession,
} from "./helpers/native2BackendHarness.mjs";

/** Exercise native Pi discovery, installation and WSL contracts using local CLI fixtures. */
const executable = resolveBackendExecutable();
const isWindows = process.platform === "win32";

function readJsonLines(path) {
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

function baseSettings(extra = {}) {
	return {
		customPiPath: "",
		piTypescriptPath: "",
		piRustPath: "",
		piBoltPath: "",
		piRuntimePreference: "auto",
		wslEnabled: false,
		wslDistro: "Ubuntu",
		wslUser: "root",
		piRpcOffline: true,
		piProxyEnabled: false,
		piProxyUrl: "http://127.0.0.1:7890",
		piProxyBypass: "localhost,127.0.0.1,::1",
		language: "en-US",
		...extra,
	};
}

function wire(value) {
	return JSON.parse(JSON.stringify(value));
}

if (executable && isWindows) {
	describe("native2 pi install / WSL contracts", () => {
		let root;
		let home;
		let appData;
		let localAppData;
		let miseData;
		let piBin;
		let npmBin;
		let wslBin;
		let piScript;
		let previousPath;
		let realPath;
		let previousWslScenario;
		let previousWslLog;

		before(() => {
			root = mkdtempSync(join(tmpdir(), "pideck-native2-piinstall-"));
			home = join(root, "home");
			appData = join(root, "appdata");
			localAppData = join(root, "localappdata");
			miseData = join(root, "mise");
			for (const directory of [
				join(home, ".pi", "agent"),
				appData,
				localAppData,
				miseData,
			]) {
				mkdirSync(directory, { recursive: true });
			}
			piBin = join(root, "pi-bin");
			npmBin = join(root, "npm-bin");
			wslBin = join(root, "wsl-bin");
			mkdirSync(piBin, { recursive: true });
			mkdirSync(npmBin, { recursive: true });
			mkdirSync(wslBin, { recursive: true });

			piScript = join(piBin, "fake-pi.mjs");
			copyFileSync(resolve("tests/fixtures/native2-fake-pi-models.mjs"), piScript);
			copyFileSync(
				resolve("tests/fixtures/native2-fake-npm.mjs"),
				join(npmBin, "fake-npm.mjs"),
			);
			writeNodeShim(npmBin, "npm", join(npmBin, "fake-npm.mjs"));
			copyFileSync(
				resolve("tests/fixtures/native2-fake-wsl.mjs"),
				join(wslBin, "fake-wsl.mjs"),
			);
			// `shell: true` in the oracle's wsl exec inherits the real process PATH, so the
			// fixture directory has to be reachable there as well as in the backend env.
			previousPath = process.env.PATH;
			realPath = previousPath;
			process.env.PATH = joinPathParts([wslBin, npmBin, previousPath]);
			// The oracle's wsl probe inherits the real process environment (`execFile` without
			// an explicit env, like the production call), so the fixture has to be described
			// there too. The scenario file is rewritten per test at this stable path.
			previousWslScenario = process.env.FAKE_WSL_SCENARIO;
			previousWslLog = process.env.FAKE_WSL_LOG;
			process.env.FAKE_WSL_SCENARIO = join(wslBin, "scenario.json");
			process.env.FAKE_WSL_LOG = join(wslBin, "wsl.log");
			installWslFixture();
		});

		after(() => {
			if (previousPath !== undefined) process.env.PATH = previousPath;
			for (const [key, value] of [
				["FAKE_WSL_SCENARIO", previousWslScenario],
				["FAKE_WSL_LOG", previousWslLog],
			]) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
			if (root) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
		});

		const pathValue = () => joinPathParts([qtBinDirectory(), piBin, npmBin, wslBin, realPath]);

		function envFor(extra = {}) {
			const sharedPath = pathValue();
			return {
				PATH: sharedPath,
				Path: sharedPath,
				APPDATA: appData,
				LOCALAPPDATA: localAppData,
				MISE_DATA_DIR: miseData,
				MISE_INSTALL_PATH: "",
				MISE_INSTALLS_DIR: "",
				ComSpec: process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe",
				PIDECK_HOME: home,
				PIDECK_HOST_HOME: home,
				PIDECK_WSL_EXE: "wsl-fixture",
				// The WSL probe builds an explicit child environment, so the fixture
				// description must be in it (and in the real env for the `which` probe).
				FAKE_WSL_SCENARIO: join(wslBin, "scenario.json"),
				FAKE_WSL_LOG: join(wslBin, "wsl.log"),
				...extra,
			};
		}

		function writePiScenario(scenario) {
			const scenarioPath = join(piBin, "scenario.json");
			writeFileSync(scenarioPath, JSON.stringify(scenario));
			return scenarioPath;
		}

		function writeNpmScenario(scenario) {
			const scenarioPath = join(npmBin, "scenario.json");
			writeFileSync(scenarioPath, JSON.stringify(scenario));
			return scenarioPath;
		}

		function writeWslScenario(scenario) {
			const scenarioPath = join(wslBin, "scenario.json");
			writeFileSync(scenarioPath, JSON.stringify(scenario));
			return scenarioPath;
		}

		function truncate(...paths) {
			for (const path of paths) writeFileSync(path, "");
		}

		/** A `.cmd` shim for the fake `wsl`; both sides resolve it by bare name on PATH. */
		function installWslFixture() {
			const shim = writeNodeShim(wslBin, "wsl-fixture", join(wslBin, "fake-wsl.mjs"));
			assert.ok(existsSync(shim));
			return shim;
		}

		/** Start the backend and build the oracle against the identical environment. */
		async function startTest(t, { settings = {}, env = {} } = {}) {
			const finalSettings = baseSettings(settings);
			const finalEnv = envFor(env);
			const session = await startBackendSession(t, {
				settings: finalSettings,
				env: finalEnv,
			});

			return {
				session,
				invoke: (channel, args = []) => session.invoke(channel, args),
				backendSettings: () =>
					JSON.parse(readFileSync(join(session.fixture.userData, "settings.json"), "utf8")),
			};
		}

		test("pi:check matches the locator status byte for byte, including searchedDirs", async (t) => {
			installWslFixture();
			const scenarioPath = writePiScenario({ version: "1.2.3" });
			const shim = writeNodeShim(piBin, "pi", piScript);
			const { invoke } = await startTest(t, {
				settings: { piRuntimePreference: "typescript", piTypescriptPath: shim },
				env: { FAKE_PI_MODELS_SCENARIO: scenarioPath },
			});

			const actual = await invoke("pi:check");
			assert.equal(actual.payload.ok, true, JSON.stringify(actual.payload));
			assert.equal(actual.payload.result.installed, true);
			assert.equal(actual.payload.result.command, shim);
			assert.equal(actual.payload.result.version, "1.2.3");
			assert.equal(actual.payload.result.runtimeKind, "typescript");
			assert.ok(
				actual.payload.result.searchedDirs.includes(piBin),
				"the resolved bin directory is part of the reported search list",
			);
			assert.ok(actual.payload.result.searchedDirs.includes(join(appData, "npm")));
		});

		test("pi:check resolves a WSL pi marker and probes the distro pi", async (t) => {
			const shim = installWslFixture();
			assert.ok(shim);
			writeWslScenario({
				which: "/usr/local/bin/pi",
				whoami: "dev",
				piVersion: "1.2.3",
			});
			const { invoke } = await startTest(t, {
				settings: {
					piRuntimePreference: "auto",
					wslEnabled: true,
					wslDistro: "Ubuntu",
					wslUser: "dev",
				},
			});

			const actual = await invoke("pi:check");
			assert.equal(actual.payload.ok, true, JSON.stringify(actual.payload));
			assert.equal(actual.payload.result.installed, true);
			assert.equal(actual.payload.result.command, "wsl -d Ubuntu -u dev pi");
			assert.deepEqual(actual.payload.result.searchedDirs, []);
			const probe = readJsonLines(join(wslBin, "wsl.log"));
			assert.ok(probe.some((entry) => entry.argv.includes("which")));
			assert.ok(probe.some((entry) => entry.argv.includes("--version")));
		});

		test("pi:check-custom validates, normalizes and persists the resolved shim", async (t) => {
			const scenarioPath = writePiScenario({ version: "1.2.3" });
			const shim = writeNodeShim(piBin, "pi", piScript);
			const { invoke, backendSettings } = await startTest(t, {
				env: { FAKE_PI_MODELS_SCENARIO: scenarioPath },
			});

			// The user pastes the extension-less path; npm also wrote a `.cmd` sibling.
			const pasted = shim.replace(/\.cmd$/, "");
			const actual = await invoke("pi:check-custom", [pasted]);
			assert.equal(actual.payload.ok, true, JSON.stringify(actual.payload));
			assert.equal(actual.payload.result.installed, true);
			assert.equal(actual.payload.result.command, shim);
			assert.deepEqual(actual.payload.result.searchedDirs, []);
			assert.equal(backendSettings().customPiPath, shim, "the resolved path is persisted");

			const missing = join(root, "missing", "pi.cmd");
			const broken = await invoke("pi:check-custom", [missing]);
			assert.equal(broken.payload.result.installed, false);
			assert.equal(broken.payload.result.command, missing);
			assert.equal(broken.payload.result.error, "Could not run pi CLI. Check its path and installation.");
		});

		test("pi:check-npm reports the same availability and version", async (t) => {
			const npmLog = join(npmBin, "npm.log");
			truncate(npmLog);
			const scenarioPath = writeNpmScenario({ version: "10.8.2" });
			const { invoke } = await startTest(t, {
				env: { FAKE_NPM_SCENARIO: scenarioPath, FAKE_NPM_LOG: npmLog },
			});

			const actual = await invoke("pi:check-npm");
			assert.equal(actual.payload.ok, true, JSON.stringify(actual.payload));
			assert.deepEqual(wire(actual.payload.result), { available: true, version: "10.8.2" });
			assert.equal(readJsonLines(npmLog).filter((entry) => entry.argv[0] === "--version").length, 1);

			// A failing npm still answers `{available:false}`; the message itself is
			// implementation specific, so both sides are required to carry the stderr.
			truncate(npmLog);
			writeNpmScenario({ versionExit: 1, versionStderr: "npm exploded\n" });
			const failure = await invoke("pi:check-npm");
			assert.equal(failure.payload.result.available, false);
			assert.match(String(failure.payload.result.error), /npm exploded/);
		});

		test("pi:exec-install runs the command through cmd with npm network calls disabled", async (t) => {
			const npmLog = join(npmBin, "npm.log");
			truncate(npmLog);
			const scenarioPath = writeNpmScenario({
				installStdout: "installed fake package\n",
				installExit: 0,
			});
			const { invoke } = await startTest(t, {
				env: { FAKE_NPM_SCENARIO: scenarioPath, FAKE_NPM_LOG: npmLog },
			});

			const command = "npm install -g @earendil-works/pi-coding-agent";
			const actual = await invoke("pi:exec-install", [command]);
			assert.equal(actual.payload.ok, true, JSON.stringify(actual.payload));
			assert.deepEqual(wire(actual.payload.result), {
				success: true,
				exitCode: 0,
				stdout: "installed fake package\n",
				stderr: "",
			});

			const entries = readJsonLines(npmLog);
			assert.equal(entries.length, 1, "one native install invocation");
			for (const entry of entries) {
				assert.deepEqual(entry.argv, ["install", "-g", "@earendil-works/pi-coding-agent"]);
				assert.equal(entry.fund, "false");
				assert.equal(entry.audit, "false");
				assert.equal(entry.cwd, home, "the install runs in the user home directory");
			}

			truncate(npmLog);
			writeNpmScenario({ installStderr: "install failed: EACCES\n", installExit: 3 });
			const failure = await invoke("pi:exec-install", [command]);
			assert.deepEqual(wire(failure.payload.result), {
				success: false,
				exitCode: 3,
				stdout: "",
				stderr: "install failed: EACCES\n",
			});
		});

		test("wsl:list-distros filters binary noise and invalid distribution names", async (t) => {
			const wslLog = join(wslBin, "wsl.log");
			truncate(wslLog);
			const scenarioPath = writeWslScenario({
				// UTF-16LE output arrives NUL-laden; the WSL banner contains a backslash.
				distros: ["Ubuntu", "docker-desktop\\", "Bad\u0000Name", "", "Debian"],
			});
			const { invoke } = await startTest(t, {
				env: { FAKE_WSL_SCENARIO: scenarioPath, FAKE_WSL_LOG: wslLog },
			});

			const actual = await invoke("wsl:list-distros");
			assert.equal(actual.payload.ok, true, JSON.stringify(actual.payload));
			assert.deepEqual(actual.payload.result, ["Ubuntu", "Debian"]);
			const entries = readJsonLines(wslLog);
			assert.equal(entries.length, 1);
			assert.deepEqual(entries[0].argv, ["-l", "-q"]);

			truncate(wslLog);
			writeWslScenario({ distros: ["Ubuntu"], listExit: 3 });
			const failure = await invoke("wsl:list-distros");
			assert.deepEqual(wire(failure.payload.result), []);
		});

		test("wsl:validate-connection reports each connection and Pi availability state", async (t) => {
			const wslLog = join(wslBin, "wsl.log");
			truncate(wslLog);
			writeWslScenario({ whoami: "dev", piVersion: "1.2.3" });
			const { invoke } = await startTest(t, {
				env: { FAKE_WSL_SCENARIO: join(wslBin, "scenario.json"), FAKE_WSL_LOG: wslLog },
			});

			const connected = await invoke("wsl:validate-connection", ["Ubuntu", "dev"]);
			assert.equal(connected.payload.ok, true, JSON.stringify(connected.payload));
			assert.deepEqual(wire(connected.payload.result), {
				ok: true,
				whoami: "dev",
				piVersion: "1.2.3",
				error: "",
			});

			// The distro is reachable but pi is missing: ok stays true, the error explains why.
			writeWslScenario({ whoami: "dev", piExit: 1 });
			const missingPi = await invoke("wsl:validate-connection", ["Ubuntu", "dev"]);
			assert.deepEqual(wire(missingPi.payload.result), {
				ok: true,
				whoami: "dev",
				piVersion: "",
				error: "pi CLI was not detected. Run npm i -g @earendil-works/pi-coding-agent in WSL.",
			});

			writeWslScenario({ whoamiExit: 1, whoamiStderr: "no such distro\n" });
			const disconnected = await invoke("wsl:validate-connection", ["Ubuntu", "dev"]);
			assert.deepEqual(wire(disconnected.payload.result), {
				ok: false,
				whoami: "",
				piVersion: "",
				error: "Could not connect to the selected WSL distribution and user. Check the settings and try again.",
			});
		});
	});
}
