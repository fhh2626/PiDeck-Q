// Scripted `pi --version` probe that records its own pid.
//
// The shutdown suites need two facts the general fake pi cannot give:
//  - when the probe child started and finished (so a quit in the middle of a probe can be
//    timed against the child instead of against a wall-clock sleep), and
//  - the child's pid (so "no survivor children" is an assertion on a process that really
//    existed, not on the absence of a log line).
// It is a separate fixture on purpose: `native2-fake-pi-runtime.mjs` is asserted on by many
// suites, and adding fields to its `--version` branch would change their recorded logs.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Materialize the probe fixture inside `fixture.root`.
 * Returns the shim path plus readers for the recorded lifecycle.
 */
export function createProbePi(fixture, { version = "0.79.0", versionDelayMs = 0 } = {}, { repoRoot = process.cwd() } = {}) {
	const directory = join(fixture.root, "fake-pi-probe");
	mkdirSync(directory, { recursive: true });
	const script = join(directory, "probe-pi.mjs");
	copyFileSync(join(repoRoot, "tests/fixtures/native2-fake-pi-probe.mjs"), script);
	const scenarioPath = join(directory, "scenario.json");
	writeFileSync(scenarioPath, JSON.stringify({ version, versionDelayMs }));
	const logPath = join(directory, "probe.log");
	const shim = join(directory, process.platform === "win32" ? "pi.cmd" : "pi.sh");
	writeFileSync(
		shim,
		process.platform === "win32"
			? `@echo off\r\nnode "${script}" %*\r\n`
			: `#!/bin/sh\nexec node "${script}" "$@"\n`,
	);
	const entries = () => {
		if (!existsSync(logPath)) return [];
		return readFileSync(logPath, "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line));
	};
	return {
		shim,
		scenarioPath,
		logPath,
		directory,
		entries,
		setScenario: (next) => writeFileSync(scenarioPath, JSON.stringify({ version, ...next })),
		starts: () => entries().filter((entry) => entry.kind === "probe-start"),
		exits: () => entries().filter((entry) => entry.kind === "probe-exit"),
	};
}

/** True while `pid` still exists (Windows: `process.kill(pid, 0)` reports EPERM for live). */
export function processAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error.code === "EPERM";
	}
}
