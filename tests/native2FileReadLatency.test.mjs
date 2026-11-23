import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { backendTestAvailability, startBackendSession } from "./helpers/native2BackendHarness.mjs";
import { createProbePi } from "./helpers/native2ProbePi.mjs";
import { waitFor } from "./helpers/native2RuntimeEvents.mjs";

/** A local delayed child occupies the domain queue without using a network or real pi. */
test("native file reads finish while an unrelated domain probe is still running", {
	skip: backendTestAvailability().skip,
}, async (t) => {
	let probe;
	let target;
	let releaseGate;
	const content = "small editor document\n";
	const session = await startBackendSession(t, {
		settings: { singleInstance: false },
		prepare: (fixture) => {
			const project = join(fixture.root, "project");
			mkdirSync(project);
			target = join(project, "document.txt");
			writeFileSync(target, content);
			writeFileSync(join(fixture.userData, "projects.json"), JSON.stringify([
				{ id: "file-latency", name: "File latency", path: project, lastOpenedAt: 1, sortOrder: 0, environment: "windows" },
			]));
			probe = createProbePi(fixture);
			releaseGate = join(probe.directory, "release");
			probe.setScenario({ versionGate: releaseGate });
			return {
				settings: { customPiPath: probe.shim },
				env: { FAKE_PI_SCENARIO: probe.scenarioPath, FAKE_PI_LOG: probe.logPath },
			};
		},
	});
	const check = session.invoke("pi:check", []);
	await waitFor(() => probe.starts().length > 0, 10_000, "the blocking probe starts");
	const started = performance.now();
	const pendingReads = Promise.all(["files:read-content", "files:read-base64"].map(async (channel) => {
		const result = await session.invoke(channel, [target, 1024]);
		return { channel, result, elapsedMs: performance.now() - started, probeFinished: probe.exits().length > 0 };
	}));
	let timer;
	try {
		const reads = await Promise.race([
			pendingReads,
			new Promise((resolve) => { timer = setTimeout(() => resolve(null), 5_000); }),
		]);
		assert.ok(reads, "interactive reads must finish before the test releases unrelated domain work");
		for (const { channel, result, elapsedMs, probeFinished } of reads) {
			t.diagnostic(`${channel} completed in ${Math.round(elapsedMs)} ms while the domain probe remained gated`);
			assert.equal(result.payload.ok, true, JSON.stringify(result.payload));
			assert.equal(result.payload.result, channel === "files:read-content" ? content : Buffer.from(content).toString("base64"));
			assert.equal(probeFinished, false, `${channel} waited for the unrelated domain probe`);
		}
	} finally {
		clearTimeout(timer);
		writeFileSync(releaseGate, "release");
		await Promise.all([check, pendingReads]);
	}
});
