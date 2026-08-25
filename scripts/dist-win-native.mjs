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

await run(npmCommand, ["run", "build"]);
const makensis = process.platform === "win32" ? "makensis.exe" : "makensis";
await run(makensis, ["installer/PiDeck-Q.nsi"]);
console.log("Native Windows installer and staging are ready.");
console.log("The installer checks for WebView2 Evergreen Runtime and runs Microsoft's bootstrapper when absent.");
