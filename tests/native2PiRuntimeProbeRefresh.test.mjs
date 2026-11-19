import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { after, before, test } from "node:test";

import { backendTestAvailability } from "./helpers/native2BackendHarness.mjs";
import { createSuiteProject, removeSuiteProject, startRuntimeBackend } from "./helpers/native2RuntimeEvents.mjs";

const { skip } = backendTestAvailability();
const versions = { typescript: "1.4.0", bolt: "1.4.0 (Pi-Bolt 1.0.2, linux-x64)" };
let project;
before(() => { project = createSuiteProject("pideck-probe-refresh-"); });
after(() => removeSuiteProject(project?.root));

/** Check the actual RPC child arguments and environment after implementation detection. */
function assertImplementation(spawn, kind) {
	assert.equal(spawn.env.PIDECK_PI_STANDALONE, kind === "bolt" ? "1" : null);
	assert.equal(spawn.argv.includes("--offline"), kind === "typescript", JSON.stringify(spawn.argv));
}

for (const operation of ["restart", "compact"]) {
	for (const [initialKind, replacementKind] of [["bolt", "typescript"], ["typescript", "bolt"]]) {
		test(`runtime ${operation} detects an in-place ${initialKind} to ${replacementKind} replacement`, { skip }, async (t) => {
			const session = await startRuntimeBackend(t, {
				projectPath: project.projectPath,
				projectId: "probe-refresh",
				settings: { piRuntimePreference: "auto", piRpcOffline: true },
				scenario: {
					version: versions[initialKind],
					responses: { compact: { exitBeforeReply: true } },
				},
			});
			const { record, target } = await session.activate(`${operation}-${initialKind}`);
			assert.ok(target?.agentId, "the initial runtime must activate successfully");
			const first = session.fake.readLog().filter((entry) => entry.kind === "spawn");
			assert.equal(first.length, 1);
			assertImplementation(first[0], initialKind);

			// Package managers can replace a shim's target without changing the shim or
			// its configured path. The next process must identify the current target.
			const shimBefore = readFileSync(session.fake.shim);
			writeFileSync(session.fake.scenarioPath, JSON.stringify({ version: versions[replacementKind] }));
			const checked = await session.invoke("pi:check");
			assert.equal(checked.payload.ok, true, JSON.stringify(checked.payload));
			assert.equal(checked.payload.result.runtimeKind, replacementKind);
			const replaced = await session.invoke(`sessions:runtime-${operation}`, [{
				sessionId: record.id, agentId: target.agentId, runtimeGeneration: target.runtimeGeneration,
			}]);
			assert.equal(replaced.payload.ok, true, JSON.stringify(replaced.payload));
			assert.equal(replaced.payload.result.ok, true, JSON.stringify(replaced.payload));
			assert.deepEqual(readFileSync(session.fake.shim), shimBefore, "the command shim must remain unchanged");
			const spawns = session.fake.readLog().filter((entry) => entry.kind === "spawn");
			assert.equal(spawns.length, 2);
			assertImplementation(spawns[1], replacementKind);
		});
	}
}
