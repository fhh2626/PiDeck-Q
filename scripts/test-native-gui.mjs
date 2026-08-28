import { spawn } from "node:child_process";

const xmakeCommand = process.platform === "win32" ? "xmake.exe" : "xmake";

function run(args) {
	return new Promise((resolve, reject) => {
		const environment = { ...process.env };
		// Do not force another platform's Qt plugin. Linux CI may provide
		// offscreen/xcb/wayland explicitly, while macOS uses Cocoa by default.
		if (process.platform === "win32" && !environment.QT_QPA_PLATFORM) {
			environment.QT_QPA_PLATFORM = "windows";
		}
		const child = spawn(xmakeCommand, args, {
			stdio: "inherit",
			env: environment,
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
