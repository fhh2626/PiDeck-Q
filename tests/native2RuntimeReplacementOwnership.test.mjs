import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { after, test } from "node:test";
import {
	createSuiteProject,
	removeSuiteProject,
	slash,
	sleep,
	startRuntimeBackend,
	waitFor,
	writeSessionFile,
} from "./helpers/native2RuntimeEvents.mjs";

/**
 * Runtime replacement ownership (rereview R1/R2).
 *
 * Oracle contract (`src/main/sessions/SessionRuntimeCoordinator.ts`):
 *  - `restartSession` keeps its `reserveBoundRuntime` reservation until the new process
 *    answered `get_state`, applied preferences and is about to be bound, so a concurrent
 *    `activate` cannot spawn a second runtime for the same session;
 *  - `activate` refuses while a replacement reservation is held;
 *  - a runtime that fails `get_state` is stopped (deferred, never on its own RPC stack)
 *    while a file-backed session keeps its durable catalog row.
 *
 * Every case drives the real backend over the real wire protocol with fake pi.
 */
const project = createSuiteProject("pideck-native2-replacement-");
after(() => removeSuiteProject(project.root));
const projectId = "replacement-ownership";

async function importFile(session, name) {
	const filePath = writeSessionFile(session.fixture.sessions, project.projectPath, name);
	const listed = await session.invoke("sessions:catalog-list", [projectId]);
	assert.equal(listed.payload.ok, true, JSON.stringify(listed.payload));
	const record = listed.payload.result.find((entry) => slash(entry.filePath) === slash(filePath));
	assert.ok(record, "the session file must be imported into the catalog");
	return record;
}

async function liveAgents(session, sessionId) {
	const reply = await session.invoke("system:process-metrics");
	assert.equal(reply.payload.ok, true, JSON.stringify(reply.payload));
	return reply.payload.result.agents.filter((row) => row.sessionId === sessionId);
}

async function boundRuntimes(session, sessionId) {
	const listed = await session.invoke("sessions:runtime-list");
	assert.equal(listed.payload.ok, true, JSON.stringify(listed.payload));
	return listed.payload.result.filter((row) => row.sessionId === sessionId);
}

function spawns(fake) {
	return fake.readLog().filter((row) => row.kind === "spawn").length;
}

function getStateCommands(fake) {
	return fake.commands().filter((row) => row.command === "get_state").length;
}

/** Rewrite the suite-owned fake pi scenario; the next spawned pi reads it at startup. */
function rewriteScenario(fake, scenario) {
	writeFileSync(fake.scenarioPath, JSON.stringify(scenario));
}

/** Poll the asynchronous metrics API explicitly; waitFor accepts synchronous predicates. */
async function waitForNoLiveAgents(session, sessionId) {
	const deadline = Date.now() + 10_000;
	let remaining;
	do {
		remaining = await liveAgents(session, sessionId);
		if (remaining.length === 0) return;
		await sleep(20);
	} while (Date.now() < deadline);
	assert.equal(remaining.length, 0, `the failed runtime must be reaped: ${JSON.stringify(remaining)}`);
}

test("activation during a restart handshake is refused and leaves one runtime", { timeout: 45_000 }, async (t) => {
	const session = await startRuntimeBackend(t, {
		projectId,
		projectPath: project.projectPath,
		scenario: { responses: { get_state: { delayMs: 1500 } } },
	});
	const { record, target } = await session.activate("replacement-restart-race");
	const stateCommandsBefore = getStateCommands(session.fake);

	const restartPending = session.invoke("sessions:runtime-restart", [target]);
	await waitFor(
		() => spawns(session.fake) >= 2 && getStateCommands(session.fake) > stateCommandsBefore,
		20_000,
		"restart process waiting for its state response",
	);

	// The replacement owns the session for the whole handshake: a concurrent activation
	// must be refused, not answered with a second successful runtime identity.
	const activated = await session.invoke("sessions:runtime-activate", [record.id]);
	assert.equal(activated.payload.ok, true, JSON.stringify(activated.payload));
	assert.equal(activated.payload.result.ok, false, JSON.stringify(activated.payload));
	assert.equal(activated.payload.result.error.code, "SESSION_RUNTIME_CHANGED");

	const restarted = await restartPending;
	assert.equal(restarted.payload.ok, true, JSON.stringify(restarted.payload));
	assert.equal(restarted.payload.result.ok, true, JSON.stringify(restarted.payload));
	const replacement = restarted.payload.result.value.runtime;
	assert.ok(replacement?.agentId, JSON.stringify(restarted.payload));
	assert.equal(replacement.runtimeGeneration, target.runtimeGeneration + 1);

	await sleep(200);
	const bound = await boundRuntimes(session, record.id);
	const processes = await liveAgents(session, record.id);
	assert.equal(bound.length, 1, JSON.stringify(bound));
	assert.equal(bound[0].agentId, replacement.agentId);
	assert.equal(bound[0].runtimeGeneration, replacement.runtimeGeneration);
	assert.equal(processes.length, 1, "the refused activation must not leave a competing pi process");
	assert.equal(processes[0].agentId, replacement.agentId);

	// The successful restart target must still be usable: no stale success.
	const state = await session.invoke("sessions:runtime-state", [replacement]);
	assert.equal(state.payload.ok, true, JSON.stringify(state.payload));
	assert.equal(state.payload.result.ok, true, JSON.stringify(state.payload));
});

test("fork keeps the reservation: activation during the fork handshake is refused", { timeout: 45_000 }, async (t) => {
	const session = await startRuntimeBackend(t, {
		projectId,
		projectPath: project.projectPath,
		scenario: {
			forkMessages: [{ entryId: "u1", text: "first question" }],
			responses: { fork: { delayMs: 1200 } },
		},
	});
	const { record, target } = await session.activate("replacement-fork-race");

	const forkPending = session.invoke("sessions:runtime-fork", [target, "u1"]);
	await waitFor(
		() => session.fake.commands().some((row) => row.command === "fork"),
		20_000,
		"fork RPC in flight",
	);
	const spawnCountBefore = spawns(session.fake);
	const activated = await session.invoke("sessions:runtime-activate", [record.id]);
	assert.equal(activated.payload.result.ok, false, JSON.stringify(activated.payload));
	assert.equal(activated.payload.result.error.code, "SESSION_RUNTIME_CHANGED");
	assert.equal(spawns(session.fake), spawnCountBefore, "the refused activation must not spawn any pi");

	const forked = await forkPending;
	assert.equal(forked.payload.result.ok, true, JSON.stringify(forked.payload));
	const value = forked.payload.result.value;
	assert.equal(value.agentId, target.agentId, "fork keeps the process");
	assert.equal(value.runtimeGeneration, target.runtimeGeneration + 1);

	await sleep(200);
	const processes = await liveAgents(session, record.id);
	assert.equal(processes.length, 1, "a refused activation must not leave a competing pi process");
});

test("clone keeps the reservation and refuses activation without spawning a second pi", { timeout: 45_000 }, async (t) => {
	const session = await startRuntimeBackend(t, {
		projectId,
		projectPath: project.projectPath,
		scenario: { responses: { clone: { delayMs: 1200 } } },
	});
	const { record, target } = await session.activate("replacement-clone-race");
	const clonePending = session.invoke("sessions:runtime-clone", [target]);
	await waitFor(
		() => session.fake.commands().some((row) => row.command === "clone"),
		20_000,
		"clone RPC in flight",
	);
	const spawnCountBefore = spawns(session.fake);
	const activated = await session.invoke("sessions:runtime-activate", [record.id]);
	assert.equal(activated.payload.result.ok, false, JSON.stringify(activated.payload));
	assert.equal(activated.payload.result.error.code, "SESSION_RUNTIME_CHANGED");
	assert.equal(spawns(session.fake), spawnCountBefore, "a refused activation must not spawn any pi");
	const cloned = await clonePending;
	assert.equal(cloned.payload.result.ok, true, JSON.stringify(cloned.payload));
	const bound = await boundRuntimes(session, record.id);
	assert.equal(bound.length, 1);
	assert.equal(bound[0].agentId, target.agentId, "clone keeps the process");
	assert.equal(bound[0].runtimeGeneration, target.runtimeGeneration + 1);
	assert.equal((await liveAgents(session, record.id)).length, 1);
});

test("a file-backed activation that fails get_state reaps its runtime and keeps the catalog row", { timeout: 60_000 }, async (t) => {
	const session = await startRuntimeBackend(t, {
		projectId,
		projectPath: project.projectPath,
		scenario: { responses: { get_state: { error: "startup rejected by test" } } },
	});
	const record = await importFile(session, "replacement-failed-activation");

	for (let attempt = 0; attempt < 2; attempt += 1) {
		const reply = await session.invoke("sessions:runtime-activate", [record.id]);
		assert.equal(reply.payload.ok, true, JSON.stringify(reply.payload));
		assert.equal(reply.payload.result.ok, false, JSON.stringify(reply.payload));
		assert.equal(reply.payload.result.error.code, "SESSION_COMMAND_FAILED");
	}
	await waitForNoLiveAgents(session, record.id);
	assert.equal((await boundRuntimes(session, record.id)).length, 0);

	const listed = await session.invoke("sessions:catalog-list", [projectId]);
	assert.equal(listed.payload.ok, true, JSON.stringify(listed.payload));
	assert.ok(
		listed.payload.result.some((row) => row.id === record.id),
		"a file-backed session keeps its durable catalog identity after a failed activation",
	);

	// Healthy retry: the durable row is still usable and gets exactly one runtime.
	rewriteScenario(session.fake, {});
	const retried = await session.invoke("sessions:runtime-activate", [record.id]);
	assert.equal(retried.payload.result.ok, true, JSON.stringify(retried.payload));
	await sleep(200);
	const bound = await boundRuntimes(session, record.id);
	const processes = await liveAgents(session, record.id);
	assert.equal(bound.length, 1, JSON.stringify(bound));
	assert.equal(processes.length, 1, "the retried activation must own exactly one pi process");
	assert.equal(bound[0].agentId, retried.payload.result.value.agentId);
});

test("a failed restart reaps the new runtime and releases the reservation", { timeout: 60_000 }, async (t) => {
	const session = await startRuntimeBackend(t, {
		projectId,
		projectPath: project.projectPath,
		scenario: {},
	});
	const { record, target } = await session.activate("replacement-restart-failure");

	// The restarted process comes up but its handshake fails.
	rewriteScenario(session.fake, { responses: { get_state: { error: "restart rejected by test" } } });
	const restarted = await session.invoke("sessions:runtime-restart", [target]);
	assert.equal(restarted.payload.ok, true, JSON.stringify(restarted.payload));
	assert.equal(restarted.payload.result.ok, false, JSON.stringify(restarted.payload));

	await waitForNoLiveAgents(session, record.id);
	assert.equal((await boundRuntimes(session, record.id)).length, 0);
	const listed = await session.invoke("sessions:catalog-list", [projectId]);
	assert.ok(listed.payload.result.some((row) => row.id === record.id), "the catalog row must survive");

	// The reservation must be gone, otherwise every later activation is refused forever.
	rewriteScenario(session.fake, {});
	const activated = await session.invoke("sessions:runtime-activate", [record.id]);
	assert.equal(activated.payload.ok, true, JSON.stringify(activated.payload));
	assert.equal(activated.payload.result.ok, true, JSON.stringify(activated.payload));
	await sleep(200);
	const bound = await boundRuntimes(session, record.id);
	const processes = await liveAgents(session, record.id);
	assert.equal(bound.length, 1, JSON.stringify(bound));
	assert.equal(processes.length, 1, "the activation after a failed restart must own one pi process");
	assert.equal(bound[0].agentId, activated.payload.result.value.agentId);
});

test("concurrent activations coalesce into one runtime and one generation", { timeout: 45_000 }, async (t) => {
	const session = await startRuntimeBackend(t, {
		projectId,
		projectPath: project.projectPath,
		scenario: { responses: { get_state: { delayMs: 400 } } },
	});
	const record = await importFile(session, "replacement-concurrent-activation");

	const [first, second] = await Promise.all([
		session.invoke("sessions:runtime-activate", [record.id]),
		session.invoke("sessions:runtime-activate", [record.id]),
	]);
	for (const reply of [first, second]) {
		assert.equal(reply.payload.ok, true, JSON.stringify(reply.payload));
		assert.equal(reply.payload.result.ok, true, JSON.stringify(reply.payload));
	}
	assert.equal(first.payload.result.value.agentId, second.payload.result.value.agentId);
	assert.equal(first.payload.result.value.runtimeGeneration, second.payload.result.value.runtimeGeneration);

	await sleep(200);
	const bound = await boundRuntimes(session, record.id);
	const processes = await liveAgents(session, record.id);
	assert.equal(bound.length, 1, JSON.stringify(bound));
	assert.equal(processes.length, 1, "coalesced activation must own exactly one pi process");
	assert.equal(processes[0].agentId, bound[0].agentId);
});
