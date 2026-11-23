import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { resolveBackendExecutable, SseClient, startBackendSession } from "./helpers/native2BackendHarness.mjs";
import { waitFor } from "./helpers/native2RuntimeEvents.mjs";
import { nativeBuildPaths } from "./helpers/nativeBuildPaths.mjs";

const executable = resolveBackendExecutable();
const wsl = nativeBuildPaths("PiDeck-FakeWsl").map((path) => join(process.cwd(), path)).find(existsSync);
if (process.env.PIDECK_REQUIRE_BACKEND_TESTS === "1") assert.ok(wsl, "Build PiDeck-FakeWsl before required native tests");
const skip = !executable || !wsl;
const selected = { provider: "custom", modelId: "shared-id" };

test("a WSL model deletion clears only the matching distro and user namespace", { skip }, async (t) => {
	const session = await startBackendSession(t, {
		prepare(fixture) {
			const project = join(fixture.root, "project");
			const uncRoot = join(fixture.root, "unc");
			const home = join(uncRoot, "Ubuntu", "home", "dev");
			mkdirSync(project, { recursive: true });
			mkdirSync(join(home, ".pi", "agent"), { recursive: true });
			writeFileSync(join(home, ".pi", "agent", "models.json"), JSON.stringify({ providers: { custom: { models: [{ id: selected.modelId }] } } }));
			writeFileSync(join(fixture.userData, "projects.json"), JSON.stringify([{ id: "project", path: project, environment: "wsl" }]));
			writeFileSync(join(fixture.userData, "session-catalog.json"), JSON.stringify({ version: 1, sessions: [
				{ id: "current", environment: "wsl", wslDistro: "Ubuntu", wslUser: "dev" },
				{ id: "equivalent", environment: "wsl", wslDistro: " ubuntu ", wslUser: " dev " },
				{ id: "other-distro", environment: "wsl", wslDistro: "Debian", wslUser: "dev" },
				{ id: "other-user", environment: "wsl", wslDistro: "Ubuntu", wslUser: "root" },
				{ id: "unknown", environment: "wsl" },
				{ id: "native", environment: "native" },
			].map((entry) => ({ ...entry, projectId: "project", title: entry.id, status: "active", source: "pi", createdAt: 1, updatedAt: 1, model: selected })) }));
			const scenarioPath = join(fixture.root, "wsl.json");
			writeFileSync(scenarioPath, JSON.stringify({ root: home, linuxHome: "/home/dev", home: "/home/dev" }));
			return { env: {
				PIDECK_WSL_EXE: wsl, PIDECK_WSL_UNC_ROOT: uncRoot,
				FAKE_WSL_NODE: process.execPath,
				FAKE_WSL_SCRIPT: join(process.cwd(), "tests/fixtures/native2-fake-wsl-fs.mjs"),
				FAKE_WSL_SCENARIO: scenarioPath,
			} };
		},
	});
	const switched = await session.invoke("settings:update", [{ wslEnabled: true, wslDistro: "Ubuntu", wslUser: "dev" }]);
	assert.equal(switched.payload.ok, true, JSON.stringify(switched.payload));
	const source = (await session.invoke("config:get-models")).payload.result;
	assert.equal(source.parsed.providers.custom.models[0].id, selected.modelId, "the deletion must target the published WSL config");
	const sse = new SseClient(`${session.baseUrl}__pideck/events?token=${encodeURIComponent(session.token)}`);
	await sse.connect();
	t.after(() => sse.close());
	assert.equal((await session.invoke("config:save-models", [{ providers: {} }])).payload.result.valid, true);
	const records = (await session.invoke("sessions:catalog-list", ["project", { scan: false }])).payload.result;
	for (const id of ["current", "equivalent"]) assert.deepEqual(records.find((entry) => entry.id === id).model, { provider: "", modelId: "" });
	for (const id of ["other-distro", "other-user", "unknown", "native"]) {
		assert.deepEqual(records.find((entry) => entry.id === id).model, selected, `${id} owns a different model configuration`);
	}
	const change = (await sse.waitFor((frame) => frame.payload.channel === "models:changed" && frame.payload.args?.[0]?.removedModels?.length, 15000)).payload.args[0];
	assert.equal(change.environment, "wsl");
	assert.equal(change.wslDistro, "Ubuntu");
	assert.equal(change.wslUser, "dev");
});

test("a save during a WSL switch cleans the still-published native configuration", { skip }, async (t) => {
	let configDir;
	let nativeProject;
	let wslProject;
	let probeLog;
	const definitions = { providers: { custom: { models: [{ id: selected.modelId }] } } };
	const defaults = { defaultProvider: selected.provider, defaultModel: selected.modelId };
	const session = await startBackendSession(t, {
		prepare(fixture) {
			configDir = join(fixture.home, ".pi", "agent");
			const uncRoot = join(fixture.root, "unc");
			const home = join(uncRoot, "Ubuntu", "home", "dev");
			nativeProject = join(fixture.root, "native-project");
			wslProject = join(home, "wsl-project");
			for (const directory of [configDir, join(home, ".pi", "agent"), join(nativeProject, ".pi"), join(wslProject, ".pi")]) mkdirSync(directory, { recursive: true });
			for (const directory of [configDir, join(home, ".pi", "agent")]) writeFileSync(join(directory, "models.json"), JSON.stringify(definitions));
			for (const directory of [configDir, join(nativeProject, ".pi"), join(wslProject, ".pi")]) writeFileSync(join(directory, "settings.json"), JSON.stringify(defaults));
			writeFileSync(join(fixture.userData, "projects.json"), JSON.stringify([
				{ id: "project", path: nativeProject }, { id: "wsl-project", path: wslProject, environment: "wsl" },
			]));
			writeFileSync(join(fixture.userData, "session-catalog.json"), JSON.stringify({ version: 1, sessions: [
				{ id: "native", environment: "native" },
				{ id: "wsl", environment: "wsl", wslDistro: "Ubuntu", wslUser: "dev" },
			].map((entry) => ({ ...entry, projectId: "project", title: entry.id, status: "active", source: "pi", createdAt: 1, updatedAt: 1, model: selected })) }));
			const scenario = join(fixture.root, "wsl.json");
			probeLog = join(fixture.root, "wsl.log");
			writeFileSync(scenario, JSON.stringify({ root: home, linuxHome: "/home/dev", home: "/home/dev", homeDelayMs: 1200 }));
			return { env: { PIDECK_WSL_EXE: wsl, PIDECK_WSL_UNC_ROOT: uncRoot, FAKE_WSL_NODE: process.execPath,
				FAKE_WSL_SCRIPT: join(process.cwd(), "tests/fixtures/native2-fake-wsl-fs.mjs"), FAKE_WSL_SCENARIO: scenario, FAKE_WSL_LOG: probeLog } };
		},
	});
	const sse = new SseClient(`${session.baseUrl}__pideck/events?token=${encodeURIComponent(session.token)}`);
	await sse.connect();
	t.after(() => sse.close());
	const switching = session.invoke("settings:update", [{ wslEnabled: true, wslDistro: "Ubuntu", wslUser: "dev" }]);
	await waitFor(() => existsSync(probeLog) && readFileSync(probeLog, "utf8").includes("printenv"), 5000, "held environment resolution");
	assert.equal((await session.invoke("config:save-models", [{ providers: {} }])).payload.result.valid, true);
	assert.deepEqual(JSON.parse(readFileSync(join(configDir, "models.json"), "utf8")), { providers: {} });
	assert.equal(JSON.parse(readFileSync(join(nativeProject, ".pi", "settings.json"), "utf8")).defaultModel, "");
	assert.equal(JSON.parse(readFileSync(join(wslProject, ".pi", "settings.json"), "utf8")).defaultModel, selected.modelId);
	const records = (await session.invoke("sessions:catalog-list", ["project", { scan: false }])).payload.result;
	assert.deepEqual(records.find((entry) => entry.id === "native").model, { provider: "", modelId: "" });
	assert.deepEqual(records.find((entry) => entry.id === "wsl").model, selected);
	assert.equal((await switching).payload.ok, true);
	const change = (await sse.waitFor((frame) => frame.payload.channel === "models:changed" && frame.payload.args?.[0]?.removedModels?.length, 15000)).payload.args[0];
	assert.equal(change.environment, "native");
});

test("a model deleted in WSL remains selectable as a native Git default and favorite", { skip }, async (t) => {
	const session = await startBackendSession(t, {
		prepare(fixture) {
			const uncRoot = join(fixture.root, "unc");
			const home = join(uncRoot, "Ubuntu", "home", "dev");
			for (const directory of [join(fixture.home, ".pi", "agent"), join(home, ".pi", "agent")]) {
				mkdirSync(directory, { recursive: true });
				writeFileSync(join(directory, "models.json"), JSON.stringify({ providers: { custom: { models: [{ id: selected.modelId }] } } }));
			}
			const scenario = join(fixture.root, "wsl.json");
			writeFileSync(scenario, JSON.stringify({ root: home, linuxHome: "/home/dev", home: "/home/dev" }));
			return { env: { PIDECK_WSL_EXE: wsl, PIDECK_WSL_UNC_ROOT: uncRoot, FAKE_WSL_NODE: process.execPath,
				FAKE_WSL_SCRIPT: join(process.cwd(), "tests/fixtures/native2-fake-wsl-fs.mjs"), FAKE_WSL_SCENARIO: scenario } };
		},
	});
	assert.equal((await session.invoke("settings:update", [{ wslEnabled: true, wslDistro: "Ubuntu", wslUser: "dev" }])).payload.ok, true);
	assert.equal((await session.invoke("config:save-models", [{ providers: {} }])).payload.result.valid, true);
	assert.equal((await session.invoke("settings:update", [{ wslEnabled: false }])).payload.ok, true);
	const patch = { gitCommitMessageProvider: selected.provider, gitCommitMessageModel: selected.modelId,
		favoriteModels: [`${selected.provider}/${selected.modelId}`] };
	const saved = (await session.invoke("settings:update", [patch])).payload;
	assert.equal(saved.ok, true, JSON.stringify(saved));
	for (const settings of [saved.result, JSON.parse(readFileSync(join(session.fixture.userData, "settings.json"), "utf8"))]) {
		assert.equal(settings.gitCommitMessageProvider, selected.provider);
		assert.equal(settings.gitCommitMessageModel, selected.modelId);
		assert.deepEqual(settings.favoriteModels, patch.favoriteModels);
	}
});
