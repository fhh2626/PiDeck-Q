import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

/** Exercise the real ignore rules in an isolated repository, without user excludes. */
function ignoredPaths(t, paths) {
	const directory = mkdtempSync(join(tmpdir(), "pideck-log-ignore-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	writeFileSync(join(directory, ".gitignore"), readFileSync(".gitignore", "utf8"));
	const initialized = spawnSync("git", ["init", "--quiet", directory], { windowsHide: true, encoding: "utf8" });
	assert.equal(initialized.status, 0, initialized.error?.message ?? initialized.stderr);
	const result = spawnSync("git", [
		"-C", directory, "-c", "core.excludesFile=", "check-ignore", "--no-index", "--stdin", "-z",
	], { windowsHide: true, encoding: "utf8", input: `${paths.join("\0")}\0` });
	assert.ok(result.status === 0 || result.status === 1, result.error?.message ?? result.stderr);
	return result.stdout.split("\0").filter(Boolean);
}

test("logs directories keep source and other non-log files eligible for version control", (t) => {
	const paths = [
		"native/backend/domain/logs/AppLogStore.h",
		"native/backend/domain/logs/AppLogStore.cpp",
		"native/backend/domain/logs/RpcLogEntry.h",
		"native/backend/domain/logs/RpcLogEntry.cpp",
		"native/backend/domain/logs/RpcLogLive.h",
		"native/backend/domain/logs/RpcLogLive.cpp",
		"native/backend/domain/logs/RpcLogStore.h",
		"native/backend/domain/logs/RpcLogStore.cpp",
		"native/backend/domain/logs/helpers/format.cpp",
		"logs/schema.json",
		"logs/nested/parser.ts",
		"docs/guide.md",
	];
	assert.deepEqual(ignoredPaths(t, paths), []);
});

test("logs directories ignore log and Markdown files at every depth", (t) => {
	const paths = [
		"logs/app.log",
		"logs/notes.md",
		"logs/nested/app.log",
		"logs/nested/notes.md",
		"native/backend/domain/logs/app.log",
		"native/backend/domain/logs/notes.md",
		"native/backend/domain/logs/nested/app.log",
		"native/backend/domain/logs/nested/notes.md",
		"app.log",
	];
	assert.deepEqual(ignoredPaths(t, paths), paths);
});
