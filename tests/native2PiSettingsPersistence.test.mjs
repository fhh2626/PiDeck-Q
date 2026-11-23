import assert from "node:assert/strict";
import { copyFileSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import test from "node:test";
import { createFakePi, resolveBackendExecutable, startBackendSession, stopBackendProcess } from "./helpers/native2BackendHarness.mjs";
import { withHookHost } from "./helpers/l5_hookHost.mjs";

const skip = !resolveBackendExecutable() && "PiDeckBackend executable not found";
const { atom } = createRequire(import.meta.url)("jotai");

/** Read returned settings and the persisted file so JSON transport behavior is observable. */
function diskSettings(session) {
	return JSON.parse(readFileSync(join(session.fixture.userData, "settings.json"), "utf8"));
}

async function invoke(session, channel, args = []) {
	const response = await session.invoke(channel, args);
	assert.equal(response.payload.ok, true, JSON.stringify(response.payload));
	return response.payload.result;
}

for (const operation of ["refreshPiStatus", "checkPiInstallInline", "checkPiInstall"]) {
	test(`${operation} clears a failed installation cache through actual JSON IPC`, { skip }, async (t) => {
		const session = await startBackendSession(t, { prepare(fixture) {
			const command = join(fixture.root, "missing-pi");
			return { settings: {
				piRuntimePreference: "typescript", piTypescriptPath: command,
				piInstall: { command, version: "1.5.2", runtimeKind: "typescript" },
			} };
		} });
		const settings = await invoke(session, "settings:get");
		let saved;
		await withHookHost(async (host) => {
			const { usePiUpdate } = host.load("src/renderer/src/hooks/usePiUpdate.ts", {
				stubs: { "../atoms": { settingsOpenAtom: atom(false) }, "../i18n": { t: (key) => key } },
			});
			const mounted = await host.mount(usePiUpdate, {
				settings, setSettings(value) { saved = value; }, showToast() {},
				api: {
					pi: { check: () => invoke(session, "pi:check") },
					settings: { update: (patch) => invoke(session, "settings:update", [patch]) },
				},
			});
			await host.act(async () => mounted.result()[operation]());
			assert.equal(mounted.result().piStatus.installed, false);
			assert.equal(mounted.result().piChecking, false);
		});
		assert.ok(saved);
		for (const snapshot of [saved, diskSettings(session), await invoke(session, "settings:get")]) {
			assert.equal(Object.hasOwn(snapshot, "piInstall"), false, JSON.stringify(snapshot.piInstall));
		}
	});
}

test("the installation cache null patch deletes the field without persisting null", { skip }, async (t) => {
	const cache = { command: "/custom/pi", version: "1.5.2", runtimeKind: "typescript" };
	const session = await startBackendSession(t, { settings: { piInstall: cache } });
	const retained = await invoke(session, "settings:update", [{ theme: "dark" }]);
	assert.deepEqual(retained.piInstall, cache);
	const cleared = await invoke(session, "settings:update", [{ piInstall: null }]);
	for (const snapshot of [cleared, diskSettings(session), await invoke(session, "settings:get")]) {
		assert.equal(Object.hasOwn(snapshot, "piInstall"), false);
		assert.equal(snapshot.theme, "dark");
	}
	const restored = await invoke(session, "settings:update", [{ piInstall: cache }]);
	assert.deepEqual(restored.piInstall, cache);
	assert.deepEqual(diskSettings(session).piInstall, cache);
});

test("an old persisted null cache is omitted from settings snapshots", { skip }, async (t) => {
	const session = await startBackendSession(t, { settings: { piInstall: null } });
	for (const snapshot of [await invoke(session, "settings:get"), diskSettings(session)]) {
		assert.equal(Object.hasOwn(snapshot, "piInstall"), false);
	}
});

for (const [runtimeKind, version, name] of [
	["typescript", "1.5.2", "pi-rust"],
	["bolt", "1.4.0 (Pi-Bolt 1.0.2)", "pi_agent_rust"],
	["unknown", "custom development build", "custom-agent"],
]) {
	test(`custom validation saves confirmed ${runtimeKind} behind command name ${name}`, { skip }, async (t) => {
		let command;
		const session = await startBackendSession(t, { prepare(fixture) {
			const fake = createFakePi(fixture, { version });
			command = join(fake.directory, process.platform === "win32" ? `${name}.cmd` : name);
			copyFileSync(fake.shim, command);
			return { env: { FAKE_PI_SCENARIO: fake.scenarioPath, FAKE_PI_LOG: fake.logPath } };
		} });
		const status = await invoke(session, "pi:check-custom", [command]);
		assert.equal(status.installed, true, JSON.stringify(status));
		assert.equal(status.runtimeKind, runtimeKind);
		for (const snapshot of [await invoke(session, "settings:get"), diskSettings(session)]) {
			assert.equal(snapshot.customPiPath, command);
			assert.deepEqual(snapshot.piInstall, { command, version, runtimeKind });
		}
		// A later unrelated settings save must retain the confirmed path as well.
		const saved = await invoke(session, "settings:update", [{ theme: "dark" }]);
		assert.equal(saved.customPiPath, command);
		assert.deepEqual(saved.piInstall, { command, version, runtimeKind });
		// Losing a detection cache must preserve the user's confirmed command, including
		// after the migration runs again in a new backend reading the same settings file.
		const cleared = await invoke(session, "settings:update", [{ piInstall: null }]);
		for (const snapshot of [cleared, await invoke(session, "settings:get"), diskSettings(session)]) {
			assert.equal(snapshot.customPiPath, command);
			assert.equal(Object.hasOwn(snapshot, "piInstall"), false);
		}
		await stopBackendProcess(session.backend, session.host);
		const restarted = await startBackendSession(t, { env: { PIDECK_USER_DATA: session.fixture.userData } });
		const reloaded = await invoke(restarted, "settings:get");
		assert.equal(reloaded.customPiPath, command);
		assert.equal(Object.hasOwn(reloaded, "piInstall"), false);
		await stopBackendProcess(restarted.backend, restarted.host);
	});
}

test("custom validation reports failure when settings migration rejects the probed installation", { skip }, async (t) => {
	let command;
	const session = await startBackendSession(t, { prepare(fixture) {
		const fake = createFakePi(fixture, { version: "pi 0.2.0 (unknown abc)" });
		command = fake.shim;
		return { env: { FAKE_PI_SCENARIO: fake.scenarioPath, FAKE_PI_LOG: fake.logPath } };
	} });
	const status = await invoke(session, "pi:check-custom", [command]);
	assert.equal(status.installed, false, JSON.stringify(status));
	assert.ok(status.error);
	for (const snapshot of [await invoke(session, "settings:get"), diskSettings(session)]) {
		assert.equal(snapshot.customPiPath, "");
		assert.equal(Object.hasOwn(snapshot, "piInstall"), false);
	}
});

test("a rejected custom installation preserves the previous working configuration", { skip }, async (t) => {
	const existing = { command: "/previous/custom-pi", version: "1.5.2", runtimeKind: "typescript" };
	let command;
	const session = await startBackendSession(t, {
		settings: { customPiPath: existing.command, piInstall: existing, piEnvironmentChecked: true },
		prepare(fixture) {
			const fake = createFakePi(fixture, { version: "pi 0.2.0 (unknown abc)" });
			command = fake.shim;
			return { env: { FAKE_PI_SCENARIO: fake.scenarioPath, FAKE_PI_LOG: fake.logPath } };
		},
	});
	const status = await invoke(session, "pi:check-custom", [command]);
	for (const snapshot of [await invoke(session, "settings:get"), diskSettings(session)]) {
		assert.equal(snapshot.customPiPath, existing.command);
		assert.deepEqual(snapshot.piInstall, existing);
		assert.equal(snapshot.piEnvironmentChecked, true);
	}
	assert.equal(status.installed, false, JSON.stringify(status));
	assert.ok(status.error);
});
