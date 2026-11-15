// Fake `pi` CLI used by the extension parity tests.
//
// The C++ backend resolves pi from settings and runs `pi list/install/remove/update`
// with an argument array, so the fixture has to be a real executable that speaks the
// same stdout format. It is installed as a `.cmd` shim (npm installs pi that way on
// Windows), which also exercises the batch-shim launch path.
//
// State lives in `<dir>/fake-pi-state.json` so a test can assert that a command really
// ran and with which arguments.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const here = dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const statePath = process.env.PIDECK_FAKE_PI_STATE ?? join(here, "fake-pi-state.json");

function readState() {
	try {
		return JSON.parse(readFileSync(statePath, "utf8"));
	} catch {
		return { calls: [], packages: [] };
	}
}

function writeState(state) {
	writeFileSync(statePath, JSON.stringify(state, null, 2));
}

const args = process.argv.slice(2).filter((arg) => arg !== "--no-approve");
const state = readState();
state.calls.push(args);

const command = args[0] ?? "";
if (command === "--version") {
	writeState(state);
	process.stdout.write("0.79.0\n");
	process.exit(0);
}

if (command === "list") {
	const lines = [];
	const userPackages = state.packages.filter((entry) => entry.scope === "user");
	const projectPackages = state.packages.filter((entry) => entry.scope === "project");
	if (userPackages.length > 0) {
		lines.push("User packages:");
		for (const entry of userPackages) {
			lines.push(`  ${entry.source}${entry.filtered ? " (filtered)" : ""}`);
			if (entry.path) lines.push(`    ${entry.path}`);
		}
	}
	if (projectPackages.length > 0) {
		lines.push("Project packages:");
		for (const entry of projectPackages) {
			lines.push(`  ${entry.source}${entry.filtered ? " (filtered)" : ""}`);
			if (entry.path) lines.push(`    ${entry.path}`);
		}
	}
	writeState(state);
	process.stdout.write(`${lines.join("\n")}${lines.length > 0 ? "\n" : ""}`);
	process.exit(0);
}

if (command === "install") {
	state.packages.push({ source: args[1] ?? "", scope: "user", path: "" });
	writeState(state);
	process.stdout.write(`installed ${args[1] ?? ""}\n`);
	process.exit(0);
}

if (command === "remove") {
	const source = args[1] ?? "";
	state.packages = state.packages.filter((entry) => entry.source !== source);
	writeState(state);
	process.stdout.write(`removed ${source}\n`);
	process.exit(0);
}

if (command === "update") {
	writeState(state);
	process.stdout.write(`updated ${args.slice(1).join(" ")}\n`);
	process.exit(0);
}

writeState(state);
process.stderr.write(`unknown command: ${args.join(" ")}\n`);
process.exit(1);
