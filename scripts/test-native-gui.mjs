import { spawn } from "node:child_process";

const xmakeCommand = process.platform === "win32" ? "xmake.exe" : "xmake";

function run(args) {
	return new Promise((resolve, reject) => {
		const child = spawn(xmakeCommand, args, {
			stdio: "inherit",
			env: { ...process.env, QT_QPA_PLATFORM: process.env.QT_QPA_PLATFORM ?? "windows" },
		});
		child.once("error", reject);
		child.once("exit", (code, signal) => {
			if (code === 0) resolve();
			else reject(new Error(`${xmakeCommand} ${args.join(" ")} exited with ${code ?? signal}`));
		});
	});
}

await run(["f", "-m", "debug", "-y"]);
await run(["build", "PiDeck-NativeGuiTest"]);
await run(["run", "PiDeck-NativeGuiTest"]);
console.log("Native GUI integration test passed.");
