import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const npmCommand = process.platform === "win32" ? process.execPath : "npm";
const npmPrefixArgs = process.platform === "win32"
	? [process.env.npm_execpath ?? join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js")]
	: [];
const packageManifest = JSON.parse(await readFile("package.json", "utf8"));
const buildVersion = packageManifest.version;
if (typeof buildVersion !== "string" || !/^\d+\.\d+\.\d+([-.][0-9A-Za-z.-]+)?$/.test(buildVersion)) {
	throw new Error(`Invalid package version: ${String(buildVersion)}`);
}

function run(command, args, env = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { stdio: "inherit", env: { ...process.env, ...env } });
		child.once("error", reject);
		child.once("exit", (code, signal) => {
			if (code === 0) resolve();
			else reject(new Error(`${command} exited with ${code ?? signal}`));
		});
	});
}

const buildEnv = { PIDECK_VERSION: buildVersion };
await run(npmCommand, [...npmPrefixArgs, "run", "make-icon"], buildEnv);
await run(npmCommand, [...npmPrefixArgs, "run", "build"], buildEnv);
await run(npmCommand, [...npmPrefixArgs, "run", "build:native"], buildEnv);
await run(npmCommand, [...npmPrefixArgs, "run", "verify:build-artifacts"], buildEnv);
console.log("Native Windows staging is ready.");
console.log("Installer compilation is disabled temporarily; release/win-unpacked contains the runnable Native build.");
