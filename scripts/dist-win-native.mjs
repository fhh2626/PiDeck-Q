import { spawn } from "node:child_process";

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

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

await run(npmCommand, ["run", "make-icon"]);
await run(npmCommand, ["run", "build"]);
await run(npmCommand, ["run", "build:native"]);
await run(npmCommand, ["run", "verify:build-artifacts"]);
console.log("Native Windows staging is ready.");
console.log("Installer compilation is disabled temporarily; release/win-unpacked contains the runnable Native build.");
