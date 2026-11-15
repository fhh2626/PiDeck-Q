// Shutdown budget: a quit while background domain work is in flight must end the process
// from the Qt event loop, within the host's force-kill budget, with the normal exit code.
//
// The defect this pins down: `application.prepareQuit` was ACKed (`application.readyToExit`
// within ~300 ms) while a `pi:check` probe was running, and the process then never exited.
// The serial domain executor drained "successfully" (the body finished inside the drain
// window), so it posted its continuation into the main thread's event queue — after the
// event loop had already stopped. Nothing delivered it, and destroying it during
// `QCoreApplication` teardown blocked forever: freeing the last `QPointer<QTcpSocket>` of a
// closed client socket reached `free_dbg` with a block that the release CRT of Qt owns
// (Qt6Core.dll imports ucrtbase, a debug backend imports ucrtbased), which raises
// `_CrtIsValidHeapPointer(block)`. A GUI-less process reports that through `MessageBoxW`,
// so the backend sat on a modal dialog nobody could dismiss. The host's 1500 ms force kill
// hid it, which is exactly why it needs an assertion instead of a manual repro.
//
// The suites below assert the observable contract, not the mechanism:
//  - the exit happens well inside the budget, from the normal path (`code === 0`, no kill),
//  - the shutdown still ACKs the host first,
//  - a probe child that was in flight is never left behind, and
//  - a body that truly outlives the drain budget still exits inside the budget (emergency
//    exit) instead of waiting a second drain window.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createProbePi, processAlive } from "./helpers/native2ProbePi.mjs";
import {
	createSharedFixture,
	startBackend,
	waitFor,
} from "./helpers/native2RestartableBackend.mjs";

const PROJECT = "shutdown-project";
/** The host force-kills a sidecar 1500 ms after prepareQuit; anything past this is a hang. */
const EXIT_BUDGET_MS = 3_000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function seedFixture() {
	const fixture = createSharedFixture({ settings: { language: "en-US" } });
	writeFileSync(
		join(fixture.userData, "projects.json"),
		JSON.stringify([
			{ id: PROJECT, name: "shutdown", path: fixture.project, lastOpenedAt: 1, sortOrder: 0, environment: "windows" },
		]),
	);
	// One displayable session so `sessions:list` has a real scan to do.
	const directory = join(fixture.sessions, "--shutdown--");
	mkdirSync(directory, { recursive: true });
	writeFileSync(
		join(directory, "s1.jsonl"),
		`${JSON.stringify({
			type: "session",
			version: 3,
			id: "s1",
			timestamp: "2026-01-01T00:00:00.000Z",
			cwd: fixture.project.replaceAll("\\", "/"),
		})}\n${JSON.stringify({
			type: "message",
			id: "u0",
			parentId: null,
			timestamp: "2026-01-01T00:00:01.000Z",
			message: { role: "user", content: [{ type: "text", text: "shutdown probe" }], timestamp: 1 },
		})}\n`,
	);
	return fixture;
}

function readyToExitSeen(backend) {
	return backend.host.frames.some((frame) => frame.type === "event" && frame.name === "application.readyToExit");
}

/**
 * Quit and assert the process ends from the event loop inside the budget.
 * Returns the exit result so callers can assert more.
 */
async function quitWithinBudget(backend, label) {
	const exited = backend.backend.exited;
	const startedAt = Date.now();
	backend.host.emit("application.prepareQuit");
	const result = await Promise.race([exited, sleep(EXIT_BUDGET_MS + 2_000).then(() => null)]);
	const elapsedMs = Date.now() - startedAt;
	if (backend.backend.child.exitCode === null) backend.backend.child.kill();
	assert.ok(result, `${label}: backend did not exit within ${EXIT_BUDGET_MS + 2_000} ms (host would have had to force-kill it)`);
	assert.ok(elapsedMs <= EXIT_BUDGET_MS, `${label}: exit took ${elapsedMs} ms, budget is ${EXIT_BUDGET_MS} ms`);
	assert.equal(result.code, 0, `${label}: exit code ${result.code} (stderr: ${result.stderr.slice(-800)})`);
	assert.equal(readyToExitSeen(backend), true, `${label}: shutdown did not ACK the host before exiting`);
	return { elapsedMs, result };
}

/** Assert every recorded probe pid is gone: a shutdown must not orphan a child. */
async function assertNoSurvivorChildren(probe, label) {
	for (const entry of probe.starts()) {
		await waitFor(() => !processAlive(entry.pid), `${label}: probe child ${entry.pid} is still running`, 5_000, 50);
	}
}

describe("native2 shutdown budget", () => {
	it("a quit while a pi --version probe is in flight exits from the event loop", async (t) => {
		const fixture = seedFixture();
		const probe = createProbePi(fixture, { versionDelayMs: 150 });
		const backend = await startBackend(t, fixture, {
			settings: { language: "en-US", customPiPath: probe.shim },
			env: { FAKE_PI_SCENARIO: probe.scenarioPath, FAKE_PI_LOG: probe.logPath },
		});

		const check = backend.invoke("pi:check", []).catch(() => null);
		await waitFor(() => probe.starts().length === 1, "pi:check never started the probe", 10_000, 20);
		await quitWithinBudget(backend, "probe in flight");
		await Promise.race([check, sleep(1_000)]);

		// The child was inside its own delay when the quit arrived, so a backend that simply
		// abandoned the executor would leave it running.
		await waitFor(() => probe.exits().length === 1, "the probe child never recorded its exit", 5_000, 50);
		await assertNoSurvivorChildren(probe, "probe in flight");
	});

	it("a scan queued behind an in-flight probe does not extend the exit", async (t) => {
		const fixture = seedFixture();
		const probe = createProbePi(fixture, { versionDelayMs: 200 });
		const backend = await startBackend(t, fixture, {
			settings: { language: "en-US", customPiPath: probe.shim },
			env: { FAKE_PI_SCENARIO: probe.scenarioPath, FAKE_PI_LOG: probe.logPath },
		});

		const check = backend.invoke("pi:check", []).catch(() => null);
		await waitFor(() => probe.starts().length === 1, "pi:check never started the probe", 10_000, 20);
		// The serial executor queues the scan behind the probe: at quit time one body is
		// running and another is queued, which is the case that used to leave both a queued
		// completion and a queued body behind.
		const scan = backend.invoke("sessions:list", [PROJECT]).catch(() => null);
		await quitWithinBudget(backend, "scan queued behind probe");
		await Promise.race([Promise.all([check, scan]), sleep(1_000)]);

		await waitFor(() => probe.exits().length === 1, "the probe child never recorded its exit", 5_000, 50);
		await assertNoSurvivorChildren(probe, "scan queued behind probe");
	});

	it("two probes and a scan in flight still exit inside the budget", async (t) => {
		const fixture = seedFixture();
		const probe = createProbePi(fixture, { versionDelayMs: 150 });
		const backend = await startBackend(t, fixture, {
			settings: { language: "en-US", customPiPath: probe.shim },
			env: { FAKE_PI_SCENARIO: probe.scenarioPath, FAKE_PI_LOG: probe.logPath },
		});

		const first = backend.invoke("pi:check", []).catch(() => null);
		await waitFor(() => probe.starts().length === 1, "first pi:check never started the probe", 10_000, 20);
		const second = backend.invoke("pi:check", []).catch(() => null);
		const scan = backend.invoke("sessions:list", [PROJECT]).catch(() => null);
		await quitWithinBudget(backend, "two probes and a scan");
		await Promise.race([Promise.all([first, second, scan]), sleep(1_000)]);

		// Only the running probe reaches the child; the queued one is dropped with its job.
		for (const entry of probe.starts()) {
			await waitFor(() => !processAlive(entry.pid), `probe child ${entry.pid} is still running`, 5_000, 50);
		}
	});

	it("a body that outlives the drain budget exits through the emergency path, once", async (t) => {
		const fixture = seedFixture();
		// Longer than the whole shutdown budget: this is the "worker truly outlives the
		// budget" branch, which must exit immediately instead of waiting a second drain.
		const probe = createProbePi(fixture, { versionDelayMs: 2_000 });
		const backend = await startBackend(t, fixture, {
			settings: { language: "en-US", customPiPath: probe.shim },
			env: { FAKE_PI_SCENARIO: probe.scenarioPath, FAKE_PI_LOG: probe.logPath },
		});

		const check = backend.invoke("pi:check", []).catch(() => null);
		await waitFor(() => probe.starts().length === 1, "pi:check never started the probe", 10_000, 20);
		const { elapsedMs } = await quitWithinBudget(backend, "body outlives drain budget");
		// The emergency exit spends the drain budget once (250 ms) plus the ACK; a second
		// 2 s drain window would show up here.
		assert.ok(elapsedMs < 2_500, `emergency exit took ${elapsedMs} ms; the drain deadline was spent twice`);
		await Promise.race([check, sleep(1_000)]);

		// The child was started before the quit by a body that could not be stopped; it must
		// end on its own, not linger forever (the host's job object reaps it in production).
		for (const entry of probe.starts()) {
			await waitFor(() => !processAlive(entry.pid), `probe child ${entry.pid} is still running`, 8_000, 100);
		}
	});
});
