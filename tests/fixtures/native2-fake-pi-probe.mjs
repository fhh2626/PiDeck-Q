// Fake `pi` used by the shutdown-budget suite: it records the lifecycle of every
// `--version` probe by pid, which is what proves a quit in the middle of a probe neither
// waits for the child forever nor leaves it behind.
//
// Only `--version` is implemented: the suite never activates a runtime, and answering any
// other call would hide a test that accidentally depends on the real RPC surface.
import { appendFileSync, readFileSync } from "node:fs";

const scenarioPath = process.env.FAKE_PI_SCENARIO ?? "";
const logPath = process.env.FAKE_PI_LOG ?? "";
const scenario = scenarioPath ? JSON.parse(readFileSync(scenarioPath, "utf8")) : {};

function log(entry) {
	if (!logPath) return;
	appendFileSync(logPath, `${JSON.stringify(entry)}\n`);
}

const argv = process.argv.slice(2);
if (argv.includes("--version")) {
	const delayMs = Number(scenario.versionDelayMs ?? 0);
	log({ kind: "probe-start", pid: process.pid, at: Date.now(), delayMs });
	if (Number.isFinite(delayMs) && delayMs > 0) {
		await new Promise((resolve) => setTimeout(resolve, delayMs));
	}
	log({ kind: "probe-exit", pid: process.pid, at: Date.now() });
	process.stdout.write(`${scenario.version ?? "0.79.0"}\n`);
	process.exit(0);
}

log({ kind: "unsupported", argv });
process.stderr.write(`fake pi probe: unsupported invocation ${argv.join(" ")}\n`);
process.exit(1);
