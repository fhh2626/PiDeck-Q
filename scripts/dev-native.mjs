import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const xmakeCommand = process.platform === "win32" ? "xmake.exe" : "xmake";
const packageVersion = JSON.parse(readFileSync("package.json", "utf8")).version;

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
	const appData = process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
	const userData = process.env.PIDECK_DEV_USER_DATA ?? join(appData, "pi-desktop-dev");
	await run(executable, [], {
		PIDECK_PACKAGED: "0",
		PIDECK_USER_DATA: userData,
		PIDECK_VERSION: `${process.env.PIDECK_VERSION ?? packageVersion}-dev`,
		PIDECK_APP_USER_MODEL_ID: "com.ayuayue.pi-desktop-dev",
		PIDECK_TOAST_SHORTCUT_NAME: "PiDeck-Q Dev.lnk",
	});
} else {
	console.warn("Native debug executable was not found at the default Xmake output path.");
}
