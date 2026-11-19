import assert from "node:assert/strict";
import { copyFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { backendTestAvailability, createFakePi, startBackendSession } from "./helpers/native2BackendHarness.mjs";
import { createSuiteProject, removeSuiteProject, slash, waitFor, writeSessionFile } from "./helpers/native2RuntimeEvents.mjs";
import { processAlive } from "./helpers/native2ProbePi.mjs";

const { skip } = backendTestAvailability();
const projectId = "probe-admission-project";
let project;
before(() => { project = createSuiteProject("pideck-probe-admission-"); });
after(() => removeSuiteProject(project?.root));

/** A cold command's --version stays pending while public lifecycle IPCs compete. */
async function fixture(t, { gateActivation = false, chatProject = false } = {}) {
	let fake;
	let versionGate;
	const scenario = { version: "1.4.0", responses: { compact: { exitBeforeReply: true } } };
	const session = await startBackendSession(t, {
		projects: [{ id: projectId, path: project.projectPath }],
		settings: { language: "en-US" },
		prepare: (directory) => {
			versionGate = join(directory.root, "version-released");
			fake = createFakePi(directory, gateActivation ? { ...scenario, versionGate } : scenario);
			return {
				settings: { customPiPath: fake.shim },
				env: { FAKE_PI_SCENARIO: fake.scenarioPath, FAKE_PI_LOG: fake.logPath },
			};
		},
	});
	const activeProjectId = chatProject ? "builtin-chat" : projectId;
	const projectRecord = (await session.invoke("projects:list")).payload.result.find((entry) => entry.id === activeProjectId);
	assert.ok(projectRecord);
	const filePath = writeSessionFile(session.fixture.sessions, projectRecord.path, "probe-admission");
	const listed = await session.invoke("sessions:catalog-list", [activeProjectId]);
	assert.equal(listed.payload.ok, true, JSON.stringify(listed.payload));
	const record = listed.payload.result.find((entry) => slash(entry.filePath) === slash(filePath));
	assert.ok(record);
	return {
		...session, fake, record, filePath,
		waitForProbe: () => waitFor(() => fake.readLog().some((entry) => entry.kind === "probe-start"), 3_000, "pending version probe"),
		waitForProbeExit: async () => {
			const probe = fake.readLog().find((entry) => entry.kind === "probe-start");
			assert.ok(probe?.pid > 0);
			await waitFor(() => fake.readLog().some((entry) => entry.kind === "probe-exit") && !processAlive(probe.pid),
				3_000, "cancelled probe process exit");
		},
		releaseProbe: () => writeFileSync(versionGate, "release"),
		spawns: () => fake.readLog().filter((entry) => entry.kind === "spawn"),
		async selectColdCommand() {
			const replacement = join(fake.directory, process.platform === "win32" ? "replacement.cmd" : "replacement.sh");
			copyFileSync(fake.shim, replacement);
			writeFileSync(fake.scenarioPath, JSON.stringify({ ...scenario, versionGate }));
			const changed = await session.invoke("settings:update", [{ customPiPath: replacement }]);
			assert.equal(changed.payload.ok, true, JSON.stringify(changed.payload));
		},
		async selectOriginalCommand() {
			// Each child reads its scenario once at startup. Future probes are ungated,
			// while the cancelled reconnect keeps its captured gate until releaseProbe.
			writeFileSync(fake.scenarioPath, JSON.stringify(scenario));
			const changed = await session.invoke("settings:update", [{ customPiPath: fake.shim }]);
			assert.equal(changed.payload.ok, true, JSON.stringify(changed.payload));
		},
	};
}

for (const reconnect of [false, true]) {
	test(`a ${reconnect ? "reconnect" : "first activation"} rechecks the project path after probing before starting Pi`, { skip }, async (t) => {
		const f = await fixture(t, { gateActivation: !reconnect, chatProject: true });
		let pending;
		if (reconnect) {
			const activated = await f.invoke("sessions:runtime-activate", [f.record.id]);
			assert.equal(activated.payload.result.ok, true, JSON.stringify(activated.payload));
			const runtime = activated.payload.result.value;
			await f.selectColdCommand();
			pending = f.invoke("sessions:runtime-compact", [{
				sessionId: f.record.id, agentId: runtime.agentId, runtimeGeneration: runtime.runtimeGeneration,
			}]);
		} else {
			pending = f.invoke("sessions:runtime-activate", [f.record.id]);
		}
		try {
			await f.waitForProbe();
			const changed = await f.invoke("projects:set-chat-path", [join(f.fixture.root, "changed-chat-project")]);
			assert.equal(changed.payload.ok, true, JSON.stringify(changed.payload));
		} finally {
			f.releaseProbe();
		}
		const result = await pending;
		assert.equal(result.payload.result.ok, false, "a path change must invalidate the captured launch");
		assert.match(result.payload.result.error.debugDetails, /Project path changed/);
		assert.equal(f.spawns().length, reconnect ? 1 : 0, "Pi must never start with the stale project directory");
		assert.deepEqual((await f.invoke("sessions:runtime-list")).payload.result, []);
	});
}

test("a project's first activation reserves it while the Pi version probe is pending", { skip }, async (t) => {
	const f = await fixture(t, { gateActivation: true });
	const activation = f.invoke("sessions:runtime-activate", [f.record.id]);
	let removed;
	try {
		await f.waitForProbe();
		removed = await f.invoke("projects:remove", [projectId]);
	} finally {
		f.releaseProbe();
	}
	const activated = await activation;
	assert.equal(removed.payload.ok, false, "project removal must see the pending activation before any RPC child exists");
	assert.match(removed.payload.error.message, /PROJECT_HAS_RUNNING_AGENT/);
	assert.equal(activated.payload.result.ok, true, JSON.stringify(activated.payload));
	assert.equal(f.spawns().length, 1);
	assert.ok((await f.invoke("projects:list")).payload.result.some((entry) => entry.id === projectId));
});

for (const mutation of ["remove-project", "delete-session", "stop"]) {
	test(`a cold reconnect ${mutation === "stop" ? "allows stop and discards its late probe" : `reserves ownership against ${mutation}`}`, { skip }, async (t) => {
		const f = await fixture(t);
		const activated = await f.invoke("sessions:runtime-activate", [f.record.id]);
		assert.equal(activated.payload.result.ok, true, JSON.stringify(activated.payload));
		const runtime = activated.payload.result.value;
		const target = { sessionId: f.record.id, agentId: runtime.agentId, runtimeGeneration: runtime.runtimeGeneration };
		await f.selectColdCommand();
		const compaction = f.invoke("sessions:runtime-compact", [target]);
		let result;
		try {
			await f.waitForProbe();
			result = mutation === "remove-project"
				? await f.invoke("projects:remove", [projectId])
				: mutation === "delete-session"
					? await f.invoke("sessions:catalog-delete", [f.record.id, { permanent: true }])
					: await f.invoke("sessions:runtime-stop", [target]);
		} finally {
			f.releaseProbe();
		}
		const compacted = await compaction;
		const runtimes = (await f.invoke("sessions:runtime-list")).payload.result;
		if (mutation === "stop") {
			assert.equal(result.payload.result.ok, true, JSON.stringify(result.payload));
			assert.equal(compacted.payload.result.ok, false);
			assert.equal(f.spawns().length, 1, "a cancelled probe must not resurrect the stopped runtime");
			assert.deepEqual(runtimes, []);
		} else {
			assert.equal(result.payload.ok, false, `${mutation} must see the pending reconnect as busy`);
			assert.equal(compacted.payload.result.ok, true, JSON.stringify(compacted.payload));
			assert.equal(f.spawns().length, 2);
			assert.equal(runtimes.length, 1);
			assert.equal(runtimes[0].agentId, target.agentId);
			assert.equal(runtimes[0].runtimeGeneration, target.runtimeGeneration);
		}
		assert.equal(existsSync(f.filePath), true, "pending and cancelled reconnects must preserve the session file");
	});
}

test("stopping a pending reconnect releases its command lease before a new activation", { skip }, async (t) => {
	const f = await fixture(t);
	const activated = await f.invoke("sessions:runtime-activate", [f.record.id]);
	assert.equal(activated.payload.result.ok, true, JSON.stringify(activated.payload));
	const runtime = activated.payload.result.value;
	const target = { sessionId: f.record.id, agentId: runtime.agentId, runtimeGeneration: runtime.runtimeGeneration };
	await f.selectColdCommand();
	const compaction = f.invoke("sessions:runtime-compact", [target]);
	let reactivated;
	try {
		await f.waitForProbe();
		const cancelledProbe = f.fake.readLog().find((entry) => entry.kind === "probe-start");
		assert.ok(cancelledProbe?.pid > 0);
		const stopped = await f.invoke("sessions:runtime-stop", [target]);
		assert.equal(stopped.payload.result.ok, true, JSON.stringify(stopped.payload));
		// The successor probes afresh while the cancelled reconnect remains pending.
		await f.selectOriginalCommand();
		reactivated = await f.invoke("sessions:runtime-activate", [f.record.id]);
		assert.equal(processAlive(cancelledProbe.pid), true,
			"a new activation must complete before the cancelled probe is released or times out");
		assert.equal(f.fake.readLog().some((entry) => entry.kind === "probe-exit" && entry.pid === cancelledProbe.pid), false,
			"the cancelled probe must still be gated when its successor activates");
	} finally {
		f.releaseProbe();
	}
	const compacted = await compaction;
	await f.waitForProbeExit();
	assert.equal(compacted.payload.result.ok, false);
	assert.equal(reactivated.payload.result.ok, true, JSON.stringify(reactivated.payload));
	const replacement = reactivated.payload.result.value;
	assert.notEqual(replacement.agentId, target.agentId);
	assert.ok(replacement.runtimeGeneration > target.runtimeGeneration);
	const runtimes = (await f.invoke("sessions:runtime-list")).payload.result;
	assert.equal(runtimes.length, 1);
	assert.equal(runtimes[0].agentId, replacement.agentId, "the cancelled probe must not replace the new runtime");
	assert.equal(f.spawns().length, 2, "the stopped runtime must have exactly one successful successor");
});
