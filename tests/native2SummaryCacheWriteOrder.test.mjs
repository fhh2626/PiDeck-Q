// Session-summary cache write ordering (regression, deterministic).
//
// The defect: the debounced background write and shutdown's `flush()` persist the same
// cache file. When the debounced payload was still queued while `flush()` wrote a newer
// snapshot, the older payload's rename could land last and roll the disk cache back one
// version (losing work and forcing a full rescan on the next launch).
//
// The end-to-end race could not be constructed reliably: it needs a timer-driven payload
// to still be queued at the exact moment shutdown flushes, and three different public
// constructions flipped green/red on the same binary. The rule itself is pure, so it is
// covered directly by `PiDeck-SummaryCacheWriteOrderTest`, which drives the production
// `WriteOrdering` gate in the order that used to lose data. This suite runs that exe and
// asserts its public output; it never re-implements the rule in JavaScript.
import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { childPathEnvironment, environmentPath, qtBinDirectory } from "./helpers/native2BackendHarness.mjs";
import { joinPathParts } from "./helpers/native2FakeProcess.mjs";
import { nativeBuildPaths } from "./helpers/nativeBuildPaths.mjs";

const REPO = process.cwd();
const pinned = process.env.PIDECK_SUMMARY_CACHE_TEST_EXECUTABLE;
const CANDIDATES = nativeBuildPaths("PiDeck-SummaryCacheWriteOrderTest", { pinned });
const SOURCES = [
	"native/tests/SummaryCacheWriteOrderTest.cpp",
	"native/backend/domain/sessions/WriteOrdering.cpp",
	"native/backend/domain/sessions/WriteOrdering.h",
	"xmake.lua",
];

function resolveTestExe() {
	const built = Math.max(...SOURCES.map((source) => statSync(resolve(REPO, source)).mtimeMs));
	for (const candidate of CANDIDATES) {
		const full = resolve(REPO, candidate);
		if (!existsSync(full)) continue;
		// Stale-binary guard: the assertion must run against the current source, not an
		// executable left over from an earlier edit.
		if (statSync(full).mtimeMs >= built) return full;
	}
	return null;
}

const executable = resolveTestExe();
const required = Boolean(pinned) || process.env.PIDECK_REQUIRE_BACKEND_TESTS === "1";
const skip = executable
	? false
	: required
		? false
		: `PiDeck-SummaryCacheWriteOrderTest not built (run "PIDECK_STAGE_DIR=build/native2-validation-unpacked xmake build -y PiDeck-SummaryCacheWriteOrderTest")`;

describe("native2 summary cache write ordering", { skip }, () => {
	it("never lets an older snapshot land after a newer one", () => {
		assert.ok(
			executable,
			`A fresh PiDeck-SummaryCacheWriteOrderTest is required, but none exists (looked for ${CANDIDATES.join(", ")}); build it with "PIDECK_STAGE_DIR=build/native2-validation-unpacked xmake build -y PiDeck-SummaryCacheWriteOrderTest"`,
		);
		// The exe links Qt6Core.dll from the pinned package, which is not deployed next to
		// it (same reason the backend tests prepend that directory to PATH). Building the
		// child block through the helper keeps exactly one search-path entry: a Windows
		// environment spells the variable `Path`, so a plain `{ ...process.env }` copy cannot
		// read the inherited value.
		const env = childPathEnvironment(
			process.env,
			joinPathParts([qtBinDirectory(REPO), environmentPath(process.env)]),
		);
		const output = execFileSync(executable, [], { windowsHide: true, env, encoding: "utf8", timeout: 60_000 });

		const lines = output.split("\n").map((line) => line.trim()).filter(Boolean);
		assert.equal(lines.filter((line) => line.startsWith("not ok")).length, 0, `unexpected failure:\n${output}`);
		assert.match(output, /^ok - flush writes the newest snapshot$/m);
		assert.match(output, /^ok - a stale queued payload is never written$/m);
		assert.match(output, /^ok - disk keeps the newest payload$/m);
		assert.match(output, /^ok - one shared state keeps the newest payload$/m);
		assert.match(output, /all write-ordering cases passed/);

		// Every documented case must actually have run: a silently shortened suite would
		// still print the summary line.
		const okCount = lines.filter((line) => line.startsWith("ok - ")).length;
		assert.equal(okCount, 19, `expected 19 assertions, saw ${okCount}:\n${output}`);
	});
});
