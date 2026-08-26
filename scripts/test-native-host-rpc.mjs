import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";

const xmakeCommand = process.platform === "win32" ? "xmake.exe" : "xmake";
const packageJson = JSON.parse(await readFile("package.json", "utf8"));

function run(args) {
	return new Promise((resolve, reject) => {
		const child = spawn(xmakeCommand, args, {
			stdio: "inherit",
			env: { ...process.env, PIDECK_VERSION: packageJson.version },
		});
		child.once("error", reject);
		child.once("exit", (code, signal) => {
			if (code === 0) resolve();
			else reject(new Error(`${xmakeCommand} ${args.join(" ")} exited with ${code ?? signal}`));
		});
	});
}

await run(["f", "-m", "debug", "-y"]);
await run(["build", "PiDeck-HostRpcTest"]);
await run(["run", "PiDeck-HostRpcTest"]);
console.log("Native HostRpcServer integration test passed.");
