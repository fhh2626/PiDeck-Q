import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { backendTestAvailability, createFakePi, SseClient, startBackendSession } from "./helpers/native2BackendHarness.mjs";
import { createSuiteProject, removeSuiteProject, slash, waitFor, writeSessionFile } from "./helpers/native2RuntimeEvents.mjs";
import { processAlive } from "./helpers/native2ProbePi.mjs";
import { nativeBuildPaths } from "./helpers/nativeBuildPaths.mjs";

const { skip } = backendTestAvailability();
let project;
before(() => {
	project = createSuiteProject("pideck-project-resources-");
	mkdirSync(join(project.projectPath, ".pi", "extensions"), { recursive: true });
	writeFileSync(join(project.projectPath, ".pi", "settings.json"), "{}\n");
});
after(() => removeSuiteProject(project?.root));

for (const [version, approve] of [
	["0.78.9", false],
	["0.79.0", true],
	["1.4.0", true],
	["1.4.0 (Pi-Bolt 1.0.2, linux-x64, JIT off)", true],
	["pi 0.2.0 (unknown abc)", false],
]) {
	test(`project resources start directly with Pi ${version} and compatible arguments`, { skip }, async (t) => {
		let fake;
		let trustPath;
		const legacyTrust = JSON.stringify({ [slash(project.projectPath)]: false });
		const session = await startBackendSession(t, {
			projects: [{ id: "resource-project", path: project.projectPath }],
			settings: { language: "en-US" },
			prepare: (fixture) => {
				fake = createFakePi(fixture, { version });
				const agentDir = join(fixture.root, "home", ".pi", "agent");
				mkdirSync(agentDir, { recursive: true });
				trustPath = join(agentDir, "trust.json");
				writeFileSync(trustPath, legacyTrust);
				writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProjectTrust: "never" }));
				return {
					settings: { customPiPath: fake.shim },
					env: { FAKE_PI_SCENARIO: fake.scenarioPath, FAKE_PI_LOG: fake.logPath },
				};
			},
		});
		const sse = new SseClient(`${session.baseUrl}__pideck/events?token=${encodeURIComponent(session.token)}`);
		await sse.connect();
		t.after(() => sse.close());
		const filePath = writeSessionFile(session.fixture.sessions, project.projectPath, "resources");
		const listed = await session.invoke("sessions:catalog-list", ["resource-project"]);
		assert.equal(listed.payload.ok, true, JSON.stringify(listed.payload));
		const record = listed.payload.result.find((entry) => slash(entry.filePath) === slash(filePath));
		assert.ok(record, "the session must be visible in the catalog");
		let activated;
		let activationError;
		const pending = session.invoke("sessions:runtime-activate", [record.id])
			.then((result) => { activated = result; }, (error) => { activationError = error; });
		const trustRequest = () => sse.frames.find((frame) => frame.payload?.channel === "projects:trust-request");
		await waitFor(() => activated || activationError || trustRequest(), 10_000, "runtime activation");
		assert.equal(trustRequest(), undefined, "activation must not wait for a removed project approval prompt");
		assert.equal(activationError, undefined);
		await pending;
		assert.equal(activated.payload.ok, true, JSON.stringify(activated.payload));
		assert.equal(activated.payload.result.ok, true, JSON.stringify(activated.payload));
		const checkLaunches = () => {
			const spawns = fake.readLog().filter((entry) => entry.kind === "spawn");
			assert.ok(spawns.length > 0, "the backend must launch the RPC process");
			for (const spawn of spawns) {
				assert.equal(spawn.argv.includes("--approve"), approve, JSON.stringify(spawn.argv));
				assert.equal(spawn.argv.includes("--no-approve"), false);
			}
			assert.equal(readFileSync(trustPath, "utf8"), legacyTrust, "legacy Pi data must remain untouched");
		};
		checkLaunches();
		if (version === "1.4.0") {
			const runtime = activated.payload.result.value;
			const restarted = await session.invoke("sessions:runtime-restart", [{
				sessionId: record.id, agentId: runtime.agentId, runtimeGeneration: runtime.runtimeGeneration,
			}]);
			assert.equal(restarted.payload.ok, true, JSON.stringify(restarted.payload));
			assert.equal(restarted.payload.result.ok, true, JSON.stringify(restarted.payload));
			assert.equal(fake.readLog().filter((entry) => entry.kind === "spawn").length, 2);
			checkLaunches();
		}
		assert.equal(trustRequest(), undefined);
	});
}

test("reconnecting through a newly selected Pi command keeps project resources enabled", { skip }, async (t) => {
	let fake;
	const session = await startBackendSession(t, {
		projects: [{ id: "resource-reconnect", path: project.projectPath }],
		prepare: (fixture) => {
			fake = createFakePi(fixture, { version: "1.4.0", responses: { compact: { exitBeforeReply: true } } });
			return {
				settings: { customPiPath: fake.shim },
				env: { FAKE_PI_SCENARIO: fake.scenarioPath, FAKE_PI_LOG: fake.logPath },
			};
		},
	});
	const filePath = writeSessionFile(session.fixture.sessions, project.projectPath, "reconnect");
	const listed = await session.invoke("sessions:catalog-list", ["resource-reconnect"]);
	const record = listed.payload.result.find((entry) => slash(entry.filePath) === slash(filePath));
	assert.ok(record);
	const activated = await session.invoke("sessions:runtime-activate", [record.id]);
	assert.equal(activated.payload.result.ok, true, JSON.stringify(activated.payload));
	const runtime = activated.payload.result.value;
	const replacement = join(fake.directory, process.platform === "win32" ? "replacement.cmd" : "replacement.sh");
	copyFileSync(fake.shim, replacement);
	const changed = await session.invoke("settings:update", [{ customPiPath: replacement }]);
	assert.equal(changed.payload.ok, true, JSON.stringify(changed.payload));
	const compacted = await session.invoke("sessions:runtime-compact", [{
		sessionId: record.id, agentId: runtime.agentId, runtimeGeneration: runtime.runtimeGeneration,
	}]);
	assert.equal(compacted.payload.result.ok, true, JSON.stringify(compacted.payload));
	const spawns = fake.readLog().filter((entry) => entry.kind === "spawn");
	assert.equal(spawns.length, 2);
	assert.equal(spawns[1].argv.includes("--approve"), true, JSON.stringify(spawns[1].argv));
});

test("quitting during runtime version probing reaps the child within the shutdown budget", { skip }, async (t) => {
	const executable = nativeBuildPaths("PiDeck-PiVersionProbeTest", {
		pinned: process.env.PIDECK_VERSION_PROBE_TEST_EXECUTABLE,
	}).map((candidate) => resolve(candidate)).find(existsSync);
	assert.ok(executable, "Build PiDeck-PiVersionProbeTest for the real child shutdown check");
	let logPath;
	const session = await startBackendSession(t, {
		projects: [{ id: "resource-shutdown", path: project.projectPath }],
		prepare: (fixture) => {
			logPath = join(fixture.root, "probe.jsonl");
			return {
				settings: { customPiPath: executable },
				env: { PIDECK_TEST_PROBE_MODE: "timeout", PIDECK_TEST_PROBE_LOG: logPath },
			};
		},
	});
	const filePath = writeSessionFile(session.fixture.sessions, project.projectPath, "shutdown");
	const listed = await session.invoke("sessions:catalog-list", ["resource-shutdown"]);
	const record = listed.payload.result.find((entry) => slash(entry.filePath) === slash(filePath));
	assert.ok(record);
	const activation = session.invoke("sessions:runtime-activate", [record.id]).catch(() => null);
	await waitFor(() => existsSync(logPath) && readFileSync(logPath, "utf8").includes("\n"), 10_000, "runtime version probe");
	const pid = JSON.parse(readFileSync(logPath, "utf8")).pid;
	try {
		const started = performance.now();
		const ack = session.host.waitForEvent("application.readyToExit", 1_500);
		session.host.emit("application.prepareQuit");
		await ack;
		const exit = await session.backend.exited;
		assert.equal(exit.code, 0, exit.stderr);
		assert.ok(performance.now() - started < 3_000, "shutdown must remain inside the host budget");
		await activation;
		await waitFor(() => !processAlive(pid), 500, "version probe child termination");
	} finally {
		if (processAlive(pid)) process.kill(pid);
	}
});
