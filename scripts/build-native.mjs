import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";

const npmPackage = JSON.parse(await readFile("package.json", "utf8"));
const version = npmPackage.version;
if (typeof version !== "string" || !/^\d+\.\d+\.\d+([-.][0-9A-Za-z.-]+)?$/.test(version)) {
	throw new Error(`Invalid package version: ${String(version)}`);
}

const xmakeCommand = process.platform === "win32" ? "xmake.exe" : "xmake";
function run(args) {
	return new Promise((resolve, reject) => {
		const child = spawn(xmakeCommand, args, {
			stdio: "inherit",
			env: { ...process.env, PIDECK_VERSION: version },
		});
		child.once("error", reject);
		child.once("exit", (code, signal) => {
			if (code === 0) resolve();
			else reject(new Error(`${xmakeCommand} exited with ${code ?? signal}`));
		});
	});
}

await run(["f", "-m", "release", "-y"]);
await run(["-r"]);
