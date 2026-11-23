// Scriptable fake `wsl` for the WSL parity suite.
//
// No verification may depend on a real distro, so both implementations are pointed at
// this `.cmd` shim (`PIDECK_WSL_EXE` for the backend, a `getWslExe` stub for the Node
// oracle). It answers the four shapes the production code asks for:
//   wsl -l -q                       -> scenario.distros (NUL/backslash noise included)
//   wsl -d D -u U which pi          -> scenario.which
//   wsl -d D -u U whoami            -> scenario.whoami
//   wsl -d D -u U [--cd /path] pi … -> the scenario's piRuntime / piVersion
//
// The pi argv is passed through minus the wsl.exe prefix options (`-d/-u/--cd`), so a
// test can assert both the cwd handoff (`--cd`) and what pi itself received.
// Scenario: `FAKE_WSL_SCENARIO`; every invocation is appended to `FAKE_WSL_LOG`.
import { appendFileSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";

const scenarioPath = process.env.FAKE_WSL_SCENARIO ?? "";
const logPath = process.env.FAKE_WSL_LOG ?? "";
const scenario = scenarioPath ? JSON.parse(readFileSync(scenarioPath, "utf8")) : {};
const argv = process.argv.slice(2);

if (logPath) appendFileSync(logPath, `${JSON.stringify({ argv, cwd: process.cwd() })}\n`);

const userIndex = argv.indexOf("-u");
const rest = argv.slice(userIndex >= 0 ? userIndex + 2 : 0);
const cdIndex = rest.indexOf("--cd");
const command = (cdIndex >= 0 ? rest.slice(cdIndex + 2) : rest).filter((item) => item !== "--");

if (argv.includes("-l")) {
	const distros = scenario.distros ?? [];
	for (const distro of distros) process.stdout.write(`${distro}\n`);
	process.exit(Number(scenario.listExit ?? 0));
}

if (command[0] === "which") {
	if (scenario.which) process.stdout.write(`${scenario.which}\n`);
	process.exit(Number(scenario.whichExit ?? (scenario.which ? 0 : 1)));
}

if (command[0] === "whoami") {
	if (scenario.whoamiStderr) process.stderr.write(String(scenario.whoamiStderr));
	if (scenario.whoami) process.stdout.write(`${scenario.whoami}\n`);
	process.exit(Number(scenario.whoamiExit ?? 0));
}

if (command[0] === "pi" && scenario.piRuntime && !command.includes("--version")) {
	// WSL session runtime: `wsl -d D -u U -- pi --mode rpc ...`. The parity suite cannot
	// start a distro, so the scenario names a Node script that stands in for the pi inside
	// it and inherits this process's environment (that is exactly the Windows env the real
	// wsl.exe would forward through WSLENV). No top-level `return` here: this file is ESM.
	const child = spawn(process.execPath, [scenario.piRuntime, ...command.slice(1)], {
		windowsHide: true,
		stdio: "inherit",
		env: { ...process.env },
	});
	child.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 0)));
} else if (command[0] === "pi") {
	if (scenario.piStderr) process.stderr.write(String(scenario.piStderr));
	if (scenario.piVersion) process.stdout.write(`${scenario.piVersion}\n`);
	process.exit(Number(scenario.piExit ?? (scenario.piVersion ? 0 : 1)));
} else {
	process.stderr.write(`unsupported wsl invocation: ${argv.join(" ")}\n`);
	process.exit(2);
}
