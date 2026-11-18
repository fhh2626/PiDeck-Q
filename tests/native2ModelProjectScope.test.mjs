import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { resolveBackendExecutable, startBackendSession } from "./helpers/native2BackendHarness.mjs";

const executable = resolveBackendExecutable();
const platform = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macosx" : process.platform;
const wsl = join(process.cwd(), `build/${platform}/${process.arch}/debug/PiDeck-FakeWsl${process.platform === "win32" ? ".exe" : ""}`);

test("deleting a WSL model preserves project defaults in another distribution", { skip: !executable || !existsSync(wsl) }, async (t) => {
	const selected = { defaultProvider: "custom", defaultModel: "shared-id" };
	let currentProject;
	let otherProject;
	const session = await startBackendSession(t, {
		prepare(fixture) {
			const uncRoot = join(fixture.root, "unc");
			const home = join(uncRoot, "Ubuntu", "home", "dev");
			currentProject = join(home, "project");
			otherProject = join(uncRoot, "Debian", "home", "dev", "project");
			for (const path of [join(home, ".pi", "agent"), join(currentProject, ".pi"), join(otherProject, ".pi")]) mkdirSync(path, { recursive: true });
			writeFileSync(join(home, ".pi", "agent", "models.json"), JSON.stringify({ providers: { custom: { models: [{ id: "shared-id" }] } } }));
			for (const path of [currentProject, otherProject]) writeFileSync(join(path, ".pi", "settings.json"), JSON.stringify(selected));
			writeFileSync(join(fixture.userData, "projects.json"), JSON.stringify([
				{ id: "current", path: currentProject, environment: "wsl" },
				{ id: "other", path: otherProject, environment: "wsl" },
			]));
			const scenario = join(fixture.root, "wsl.json");
			writeFileSync(scenario, JSON.stringify({ root: home, linuxHome: "/home/dev", home: "/home/dev" }));
			return { env: { PIDECK_WSL_EXE: wsl, PIDECK_WSL_UNC_ROOT: uncRoot, FAKE_WSL_NODE: process.execPath,
				FAKE_WSL_SCRIPT: join(process.cwd(), "tests/fixtures/native2-fake-wsl-fs.mjs"), FAKE_WSL_SCENARIO: scenario } };
		},
	});
	assert.equal((await session.invoke("settings:update", [{ wslEnabled: true, wslDistro: "Ubuntu", wslUser: "dev" }])).payload.ok, true);
	assert.equal((await session.invoke("config:save-models", [{ providers: {} }])).payload.result.valid, true);
	assert.equal(JSON.parse(readFileSync(join(currentProject, ".pi", "settings.json"), "utf8")).defaultModel, "");
	assert.deepEqual(JSON.parse(readFileSync(join(otherProject, ".pi", "settings.json"), "utf8")), selected,
		"another distro owns an independent models.json even when provider and model names match");
});
