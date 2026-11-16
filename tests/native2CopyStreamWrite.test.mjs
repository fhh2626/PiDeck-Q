// File-drawer copy/read I/O failures (regression, deterministic).
//
// The defect: `copyWithoutOverwrite` copied a file with a single `readAll()` +
// `write()` and ignored both the read error state and the written byte count.
// `QFile::close()` is void, so ENOSPC/quota/EIO produced a 0-byte or truncated
// destination that the channel reported as a successful copy — and `files:move`
// deletes the source right after that "success", so the user lost the original.
// `readBytes` (`files:read-content`) had the same shape: a truncated body instead of
// the oracle's EIO rejection. Node parity is `fs.copyFile`/`fs.readFile`, which reject
// and keep the source.
//
// A real short write needs a full volume or a failing device, neither of which exists on
// a normal machine, so the fault is injected at the QIODevice seam the production copy
// uses. `PiDeck-CopyStreamTest` drives that seam with a real temp destination file: the
// suite asserts that a failure after the exclusive create leaves no truncated file behind
// (Node's `copyFile` removes the destination it created) while a pre-existing target is
// never touched. `tests/native2FileParity.test.mjs` covers the same path end to end for a
// multi-block file and for a refused overwrite.
import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { childPathEnvironment, environmentPath, qtBinDirectory } from "./helpers/native2BackendHarness.mjs";
import { joinPathParts } from "./helpers/native2FakeProcess.mjs";
import { nativeBuildPaths } from "./helpers/nativeBuildPaths.mjs";

const REPO = process.cwd();
const CANDIDATES = nativeBuildPaths("PiDeck-CopyStreamTest");
const SOURCES = [
	"native/tests/CopyStreamWriteTest.cpp",
	"native/backend/domain/fs/CopyStream.cpp",
	"native/backend/domain/fs/CopyStream.h",
];
// `FileOperations.cpp` consumes this seam but is not compiled into the exe (the target links
// only CopyStream.cpp), so it cannot make the binary stale: listing it made the guard demand a
// rebuild that xmake correctly refuses to perform.
const BUILD_COMMAND = '"PIDECK_STAGE_DIR=build/native2-validation-unpacked xmake build -y PiDeck-CopyStreamTest"';

function resolveTestExe() {
	for (const relative of CANDIDATES) {
		const full = join(REPO, relative);
		if (!existsSync(full)) continue;
		// Stale-binary guard: the assertion must run against the current source, not an
		// executable left over from an earlier edit.
		const built = Math.max(...SOURCES.map((source) => statSync(join(REPO, source)).mtimeMs));
		if (statSync(full).mtimeMs >= built) return full;
	}
	return null;
}

const executable = resolveTestExe();
const required = process.env.PIDECK_REQUIRE_BACKEND_TESTS === "1";
const skip = executable ? false : required ? false : `PiDeck-CopyStreamTest not built (run ${BUILD_COMMAND})`;

describe("native2 copy-stream write failures", { skip }, () => {
	it("fails the copy on a short write, a write error and a truncated read", () => {
		assert.ok(
			executable,
			`PIDECK_REQUIRE_BACKEND_TESTS=1 but no fresh PiDeck-CopyStreamTest exists (looked for ${CANDIDATES.join(
				", ",
			)}); build it with ${BUILD_COMMAND}`,
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
		const output = execFileSync(executable, [], { env, encoding: "utf8", timeout: 60_000 });

		const lines = output.split("\n").map((line) => line.trim()).filter(Boolean);
		assert.equal(lines.filter((line) => line.startsWith("not ok")).length, 0, `unexpected failure:\n${output}`);
		assert.match(output, /^ok - a multi-block copy writes every byte$/m);
		assert.match(output, /^ok - the copied bytes match the source$/m);
		assert.match(output, /^ok - a short write fails the copy$/m);
		assert.match(output, /^ok - a write error fails the copy$/m);
		assert.match(output, /^ok - a read error fails the copy$/m);
		assert.match(output, /^ok - an interrupted read is an error, not a short body$/m);
		assert.match(output, /^ok - an oversized read stops after the first block past the limit$/m);
		// A failure after the exclusive create must remove the truncated destination the copy
		// created (Node `copyFile` does the same) and must never touch a pre-existing target.
		assert.match(output, /^ok - a failed copy removes the truncated destination it created$/m);
		assert.match(output, /^ok - a failed copy leaves the source untouched$/m);
		assert.match(output, /^ok - a rejected copy removes its partial destination$/m);
		assert.match(output, /^ok - a refused copy leaves the existing target intact$/m);
		assert.match(output, /all copy-stream cases passed/);

		// Every documented case must actually have run: a silently shortened suite would
		// still print the summary line.
		const okCount = lines.filter((line) => line.startsWith("ok - ")).length;
		assert.equal(okCount, 23, `expected 23 assertions, saw ${okCount}:\n${output}`);
	});
});
