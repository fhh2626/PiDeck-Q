// Scriptable fake `pi` for the model-list parity suite.
//
// The backend resolves pi from settings and runs either the neutral RPC
// (`--mode rpc ... get_available_models`) or the `--list-models` text table, so the
// fixture has to speak both. It is installed as a `.cmd` shim, like npm does on Windows,
// which also exercises the batch-shim launch path.
//
// Scenario (`FAKE_PI_MODELS_SCENARIO`):
//   {
//     version: "1.2.3",                 // --version answer
//     versionExit: 0,
//     rpc: { models: [...] } | { error: "..." },
//     text: ["<stdout>", ...],          // successive --list-models answers (last repeats)
//     textExit: 0
//   }
// Every spawn is appended to `FAKE_PI_MODELS_LOG` so a test can assert call counts.
// Successive `--list-models` calls are counted in `FAKE_PI_MODELS_COUNTER`.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const scenarioPath = process.env.FAKE_PI_MODELS_SCENARIO ?? "";
const logPath = process.env.FAKE_PI_MODELS_LOG ?? "";
const counterPath = process.env.FAKE_PI_MODELS_COUNTER ?? "";
const scenario = scenarioPath ? JSON.parse(readFileSync(scenarioPath, "utf8")) : {};

function log(entry) {
	if (!logPath) return;
	appendFileSync(logPath, `${JSON.stringify(entry)}\n`);
}

const argv = process.argv.slice(2);
log({ kind: "spawn", argv });

if (argv.includes("--version")) {
	process.stdout.write(`${scenario.version ?? "1.2.3"}\n`);
	process.exit(Number(scenario.versionExit ?? 0));
}

if (argv.includes("--list-models")) {
	let index = 0;
	if (counterPath) {
		try {
			index = Number(readFileSync(counterPath, "utf8")) || 0;
		} catch {
			index = 0;
		}
		writeFileSync(counterPath, String(index + 1));
	}
	const answers = scenario.text ?? [""];
	const output = answers[Math.min(index, answers.length - 1)] ?? "";
	process.stdout.write(output);
	process.exit(Number(scenario.textExit ?? 0));
}

if (!argv.includes("rpc")) {
	process.stderr.write(`unsupported command: ${argv.join(" ")}\n`);
	process.exit(1);
}

const rpc = scenario.rpc ?? {};
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
	const trimmed = line.trim();
	if (!trimmed) return;
	let message = null;
	try {
		message = JSON.parse(trimmed);
	} catch {
		return;
	}
	log({ kind: "command", message });
	if (message.type !== "get_available_models") return;
	const reply = rpc.error !== undefined
		? { id: message.id, type: "response", command: message.type, success: false, error: rpc.error }
		: {
			id: message.id,
			type: "response",
			command: message.type,
			success: true,
			data: { models: rpc.models ?? [] },
		};
	process.stdout.write(`${JSON.stringify(reply)}\n`);
});
lines.on("close", () => process.exit(0));
