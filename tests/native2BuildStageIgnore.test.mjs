/**
 * Repository hygiene for the local native2 package stages.
 *
 * `build/native2-validation-unpacked` / `build/native2-cpp-unpacked` are complete unpacked
 * packages (~110 MB, thousands of binaries) produced by the packaging gate. They used to
 * sit in `git status` as untracked directories, so a `git add -A` could have committed
 * hundreds of megabytes of build output. The rule must stay narrow: the tracked packager
 * icons under `build/` are product assets and must never be ignored.
 *
 * `git check-ignore` answers from the real ignore rules (no pattern re-implementation), and
 * each case skips only when git or the repository itself is unavailable.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";

const REPO_ROOT = process.cwd();

function git(args) {
	return spawnSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" });
}

function gitAvailable() {
	const probe = git(["rev-parse", "--is-inside-work-tree"]);
	return probe.status === 0 && probe.stdout.trim() === "true";
}

describe("native2 package stage hygiene", () => {
	test("the ignore file excludes the local package stages only", () => {
		const ignore = readFileSync(join(REPO_ROOT, ".gitignore"), "utf8").split(/\r?\n/);
		assert.ok(
			ignore.some((line) => line.trim() === "build/native2-*/"),
			".gitignore must ignore build/native2-*/ (unpacked package stages)",
		);
	});

	test("git ignores both stage directories and keeps the packager icons", (t) => {
		if (!gitAvailable()) {
			t.skip("not a git checkout");
			return;
		}
		for (const path of [
			"build/native2-validation-unpacked/PiDeck-Q.exe",
			"build/native2-cpp-unpacked/PiDeckBackend.exe",
		]) {
			const ignored = git(["check-ignore", "-v", "--", path]);
			assert.equal(ignored.status, 0, `${path} must be ignored, got: ${ignored.stdout}${ignored.stderr}`);
			assert.match(`${ignored.stdout}`, /\.gitignore:\d+:build\/native2-\*\//);
		}
		for (const tracked of ["build/icon.png", "build/icon.ico", "build/icons/16x16.png"]) {
			assert.notEqual(git(["check-ignore", "-q", "--", tracked]).status, 0, `${tracked} must not be ignored`);
			assert.equal(
				git(["ls-files", "--error-unmatch", "--", tracked]).status,
				0,
				`${tracked} must stay tracked as a product asset`,
			);
		}
	});
});
