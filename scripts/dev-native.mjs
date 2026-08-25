import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const xmakeCommand = process.platform === "win32" ? "xmake.exe" : "xmake";

function run(command, args, env = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			stdio: "inherit",
			env: { ...process.env, ...env },
		});
		child.once("error", reject);
		child.once("exit", (code, signal) => {
			if (code === 0) resolve();
			else reject(new Error(`${command} exited with ${code ?? signal}`));
		});
	});
}

await run(npmCommand, ["run", "build:renderer"]);
await run(npmCommand, ["run", "build:node"]);
await run(xmakeCommand, ["f", "-m", "debug", "-y"]);
await run(xmakeCommand, ["-r"]);

const executable = "release/win-unpacked/PiDeck-Q.exe";
if (existsSync(executable)) {
	await run(executable, []);
} else {
	console.warn("Native debug executable was not found at the default Xmake output path.");
}
