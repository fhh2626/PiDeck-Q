import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createFakePi, resolveBackendExecutable, startBackendSession } from "./helpers/native2BackendHarness.mjs";
import { createSuiteProject, removeSuiteProject, slash, writeSessionFile } from "./helpers/native2RuntimeEvents.mjs";

const skip = !resolveBackendExecutable() && "PiDeckBackend executable not found";

/** Read through IPC and disk so migration cannot survive only in a returned snapshot. */
async function settingsSnapshots(session, channel = "settings:get", patch) {
	const response = await session.invoke(channel, patch ? [patch] : []);
	assert.equal(response.payload.ok, true, JSON.stringify(response.payload));
	return [response.payload.result, JSON.parse(readFileSync(join(session.fixture.userData, "settings.json"), "utf8"))];
}

test("retired Pi runtime selection and its cached installation are removed on load", { skip }, async (t) => {
	const session = await startBackendSession(t, { settings: {
		piRuntimePreference: "rust", piRustPath: "/retired/pi-rust", customPiPath: "/retired/pi-rust",
		piInstall: { command: "/retired/pi-rust", version: "pi 0.2.0 (unknown abc)", runtimeKind: "rust" },
		piEnvironmentChecked: true, theme: "dark", piBoltPath: "/retained/pi-bolt", piTypescriptPath: "/retained/pi",
	} });
	for (const settings of await settingsSnapshots(session)) {
		assert.equal(settings.piRuntimePreference, "auto");
		assert.equal(Object.hasOwn(settings, "piRustPath"), false);
		assert.equal(settings.customPiPath, "");
		assert.equal(Object.hasOwn(settings, "piInstall"), false);
		assert.equal(settings.piEnvironmentChecked, false);
		assert.equal(settings.piBoltPath, "/retained/pi-bolt");
		assert.equal(settings.piTypescriptPath, "/retained/pi");
		assert.equal(settings.theme, "dark");
	}
});

for (const [label, cache] of [
	["recorded kind", { command: "/renamed/assistant", version: "development", runtimeKind: "rust" }],
	["old version banner", { command: "/renamed/assistant", version: "pi 0.2.0 (unknown abc)" }],
]) {
	test(`migration clears a renamed retired custom Pi identified by ${label}`, { skip }, async (t) => {
		const session = await startBackendSession(t, { settings: {
			piRuntimePreference: "auto", customPiPath: cache.command, piInstall: cache, piEnvironmentChecked: true,
		} });
		for (const settings of await settingsSnapshots(session)) {
			assert.equal(settings.customPiPath, "");
			assert.equal(Object.hasOwn(settings, "piInstall"), false);
			assert.equal(settings.piEnvironmentChecked, false);
		}
	});
}

test("migration preserves supported Pi settings when a stale retired path remains", { skip }, async (t) => {
	const cache = { command: "/projects/rust/pi-bolt", version: "1.4.0 (Pi-Bolt 1.0.2)", runtimeKind: "bolt" };
	const session = await startBackendSession(t, { settings: {
		piRuntimePreference: "bolt", piRustPath: "/retired/pi_agent_rust", customPiPath: cache.command,
		piInstall: cache, piBoltPath: cache.command, piEnvironmentChecked: true,
	} });
	for (const settings of await settingsSnapshots(session)) {
		assert.equal(settings.piRuntimePreference, "bolt");
		assert.equal(Object.hasOwn(settings, "piRustPath"), false);
		assert.equal(settings.customPiPath, cache.command);
		assert.deepEqual(settings.piInstall, cache);
		assert.equal(settings.piEnvironmentChecked, true);
	}
});

test("migration removes a stale retired cache without clearing a different supported custom path", { skip }, async (t) => {
	const session = await startBackendSession(t, { settings: {
		piRuntimePreference: "auto", customPiPath: "/current/pi",
		piInstall: { command: "/retired/pi-rust", version: "development", runtimeKind: "rust" },
	} });
	for (const settings of await settingsSnapshots(session)) {
		assert.equal(settings.customPiPath, "/current/pi");
		assert.equal(Object.hasOwn(settings, "piInstall"), false);
	}
});

test("settings updates cannot persist the retired Pi selection or path again", { skip }, async (t) => {
	const session = await startBackendSession(t);
	for (const settings of await settingsSnapshots(session, "settings:update", {
		piRuntimePreference: "rust", piRustPath: "C:\\tools\\pi_agent_rust.exe",
		customPiPath: "C:\\tools\\pi_agent_rust.exe", piEnvironmentChecked: true,
		piInstall: { command: "C:\\tools\\pi_agent_rust.exe", version: "pi 0.2.0", runtimeKind: "rust" },
		theme: "light",
	})) {
		assert.equal(settings.piRuntimePreference, "auto");
		assert.equal(Object.hasOwn(settings, "piRustPath"), false);
		assert.equal(settings.customPiPath, "");
		assert.equal(Object.hasOwn(settings, "piInstall"), false);
		assert.equal(settings.piEnvironmentChecked, false);
		assert.equal(settings.theme, "light");
	}
});

for (const update of [false, true]) {
	test(`retired command path aliases are normalized on ${update ? "update" : "load"}`, { skip }, async (t) => {
		const legacy = { piRuntimePreference: "auto", piRustPath: "C:\\Tools\\old-agent\\runner.exe",
			customPiPath: '"c:/TOOLS/old-agent/./bin/../runner.exe"' };
		const session = await startBackendSession(t, { settings: update ? {} : legacy });
		for (const settings of await settingsSnapshots(session, update ? "settings:update" : "settings:get", update ? legacy : undefined)) {
			assert.equal(settings.customPiPath, "");
			assert.equal(Object.hasOwn(settings, "piRustPath"), false);
		}
	});

	test(`retired WSL cache command migrates its matching custom URL on ${update ? "update" : "load"}`, { skip }, async (t) => {
		const legacy = { piRuntimePreference: "auto", customPiPath: "wsl://Ubuntu/dev//home/dev/./bin/../Agent",
			piInstall: { command: "wsl -d Ubuntu -u dev /home/dev/Agent", version: "pi 0.2.0", runtimeKind: "rust" } };
		const session = await startBackendSession(t, { settings: update ? {} : legacy });
		for (const settings of await settingsSnapshots(session, update ? "settings:update" : "settings:get", update ? legacy : undefined)) {
			assert.equal(settings.customPiPath, "");
			assert.equal(Object.hasOwn(settings, "piInstall"), false);
			assert.equal(settings.piEnvironmentChecked, false);
		}
	});

	test(`retired WSL migration preserves a different Linux path case on ${update ? "update" : "load"}`, { skip }, async (t) => {
		const legacy = { piRuntimePreference: "auto", customPiPath: "wsl://Ubuntu/dev//home/dev/Agent",
			piInstall: { command: "wsl -d Ubuntu -u dev /home/dev/agent", version: "pi 0.2.0", runtimeKind: "rust" } };
		const session = await startBackendSession(t, { settings: update ? {} : legacy });
		for (const settings of await settingsSnapshots(session, update ? "settings:update" : "settings:get", update ? legacy : undefined)) {
			assert.equal(settings.customPiPath, legacy.customPiPath);
			assert.equal(Object.hasOwn(settings, "piInstall"), false);
		}
	});
}

test("a supported cached version protects a custom path reused after the retired installation", { skip }, async (t) => {
	const cache = { command: "C:\\tools\\custom-pi.exe", version: "1.4.0" };
	const session = await startBackendSession(t, { settings: {
		piRuntimePreference: "auto", customPiPath: cache.command, piRustPath: '"c:/TOOLS/custom-pi.exe"',
		piInstall: cache, piEnvironmentChecked: true,
	} });
	for (const settings of await settingsSnapshots(session)) {
		assert.equal(settings.customPiPath, cache.command);
		assert.deepEqual(settings.piInstall, cache);
		assert.equal(settings.piEnvironmentChecked, true);
		assert.equal(Object.hasOwn(settings, "piRustPath"), false);
	}
});

test("migration preserves a distinct POSIX command containing a literal backslash", {
	skip: skip || process.platform === "win32" && "Windows treats backslashes as path separators",
}, async (t) => {
	const customPiPath = "/home/dev/old\\runner";
	const session = await startBackendSession(t, { settings: {
		piRuntimePreference: "auto", piRustPath: "/home/dev/old/runner", customPiPath,
	} });
	for (const settings of await settingsSnapshots(session)) {
		assert.equal(settings.customPiPath, customPiPath);
		assert.equal(Object.hasOwn(settings, "piRustPath"), false);
	}
});

for (const [kind, version] of [
	["typescript", "1.4.0"], ["typescript", "0.85.1"],
	["bolt", "1.4.0 (Pi-Bolt 1.0.2, linux-x64)"], ["bolt", "1.4.0 (Pi-Bolt 1.0.2, win32-x64-jit, JIT on)"],
	["unknown", "custom development build"],
]) {
	test(`Pi discovery classifies ${version} as ${kind} after migration`, { skip }, async (t) => {
		let fake;
		const session = await startBackendSession(t, { prepare: (fixture) => {
			fake = createFakePi(fixture, { version });
			return {
				settings: { piRuntimePreference: kind === "unknown" ? "auto" : kind,
					[kind === "bolt" ? "piBoltPath" : kind === "typescript" ? "piTypescriptPath" : "customPiPath"]: fake.shim,
					piRustPath: "/retired/pi-rust" },
				env: { FAKE_PI_SCENARIO: fake.scenarioPath, FAKE_PI_LOG: fake.logPath },
			};
		} });
		const checked = await session.invoke("pi:check");
		assert.equal(checked.payload.ok, true, JSON.stringify(checked.payload));
		assert.equal(checked.payload.result.installed, true);
		assert.equal(checked.payload.result.runtimeKind, kind);
		assert.equal(checked.payload.result.command, fake.shim);
	});
}

for (const preference of ["bolt", "auto", "typescript"]) {
	for (const command of ["copy", "export-html"]) {
		test(`a temporary ${preference} Pi session for ${command} uses compatible offline arguments`, { skip }, async (t) => {
			const project = createSuiteProject("pideck-temporary-bolt-");
			let fake;
			const session = await startBackendSession(t, {
				projects: [{ id: "temporary-bolt", path: project.projectPath }],
				prepare: (fixture) => {
					fake = createFakePi(fixture, {
						version: preference === "typescript" ? "1.4.0" : "1.4.0 (Pi-Bolt 1.0.2)",
						responses: { clone: { data: { cancelled: true } }, export_html: { data: { path: "/exported/session.html" } } },
					});
					return { settings: { piRuntimePreference: preference, piRpcOffline: true,
						[preference === "bolt" ? "piBoltPath" : preference === "typescript" ? "piTypescriptPath" : "customPiPath"]: fake.shim },
						env: { FAKE_PI_SCENARIO: fake.scenarioPath, FAKE_PI_LOG: fake.logPath } };
				},
			});
			t.after(() => removeSuiteProject(project.root));
			const filePath = writeSessionFile(session.fixture.sessions, project.projectPath, `temporary-${command}`);
			const listed = await session.invoke("sessions:catalog-list", ["temporary-bolt"]);
			assert.equal(listed.payload.ok, true, JSON.stringify(listed.payload));
			const record = listed.payload.result.find((entry) => slash(entry.filePath) === slash(filePath));
			assert.ok(record);
			const result = await session.invoke(`sessions:catalog-${command}`, [record.id]);
			assert.equal(result.payload.ok, true, JSON.stringify(result.payload));
			const spawn = fake.readLog().find((entry) => entry.kind === "spawn");
			assert.ok(spawn, "the temporary RPC child must start");
			assert.equal(spawn.argv.includes("--offline"), preference === "typescript", JSON.stringify(spawn.argv));
			assert.ok(fake.commands().some((entry) => entry.command === (command === "copy" ? "clone" : "export_html")));
		});
	}
}
