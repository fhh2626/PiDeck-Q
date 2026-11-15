import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, test } from "node:test";
import { joinPathParts, writeNodeShim } from "./helpers/native2FakeProcess.mjs";
import { createDesktopRpcOracle } from "./helpers/native2DesktopRpcOracle.mjs";
import {
	SseClient,
	qtBinDirectory,
	resolveBackendExecutable,
	startBackendSession,
} from "./helpers/native2BackendHarness.mjs";

/**
 * `projects:list-models` parity: RPC normalization, text fallback, the empty-result
 * retry, the process-level cache and the `models:changed` push after a pi-runtime
 * settings change.
 *
 * Both sides run the *real* production code: the backend is the built
 * `PiDeckBackend.exe`, and the goldens are produced by loading `systemIpc.ts` (the
 * oracle) in a VM with a fake `process` that sees exactly the environment the backend
 * was spawned with. The fake pi is a `.cmd` shim speaking the real RPC wire protocol and
 * the real `--list-models` table format, so nothing here mocks the behaviour under test.
 */

const executable = resolveBackendExecutable();

function readJsonLines(path) {
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

function installFakePiModels(directory, scenario) {
	mkdirSync(directory, { recursive: true });
	const script = join(directory, "fake-pi-models.mjs");
	copyFileSync(resolve("tests/fixtures/native2-fake-pi-models.mjs"), script);
	const scenarioPath = join(directory, "scenario.json");
	writeFileSync(scenarioPath, JSON.stringify(scenario));
	const logPath = join(directory, "pi.log");
	const counterPath = join(directory, "counter.txt");
	return {
		shim: writeNodeShim(directory, "pi", script),
		scenarioPath,
		logPath,
		counterPath,
		spawns: () => readJsonLines(logPath).filter((entry) => entry.kind === "spawn"),
		commands: () =>
			readJsonLines(logPath)
				.filter((entry) => entry.kind === "command")
				.map((entry) => entry.message.type),
	};
}

/** The fake pi needs the same environment the backend receives (PATH/PIDECK_HOME). */
function fakeEnvFor(fake, extra = {}) {
	return {
		FAKE_PI_MODELS_SCENARIO: fake.scenarioPath,
		FAKE_PI_MODELS_LOG: fake.logPath,
		FAKE_PI_MODELS_COUNTER: fake.counterPath,
		...extra,
	};
}

const delay = (ms) => new Promise((done) => setTimeout(done, ms));

/**
 * Compare what actually crosses the wire, not the in-process object shape.
 *
 * The oracle's objects are created inside the VM realm (different `Object.prototype`)
 * and carry `undefined`-valued keys, which JSON drops; the backend's result has already
 * been serialized. Normalising both through JSON is therefore the honest comparison: it
 * asserts absent keys stay absent instead of rejecting the realm difference.
 */
function wire(value) {
	return JSON.parse(JSON.stringify(value));
}

async function waitFor(predicate, timeoutMs = 15_000, stepMs = 25) {
	const started = Date.now();
	while (Date.now() - started < timeoutMs) {
		if (predicate()) return true;
		await delay(stepMs);
	}
	return false;
}

if (executable && process.platform === "win32") {
	describe("native2 model list parity", () => {
		let root;
		let sequence = 0;

		before(() => {
			root = mkdtempSync(join(tmpdir(), "pideck-native2-models-"));
		});
		after(() => {
			if (root) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
		});

		/**
		 * One isolated scope: a home for `models.json`, empty APPDATA/LOCALAPPDATA/MISE
		 * dirs (so `searchDirs` is deterministic) and separate fake-pi directories for the
		 * backend and the oracle so their spawn counters never mix.
		 */
		function makeScope() {
			sequence += 1;
			const scopeRoot = join(root, `scope-${sequence}`);
			const backendHome = join(scopeRoot, "backend-home");
			const oracleHome = join(scopeRoot, "oracle-home");
			for (const home of [backendHome, oracleHome]) {
				mkdirSync(join(home, ".pi", "agent"), { recursive: true });
				mkdirSync(join(home, "AppData/Roaming"), { recursive: true });
				mkdirSync(join(home, "AppData/Local"), { recursive: true });
			}
			const appData = join(scopeRoot, "appdata");
			const localAppData = join(scopeRoot, "localappdata");
			const miseData = join(scopeRoot, "mise");
			mkdirSync(appData, { recursive: true });
			mkdirSync(localAppData, { recursive: true });
			mkdirSync(miseData, { recursive: true });
			return {
				root: scopeRoot,
				backendHome,
				oracleHome,
				appData,
				localAppData,
				miseData,
				backendPiDir: join(scopeRoot, "backend-pi"),
				oraclePiDir: join(scopeRoot, "oracle-pi"),
				path: joinPathParts([
					qtBinDirectory(),
					join(scopeRoot, "backend-pi"),
					join(scopeRoot, "oracle-pi"),
					process.env.PATH,
				]),
			};
		}

		function envFor(scope, extra = {}) {
			return {
				PATH: scope.path,
				Path: scope.path,
				APPDATA: scope.appData,
				LOCALAPPDATA: scope.localAppData,
				MISE_DATA_DIR: scope.miseData,
				MISE_INSTALL_PATH: "",
				MISE_INSTALLS_DIR: "",
				ComSpec: process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe",
				...extra,
			};
		}

		function writeModels(home, value) {
			writeFileSync(
				join(home, ".pi", "agent", "models.json"),
				typeof value === "string" ? value : JSON.stringify(value),
			);
		}

		/**
		 * Start the backend plus an oracle loaded fresh for this test (the model cache is
		 * module state, so a shared graph would leak test 1's list into test 2).
		 */
		async function startTest(t, scope, scenario, { modelsConfig, backendModels, settings = {} } = {}) {
			const backendFake = installFakePiModels(scope.backendPiDir, scenario);
			const oracleFake = installFakePiModels(scope.oraclePiDir, scenario);
			const finalSettings = {
				language: "en-US",
				piRuntimePreference: "typescript",
				piTypescriptPath: backendFake.shim,
				...settings,
			};
			const session = await startBackendSession(t, {
				settings: finalSettings,
				env: envFor(scope, {
					PIDECK_HOME: scope.backendHome,
					PIDECK_HOST_HOME: scope.backendHome,
					...fakeEnvFor(backendFake),
				}),
			});

			const oracle = createDesktopRpcOracle({
				home: scope.oracleHome,
				settings: {
					...envlessSettings(),
					language: "en-US",
					piRuntimePreference: "typescript",
					piTypescriptPath: oracleFake.shim,
					...settings,
				},
				env: envFor(scope, {
					ComSpec: process.env.ComSpec ?? "",
					...fakeEnvFor(oracleFake),
				}),
				modelsConfig,
			});
			return {
				session,
				backendFake,
				oracleFake,
				invoke: (channel, args = []) => session.invoke(channel, args),
				oracle,
			};
		}

		/** Settings keys the production default store would fill in. */
		function envlessSettings() {
			return {
				customPiPath: "",
				piRustPath: "",
				piBoltPath: "",
				piRuntimePreference: "auto",
				piRpcOffline: true,
				piProxyEnabled: false,
				piProxyUrl: "http://127.0.0.1:7890",
				piProxyBypass: "localhost,127.0.0.1,::1",
			};
		}

		test("RPC payload normalizes like the oracle and the list is cached across invokes", async (t) => {
			const scope = makeScope();
			const modelsConfig = {
				parsed: {
					providers: {
						anthropic: {
							models: [
								{ id: "claude-sonnet-4", thinkingLevelMap: { xhigh: "xhigh", max: "max" } },
							],
						},
						local: {
							models: [
								{ id: "llama", reasoning: false, thinkingLevelMap: { xhigh: "xhigh" } },
							],
						},
					},
				},
			};
			writeModels(scope.backendHome, modelsConfig.parsed);
			const { invoke, oracle, backendFake, oracleFake } = await startTest(
				t,
				scope,
				{
					rpc: {
						models: [
							{
								provider: "anthropic",
								id: "claude-sonnet-4",
								name: " Sonnet 4 ",
								contextWindow: 200_000,
								maxTokens: 8_192,
								reasoning: true,
								images: true,
							},
							{ provider: " openai ", modelId: "gpt-5", input: ["text", "image"] },
							{ provider: "openai", id: "gpt-5" },
							{ provider: "broken" },
							{ provider: "local", id: "llama", input: [], images: false },
						],
					},
				},
				{ modelsConfig },
			);

			const first = await invoke("projects:list-models");
			assert.equal(first.payload.ok, true, JSON.stringify(first.payload));
			const expected = await oracle.invoke("projects:list-models");
			assert.deepEqual(wire(first.payload.result), wire(expected), "model list must match the oracle byte for byte");
			assert.deepEqual(
				first.payload.result.map((model) => model.id),
				["claude-sonnet-4", "gpt-5", "llama"],
			);
			assert.deepEqual(first.payload.result[0].thinkingLevels, { xhigh: true, max: true });
			assert.deepEqual(first.payload.result[2].thinkingLevels, { xhigh: false, max: false });

			const backendSpawns = backendFake.spawns().length;
			const oracleSpawns = oracleFake.spawns().length;
			assert.equal(backendSpawns, 1, "one pi fork per cold list");
			assert.equal(oracleSpawns, 1);

			const second = await invoke("projects:list-models");
			assert.deepEqual(wire(second.payload.result), wire(expected));
			assert.equal(backendFake.spawns().length, backendSpawns, "the second invoke must hit the cache");
			await oracle.invoke("projects:list-models");
			assert.equal(oracleFake.spawns().length, oracleSpawns, "the oracle caches the same way");
		});

		test("a pi without RPC models falls back to the --list-models text table", async (t) => {
			const scope = makeScope();
			writeModels(scope.backendHome, { providers: {} });
			const table = [
				"provider                   model                  context  max-out  thinking  images",
				"deepseek                   deepseek-chat          65.5K    8K       no        no",
				"grok.weishiair.de copy     grok-4                 200K     16K      yes       yes",
				"openai                     gpt-5                  400K     128K     yes       yes",
				"openai                     gpt-5                  400K     128K     yes       yes",
				"Showing 3 of 4 providers (use --all to list all) ",
			].join("\n");
			const { invoke, oracle, backendFake, oracleFake } = await startTest(t, scope, {
				rpc: { models: [] },
				text: [`${table}\n`],
			});

			const actual = await invoke("projects:list-models");
			assert.equal(actual.payload.ok, true, JSON.stringify(actual.payload));
			const expected = await oracle.invoke("projects:list-models");
			assert.deepEqual(wire(actual.payload.result), wire(expected));
			assert.deepEqual(
				actual.payload.result.map((model) => `${model.provider}/${model.id}`),
				["deepseek/deepseek-chat", "grok.weishiair.de copy/grok-4", "openai/gpt-5"],
			);
			assert.equal(actual.payload.result[0].contextWindow, 67_072);
			assert.equal(actual.payload.result[1].maxTokens, 16_384);
			assert.equal(backendFake.spawns().length, 2, "one RPC probe plus one text probe");
			assert.equal(oracleFake.spawns().length, 2);
		});

		test("an empty model list is retried once before it is reported", async (t) => {
			const scope = makeScope();
			writeModels(scope.backendHome, { providers: {} });
			const table = "provider  model  context  max-out  thinking  images\nacme  acme-1  128K  4K  no  yes\n";
			// A TypeScript selection tries the `--offline` fast set, then the neutral set,
			// before the empty list is retried: two empty answers for the first attempt and
			// the table for the retry.
			const { invoke, oracle, backendFake, oracleFake } = await startTest(t, scope, {
				rpc: { models: [] },
				text: ["", "", `${table}`],
			});

			const actual = await invoke("projects:list-models");
			assert.equal(actual.payload.ok, true, JSON.stringify(actual.payload));
			const expected = await oracle.invoke("projects:list-models");
			assert.deepEqual(wire(actual.payload.result), wire(expected));
			assert.deepEqual(actual.payload.result.map((model) => model.id), ["acme-1"]);
			const backendSpawns = backendFake.spawns();
			assert.equal(backendSpawns.length, 5, "RPC + both text arg sets, then RPC + the table");
			assert.equal(oracleFake.spawns().length, 5);
			assert.ok(
				backendSpawns[1].argv.includes("--offline"),
				"the TypeScript preference tries the --offline set first",
			);
			assert.ok(
				!backendSpawns[2].argv.includes("--offline"),
				"then the neutral set both implementations understand",
			);
		});

		test("a broken pi yields an empty list instead of a rejected channel", async (t) => {
			const scope = makeScope();
			writeModels(scope.backendHome, { providers: {} });
			const { invoke, oracle } = await startTest(t, scope, {
				rpc: { error: "model table unavailable" },
				text: [""],
			});

			const actual = await invoke("projects:list-models");
			assert.equal(actual.payload.ok, true, JSON.stringify(actual.payload));
			assert.deepEqual(actual.payload.result, []);
			const expected = await oracle.invoke("projects:list-models");
			assert.deepEqual(wire(actual.payload.result), wire(expected));
		});

		test("an unreadable models.json still answers with all-false thinking levels", async (t) => {
			const scope = makeScope();
			writeModels(scope.backendHome, "{ this is not json");
			const models = [{ provider: "acme", id: "acme-1", reasoning: true }];
			const { invoke, oracle } = await startTest(
				t,
				scope,
				{ rpc: { models } },
				{
					modelsConfig: {
						parsed: { providers: {} },
						diagnostic: { fileName: "models.json", message: "Unexpected token" },
					},
				},
			);

			const actual = await invoke("projects:list-models");
			assert.equal(actual.payload.ok, true, JSON.stringify(actual.payload));
			const expected = await oracle.invoke("projects:list-models");
			assert.deepEqual(wire(actual.payload.result), wire(expected));
			assert.deepEqual(actual.payload.result[0].thinkingLevels, { xhigh: false, max: false });
		});

		test("settings:update re-probes the model list and pushes exactly one models:changed", async (t) => {
			const scope = makeScope();
			writeModels(scope.backendHome, { providers: {} });
			const { session, invoke, oracle, backendFake, oracleFake } = await startTest(t, scope, {
				rpc: { models: [{ provider: "acme", id: "acme-1" }] },
			});
			// Warm the cache first: the update must invalidate it, not merely refill it.
			await invoke("projects:list-models");
			await oracle.invoke("projects:list-models");
			const backendSpawns = backendFake.spawns().length;
			const oracleSpawns = oracleFake.spawns().length;

			const client = new SseClient(
				`${session.baseUrl}__pideck/events?token=${encodeURIComponent(session.token)}`,
			);
			await client.connect();
			t.after(() => client.close());

			const updated = await invoke("settings:update", [{ piRuntimePreference: "typescript" }]);
			assert.equal(updated.payload.ok, true, JSON.stringify(updated.payload));
			const frame = await client.waitFor("models:changed", 20_000);
			assert.deepEqual(frame.payload.args ?? [], [], "models:changed carries no payload");
			assert.equal(
				backendFake.spawns().length,
				backendSpawns + 1,
				"the runtime-preference change re-probes the model list once",
			);

			await oracle.invoke("settings:update", [{ piRuntimePreference: "typescript" }]);
			assert.ok(
				await waitFor(() => oracle.sent.includes("models:changed")),
				"the oracle publishes models:changed for the same patch",
			);
			await delay(300);
			assert.equal(
				oracle.sent.filter((channel) => channel === "models:changed").length,
				1,
			);
			assert.equal(oracleFake.spawns().length, oracleSpawns + 1);

			// An unrelated setting must neither re-probe nor signal on either side.
			const frames = () =>
				client.frames.filter((entry) => entry.payload.channel === "models:changed").length;
			const framesBefore = frames();
			const backendSpawnsBefore = backendFake.spawns().length;
			const oracleSpawnsBefore = oracleFake.spawns().length;
			const oracleSentBefore = oracle.sent.filter((channel) => channel === "models:changed").length;
			await invoke("settings:update", [{ theme: "dark" }]);
			await oracle.invoke("settings:update", [{ theme: "dark" }]);
			await delay(800);
			assert.equal(frames(), framesBefore, "an unrelated setting must not push models:changed");
			assert.equal(backendFake.spawns().length, backendSpawnsBefore);
			assert.equal(oracleFake.spawns().length, oracleSpawnsBefore);
			assert.equal(
				oracle.sent.filter((channel) => channel === "models:changed").length,
				oracleSentBefore,
			);
		});
	});
}
