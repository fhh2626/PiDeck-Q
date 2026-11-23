import assert from "node:assert/strict";
import { copyFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { createFakePi, resolveBackendExecutable, startBackendSession } from "./helpers/native2BackendHarness.mjs";
import { createSuiteProject, removeSuiteProject, slash, writeSessionFile } from "./helpers/native2RuntimeEvents.mjs";

const skip = !resolveBackendExecutable() && "PiDeckBackend executable not found";

for (const [runtimeKind, version] of [["bolt", "1.4.0 (Pi-Bolt 1.0.2)"], ["unknown", "custom development build"]]) {
	for (const operation of ["copy", "export-html"]) {
		test(`temporary ${operation} accepts ${runtimeKind} at a stale TypeScript path`, { skip }, async (t) => {
			const project = createSuiteProject("pideck-temporary-compatibility-");
			t.after(() => removeSuiteProject(project.root));
			let fake;
			const session = await startBackendSession(t, {
				projects: [{ id: "temporary", path: project.projectPath }],
				prepare(fixture) {
					fake = createFakePi(fixture, {
						version, rejectedArguments: ["--offline"],
						responses: { clone: { data: { cancelled: true } }, export_html: { data: { path: "/exported/session.html" } } },
					});
					const command = join(fake.directory, process.platform === "win32" ? "runner.cmd" : "runner");
					copyFileSync(fake.shim, command);
					return {
						settings: { piRuntimePreference: "typescript", piTypescriptPath: command, piRpcOffline: true },
						env: { FAKE_PI_SCENARIO: fake.scenarioPath, FAKE_PI_LOG: fake.logPath, PI_OFFLINE: undefined },
					};
				},
			});
			const checked = await session.invoke("pi:check");
			assert.equal(checked.payload.ok, true);
			assert.equal(checked.payload.result.runtimeKind, runtimeKind);
			const filePath = writeSessionFile(session.fixture.sessions, project.projectPath, "temporary-compatible");
			const listed = await session.invoke("sessions:catalog-list", ["temporary"]);
			assert.equal(listed.payload.ok, true);
			const record = listed.payload.result.find((entry) => slash(entry.filePath) === slash(filePath));
			assert.ok(record);
			const result = await session.invoke(`sessions:catalog-${operation}`, [record.id]);
			assert.equal(result.payload.ok, true, JSON.stringify(result.payload));
			const spawn = fake.readLog().find((entry) => entry.kind === "spawn");
			assert.ok(spawn);
			assert.equal(spawn.argv.includes("--offline"), false, JSON.stringify(spawn.argv));
			assert.equal(spawn.env.PI_OFFLINE, "1");
			assert.ok(fake.commands().some((entry) => entry.command === (operation === "copy" ? "clone" : "export_html")));
		});
	}
}

test("temporary sessions keep offline startup disabled when the user opts out", { skip }, async (t) => {
	const project = createSuiteProject("pideck-temporary-online-");
	t.after(() => removeSuiteProject(project.root));
	let fake;
	const session = await startBackendSession(t, {
		projects: [{ id: "temporary", path: project.projectPath }],
		prepare(fixture) {
			fake = createFakePi(fixture, {
				version: "1.5.2", responses: { export_html: { data: { path: "/exported/session.html" } } },
			});
			return {
				settings: { piRuntimePreference: "typescript", piTypescriptPath: fake.shim, piRpcOffline: false },
				env: { FAKE_PI_SCENARIO: fake.scenarioPath, FAKE_PI_LOG: fake.logPath, PI_OFFLINE: undefined },
			};
		},
	});
	const filePath = writeSessionFile(session.fixture.sessions, project.projectPath, "temporary-online");
	const listed = await session.invoke("sessions:catalog-list", ["temporary"]);
	assert.equal(listed.payload.ok, true);
	const record = listed.payload.result.find((entry) => slash(entry.filePath) === slash(filePath));
	assert.ok(record);
	const result = await session.invoke("sessions:catalog-export-html", [record.id]);
	assert.equal(result.payload.ok, true, JSON.stringify(result.payload));
	const spawn = fake.readLog().find((entry) => entry.kind === "spawn");
	assert.ok(spawn);
	assert.equal(spawn.argv.includes("--offline"), false);
	assert.equal(spawn.env.PI_OFFLINE, null);
});
