import { spawn } from "node:child_process";

/** Hold an exclusive Windows read handle until released, without modifying the file. */
export async function holdExclusiveFileLock(t, path) {
	const child = spawn("powershell", ["-NoProfile", "-NonInteractive", "-Command", [
		"$ErrorActionPreference='Stop'",
		"$file=[IO.File]::Open($env:PIDECK_TEST_LOCK_PATH,'Open','Read','None')",
		"try { [Console]::Out.WriteLine('locked'); [Console]::Out.Flush(); [Console]::ReadLine() | Out-Null } finally { $file.Dispose() }",
	].join("; ")], {
		windowsHide: true,
		stdio: ["pipe", "pipe", "pipe"],
		env: { ...process.env, PIDECK_TEST_LOCK_PATH: path },
	});
	const exited = new Promise((resolve) => child.once("exit", resolve));
	t.after(async () => {
		if (!child.stdin.writableEnded) child.stdin.end("\n");
		if (child.exitCode === null) child.kill();
		await exited;
	});
	await new Promise((resolve, reject) => {
		const timer = setTimeout(() => finish(new Error("Exclusive file lock did not become ready")), 10_000);
		let output = "";
		let errors = "";
		const finish = (error) => {
			clearTimeout(timer);
			child.stdout.off("data", onData);
			child.off("error", onError);
			child.off("exit", onExit);
			if (error) reject(error); else resolve();
		};
		const onData = (data) => {
			output += data.toString();
			if (output.includes("locked")) finish();
		};
		const onError = (error) => finish(error);
		const onExit = () => finish(new Error(`File lock process exited before readiness: ${errors}`));
		child.stderr.on("data", (data) => { errors += data.toString(); });
		child.stdout.on("data", onData);
		child.once("error", onError);
		child.once("exit", onExit);
	});
	return async () => {
		if (!child.stdin.writableEnded) child.stdin.end("\n");
		await exited;
	};
}
