// Session catalog cross-thread ownership (real threaded regression, CAT-1).
//
// The defect: `SessionCatalogStore` had no synchronization at all, while the backend
// reaches it from the Qt owner thread (runtime activation, project channels) *and* from
// the serial domain executor (`sessions:catalog-*` bodies, background scans). Two
// independent failures followed from that:
//   - `mutate()` / `mergeScanned()` are copy → durable write → assign transactions, so a
//     draft created between the copy and the assign was silently dropped;
//   - `listEntries()` copied the record vector while another thread appended to it, and two
//     `writeSnapshot()` calls could race the `.tmp` rename (renameWithRetry removes the
//     destination first), leaving no catalog file at all.
//
// Only a real executable can prove this: `PiDeck-SessionCatalogConcurrencyTest` drives the
// production store from two threads through its public API and asserts the observable
// invariants (no lost record, no duplicate id, durable file parses and holds everything,
// coherent identity snapshot). This suite runs that exe and asserts its public output; it
// never re-implements the store in JavaScript.
//
// The attach/remove case is also the CAT-1 fencing check: every round must either bind the
// record or fail with the store's own `Session not found: <id>` refusal (the attacher
// targets an id removed up front, so a real not-found is guaranteed), and any other
// exception class fails the case instead of being counted as a tolerated race.
import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { childPathEnvironment, environmentPath, qtBinDirectory } from "./helpers/native2BackendHarness.mjs";
import { joinPathParts } from "./helpers/native2FakeProcess.mjs";
import { nativeBuildPaths } from "./helpers/nativeBuildPaths.mjs";

const REPO = process.cwd();
const CANDIDATES = nativeBuildPaths("PiDeck-SessionCatalogConcurrencyTest");
const SOURCES = [
	"native/tests/SessionCatalogConcurrencyTest.cpp",
	"native/backend/domain/sessions/SessionCatalogStore.cpp",
	"native/backend/domain/sessions/SessionCatalogDeletion.cpp",
	"native/backend/domain/sessions/SessionCatalogStore.h",
	"native/backend/domain/sessions/SessionCatalogMerge.cpp",
	"native/backend/domain/sessions/CatalogRecords.cpp",
	"native/backend/domain/sessions/SessionFiles.cpp",
];

function resolveTestExe() {
	for (const relative of CANDIDATES) {
		const full = join(REPO, relative);
		if (!existsSync(full)) continue;
		// Stale-binary guard: the assertions must run against the current source, not an
		// executable left over from before the fix.
		const built = Math.max(...SOURCES.map((source) => statSync(join(REPO, source)).mtimeMs));
		if (statSync(full).mtimeMs >= built) return full;
	}
	return null;
}

const executable = resolveTestExe();
const required = process.env.PIDECK_REQUIRE_BACKEND_TESTS === "1";
// Under the required gate a missing (or stale) executable must FAIL, not skip: a skipped
// suite still prints "pass", and this one is the only threaded evidence for the catalog
// ownership rules. Fail before the suite body so the reason is the message, not a
// side effect of whichever assertion happens to run first.
if (required && !executable) {
	throw new Error(
		`PIDECK_REQUIRE_BACKEND_TESTS=1 but no fresh PiDeck-SessionCatalogConcurrencyTest exists (looked for ${CANDIDATES.join(", ")}); ` +
			"build it with \"PIDECK_STAGE_DIR=build/native2-validation-unpacked xmake build -y PiDeck-SessionCatalogConcurrencyTest\"",
	);
}
const skip = executable
	? false
	: `PiDeck-SessionCatalogConcurrencyTest not built (run "PIDECK_STAGE_DIR=build/native2-validation-unpacked xmake build -y PiDeck-SessionCatalogConcurrencyTest")`;

describe("native2 session catalog concurrency", { skip }, () => {
	it("keeps every record and one coherent durable file under real threaded mutation", () => {
		assert.ok(
			executable,
			`PIDECK_REQUIRE_BACKEND_TESTS=1 but no fresh PiDeck-SessionCatalogConcurrencyTest exists (looked for ${CANDIDATES.join(", ")}); build it with "PIDECK_STAGE_DIR=build/native2-validation-unpacked xmake build -y PiDeck-SessionCatalogConcurrencyTest"`,
		);
		// The exe links Qt6Core.dll from the pinned package, which is not deployed next to
		// it (same reason the backend suites prepend that directory to PATH). Building the
		// child block through the helper keeps exactly one search-path entry: a Windows
		// environment spells the variable `Path`, so a plain `{ ...process.env }` copy cannot
		// read the inherited value.
		const env = childPathEnvironment(
			process.env,
			joinPathParts([qtBinDirectory(REPO), environmentPath(process.env)]),
		);
		let output = "";
		try {
			output = execFileSync(executable, [], { windowsHide: true, env, encoding: "utf8", timeout: 180_000 });
		} catch (error) {
			// A crash is the failure mode of an unsynchronised store, so report its output
			// (the red evidence) instead of a bare exit status.
			output = `${error.stdout ?? ""}${error.stderr ?? ""}`;
			assert.fail(`the concurrency executable failed (exit ${error.status}):\n${output}`);
		}

		const lines = output.split("\n").map((line) => line.trim()).filter(Boolean);
		assert.equal(lines.filter((line) => line.startsWith("not ok")).length, 0, `unexpected failure:\n${output}`);
		assert.match(output, /^ok - every draft created during a scan survives the merge$/m);
		assert.match(output, /^ok - the durable catalog holds every persisted record$/m);
		assert.match(output, /^ok - no torn read: ids stay unique and the seeded record stays visible$/m);
		assert.match(output, /^ok - a removed record is never resurrected by a concurrent attach$/m);
		assert.match(output, /^ok - attach only ever fails with the store's clean not-found$/m);
		assert.match(output, /^ok - every attach either bound the record or reported not-found$/m);
		assert.match(output, /^ok - a concurrently removed id is really reported as a clean not-found$/m);
		assert.match(output, /^ok - an identity context read is never a mix of two publications$/m);
		assert.match(output, /^ok - a stale scan cannot resurrect a successfully deleted path$/m);
		assert.match(output, /^ok - stale scan rejection also preserves the durable catalog$/m);
		assert.match(output, /^ok - a new scan can discover a genuinely recreated session path$/m);
		assert.match(output, /all session catalog concurrency cases passed/);

		// Every documented case must actually have run: a silently shortened suite would
		// still print the summary line.
		const okCount = lines.filter((line) => line.startsWith("ok - ")).length;
		assert.equal(okCount, 19, `expected 19 assertions, saw ${okCount}:\n${output}`);
	});
});
