// Scriptable fake `npm` for the pi-install parity suite.
//
// `pi:check-npm` runs `npm --version` and `pi:exec-install` runs the renderer's install
// command through `cmd.exe /d /s /c`, so the fixture has to be a real `.cmd` shim on
// PATH. Every invocation records its argv, the npm config flags and the cwd so a test
// can assert that `npm_config_fund`/`npm_config_audit` are disabled and that the install
// ran in the user home.
//
// Scenario (`FAKE_NPM_SCENARIO`):
//   {
//     version: "10.8.2", versionStdout, versionStderr, versionExit,
//     installStdout, installStderr, installExit
//   }
import { appendFileSync, readFileSync } from "node:fs";

const scenarioPath = process.env.FAKE_NPM_SCENARIO ?? "";
const logPath = process.env.FAKE_NPM_LOG ?? "";
const scenario = scenarioPath ? JSON.parse(readFileSync(scenarioPath, "utf8")) : {};
const argv = process.argv.slice(2);

if (logPath) {
	appendFileSync(
		logPath,
		`${JSON.stringify({
			argv,
			fund: process.env.npm_config_fund ?? null,
			audit: process.env.npm_config_audit ?? null,
			cwd: process.cwd(),
		})}\n`,
	);
}

if (argv[0] === "--version") {
	if (scenario.versionStderr) process.stderr.write(String(scenario.versionStderr));
	process.stdout.write(String(scenario.versionStdout ?? `${scenario.version ?? "10.8.2"}\n`));
	process.exit(Number(scenario.versionExit ?? 0));
}

process.stdout.write(String(scenario.installStdout ?? ""));
process.stderr.write(String(scenario.installStderr ?? ""));
process.exit(Number(scenario.installExit ?? 0));
