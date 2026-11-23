import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
	childPathEnvironment,
	createFakePi,
	environmentPath,
	resolveBackendExecutable,
	startBackendSession,
} from "./helpers/native2BackendHarness.mjs";
import { createStatusRepo } from "./helpers/native2GitFixture.mjs";

/**
 * Regression for the spelling of the Windows search path.
 *
 * A Windows environment block spells the variable `Path`, and object spread is case
 * sensitive: `{ ...process.env }.PATH` is `undefined` in a normal Windows session even
 * though `process.env.PATH` reads fine. The harness built the sidecar's PATH from that
 * spread value, so a `Path`-cased parent spawned the backend with PATH = the Qt DLL
 * directory only. git/node/npx and every `.cmd` shim then became unresolvable: "Unable to
 * start git", a git status that reports empty groups, and a fake pi that exits before it
 * accepts a command.
 *
 * A `PATH`-spelled shell hides the defect completely, so the ambient block is re-keyed to
 * the Windows spelling here; the bug must stay red under that spelling even on a green
 * machine.
 */

const PROJECT_ID = "path-case";
const executable = resolveBackendExecutable();

/** Re-key the inherited search path to the spelling a Windows environment block uses. */
function useWindowsPathSpelling(t) {
	const inherited = process.env.PATH ?? "";
	// Node's env store is case insensitive, so deleting either spelling drops the single
	// entry; re-adding it under `Path` reproduces the block a normal Windows session has.
	delete process.env.PATH;
	delete process.env.Path;
	process.env.Path = inherited;
	t.after(() => {
		delete process.env.PATH;
		delete process.env.Path;
		process.env.PATH = inherited;
	});
}

/** Temporary root for one test; the harness fixture lives inside it. */
function temporaryRoot(prefix) {
	const root = mkdtempSync(join(tmpdir(), prefix));
	return {
		root,
		cleanup: () => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
	};
}

if (executable && process.platform === "win32") {
	test("a Path-cased parent still lets the backend run git", async (t) => {
		useWindowsPathSpelling(t);
		const { root, cleanup } = temporaryRoot("pideck-native2-path-case-");
		const repo = createStatusRepo(join(root, "status-repo"));
		// after-hooks run in registration order. Stop pi before removing its working directory,
		// and still register cleanup if backend startup rejects.
		const session = await startBackendSession(t, { projects: [{ id: PROJECT_ID, path: repo }] })
			.finally(() => t.after(cleanup));

		const status = await session.invoke("git:status", [PROJECT_ID]);
		assert.equal(status.payload.ok, true, JSON.stringify(status.payload));
		const result = status.payload.result;
		// A git that never started is not an error here: every group simply comes back empty.
		assert.ok(result.index.length > 0, `the index group is empty: ${JSON.stringify(result)}`);
		assert.ok(result.workingTree.length > 0, `the worktree group is empty: ${JSON.stringify(result)}`);
		assert.ok(result.untracked.length > 0, `the untracked group is empty: ${JSON.stringify(result)}`);
	});

	test("a Path-cased parent still spawns the pi batch shim", async (t) => {
		useWindowsPathSpelling(t);
		const { root, cleanup } = temporaryRoot("pideck-native2-path-case-pi-");
		const projectPath = join(root, "project");
		mkdirSync(projectPath, { recursive: true });
		let fake = null;
		const session = await startBackendSession(t, {
			projects: [{ id: PROJECT_ID, path: projectPath }],
			settings: { language: "en-US" },
			prepare: (fixture) => {
				fake = createFakePi(fixture, {});
				return {
					settings: { customPiPath: fake.shim },
					env: { FAKE_PI_SCENARIO: fake.scenarioPath, FAKE_PI_LOG: fake.logPath },
				};
			},
		}).finally(() => t.after(cleanup));

		const created = await session.invoke("sessions:create-anonymous", [{ projectId: PROJECT_ID }]);
		assert.equal(created.payload.ok, true, JSON.stringify(created.payload));
		const activated = await session.invoke("sessions:runtime-activate", [created.payload.result.session.id]);
		assert.equal(activated.payload.ok, true, JSON.stringify(activated.payload));
		assert.equal(activated.payload.result.ok, true, JSON.stringify(activated.payload));
		// pi is installed as a `.cmd` shim whose body runs `node`, so both the shim lookup and
		// node have to resolve from the PATH the backend was spawned with.
		const spawn = fake.readLog().find((entry) => entry.kind === "spawn");
		assert.ok(spawn, "the pi shim never ran inside the backend");
		assert.ok(spawn.argv.includes("--mode"), JSON.stringify(spawn.argv));
	});
}

test("the child environment carries exactly one search-path entry", () => {
	// A Windows block: `Path` only. The prepended directory must extend the real PATH.
	const windowsChild = childPathEnvironment({ Path: "C:\\Windows", SystemRoot: "C:\\Windows" }, "qt-bin;C:\\Windows");
	assert.deepEqual(Object.keys(windowsChild).filter((key) => key.toUpperCase() === "PATH"), ["Path"]);
	assert.equal(windowsChild.Path, "qt-bin;C:\\Windows");
	assert.equal(windowsChild.SystemRoot, "C:\\Windows");

	// A caller override spelled the other way must win and leave a single entry behind.
	const overridden = childPathEnvironment({ Path: "inherited", PATH: "override" }, "override");
	assert.deepEqual(Object.keys(overridden).filter((key) => key.toUpperCase() === "PATH"), ["PATH"]);
	assert.equal(overridden.PATH, "override");

	// Reading the inherited value is case insensitive, and the last write wins exactly like
	// it does for a full merge of the ambient block with a caller override.
	assert.equal(environmentPath({ Path: "inherited" }), "inherited");
	assert.equal(environmentPath({ PATH: "inherited" }), "inherited");
	assert.equal(environmentPath({ Path: "inherited", PATH: "override" }), "override");
	assert.equal(environmentPath({ Path: undefined }), "");
	assert.equal(environmentPath({}), "");
});

// Resolve overrides separately: object spread can retain an old key's insertion position
// when an ambient block already contains both spellings of the Windows variable.
test("a missing path override inherits the ambient value while an empty override clears it", () => {
	assert.equal(environmentPath({ OTHER: "value" }, "inherited"), "inherited");
	assert.equal(environmentPath({ Path: "" }, "inherited"), "");
	assert.equal(environmentPath({ PATH: undefined }, "inherited"), "");
});
